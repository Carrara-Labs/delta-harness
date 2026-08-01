// The neutral contract. Every channel codec produces an Inbound; the durable
// core and the agent only ever see these typed fields. Platform specifics
// (the raw update) stay at the edge in `raw` and never reach the agent.

/** A file the user sent, referenced by its channel-native id. The bytes are
 *  fetched (codec.download) and handed to the daemon file seam at dispatch,
 *  never buffered in the durable inbox - only this small ref is. */
export type AttachmentRef = {
  fileId: string;
  name: string;
  mime?: string;
};

export type Inbound = {
  /** Platform-unique id for this event. Powers dedup. e.g. "tg:8021" */
  eventId: string;
  /** One chat/thread maps to one agent session. e.g. "tg:12345" */
  conversationId: string;
  /** Who sent it. Becomes the engine's user_id (session ownership). e.g. "tg:678" */
  actorId: string;
  /** Where a reply is delivered. Channel-native. */
  chatId: string;
  /** The message text handed to the agent (the caption, for a file-only message). */
  text: string;
  /** Files the user attached, if any. Fetched + uploaded to the daemon at dispatch. */
  attachments?: AttachmentRef[];
  /** Raw platform payload, kept at the edge for debugging only. Never sent to the agent. */
  raw?: unknown;
};

export type OutboundResult = {
  ok: boolean;
  retryable: boolean;
  error?: string;
  /** Platform-requested backoff before the next attempt (Telegram 429 retry_after). */
  retryAfterMs?: number;
};

/** A bounded operation result. Supervisory and inspect failures stay values. */
export type OperationResult = { ok: boolean; error?: string; note?: string };

/** Bytes fetched for an attachment, ready to hand to the daemon file seam. */
export type DownloadedFile = { bytes: Uint8Array; name: string; mime: string };

/** Per-channel, pure transport. Small on purpose. */
export interface ChannelCodec {
  name: string;
  /** Channel-aware source chunking (Telegram balances fenced code blocks). */
  chunk?(text: string): string[];
  send(chatId: string, text: string): Promise<OutboundResult>;
  sendDocument?(chatId: string, relativePath: string): Promise<OutboundResult>;
  /** Send a message with a channel-native button that opens `url` INSIDE the client — the
   *  secure-intake door. Absent on a codec with no such affordance; intake then stays off. */
  sendIntakeButton?(
    chatId: string,
    text: string,
    label: string,
    url: string,
  ): Promise<OutboundResult>;
  typing?(chatId: string): Promise<void>;
  /** Fetch an attachment's bytes. Returns null on any failure (error-as-value). */
  download?(ref: AttachmentRef): Promise<DownloadedFile | null>;
}

/** Fills the durable inbox. Webhook or long-poll; durable insert before ack. */
export interface IngressDriver {
  start(): Promise<void>;
  stop(): void;
}

/** The substrate abstraction: same edge fronts Fly or a Mac Mini. */
export interface AgentSupervisor {
  /** Ensure the agent is reachable; returns its base URL. */
  ensureAwake(): Promise<string>;
  /** Suspend if idle. No-op for an always-on local daemon. */
  maybeSuspend(): Promise<void>;
  /** Restart into the ordinary or engine-provided safe-mode environment. */
  restart(safeMode: boolean): Promise<OperationResult>;
  /** Reap an owned child; a no-op for externally managed daemons. */
  shutdown(): Promise<OperationResult>;
}

/** Runs one turn against the Delta engine seam. */
export interface AgentClient {
  run(
    input: string,
    opts: { previousResponseId?: string; userId: string },
  ): Promise<{ responseId: string; outputText: string }>;
  /** Upload files to the daemon workspace (POST /v1/files). Returns their saved paths. */
  uploadFiles?(files: DownloadedFile[]): Promise<Array<{ path: string; mime: string }>>;
  /** Read the agent's secret-free status (GET /v1/status): version, profile, model, budget. */
  status?(): Promise<Record<string, unknown> | null>;
  /** Start an async turn on the daemon's /v1/tasks surface (0.3.2); returns the run id at once. */
  startTask?(
    input: string,
    opts: { previousResponseId?: string; userId: string; idempotencyKey: string },
  ): Promise<{ id: string } | { error: string }>;
  /** Poll a task's authoritative status; null on a transient failure (keep the task active).
   *  userId asserts the owning principal so the ownership-gated status read matches. */
  pollTask?(
    id: string,
    userId: string,
  ): Promise<{ status: string; responseId?: string; outputText?: string; error?: string } | null>;
  /** Cancel a running task (best-effort). userId asserts the owning principal. */
  cancelTask?(id: string, userId: string): Promise<void>;
  /** Write a credential to the harness vault (PUT /v1/secrets/:name, 0.2.10). Loopback-only,
   *  create-only on the harness side: a 409 means the name already exists and is terminal. */
  storeSecret?(
    name: string,
    value: string,
    purpose: string,
  ): Promise<{ ok: boolean; status: number; error?: string }>;
  /** Whether the vault is usable and which credential names the config wires a destination
   *  for — an intake offer is refused unless the vault is on and the name is declared. */
  vaultState?(): Promise<{ enabled: boolean; declared: string[]; safeMode: boolean }>;
  /** Revert the self-file through the separately inspect-authenticated endpoint. */
  revertSelf?(id: number): Promise<OperationResult>;
  /** Self-file revision history (GET /v1/dev/self/revisions, inspect-gated) for the /revert
   *  picker: the live file plus prior snapshots, newest first. Null on any failure. */
  revisions?(): Promise<{
    current: string;
    revisions: { id: number; ts: number; content: string }[];
  } | null>;
}
