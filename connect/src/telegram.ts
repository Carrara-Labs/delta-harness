import type { ChannelCodec, IngressDriver, Inbound, OutboundResult } from "./types";
import type { Store } from "./store";

// Telegram codec + long-poll ingress. Zero deps: raw Bot API over fetch.
// Long-poll is the right default for a home box - no public URL, just
// outbound HTTPS. The durable contract: insert to the inbox BEFORE advancing
// the offset, so an update accepted from Telegram survives a crash.

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
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (data.ok) return { ok: true, retryable: false };
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, retryable, error: data.description };
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
}

type TgUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; type: string };
    from: { id: number };
  };
};

export class TelegramLongPoll implements IngressDriver {
  private aborted = false;

  constructor(
    private readonly token: string,
    private readonly store: Store,
    private readonly opts: { allowed: Set<string> },
  ) {}

  async start(): Promise<void> {
    let offset = Number(this.store.getMeta("tg_offset") ?? 0);
    while (!this.aborted) {
      try {
        const url =
          API(this.token, "getUpdates") +
          `?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
        const data = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
        if (!data.ok || !data.result) {
          await Bun.sleep(1000);
          continue;
        }
        for (const u of data.result) {
          offset = u.update_id + 1;
          const msg = u.message;
          // DM-only v1; ignore non-text and non-private, but still advance.
          if (!msg?.text || msg.chat.type !== "private") {
            this.store.setMeta("tg_offset", offset);
            continue;
          }
          const userId = String(msg.from.id);
          if (this.opts.allowed.size > 0 && !this.opts.allowed.has(userId)) {
            this.store.setMeta("tg_offset", offset);
            continue;
          }
          const event: Inbound = {
            eventId: `tg:${u.update_id}`,
            conversationId: `tg:${msg.chat.id}`,
            actorId: `tg:${userId}`,
            chatId: String(msg.chat.id),
            text: msg.text,
            raw: u,
          };
          // Durable BEFORE ack: insert, then persist the advanced offset.
          this.store.insertInbox(event);
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
