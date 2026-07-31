import type { InboxRow, Store } from "./store";
import type {
  AgentClient,
  AgentSupervisor,
  AttachmentRef,
  ChannelCodec,
  OperationResult,
  OutboundResult,
} from "./types";

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
  "I'm your Delta agent. Just talk to me normally - ask a question, hand me a task,",
  "or think out loud. A few built-in commands:",
  "",
  "/new - start a fresh thread (clears our previous context)",
  "/model - which model and effort I'm running",
  "/status - my version, profile, model, budget, and MCP servers",
  "/restart - restart the daemon (operator only)",
  "/safemode - restart with optional features disabled (operator only)",
  "/revert <id> - restore a self-file revision (operator only)",
  "/help - this message",
  "/id - your Telegram id",
].join("\n");

/** Format the daemon's secret-free /v1/status into a short chat reply. */
function formatStatus(st: Record<string, unknown>, modelOnly: boolean): string {
  const m =
    typeof st.model === "object" && st.model !== null && !Array.isArray(st.model)
      ? (st.model as Record<string, unknown>)
      : {};
  const model = typeof m.model === "string" && m.model ? m.model : null;
  const effort =
    typeof m.reasoning_effort === "string" && m.reasoning_effort ? m.reasoning_effort : null;
  const cascade = Array.isArray(m.models)
    ? m.models.filter((value): value is string => typeof value === "string" && Boolean(value))
    : [];
  if (modelOnly) {
    const lines = [`Model: ${model ?? "unknown"}`];
    if (effort) lines.push(`Effort: ${effort}`);
    if (cascade.length > 1) lines.push(`Failover: ${cascade.join(" → ")}`);
    return lines.join("\n");
  }
  const lines: string[] = [];
  if (typeof st.version === "string" || typeof st.version === "number")
    lines.push(`Version: ${st.version}`);
  if (typeof st.profile === "string" && st.profile) lines.push(`Profile: ${st.profile}`);
  if (model) lines.push(`Model: ${model}${effort ? ` (effort ${effort})` : ""}`);
  const budget =
    typeof st.budget === "object" && st.budget !== null && !Array.isArray(st.budget)
      ? (st.budget as Record<string, unknown>)
      : null;
  if (budget) {
    const fields = [
      ["steps", budget.maxSteps],
      ["tokens", budget.maxTokens],
      ["cost USD", budget.maxCostUsd],
    ]
      .filter(
        (entry) =>
          typeof entry[1] === "string" ||
          (typeof entry[1] === "number" && Number.isFinite(entry[1])),
      )
      .map(([label, value]) => `${label}: ${String(value)}`);
    if (fields.length) lines.push(`Budget/run: ${fields.join(" · ")}`);
  }
  if (Array.isArray(st.mcp_servers)) {
    const servers = st.mcp_servers.flatMap((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const server = value as Record<string, unknown>;
      const name = typeof server.name === "string" ? server.name : "";
      const transport = typeof server.transport === "string" ? server.transport : "";
      return name || transport
        ? [`${name}${name && transport ? " (" : ""}${transport}${name && transport ? ")" : ""}`]
        : [];
    });
    lines.push(`MCP servers: ${servers.length ? servers.join(", ") : "none"}`);
  }
  return lines.length ? lines.join("\n") : "Status is unavailable.";
}

const NEW_THREAD =
  "Fresh thread started. I've cleared our previous context - your next message begins a new conversation.";

const DOCUMENT_SENTINEL = "\0delta-document:";
const OPERATOR_DENIED = "That operator command is not authorized.";

export type ActiveOrigin = {
  conversationId: string;
  actorId: string;
  chatId: string;
};

export function operatorAuthorized(
  eventId: string,
  actorId: string,
  allowed: ReadonlySet<string>,
): boolean {
  return (
    allowed.size > 0 &&
    eventId.startsWith("tg:") &&
    actorId.startsWith("tg:") &&
    allowed.has(actorId.slice(3))
  );
}

export function extractDocumentMarker(text: string): { text: string; path?: string } {
  const match = text.match(/(?:^|\n)\[\[send: ([^\r\n]{1,1024})\]\]$/);
  if (!match) return { text };
  return { text: text.slice(0, match.index).trimEnd(), path: match[1] as string };
}

function operatorCommand(text: string): { name: string; args: string[] } | null {
  const parts = text.split(/\s+/);
  const name = parts[0] ?? "";
  return name === "/restart" || name === "/safemode" || name === "/revert"
    ? { name, args: parts.slice(1) }
    : null;
}

export class Connector {
  private running = false;
  private origin: ActiveOrigin | null = null;

  constructor(
    private readonly store: Store,
    private readonly codec: ChannelCodec,
    private readonly agent: AgentClient,
    private readonly sup: AgentSupervisor,
    private readonly log: (m: string) => void = () => {},
    private readonly allowed: ReadonlySet<string> = new Set(),
  ) {}

  get activeOrigin(): Readonly<ActiveOrigin> | null {
    return this.origin;
  }

  private chunks(text: string): string[] {
    return this.codec.chunk?.(text) ?? chunkText(text);
  }

  private async localReply(row: InboxRow, text: string, resetSession = false): Promise<void> {
    this.store.commitTurn({
      eventId: row.event_id,
      conversationId: row.conversation_id,
      chatId: row.chat_id,
      userId: row.actor_id,
      resetSession,
      replyChunks: this.chunks(text),
    });
    await this.flushOutbox();
  }

  /** Process at most one inbox event. Returns false when the inbox is empty. */
  async runOnce(): Promise<boolean> {
    const row = this.store.nextPending();
    if (!row) {
      await this.flushOutbox();
      return false;
    }
    const text = row.text.trim();

    // Async command intercepts: a single status read, still no agent turn spent.
    if (text === "/model" || text === "/status") {
      try {
        await this.sup.ensureAwake();
      } catch {
        // Status remains an error value below.
      }
      let st: Record<string, unknown> | null = null;
      try {
        st = this.agent.status ? await this.agent.status() : null;
      } catch {
        // Third-party AgentClient implementations still degrade like DeltaAgent.
      }
      const reply = st
        ? formatStatus(st, text === "/model")
        : "I couldn't read my status just now - try again in a moment.";
      await this.localReply(row, reply);
      return true;
    }

    const operator = operatorCommand(text);
    if (operator) {
      if (!operatorAuthorized(row.event_id, row.actor_id, this.allowed)) {
        await this.localReply(row, OPERATOR_DENIED);
        return true;
      }
      if ((operator.name === "/restart" || operator.name === "/safemode") && operator.args.length) {
        await this.localReply(row, `Usage: ${operator.name}`);
        return true;
      }
      if (operator.name === "/revert") {
        const raw = operator.args.length === 1 ? operator.args[0] : undefined;
        const id = raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : 0;
        if (!Number.isSafeInteger(id) || id < 1) {
          await this.localReply(row, "Usage: /revert <positive revision id>");
          return true;
        }
        try {
          await this.sup.ensureAwake();
        } catch {
          // The inspect request below returns the useful bounded error.
        }
        let result: OperationResult;
        try {
          result = this.agent.revertSelf
            ? await this.agent.revertSelf(id)
            : { ok: false, error: "revert is unavailable" };
        } catch (error) {
          result = { ok: false, error: String(error) };
        }
        await this.localReply(
          row,
          result.ok
            ? (result.note ?? "Reverted; the change takes effect on the next run.")
            : `Revert failed: ${result.error ?? "unknown error"}`,
        );
        return true;
      }
      let result: OperationResult;
      try {
        result = await this.sup.restart(operator.name === "/safemode");
      } catch (error) {
        result = { ok: false, error: String(error) };
      }
      await this.localReply(
        row,
        result.ok
          ? (result.note ??
              (operator.name === "/safemode"
                ? "Daemon started in safe mode."
                : "Daemon restarted."))
          : `Restart failed: ${result.error ?? "unknown error"}`,
      );
      return true;
    }

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
      await this.localReply(row, canned, isNew);
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
      this.origin = {
        conversationId: row.conversation_id,
        actorId: row.actor_id,
        chatId: row.chat_id,
      };
      let out: Awaited<ReturnType<AgentClient["run"]>>;
      try {
        out = await this.agent.run(input, {
          previousResponseId: session?.prev_response_id ?? undefined,
          userId: row.actor_id,
        });
      } finally {
        this.origin = null;
      }
      responseId = out.responseId;
      const marked = extractDocumentMarker(out.outputText.trim());
      const reply = marked.text || (marked.path ? "" : "(I finished, but produced no text.)");
      replyChunks = reply ? this.chunks(reply) : [];
      if (marked.path) replyChunks.push(`${DOCUMENT_SENTINEL}${marked.path}`);
    } catch (e) {
      this.origin = null;
      this.log(`turn failed for ${row.event_id}: ${String(e)}`);
      replyChunks = this.chunks(
        "Something went wrong on my end and I could not finish that. Try again in a moment.",
      );
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
      let r: OutboundResult;
      try {
        r = row.text.startsWith(DOCUMENT_SENTINEL)
          ? this.codec.sendDocument
            ? await this.codec.sendDocument(row.chat_id, row.text.slice(DOCUMENT_SENTINEL.length))
            : { ok: false, retryable: false, error: "document send unsupported" }
          : await this.codec.send(row.chat_id, row.text);
      } catch (error) {
        r = { ok: false, retryable: true, error: String(error) };
      }
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
