import type { AgentClient, AgentSupervisor, ChannelCodec } from "./types";
import type { Store } from "./store";

// The dispatch loop. Drains the durable inbox oldest-first, one at a time
// (serial per process = ordered, no session fork). Order of durable writes is
// the whole point: the reply is enqueued to the outbox and the inbox row is
// marked done BEFORE we attempt delivery, so a crash never loses an answer,
// and the outbox dedup_key means a re-run never sends it twice.

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
    const dedupKey = `out:${row.event_id}`;

    // Local intercept: /id answers without spending an agent turn (handy for
    // filling the allowlist on first contact).
    if (row.text.trim() === "/id") {
      this.store.enqueueOutbox(dedupKey, row.conversation_id, row.chat_id, `Your Telegram id: ${row.actor_id.replace("tg:", "")}`);
      this.store.markInboxDone(row.event_id);
      await this.flushOutbox();
      return true;
    }

    try {
      await this.sup.ensureAwake();
      await this.codec.typing?.(row.chat_id);
      const session = this.store.getSession(row.conversation_id);
      const { responseId, outputText } = await this.agent.run(row.text, {
        previousResponseId: session?.prev_response_id ?? undefined,
        userId: row.actor_id,
      });
      this.store.setSession(row.conversation_id, responseId, row.actor_id);
      const reply = outputText.trim() || "(the agent returned no text)";
      this.store.enqueueOutbox(dedupKey, row.conversation_id, row.chat_id, reply);
      this.store.markInboxDone(row.event_id);
    } catch (e) {
      this.log(`turn failed for ${row.event_id}: ${String(e)}`);
      this.store.enqueueOutbox(dedupKey, row.conversation_id, row.chat_id, `⚠️ ${String(e).slice(0, 300)}`);
      this.store.markInboxDone(row.event_id);
    }

    await this.flushOutbox();
    await this.sup.maybeSuspend();
    return true;
  }

  /** Deliver queued replies. Idempotent send; retryable failures wait, permanent ones dead-letter. */
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
