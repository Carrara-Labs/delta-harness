import type { AgentClient, AgentSupervisor, ChannelCodec } from "./types";
import type { Store } from "./store";

// The dispatch loop. Drains the durable inbox oldest-first, one at a time
// (serial per process = ordered, no session fork). Order of durable writes is
// the whole point: the reply is enqueued to the outbox and the inbox row is
// marked done BEFORE we attempt delivery, so a crash never loses an answer,
// and the outbox dedup_key means a re-run never sends it twice.

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
      // a single very long line: flush what we have, then hard-cut the line
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

  /** Enqueue a reply as one or more ordered, individually-idempotent outbox rows. */
  private enqueueReply(eventId: string, conversationId: string, chatId: string, text: string): void {
    const parts = chunkText(text);
    parts.forEach((part, i) => {
      this.store.enqueueOutbox(`out:${eventId}:${i}`, conversationId, chatId, part);
    });
  }

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
      this.enqueueReply(row.event_id, row.conversation_id, row.chat_id, canned);
      this.store.markInboxDone(row.event_id);
      await this.flushOutbox();
      return true;
    }

    try {
      await this.sup.ensureAwake();
      await this.codec.typing?.(row.chat_id);
      const session = this.store.getSession(row.conversation_id);
      const { responseId, outputText } = await this.agent.run(text, {
        previousResponseId: session?.prev_response_id ?? undefined,
        userId: row.actor_id,
      });
      this.store.setSession(row.conversation_id, responseId, row.actor_id);
      const reply = outputText.trim() || "(I finished, but produced no text.)";
      this.enqueueReply(row.event_id, row.conversation_id, row.chat_id, reply);
      this.store.markInboxDone(row.event_id);
    } catch (e) {
      this.log(`turn failed for ${row.event_id}: ${String(e)}`);
      this.enqueueReply(
        row.event_id,
        row.conversation_id,
        row.chat_id,
        "Something went wrong on my end and I could not finish that. Try again in a moment.",
      );
      this.store.markInboxDone(row.event_id);
    }

    await this.flushOutbox();
    await this.sup.maybeSuspend();
    return true;
  }

  /** Deliver queued replies in order. Idempotent send; retryable failures wait, permanent ones dead-letter. */
  async flushOutbox(): Promise<void> {
    let row = this.store.nextQueuedOutbox();
    while (row) {
      const r = await this.codec.send(row.chat_id, row.text);
      if (r.ok) {
        this.store.markOutboxSent(row.dedup_key);
      } else if (r.retryable) {
        this.store.bumpOutboxAttempt(row.dedup_key);
        this.log(`send retry (${row.attempts + 1}) for ${row.dedup_key}: ${r.error ?? ""}`);
        break; // try again on the next flush
      } else {
        this.store.markOutboxDead(row.dedup_key);
        this.log(`send dead for ${row.dedup_key}: ${r.error ?? ""}`);
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
