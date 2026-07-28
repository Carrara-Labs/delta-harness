import type { InboxRow, Store } from "./store";
import type { AgentClient, AgentSupervisor, AttachmentRef, ChannelCodec } from "./types";

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
  "/new - start a fresh thread (clears our previous context)",
  "/help - this message",
  "/id - your Telegram id",
].join("\n");

const NEW_THREAD =
  "Fresh thread started. I've cleared our previous context - your next message begins a new conversation.";

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

    // Local intercepts: answered without spending an agent turn. `/new` also
    // clears the thread so the next message starts fresh (same commit).
    const isNew = text === "/new";
    const canned = isNew
      ? NEW_THREAD
      : text === "/id"
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
        resetSession: isNew,
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
      const input = await this.prepareInput(row, text);
      const out = await this.agent.run(input, {
        previousResponseId: session?.prev_response_id ?? undefined,
        userId: row.actor_id,
      });
      responseId = out.responseId;
      replyChunks = chunkText(out.outputText.trim() || "(I finished, but produced no text.)");
    } catch (e) {
      this.log(`turn failed for ${row.event_id}: ${String(e)}`);
      replyChunks = [
        "Something went wrong on my end and I could not finish that. Try again in a moment.",
      ];
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

  /** Build the agent's turn input. For a file message, the attachments are
   *  fetched from the channel and handed to the daemon workspace HERE, at
   *  dispatch (the daemon is awake), and the turn input references their saved
   *  paths so the agent can read_file them. Any fetch/upload failure degrades to
   *  a note instead of crashing the turn (error-as-value). */
  private async prepareInput(row: InboxRow, caption: string): Promise<string> {
    if (!row.attachments) return caption;
    let refs: AttachmentRef[];
    try {
      refs = JSON.parse(row.attachments) as AttachmentRef[];
    } catch {
      return caption;
    }
    if (!refs.length) return caption;

    try {
      const blobs = [];
      for (const ref of refs) {
        const dl = this.codec.download ? await this.codec.download(ref) : null;
        if (dl) blobs.push(dl);
      }
      if (blobs.length && this.agent.uploadFiles) {
        const saved = await this.agent.uploadFiles(blobs);
        const list = saved.map((s) => `- ${s.path}${s.mime ? ` (${s.mime})` : ""}`).join("\n");
        const note =
          `[The user sent ${saved.length === 1 ? "a file" : `${saved.length} files`}, saved to ` +
          `your workspace. Open ${saved.length === 1 ? "it" : "them"} with read_file:\n${list}]`;
        return [note, caption].filter(Boolean).join("\n\n");
      }
    } catch (e) {
      this.log(`attachment handling failed for ${row.event_id}: ${String(e)}`);
    }
    // Download or upload failed: tell the agent so it can respond naturally.
    return ["[The user attached a file, but it could not be retrieved.]", caption]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Deliver queued replies in order. At-least-once; backs off on retryable failures. */
  async flushOutbox(): Promise<void> {
    let row = this.store.nextQueuedOutbox();
    while (row) {
      // Strict order: if the head is still backing off, wait - never skip to a later chunk.
      if (row.next_attempt_at > Date.now()) break;
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
