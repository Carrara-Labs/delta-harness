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

/** Bytes fetched for an attachment, ready to hand to the daemon file seam. */
export type DownloadedFile = { bytes: Uint8Array; name: string; mime: string };

/** Per-channel, pure transport. Small on purpose. */
export interface ChannelCodec {
  name: string;
  send(chatId: string, text: string): Promise<OutboundResult>;
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
}

/** Runs one turn against the Delta engine seam. */
export interface AgentClient {
  run(
    input: string,
    opts: { previousResponseId?: string; userId: string },
  ): Promise<{ responseId: string; outputText: string }>;
  /** Upload files to the daemon workspace (POST /v1/files). Returns their saved paths. */
  uploadFiles?(files: DownloadedFile[]): Promise<Array<{ path: string; mime: string }>>;
}
