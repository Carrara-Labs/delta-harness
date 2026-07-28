import type { Store } from "./store";
import type {
  AttachmentRef,
  ChannelCodec,
  DownloadedFile,
  Inbound,
  IngressDriver,
  OutboundResult,
} from "./types";

// Telegram codec + long-poll ingress. Zero deps: raw Bot API over fetch.
// Long-poll is the right default for a home box - no public URL, just outbound
// HTTPS. The durable contract: insert to the inbox BEFORE advancing the offset,
// so an update accepted from Telegram survives a crash. All inbound JSON is
// UNTRUSTED and validated field-by-field before it touches the store; a
// malformed update is skipped and its offset advanced, never poison-looped.

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

export class TelegramCodec implements ChannelCodec {
  readonly name = "telegram";
  constructor(private readonly token: string) {}

  async send(chatId: string, text: string): Promise<OutboundResult> {
    try {
      const res = await fetch(API(this.token, "sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (data.ok) return { ok: true, retryable: false };
      const retryable = res.status === 429 || res.status >= 500;
      const retryAfterMs =
        typeof data.parameters?.retry_after === "number"
          ? data.parameters.retry_after * 1000
          : undefined;
      return {
        ok: false,
        retryable,
        error: data.description,
        ...(retryAfterMs ? { retryAfterMs } : {}),
      };
    } catch (e) {
      return { ok: false, retryable: true, error: String(e) };
    }
  }

  async typing(chatId: string): Promise<void> {
    try {
      await fetch(API(this.token, "sendChatAction"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // typing is best-effort UX; never fail a turn over it
    }
  }

  /** Resolve a file_id to bytes: getFile -> file_path -> download. Null on any
   *  failure, so a bad attachment degrades the turn instead of crashing it. */
  async download(ref: AttachmentRef): Promise<DownloadedFile | null> {
    try {
      const meta = await fetch(API(this.token, "getFile"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: ref.fileId }),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await meta.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: { file_path?: string };
      };
      const filePath = data.ok ? data.result?.file_path : undefined;
      if (typeof filePath !== "string" || !filePath) return null;
      const bin = await fetch(
        `https://api.telegram.org/file/bot${this.token}/${filePath}`,
        { signal: AbortSignal.timeout(60000) },
      );
      if (!bin.ok) return null;
      return {
        bytes: new Uint8Array(await bin.arrayBuffer()),
        name: ref.name,
        mime: ref.mime ?? "application/octet-stream",
      };
    } catch {
      return null;
    }
  }
}

/** Pull attachment refs (document, or the largest photo size) off an untrusted
 *  message. Only a string file_id is trusted; everything else is best-effort. */
function extractAttachments(msg: Record<string, unknown> | undefined): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const doc = msg?.document as Record<string, unknown> | undefined;
  if (doc && typeof doc.file_id === "string") {
    out.push({
      fileId: doc.file_id,
      name: typeof doc.file_name === "string" && doc.file_name ? doc.file_name : "file",
      mime: typeof doc.mime_type === "string" ? doc.mime_type : undefined,
    });
  }
  const photo = msg?.photo;
  if (Array.isArray(photo) && photo.length) {
    // Telegram sends ascending sizes; take the largest with a valid file_id.
    for (let i = photo.length - 1; i >= 0; i--) {
      const p = photo[i] as Record<string, unknown> | undefined;
      if (p && typeof p.file_id === "string") {
        out.push({ fileId: p.file_id, name: "photo.jpg", mime: "image/jpeg" });
        break;
      }
    }
  }
  return out;
}

/** Validate one untrusted update into a normalized Inbound, or null to skip it. */
export function parseUpdate(
  u: unknown,
  opts: { allowed: Set<string> },
): { updateId: number; event: Inbound | null } | null {
  if (typeof u !== "object" || u === null) return null;
  const upd = u as Record<string, unknown>;
  const updateId = upd.update_id;
  if (typeof updateId !== "number" || !Number.isFinite(updateId)) return null; // can't advance safely - skip batch item

  const msg = upd.message as Record<string, unknown> | undefined;
  const chat = msg?.chat as Record<string, unknown> | undefined;
  const from = msg?.from as Record<string, unknown> | undefined;
  // A file message carries its caption as the text; a plain message its text.
  const rawText = typeof msg?.text === "string" ? msg.text : msg?.caption;
  const text = typeof rawText === "string" ? rawText : "";
  const attachments = extractAttachments(msg);

  // Handle it only if it's a private message with text OR a file. Otherwise it's
  // a valid update with no event (advance past it), never a poison-loop.
  if (
    typeof chat?.id !== "number" ||
    chat.type !== "private" ||
    typeof from?.id !== "number" ||
    (text === "" && attachments.length === 0)
  ) {
    return { updateId, event: null };
  }
  const userId = String(from.id);
  if (opts.allowed.size > 0 && !opts.allowed.has(userId)) {
    return { updateId, event: null };
  }
  return {
    updateId,
    event: {
      eventId: `tg:${updateId}`,
      conversationId: `tg:${chat.id}`,
      actorId: `tg:${userId}`,
      chatId: String(chat.id),
      text,
      ...(attachments.length ? { attachments } : {}),
      raw: u,
    },
  };
}

export class TelegramLongPoll implements IngressDriver {
  private aborted = false;

  constructor(
    private readonly token: string,
    private readonly store: Store,
    private readonly opts: { allowed: Set<string> },
  ) {}

  async start(): Promise<void> {
    let offset = Number(this.store.getMeta("tg_offset") ?? 0);
    if (!Number.isFinite(offset)) offset = 0;
    while (!this.aborted) {
      try {
        const url =
          API(this.token, "getUpdates") +
          `?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          result?: unknown;
        } | null;
        if (!data?.ok || !Array.isArray(data.result)) {
          await Bun.sleep(1000);
          continue;
        }
        for (const raw of data.result) {
          const parsed = parseUpdate(raw, this.opts);
          if (!parsed) continue; // unparseable item: skip without advancing (can't trust update_id)
          offset = parsed.updateId + 1;
          // Durable BEFORE ack: insert (if it's an event), then persist the advanced offset.
          if (parsed.event) this.store.insertInbox(parsed.event);
          this.store.setMeta("tg_offset", offset);
        }
      } catch {
        await Bun.sleep(1000);
      }
    }
  }

  stop(): void {
    this.aborted = true;
  }
}
