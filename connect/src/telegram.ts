import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { chunkText } from "./core";
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

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function inlineToHtml(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; ) {
    if (source[i] === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        out += `<code>${escapeHtml(source.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    const image = source.startsWith("![", i);
    if (image || source[i] === "[") {
      const labelStart = i + (image ? 2 : 1);
      const labelEnd = source.indexOf("](", labelStart);
      const urlEnd = labelEnd < 0 ? -1 : source.indexOf(")", labelEnd + 2);
      if (labelEnd >= labelStart && urlEnd >= 0) {
        if (!image) {
          const label = escapeHtml(source.slice(labelStart, labelEnd));
          const rawUrl = source.slice(labelEnd + 2, urlEnd);
          try {
            const url = new URL(rawUrl);
            out +=
              url.protocol === "http:" || url.protocol === "https:"
                ? `<a href="${escapeHtml(url.toString())}">${label}</a>`
                : label;
          } catch {
            out += label;
          }
        }
        i = urlEnd + 1;
        continue;
      }
    }

    const bold = source.startsWith("**", i) ? "**" : source.startsWith("__", i) ? "__" : null;
    if (bold) {
      const end = source.indexOf(bold, i + 2);
      if (end > i + 2) {
        out += `<b>${escapeHtml(source.slice(i + 2, end))}</b>`;
        i = end + 2;
        continue;
      }
    }

    const italic = source[i] === "*" || source[i] === "_" ? source[i] : null;
    if (italic) {
      const end = source.indexOf(italic, i + 1);
      if (end > i + 1) {
        out += `<i>${escapeHtml(source.slice(i + 1, end))}</i>`;
        i = end + 1;
        continue;
      }
    }

    out += escapeHtml(source[i] as string);
    i++;
  }
  return out;
}

function headingBody(line: string): string | null {
  let hashes = 0;
  while (hashes < line.length && hashes < 6 && line[hashes] === "#") hashes++;
  return hashes > 0 && line[hashes] === " " ? line.slice(hashes + 1) : null;
}

function listBody(line: string): string | null {
  if (["- ", "* ", "+ "].some((prefix) => line.startsWith(prefix))) return line.slice(2);
  let digits = 0;
  while (digits < line.length && line.charCodeAt(digits) >= 48 && line.charCodeAt(digits) <= 57)
    digits++;
  return digits > 0 && line.slice(digits, digits + 2) === ". " ? line.slice(digits + 2) : null;
}

/** A small, total Markdown subset rendered only to Telegram-supported HTML. */
export function markdownToHtml(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trimStart().startsWith("```")) {
      let close = i + 1;
      while (close < lines.length && lines[close]?.trim() !== "```") close++;
      if (close < lines.length) {
        out.push(`<pre><code>${escapeHtml(lines.slice(i + 1, close).join("\n"))}</code></pre>`);
        i = close;
        continue;
      }
      out.push(escapeHtml(lines.slice(i).join("\n")));
      break;
    }
    const heading = headingBody(line);
    const list = listBody(line);
    if (heading !== null) out.push(`<b>${inlineToHtml(heading)}</b>`);
    else if (line === ">" || line.startsWith("> "))
      out.push(`<blockquote>${inlineToHtml(line.slice(line === ">" ? 1 : 2))}</blockquote>`);
    else if (list !== null) out.push(`• ${inlineToHtml(list)}`);
    else out.push(inlineToHtml(line));
  }
  return out.join("\n");
}

/** Split Markdown source before rendering, balancing fenced code across chunks. */
export function telegramChunks(source: string): string[] {
  const chunks = chunkText(source, 3900);
  let open = false;
  return chunks.map((chunk) => {
    let balanced = open ? `\`\`\`\n${chunk}` : chunk;
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!open && line.trimStart().startsWith("```")) open = true;
      else if (open && trimmed === "```") open = false;
    }
    if (open) balanced += "\n```";
    return balanced;
  });
}

type ResolvedPath = { ok: true; path: string } | { ok: false; error: string };

/** Resolve a late-bound document claim without permitting traversal or symlink escape. */
export function resolveDocumentPath(workspace: string | undefined, input: string): ResolvedPath {
  try {
    if (!workspace || !input || isAbsolute(input))
      return { ok: false, error: "document path must be workspace-relative" };
    const root = realpathSync(workspace);
    const target = realpathSync(resolve(root, input));
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
      return { ok: false, error: "document path escapes the workspace" };
    if (!statSync(target).isFile()) return { ok: false, error: "document path is not a file" };
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: `document unavailable: ${String(error)}` };
  }
}

type Decoded = { result: OutboundResult; parseEntities: boolean };

async function decodeTelegramResponse(response: Response): Promise<Decoded> {
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    parameters?: { retry_after?: number };
  };
  if (data.ok) return { result: { ok: true, retryable: false }, parseEntities: false };
  const retryAfterMs =
    typeof data.parameters?.retry_after === "number"
      ? data.parameters.retry_after * 1000
      : undefined;
  return {
    result: {
      ok: false,
      retryable: response.status === 429 || response.status >= 500,
      error: data.description,
      ...(retryAfterMs ? { retryAfterMs } : {}),
    },
    parseEntities:
      response.status === 400 &&
      typeof data.description === "string" &&
      data.description.toLowerCase().includes("can't parse entities"),
  };
}

export class TelegramCodec implements ChannelCodec {
  readonly name = "telegram";
  constructor(
    private readonly token: string,
    private readonly workspace?: string,
  ) {}

  chunk(text: string): string[] {
    return telegramChunks(text);
  }

  async send(chatId: string, text: string): Promise<OutboundResult> {
    try {
      const send = (body: Record<string, unknown>) =>
        fetch(API(this.token, "sendMessage"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
      const first = await decodeTelegramResponse(
        await send({ chat_id: chatId, text: markdownToHtml(text), parse_mode: "HTML" }),
      );
      if (!first.parseEntities) return first.result;
      return (await decodeTelegramResponse(await send({ chat_id: chatId, text }))).result;
    } catch (e) {
      return { ok: false, retryable: true, error: String(e) };
    }
  }

  async sendDocument(chatId: string, relativePath: string): Promise<OutboundResult> {
    const resolved = resolveDocumentPath(this.workspace, relativePath);
    if (!resolved.ok) return { ok: false, retryable: false, error: resolved.error };
    let form: FormData;
    try {
      form = new FormData();
      form.append("chat_id", chatId);
      form.append("document", Bun.file(resolved.path));
    } catch (e) {
      return { ok: false, retryable: false, error: String(e) };
    }
    try {
      const response = await fetch(API(this.token, "sendDocument"), {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60000),
      });
      return (await decodeTelegramResponse(response)).result;
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
      const bin = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
        signal: AbortSignal.timeout(60000),
      });
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
    await this.registerCommands();
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

  /** Register the "/" command menu once at startup (Telegram setMyCommands, 0.3.1). We keep the
   *  full list short (9 commands), so a single default-scope registration is enough — the default
   *  scope is Telegram's fallback for DMs and groups alike, so we cover both without fragmenting
   *  into per-scope menus. Best-effort and non-fatal: a network stall must not wedge boot. */
  private async registerCommands(): Promise<void> {
    const commands = [
      { command: "new", description: "start a fresh thread" },
      { command: "cancel", description: "stop what I'm currently working on" },
      { command: "model", description: "which model and effort I'm running" },
      { command: "provider", description: "which provider and my failover chain" },
      { command: "status", description: "version, profile, provider, model, budget" },
      { command: "help", description: "list the commands" },
      { command: "id", description: "your Telegram id" },
      { command: "restart", description: "restart the daemon (operator)" },
      { command: "safemode", description: "restart neutral, no persona or memory (operator)" },
      { command: "revert", description: "list or restore a memory revision (operator)" },
    ];
    try {
      await fetch(API(this.token, "setMyCommands"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Non-fatal: the menu is a convenience; every command still works when typed.
    }
  }

  stop(): void {
    this.aborted = true;
  }
}
