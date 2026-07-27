import type { AgentClient, AgentSupervisor, ChannelCodec } from "./types";
import type { Store } from "./store";

// The dispatch loop. Drains the durable inbox oldest-first, one at a time
// (serial per process = ordered, no session fork). The per-turn durable writes
// (advance session, enqueue reply, complete inbox) commit atomically via
// store.commitTurn, so a crash never leaves a partial turn. Delivery is
// AT-LEAST-ONCE: a crash between a successful platform send and markOutboxSent
// re-sends on restart (Telegram has no send-idempotency key), so a rare
// duplicate is possible and acceptable for chat.

/** Telegram caps a message at 4096 chars. Split on structure, hard-cut only as a last resort. */
export function chunkText(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length) chunks.push(buf);
    buf = "";
  };
  for (const line of text.split("\n")) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if (buf.length + line.length + 1 > max) flush();
    buf = buf.length ? `${buf}\n${line}` : line;
  }
  flush();
  return chunks;
}

const HELP = [
  "I'm Ferni, your Delta agent. Just talk to me normally - ask a question, hand me a task,",
  "or think out loud. A few built-in commands:",
  "",
  "/help - this message",
  "/id - your Telegram id",
].join("\n");

export class Connector {
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly codec: ChannelCodec,
    private readonly agent: AgentClient,
    private readonly sup: AgentSupervisor,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /** Process at most one inbox event. Returns false when the inbox is empty. */
  async runOnce(): Promise<boolean> {
    const row = this.store.nextPending();
    if (!row) {
      await this.flushOutbox();
      return false;
    }
    const text = row.text.trim();

    // Local intercepts: answered without spending an agent turn.
    const canned =
      text === "/id"
        ? `Your Telegram id: ${row.actor_id.replace("tg:", "")}`
        : text === "/help" || text === "/start"
          ? HELP
          : null;
    if (canned !== null) {
      this.store.commitTurn({
        eventId: row.event_id,
        conversationId: row.conversation_id,
        chatId: row.chat_id,
        userId: row.actor_id,
        replyChunks: chunkText(canned),
      });
      await this.flushOutbox();
      return true;
    }

    // Run the agent turn (the one non-durable step). A crash here leaves the
    // event pending, so it re-runs on restart (at-least-once on the turn).
    let responseId: string | undefined;
    let replyChunks: string[];
    try {
      await this.sup.ensureAwake();
      await this.codec.typing?.(row.chat_id);
      const session = this.store.getSession(row.conversation_id);
      const out = await this.agent.run(text, {
        previousResponseId: session?.prev_response_id ?? undefined,
        userId: row.actor_id,
      });
      responseId = out.responseId;
      replyChunks = chunkText(out.outputText.trim() || "(I finished, but produced no text.)");
    } catch (e) {
      this.log(`turn failed for ${row.event_id}: ${String(e)}`);
      replyChunks = ["Something went wrong on my end and I could not finish that. Try again in a moment."];
    }

    // One atomic commit: session + reply chunks + inbox-done.
    this.store.commitTurn({
      eventId: row.event_id,
      conversationId: row.conversation_id,
      chatId: row.chat_id,
      userId: row.actor_id,
      responseId,
      replyChunks,
    });

    await this.flushOutbox();
    await this.sup.maybeSuspend();
    return true;
  }

  /** Deliver queued replies in order. At-least-once; backs off on retryable failures. */
  async flushOutbox(): Promise<void> {
    let row = this.store.nextQueuedOutbox();
    while (row) {
      const r = await this.codec.send(row.chat_id, row.text);
      if (r.ok) {
        this.store.markOutboxSent(row.dedup_key);
      } else if (r.retryable) {
        // Honor Telegram retry_after; keep the reply intact (later chunks wait behind this one).
        this.store.markOutboxRetry(row.dedup_key, r.retryAfterMs ?? 1000);
        this.log(`send backoff (${row.attempts + 1}) for ${row.dedup_key}: ${r.error ?? ""}`);
        break;
      } else {
        // Permanent: drop the whole reply so a partial, out-of-order one is never sent.
        this.store.markGroupDead(row.group_key);
        this.log(`send dead for ${row.group_key}: ${r.error ?? ""}`);
      }
      row = this.store.nextQueuedOutbox();
    }
  }

  async loop(intervalMs = 500): Promise<void> {
    this.running = true;
    while (this.running) {
      const did = await this.runOnce();
      if (!did) await Bun.sleep(intervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }
}
