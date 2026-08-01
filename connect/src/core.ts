import { operatorCommand } from "./commands";
import type { InboxRow, Store, TaskRow } from "./store";
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
  "I'm your Delta agent. Just talk to me normally - ask a question, hand me a task, or think out loud. A few built-in commands:",
  "",
  "/new - start a fresh thread (clears our previous context)",
  "/cancel - stop what I'm currently working on",
  "/model - which model and effort I'm running",
  "/provider - which provider I'm on and my failover chain",
  "/status - my version, profile, provider, model, budget, and MCP servers",
  "/restart - restart the daemon (operator only)",
  "/safemode - restart neutral, without persona, policy, or learned memory (operator only)",
  "/revert - list and restore a note I wrote to my own memory (operator only)",
  "/secret NAME - hand me a credential securely, without typing it in chat (operator only)",
  "/secrets - the credentials I hold, by name (operator only)",
  "/help - this message",
  "/id - your Telegram id",
].join("\n");

/** Compact a raw token ceiling into a human figure: 3000000 → "3M", 120000 → "120k". */
function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(n % 1_000 ? 1 : 0)}k`;
  return String(n);
}

/** The `model` sub-object of /v1/status, read defensively (0.2.8 adds provider/provider_chain). */
function modelView(st: Record<string, unknown>): {
  model: string | null;
  effort: string | null;
  provider: string | null;
  chain: string[];
} {
  const m =
    typeof st.model === "object" && st.model !== null && !Array.isArray(st.model)
      ? (st.model as Record<string, unknown>)
      : {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    model: str(m.model),
    effort: str(m.reasoning_effort),
    provider: str(m.provider),
    chain: Array.isArray(m.provider_chain)
      ? m.provider_chain.filter((v): v is string => typeof v === "string" && Boolean(v))
      : [],
  };
}

/** Which provider I'm on and my failover chain (the /provider command, 0.2.8). */
function formatProvider(st: Record<string, unknown>): string {
  const { provider, chain } = modelView(st);
  if (!provider) return "I couldn't read my provider just now - try again in a moment.";
  const lines = [`Provider: ${provider}`];
  if (chain.length > 1) lines.push(`Failover: ${chain.join(" → ")}`);
  else lines.push("Failover: none configured");
  return lines.join("\n");
}

/** Format the daemon's secret-free /v1/status into a short, plain-English chat reply. */
function formatStatus(st: Record<string, unknown>, modelOnly: boolean): string {
  const { model, effort, provider, chain } = modelView(st);
  // Effort always resolves (0.2.8): "default" means the provider's own, never blank.
  const effortLabel = effort ?? "default";
  if (modelOnly) {
    const lines: string[] = [];
    if (provider) lines.push(`Provider: ${provider}`);
    lines.push(`Model: ${model ?? "unknown"}`);
    lines.push(`Effort: ${effortLabel}`);
    if (chain.length > 1) lines.push(`Failover: ${chain.join(" → ")}`);
    return lines.join("\n");
  }
  const lines: string[] = [];
  if (typeof st.version === "string" || typeof st.version === "number")
    lines.push(`Version: ${st.version}`);
  if (typeof st.profile === "string" && st.profile) lines.push(`Profile: ${st.profile}`);
  // Safe mode is observable from chat (0.2.8) - no need to read the boot log.
  if (st.safe_mode === true)
    lines.push("Safe mode: ON — persona, policy and learned memory are not loaded this run");
  // Provider ABOVE the model, both in human terms.
  if (provider)
    lines.push(
      `Provider: ${provider}${chain.length > 1 ? ` (failover: ${chain.join(" → ")})` : ""}`,
    );
  if (model) lines.push(`Model: ${model} · effort ${effortLabel}`);
  const budget =
    typeof st.budget === "object" && st.budget !== null && !Array.isArray(st.budget)
      ? (st.budget as Record<string, unknown>)
      : null;
  if (budget) {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const steps = num(budget.maxSteps);
    const tokens = num(budget.maxTokens);
    const cost = num(budget.maxCostUsd);
    const parts: string[] = [];
    if (steps !== null) parts.push(`${steps} steps`);
    if (tokens !== null) parts.push(`${humanTokens(tokens)} tokens`);
    if (cost !== null) parts.push(`$${cost} max`);
    if (parts.length) lines.push(`Budget per task: ${parts.join(" · ")}`);
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
// The intake button rides the outbox as its own chunk, exactly like a document send, so it is
// delivered in order, at-least-once, and survives a restart. The payload is a session id.
const INTAKE_SENTINEL = "\0delta-intake:";
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

/**
 * Pull a secret request out of an agent reply: `[[secret-request: NAME | why it is needed]]`,
 * the same terminal-marker family as `[[send: path]]`.
 *
 * The NAME is charset-validated here and the purpose is discarded for display — only the
 * operator's configured destination is ever shown on the form. A model can therefore ask for
 * a credential, but it cannot author a single character of the page a human types it into.
 * At most ONE request per reply: a flood of buttons is a social-engineering surface, and one
 * credential at a time is the honest flow anyway.
 */
export function extractSecretRequest(text: string): {
  text: string;
  name?: string;
  purpose?: string;
} {
  const match = text.match(
    /(?:^|\n)\[\[secret-request:\s*([A-Z][A-Z0-9_]{0,63})\s*(?:\|\s*([^\r\n\]]{0,200}))?\]\]\s*$/,
  );
  if (!match) return { text };
  return {
    text: text.slice(0, match.index).trimEnd(),
    name: match[1] as string,
    purpose: (match[2] ?? "").trim(),
  };
}

export function extractDocumentMarker(text: string): { text: string; path?: string } {
  const match = text.match(/(?:^|\n)\[\[send: ([^\r\n]{1,1024})\]\]$/);
  if (!match) return { text };
  return { text: text.slice(0, match.index).trimEnd(), path: match[1] as string };
}

/** A relative "2h ago" from a Date.now()-ms timestamp. */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The change a revision captures. Each self_revisions row is the PRIOR self-file (snapshotted
 *  after a `remember` write), so its change = diff(row → the state that replaced it): the newest
 *  row against the live file, an older row against the next-newer row. A set-based line diff is
 *  leaner than positional LCS and honest for the append-style notes a self-file accumulates. */
function lineDelta(
  row: string,
  nextNewer: string,
): { added: number; removed: number; preview: string } {
  // Multiset (not set) counts, so adding or dropping a DUPLICATE line still registers
  // (codex P1: a plain set reports "no change" for "note" → "note\nnote").
  const counts = (text: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of text.split("\n")) if (l.trim()) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const rowC = counts(row);
  const newC = counts(nextNewer);
  let added = 0;
  let firstAdded = "";
  for (const [line, n] of newC) {
    const delta = n - (rowC.get(line) ?? 0);
    if (delta > 0) {
      added += delta;
      if (!firstAdded) firstAdded = line.trim(); // first newly-added line, in appearance order
    }
  }
  let removed = 0;
  for (const [line, n] of rowC) removed += Math.max(0, n - (newC.get(line) ?? 0));
  const preview = firstAdded
    ? firstAdded.slice(0, 60)
    : removed
      ? "(removed notes)"
      : "(no textual change)";
  return { added, removed, preview };
}

/** Render the self-file revision history as a tappable picker (bare /revert, 0.3.1). */
function formatRevisions(
  data: { current: string; revisions: { id: number; ts: number; content: string }[] },
  now: number,
): string {
  const revs = data.revisions;
  if (!revs.length) return "No revisions yet - I haven't rewritten my own memory.";
  const rows = revs.slice(0, 12).map((r, i) => {
    const nextNewer = i === 0 ? data.current : (revs[i - 1] as { content: string }).content;
    const { added, removed, preview } = lineDelta(r.content, nextNewer);
    return `/revert_${r.id} · ${ago(r.ts, now)} · +${added}/-${removed} · "${preview}"`;
  });
  return [
    "Revisions of my self-written memory, newest first. Tap one to restore it:",
    "",
    ...rows,
  ].join("\n");
}

export class Connector {
  private running = false;
  /** Poll cadence while any async task is in-flight (the daemon does the work; we just check). */
  private readonly taskPollMs = 2500;
  /** A start whose 202 was lost records a PLACEHOLDER task under this id prefix + the event id. It
   *  makes the conversation durably busy (so nothing hot-loops or jumps its head), and pollTasks
   *  re-POSTs to resolve it to the real daemon run — which, thanks to the harness's terminal-aware
   *  idempotency, re-attaches to the accepted run instead of starting a second one (codex P1). */
  private readonly PLACEHOLDER = "pending:";
  /** Give up on an unresolved placeholder after this long — the daemon is unreachable, so surface a
   *  clean failure rather than wedging the conversation forever. */
  private readonly PLACEHOLDER_DEADLINE_MS = 60_000;

  constructor(
    private readonly store: Store,
    private readonly codec: ChannelCodec,
    private readonly agent: AgentClient,
    private readonly sup: AgentSupervisor,
    private readonly log: (m: string) => void = () => {},
    private readonly allowed: ReadonlySet<string> = new Set(),
    /** Secure secret intake (0.4.0). Absent → the feature is entirely off: markers are stripped
     *  and no button is ever offered. */
    private readonly intake?: {
      mint: (req: {
        name: string;
        purpose: string;
        chatId: string;
        conversationId: string;
        telegramUserId: string;
      }) => Promise<{ sessionId: string; destination: string } | { error: string }>;
      url: (sessionId: string) => string;
    },
  ) {}

  /** Turn a `[[secret-request: NAME | why]]` marker into a durable outbox chunk carrying an
   *  intake session. Returns the chunk, or a plain-text line explaining why no button appeared —
   *  a silent drop would leave the agent waiting for a credential that can never arrive. */
  private async intakeChunk(
    name: string,
    purpose: string,
    chatId: string,
    conversationId: string,
    actorId: string,
  ): Promise<string> {
    if (!this.intake) return "";
    const minted = await this.intake.mint({
      name,
      purpose,
      chatId,
      conversationId,
      telegramUserId: actorId.startsWith("tg:") ? actorId.slice(3) : actorId,
    });
    if ("error" in minted) {
      this.log(`intake offer refused for ${name}: ${minted.error}`);
      return `I can't request ${name} right now (${minted.error}).`;
    }
    return `${INTAKE_SENTINEL}${minted.sessionId}\u0000${name}`;
  }

  /** Resolve the conversation a schedule_self call binds to. The harness (≥0.2.8.1) asserts the run's
   *  owner as `userId` (x-delta-user), so we bind to THAT user's active task — correct even with
   *  several conversations running at once (codex P0). Without an asserted identity (an older daemon)
   *  we fall back to the sole-active-task binding: exact when one turn is in flight, null when 0 or ≥2
   *  (a placeholder start counts as active, so an outstanding start makes it null too), so the control
   *  server 409s an ambiguous schedule rather than misrouting it. */
  resolveScheduleOrigin(userId: string | null): Readonly<ActiveOrigin> | null {
    const t = userId ? this.store.activeTaskByUser(userId) : this.store.soleActiveOrigin();
    return t ? { conversationId: t.conversation_id, actorId: t.actor_id, chatId: t.chat_id } : null;
  }

  /** Back-compat accessor (no asserted identity) — the sole-active-task binding. */
  get activeOrigin(): Readonly<ActiveOrigin> | null {
    return this.resolveScheduleOrigin(null);
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

  /** The next message to process: the oldest pending command (which flows even while its conversation
   *  has a turn in flight) or agent turn for a free conversation. One indexed, unbounded, oldest-first
   *  query keyed on the ingest-time `intercept` classification — preserves arrival order, never buries
   *  a command, never starves one conversation behind another (codex P1). */
  private nextDispatchable(): InboxRow | null {
    return this.store.nextDispatchable();
  }

  /** Process at most one inbox event. Returns false when nothing is dispatchable. */
  async runOnce(): Promise<boolean> {
    const row = this.nextDispatchable();
    if (!row) {
      await this.flushOutbox();
      return false;
    }
    const text = row.text.trim();

    // Stop a running turn on this conversation (0.3.2). A local command, so it flows even while the
    // turn is in-flight; the daemon task flips to cancelled and pollTasks finalizes it as "Stopped."
    if (text === "/cancel") {
      const task = this.store.activeTaskForConversation(row.conversation_id);
      if (task) {
        // Record durable cancel intent FIRST, then attempt the DELETE. A dropped/500 DELETE is no
        // longer swallowed into a false "stopped" (codex P1): pollTasks re-issues it every tick
        // until the run is actually terminal, so the ack is always eventually true.
        this.store.requestCancel(task.task_id);
        await this.agent.cancelTask?.(task.task_id, task.user_id);
        await this.localReply(row, "Stopping that now.");
      } else {
        await this.localReply(row, "Nothing running to stop.");
      }
      return true;
    }

    // Async command intercepts: a single status read, still no agent turn spent.
    if (text === "/model" || text === "/status" || text === "/provider") {
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
        ? text === "/provider"
          ? formatProvider(st)
          : formatStatus(st, text === "/model")
        : "I couldn't read my status just now - try again in a moment.";
      await this.localReply(row, reply);
      return true;
    }

    // Secure credential commands (0.4.0). Operator-only: the vault is agent-wide, so a second
    // allowlisted user must not be able to provision or enumerate another's credentials.
    if (text === "/secrets" || text === "/secret" || text.startsWith("/secret ")) {
      if (!operatorAuthorized(row.event_id, row.actor_id, this.allowed)) {
        await this.localReply(row, OPERATOR_DENIED);
        return true;
      }
      if (!this.intake) {
        await this.localReply(row, "Secure intake isn't configured on this agent.");
        return true;
      }
      if (text === "/secrets") {
        const held = (await this.agent.listSecrets?.()) ?? null;
        if (!held) {
          await this.localReply(row, "I couldn't read the vault just now - try again in a moment.");
          return true;
        }
        const state = await this.agent.vaultState?.();
        const lines = held.length
          ? held.map(
              (s: { name: string; purpose: string }) =>
                `• ${s.name}${s.purpose ? ` - ${s.purpose}` : ""}`,
            )
          : ["(none yet)"];
        const canAsk =
          state?.declared.filter((n) => !held.some((h: { name: string }) => h.name === n)) ?? [];
        await this.localReply(
          row,
          [
            "Credentials I hold (names only - I can never read a value):",
            ...lines,
            ...(canAsk.length
              ? ["", `I can also use: ${canAsk.join(", ")}. Send /secret NAME to provide one.`]
              : []),
          ].join("\n"),
        );
        return true;
      }
      // /secret NAME [purpose…]
      const parts = text.split(/\s+/).slice(1);
      const name = parts[0] ?? "";
      if (!name) {
        await this.localReply(row, "Usage: /secret NAME - e.g. /secret EXA_API_KEY");
        return true;
      }
      const minted = await this.intake.mint({
        name,
        purpose: parts.slice(1).join(" "),
        chatId: row.chat_id,
        conversationId: row.conversation_id,
        telegramUserId: row.actor_id.startsWith("tg:") ? row.actor_id.slice(3) : row.actor_id,
      });
      if ("error" in minted) {
        await this.localReply(row, `I can't take ${name}: ${minted.error}.`);
        return true;
      }
      // Deliver through the durable outbox like any other reply, so an at-least-once resend
      // reuses the SAME session rather than minting a second one.
      this.store.commitTurn({
        eventId: row.event_id,
        conversationId: row.conversation_id,
        chatId: row.chat_id,
        userId: row.actor_id,
        replyChunks: [`${INTAKE_SENTINEL}${minted.sessionId}\u0000${name}`],
      });
      await this.flushOutbox();
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
        // Bare /revert lists the revisions as tappable rows; /revert <id> (or the tappable
        // /revert_<id>) restores one. Listing is a read, gated the same as the revert itself.
        if (operator.args.length === 0) {
          try {
            await this.sup.ensureAwake();
          } catch {
            // The revisions read below returns the useful bounded error.
          }
          let data: {
            current: string;
            revisions: { id: number; ts: number; content: string }[];
          } | null = null;
          try {
            data = this.agent.revisions ? await this.agent.revisions() : null;
          } catch {
            // A revision read never fails a turn.
          }
          await this.localReply(
            row,
            data
              ? formatRevisions(data, Date.now())
              : "I couldn't read my revision history just now - try again in a moment.",
          );
          return true;
        }
        const raw = operator.args.length === 1 ? operator.args[0] : undefined;
        const id = raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : 0;
        if (!Number.isSafeInteger(id) || id < 1) {
          await this.localReply(row, "Usage: /revert (lists revisions) or /revert <id>");
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
    if (isNew) {
      // A turn already running belongs to the OLD thread: let it finish and deliver, but stop it
      // from writing its response id back as the fresh thread's head (codex P1). And drop messages
      // that arrived before this reset but haven't started — "fresh start" forgets them rather than
      // running them in the new thread (codex P1 ordering).
      this.store.detachActiveTaskHead(row.conversation_id);
      this.store.dropPendingTurnsBefore(row.conversation_id, row.event_id);
    }
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

    // Dispatch the agent turn. Delta's async surface (startTask/pollTask) runs it durably on the
    // daemon's /v1/tasks queue and we track it to completion in pollTasks(), so the dispatch loop
    // is never blocked and a long turn can neither time out nor freeze the bot (0.3.2). A
    // third-party AgentClient without the async surface takes the synchronous fallback.
    if (this.agent.startTask && this.agent.pollTask) return await this.startAgentTask(row, text);
    return await this.runSyncTurn(row, text);
  }

  /** Start an async agent turn: a durable task on the daemon, tracked to completion in pollTasks. */
  private async startAgentTask(row: InboxRow, text: string): Promise<boolean> {
    const fail = async (note: string) => {
      this.store.commitTurn({
        eventId: row.event_id,
        conversationId: row.conversation_id,
        chatId: row.chat_id,
        userId: row.actor_id,
        replyChunks: this.chunks(note),
      });
      await this.flushOutbox();
    };
    try {
      await this.sup.ensureAwake();
      const session = this.store.getSession(row.conversation_id);
      const input = await this.prepareInput(row, text);
      const started = await this.agent.startTask?.(input, {
        previousResponseId: session?.prev_response_id ?? undefined,
        userId: row.actor_id,
        idempotencyKey: row.event_id,
      });
      const taskId =
        started && !("error" in started) ? started.id : `${this.PLACEHOLDER}${row.event_id}`;
      if (!started || "error" in started) {
        // A failed start might be a dropped 202 for a turn the daemon DID durably accept, so DON'T
        // finalize the event (that would orphan a billing run and lose its result — codex P1).
        // Instead record a PLACEHOLDER task: the conversation is now durably busy (no hot-loop, no
        // head-jump), and pollTasks re-POSTs to resolve the real run id — which, via the harness's
        // terminal-aware idempotency, re-attaches to the accepted run rather than starting a second.
        // Any /cancel or /new meanwhile marks the placeholder and carries over on resolution.
        this.log(`task start failed for ${row.event_id}: ${started ? started.error : "no client"}`);
      }
      const claimed = this.store.startTask({
        taskId,
        eventId: row.event_id,
        conversationId: row.conversation_id,
        chatId: row.chat_id,
        actorId: row.actor_id,
        userId: row.actor_id,
      });
      if (!claimed) {
        // The conversation already has an active task (the partial unique index). Under the serial
        // dispatch this only happens if a prior placeholder for this event is still resolving; cancel
        // the just-started daemon run (if any) so it can't duplicate, and drop this dispatch.
        this.log(`task not claimed (conversation busy) for ${row.event_id}`);
        if (started && !("error" in started))
          await this.agent.cancelTask?.(started.id, row.actor_id);
        return true;
      }
      await this.codec.typing?.(row.chat_id); // first activity ping; pollTasks keeps it warm
    } catch (e) {
      this.log(`task dispatch error for ${row.event_id}: ${String(e)}`);
      await fail("Something went wrong on my end. Try again in a moment.");
    }
    return true;
  }

  /** Re-POST a placeholder start (a start whose 202 was lost) to learn its real daemon run id. The
   *  same idempotency_key makes the harness re-attach to the accepted run rather than start a second
   *  (terminal-aware idempotency). On success the placeholder re-keys to the real id — carrying any
   *  /cancel or /new intent it collected — and normal polling takes over. If the daemon stays
   *  unreachable past the deadline, finalize with a clean failure so the conversation isn't wedged. */
  private async resolvePlaceholder(task: TaskRow): Promise<boolean> {
    const inbox = this.store.getInboxByEvent(task.event_id);
    if (inbox) {
      try {
        await this.sup.ensureAwake();
        const session = this.store.getSession(task.conversation_id);
        const input = await this.prepareInput(inbox, inbox.text.trim());
        const started = await this.agent.startTask?.(input, {
          previousResponseId: session?.prev_response_id ?? undefined,
          userId: task.user_id,
          idempotencyKey: task.event_id,
        });
        if (started && !("error" in started)) {
          this.store.resolvePlaceholderTask(task.task_id, started.id);
          return true; // resolved to the real run — progress
        }
      } catch (e) {
        this.log(`placeholder resolve error for ${task.event_id}: ${String(e)}`);
      }
    }
    if (Date.now() - task.created_at > this.PLACEHOLDER_DEADLINE_MS) {
      this.log(`giving up on unresolved start ${task.event_id} after deadline`);
      this.store.finishTask({
        taskId: task.task_id,
        eventId: task.event_id,
        conversationId: task.conversation_id,
        chatId: task.chat_id,
        userId: task.actor_id,
        replyChunks: this.chunks("I couldn't start that just now - try again in a moment."),
      });
      await this.flushOutbox();
      return true; // finalized — progress
    }
    return false; // still unresolved: NOT progress, so the loop sleeps a tick before retrying
  }

  /** Poll every in-flight task to its authoritative terminal state (GET /v1/tasks/:id) and
   *  finalize. The poll is the source of truth (the SSE is best-effort UX), so a restart, suspend,
   *  or dropped stream reconciles cleanly. Returns true if any task reached a terminal state. */
  async pollTasks(): Promise<boolean> {
    let active = this.store.activeTasks();
    if (!active.length) return false;
    // First resolve any PLACEHOLDER starts (a start whose 202 was lost) to their real daemon run:
    // re-POST with the same idempotency_key, which the harness re-attaches to the accepted run
    // (terminal-aware idempotency) instead of starting a second. On success the task re-keys to the
    // real id and is polled below; if still unresolved past the deadline, it's finalized as an error.
    const placeholders = active.filter((t) => t.task_id.startsWith(this.PLACEHOLDER));
    let placeholderProgress = false;
    if (placeholders.length) {
      // Resolve CONCURRENTLY so N placeholders don't stall the loop N × the POST timeout (codex P1).
      const outcomes = await Promise.all(placeholders.map((p) => this.resolvePlaceholder(p)));
      placeholderProgress = outcomes.some(Boolean); // a resolve or a deadline-finalize is progress
      active = this.store.activeTasks();
    }
    const real = active.filter((t) => !t.task_id.startsWith(this.PLACEHOLDER));
    // Return true only on REAL progress — merely retrying an unresolved placeholder is NOT progress,
    // so the loop sleeps a tick instead of tight-spinning re-POSTs at a down daemon (codex P1).
    if (!real.length) return placeholderProgress;
    // Poll every in-flight task CONCURRENTLY: N sequential 10s GETs during a network stall would
    // otherwise delay /cancel, /help, and typing pings by up to N × 10s (codex P1). A task carrying
    // durable cancel intent gets its DELETE re-issued first, so a dropped cancel keeps retrying
    // until the run is actually terminal (codex P1).
    const polled = await Promise.all(
      real.map(async (task) => {
        if (task.cancel_requested) await this.agent.cancelTask?.(task.task_id, task.user_id);
        const st = this.agent.pollTask
          ? await this.agent.pollTask(task.task_id, task.user_id)
          : null;
        return { task, st };
      }),
    );
    // Keep the typing indicator warm for every still-running task CONCURRENTLY: awaiting each
    // typing() in turn would re-introduce the N × timeout freeze the concurrent poll just removed
    // (a Telegram stall is ~5s per call — codex P1). Best-effort, so failures are swallowed.
    const stillRunning = polled.filter(
      (p) => p.st && (p.st.status === "queued" || p.st.status === "running"),
    );
    await Promise.allSettled(stillRunning.map((p) => this.codec.typing?.(p.task.chat_id)));
    let finalized = false;
    for (const { task, st } of polled) {
      if (!st) continue; // transient poll failure: keep the task active, retry next tick
      if (st.status === "queued" || st.status === "running") continue; // typing pinged above
      // Terminal: build the reply, finalize atomically (session + outbox + inbox + task), deliver.
      finalized = true;
      let replyChunks: string[];
      let responseId: string | undefined;
      if (st.status === "done") {
        responseId = st.responseId;
        const marked = extractDocumentMarker((st.outputText ?? "").trim());
        const asked = extractSecretRequest(marked.text);
        const reply =
          asked.text || (marked.path || asked.name ? "" : "(I finished, but produced no text.)");
        replyChunks = reply ? this.chunks(reply) : [];
        if (marked.path) replyChunks.push(`${DOCUMENT_SENTINEL}${marked.path}`);
        if (asked.name) {
          const chunk = await this.intakeChunk(
            asked.name,
            asked.purpose ?? "",
            task.chat_id,
            task.conversation_id,
            task.actor_id,
          );
          if (chunk) replyChunks.push(chunk);
        }
      } else if (st.status === "cancelled") {
        replyChunks = this.chunks("Stopped.");
      } else {
        replyChunks = this.chunks(
          `Something went wrong on my end and I could not finish that${st.error ? ` (${st.error})` : ""}. Try again in a moment.`,
        );
      }
      this.store.finishTask({
        taskId: task.task_id,
        eventId: task.event_id,
        conversationId: task.conversation_id,
        chatId: task.chat_id,
        userId: task.actor_id,
        responseId,
        replyChunks,
      });
    }
    if (finalized) {
      await this.flushOutbox();
      await this.sup.maybeSuspend();
    }
    return finalized || placeholderProgress;
  }

  /** Synchronous turn — the fallback for a third-party AgentClient without the async surface. */
  private async runSyncTurn(row: InboxRow, text: string): Promise<boolean> {
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
      const marked = extractDocumentMarker(out.outputText.trim());
      const asked = extractSecretRequest(marked.text);
      const reply =
        asked.text || (marked.path || asked.name ? "" : "(I finished, but produced no text.)");
      replyChunks = reply ? this.chunks(reply) : [];
      if (marked.path) replyChunks.push(`${DOCUMENT_SENTINEL}${marked.path}`);
      if (asked.name) {
        const chunk = await this.intakeChunk(
          asked.name,
          asked.purpose ?? "",
          row.chat_id,
          row.conversation_id,
          row.actor_id,
        );
        if (chunk) replyChunks.push(chunk);
      }
    } catch (e) {
      this.log(`turn failed for ${row.event_id}: ${String(e)}`);
      replyChunks = this.chunks(
        "Something went wrong on my end and I could not finish that. Try again in a moment.",
      );
    }
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
        if (row.text.startsWith(DOCUMENT_SENTINEL)) {
          r = this.codec.sendDocument
            ? await this.codec.sendDocument(row.chat_id, row.text.slice(DOCUMENT_SENTINEL.length))
            : { ok: false, retryable: false, error: "document send unsupported" };
        } else if (row.text.startsWith(INTAKE_SENTINEL)) {
          // A resend reuses the SAME session id, so an at-least-once delivery can never mint a
          // second session or invalidate the link the user already has open.
          const [sessionId = "", name = "a credential"] = row.text
            .slice(INTAKE_SENTINEL.length)
            .split("\u0000");
          r = this.codec.sendIntakeButton
            ? await this.codec.sendIntakeButton(
                row.chat_id,
                `Tap below to provide ${name} securely. It opens inside Telegram, is sent straight to me over an encrypted connection, and is never stored as a chat message.`,
                `Provide ${name}`,
                this.intake ? this.intake.url(sessionId) : "",
              )
            : { ok: false, retryable: false, error: "intake button unsupported" };
        } else {
          r = await this.codec.send(row.chat_id, row.text);
        }
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
      const polled = await this.pollTasks(); // finalize terminal tasks + keep typing alive
      const did = await this.runOnce(); // dispatch new work / answer intercepts
      await this.flushOutbox();
      if (polled || did) continue; // made progress this tick — keep going
      // Idle: while tasks are still in-flight, tick on the task-poll cadence; else the normal sleep.
      await Bun.sleep(this.store.activeTasks().length ? this.taskPollMs : intervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }
}
