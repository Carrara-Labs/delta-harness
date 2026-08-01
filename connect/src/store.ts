import { Database } from "bun:sqlite";

import { isIntercept } from "./commands";
import type { Inbound } from "./types";

// The durable spine. Three tables carry the correctness boundaries:
//   inbox   - dedup by eventId, so a platform retry is a no-op
//   sessions - conversationId -> previous_response_id, so a chat threads
//   outbox  - ordered, grouped delivery with retry backoff and dead-lettering
// SQLite WAL. The per-turn writes (advance session, enqueue reply, complete
// inbox) commit in ONE transaction (commitTurn) so a crash never leaves a
// partial turn. Delivery is at-least-once: a crash between a successful
// platform send and markOutboxSent re-sends on restart (Telegram has no send
// idempotency key), so a rare duplicate is possible and acceptable for chat.

export type InboxRow = {
  event_id: string;
  conversation_id: string;
  actor_id: string;
  chat_id: string;
  text: string;
  /** JSON-encoded AttachmentRef[], or null. Fetched + uploaded at dispatch. */
  attachments: string | null;
  status: string;
  received_at: number;
};

export type OutboxRow = {
  dedup_key: string;
  group_key: string;
  conversation_id: string;
  chat_id: string;
  text: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
};

export type TaskRow = {
  task_id: string;
  event_id: string;
  conversation_id: string;
  chat_id: string;
  actor_id: string;
  user_id: string;
  status: string;
  stream_message_id: string | null;
  advance_head: number;
  cancel_requested: number;
  created_at: number;
};

export type ScheduleOrigin = {
  conversationId: string;
  actorId: string;
  chatId: string;
};

export type ScheduleSpec =
  | { kind: "once"; runAt: string }
  | { kind: "interval"; intervalMs: number };

export type ScheduleView = {
  id: string;
  state: string;
  specKind: string;
  nextRunAt: string | null;
  prompt: string;
};

type ScheduleRow = {
  id: string;
  conversation_id: string;
  actor_id: string;
  chat_id: string;
  prompt: string;
  spec_kind: string;
  interval_ms: number | null;
  state: string;
  next_run_at: number | null;
};

const MAX_SEND_ATTEMPTS = 5;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox (
        event_id        TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        actor_id        TEXT NOT NULL,
        chat_id         TEXT NOT NULL,
        text            TEXT NOT NULL,
        attachments     TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        -- Classified ONCE at ingest with the precise isIntercept grammar (a local command vs an agent
        -- turn), so dispatch is an indexed boolean lookup — no SQL grammar to drift, no false
        -- positives, no whitespace holes, no bounded-scan burial of a /cancel (codex P1).
        intercept       INTEGER NOT NULL DEFAULT 0,
        received_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(status, received_at);

      CREATE TABLE IF NOT EXISTS sessions (
        conversation_id  TEXT PRIMARY KEY,
        prev_response_id TEXT,
        user_id          TEXT NOT NULL,
        updated_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        dedup_key       TEXT PRIMARY KEY,
        group_key       TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL,
        chat_id         TEXT NOT NULL,
        text            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'queued',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        sent_at         INTEGER
      );
      CREATE INDEX IF NOT EXISTS outbox_queued ON outbox(status, next_attempt_at, created_at);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Async turns (0.3.2): one durable row per in-flight agent turn dispatched to the daemon's
      -- /v1/tasks surface. The row outlives a single dispatch tick, so the tracker re-attaches
      -- after a Connect restart. The partial unique index enforces AT MOST ONE active task per
      -- conversation, so two turns can never race the same thread's previous_response_id.
      CREATE TABLE IF NOT EXISTS tasks (
        task_id         TEXT PRIMARY KEY,
        event_id        TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        chat_id         TEXT NOT NULL,
        actor_id        TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active',
        stream_message_id TEXT,
        -- 0 once /new reset the thread while this turn was running: deliver its answer but do NOT
        -- write it back as the thread head, so a slow turn can't resurrect the abandoned thread.
        advance_head    INTEGER NOT NULL DEFAULT 1,
        -- 1 once /cancel was requested: pollTasks re-issues the DELETE every tick until the run is
        -- actually terminal, so the "Stopping that now." ack is never a lie on a dropped DELETE.
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active
        ON tasks(conversation_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS tasks_active ON tasks(status, created_at);

      CREATE TABLE IF NOT EXISTS schedules (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        actor_id        TEXT NOT NULL,
        chat_id         TEXT NOT NULL,
        prompt          TEXT NOT NULL,
        spec_kind       TEXT NOT NULL,
        spec_json       TEXT NOT NULL,
        interval_ms     INTEGER,
        state           TEXT NOT NULL,
        next_run_at     INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(state, next_run_at);
    `);
    // Migrate older tables in place (add columns absent on a pre-existing DB).
    for (const alter of [
      "ALTER TABLE outbox ADD COLUMN group_key TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE inbox ADD COLUMN attachments TEXT",
      "ALTER TABLE inbox ADD COLUMN intercept INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN advance_head INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE tasks ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.db.exec(alter);
      } catch {
        // column already present on a fresh table - fine
      }
    }
    // Backfill legacy rows so each is its OWN group (group_key = dedup_key), never
    // the shared empty group - otherwise one failure would dead-letter them all.
    this.db.exec(`UPDATE outbox SET group_key = dedup_key WHERE group_key = ''`);
    // Backfill the intercept classification for any PENDING rows carried over from before the column
    // existed, so a command queued across the upgrade is still recognised. Classify in JS with the
    // real grammar (SQLite can't) — a handful of pending rows at most.
    const pending = this.db
      .query(`SELECT event_id, text FROM inbox WHERE status = 'pending'`)
      .all() as { event_id: string; text: string }[];
    const setIntercept = this.db.query(`UPDATE inbox SET intercept = ? WHERE event_id = ?`);
    for (const row of pending) setIntercept.run(isIntercept(row.text) ? 1 : 0, row.event_id);
  }

  // --- inbox -------------------------------------------------------------

  /** Insert, returning true only if this event is new (dedup on eventId). */
  insertInbox(e: Inbound): boolean {
    const r = this.db
      .query(
        `INSERT OR IGNORE INTO inbox (event_id, conversation_id, actor_id, chat_id, text, attachments, intercept, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.eventId,
        e.conversationId,
        e.actorId,
        e.chatId,
        e.text,
        e.attachments?.length ? JSON.stringify(e.attachments) : null,
        isIntercept(e.text) ? 1 : 0, // classify once, at ingest (dispatch reads the column)
        Date.now(),
      );
    return r.changes > 0;
  }

  /** The oldest pending message overall (rowid tiebreak = arrival order). The connector applies
   *  eligibility: a local command flows even for a busy conversation, but a new AGENT TURN waits
   *  behind that conversation's active task (see Connector.nextDispatchable). */
  nextPending(): InboxRow | null {
    return (
      (this.db
        .query(
          `SELECT * FROM inbox WHERE status = 'pending' ORDER BY received_at ASC, rowid ASC LIMIT 1`,
        )
        .get() as InboxRow) ?? null
    );
  }

  /** The oldest `limit` pending messages — the connector scans these for the first dispatchable one
   *  (a command, or an agent turn for a conversation with no active task). */
  pendingBatch(limit: number): InboxRow[] {
    return this.db
      .query(
        `SELECT * FROM inbox WHERE status = 'pending' ORDER BY received_at ASC, rowid ASC LIMIT ?`,
      )
      .all(limit) as InboxRow[];
  }

  conversationHasActiveTask(conversationId: string): boolean {
    return !!this.db
      .query(`SELECT 1 FROM tasks WHERE conversation_id = ? AND status = 'active' LIMIT 1`)
      .get(conversationId);
  }

  /** The active task for a conversation (for /cancel), if any. */
  activeTaskForConversation(conversationId: string): TaskRow | null {
    return (
      (this.db
        .query(`SELECT * FROM tasks WHERE conversation_id = ? AND status = 'active' LIMIT 1`)
        .get(conversationId) as TaskRow) ?? null
    );
  }

  markInboxDone(eventId: string): void {
    this.db.query(`UPDATE inbox SET status = 'done' WHERE event_id = ?`).run(eventId);
  }

  /** Drop not-yet-started agent-turn messages that arrived BEFORE a `/new` — the "fresh start"
   *  semantics: a message queued but not begun before the reset doesn't later run in the new thread
   *  (codex P1 ordering). Bounded to rows ordered before the `/new` event by (received_at, rowid) —
   *  the same order dispatch uses — so a message that arrived AFTER `/new` in the same long-poll
   *  batch is kept and runs in the fresh thread (codex P1). Only pending, non-intercept rows in this
   *  conversation are dropped; the in-flight turn ('dispatched') and queued commands are untouched. */
  dropPendingTurnsBefore(conversationId: string, newEventId: string): number {
    return this.db
      .query(
        `UPDATE inbox SET status = 'dropped'
         WHERE status = 'pending' AND intercept = 0 AND conversation_id = ?
           AND (received_at, rowid) < (SELECT received_at, rowid FROM inbox WHERE event_id = ?)`,
      )
      .run(conversationId, newEventId).changes;
  }

  /** The inbox row for an event, whatever its status — used to reconstruct the input when a
   *  placeholder task (a start whose 202 was lost) is re-POSTed to resolve its real daemon run. */
  getInboxByEvent(eventId: string): InboxRow | null {
    return (
      (this.db.query(`SELECT * FROM inbox WHERE event_id = ?`).get(eventId) as InboxRow) ?? null
    );
  }

  // --- async tasks (0.3.2) ----------------------------------------------

  /** Claim a message as an in-flight async turn: mark the inbox row dispatched and record the
   *  durable task row, atomically. The task id was minted by the daemon (idempotency_key = the
   *  event id), so a crash before this commit just re-dispatches to the SAME daemon task. Returns
   *  false if the conversation already has an active task (the partial unique index) — the caller
   *  cancels the just-started daemon task to avoid a duplicate run. */
  startTask(args: {
    taskId: string;
    eventId: string;
    conversationId: string;
    chatId: string;
    actorId: string;
    userId: string;
  }): boolean {
    try {
      const tx = this.db.transaction(() => {
        this.db
          .query(
            `INSERT INTO tasks (task_id, event_id, conversation_id, chat_id, actor_id, user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            args.taskId,
            args.eventId,
            args.conversationId,
            args.chatId,
            args.actorId,
            args.userId,
            Date.now(),
          );
        this.db
          .query(`UPDATE inbox SET status = 'dispatched' WHERE event_id = ?`)
          .run(args.eventId);
      });
      tx();
      return true;
    } catch {
      return false; // unique-index conflict: a task is already active for this conversation
    }
  }

  /** Promote a placeholder task (recorded when the daemon's 202 was lost) to the real daemon run id
   *  once a re-POST resolved it — carrying over any cancel/detach intent the placeholder collected
   *  while the id was unknown (codex P1). task_id is the PK, so this UPDATE re-keys the same row. */
  resolvePlaceholderTask(placeholderId: string, realId: string): void {
    this.db.query(`UPDATE tasks SET task_id = ? WHERE task_id = ?`).run(realId, placeholderId);
  }

  /** Count of ALL task rows regardless of status — used to assert the table doesn't accumulate
   *  finalized rows (finishTask deletes them). */
  allTasksCount(): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  }

  activeTasks(): TaskRow[] {
    return this.db
      .query(`SELECT * FROM tasks WHERE status = 'active' ORDER BY created_at ASC, rowid ASC`)
      .all() as TaskRow[];
  }

  /** Resolve the origin of a schedule_self call by the daemon-asserted user — but ONLY when it is
   *  unambiguous. The daemon asserts the user, not the conversation, so if that ONE user has active
   *  tasks in several conversations at once (e.g. a DM and a group), binding to any of them could
   *  hand one conversation's schedule to another (codex P0). Fail closed: return the task iff the
   *  user has exactly one active task; otherwise null → the control server 409s the schedule rather
   *  than misrouting it. A single-conversation user (the common case) always resolves. */
  activeTaskByUser(userId: string): TaskRow | null {
    const rows = this.db
      .query(`SELECT * FROM tasks WHERE status = 'active' AND user_id = ? LIMIT 2`)
      .all(userId) as TaskRow[];
    return rows.length === 1 ? (rows[0] as TaskRow) : null;
  }

  /** The origin a `schedule_self` call binds to — but ONLY when it is unambiguous. The daemon's
   *  schedule POST carries no run identity (just the shared gateway token), so with sync turns
   *  there was exactly one in-flight turn and the binding was exact. Under async concurrency two
   *  conversations can run at once, and a "most recent" guess would hand conversation A's schedule
   *  to B (a cross-conversation leak — codex P0). So this returns the sole active task, or null when
   *  0 or ≥2 are active; the control server then 409s an ambiguous schedule rather than misrouting
   *  it. The exact fix (daemon asserts the run's user_id → resolve via activeTaskByUser) is a harness
   *  follow-up; fail-closed is the correct, lean behaviour until then. Single-user agents (the common
   *  case) always have exactly one active task, so scheduling keeps working for them. */
  soleActiveOrigin(): TaskRow | null {
    const rows = this.db
      .query(`SELECT * FROM tasks WHERE status = 'active' LIMIT 2`)
      .all() as TaskRow[];
    return rows.length === 1 ? (rows[0] as TaskRow) : null;
  }

  /** /new reset the thread while a turn is running: keep delivering that turn's answer but stop it
   *  from writing its response id back as the (now fresh) thread head — else the abandoned thread
   *  resurrects when the slow turn lands (codex P1). */
  detachActiveTaskHead(conversationId: string): void {
    this.db
      .query(`UPDATE tasks SET advance_head = 0 WHERE conversation_id = ? AND status = 'active'`)
      .run(conversationId);
  }

  /** Record durable cancel intent so pollTasks keeps re-issuing the DELETE until the run is actually
   *  terminal — the "Stopping that now." ack must not be a lie when the first DELETE is dropped. */
  requestCancel(taskId: string): void {
    this.db.query(`UPDATE tasks SET cancel_requested = 1 WHERE task_id = ?`).run(taskId);
  }

  /** The single oldest pending message that can be dispatched RIGHT NOW: a local command (intercept,
   *  which flows even while its conversation has a turn in flight) OR an agent turn for a conversation
   *  with no active task. One indexed, unbounded, oldest-first query — so per-conversation arrival
   *  order is preserved, a command is never buried behind a flood or a deep backlog, and one busy
   *  conversation's queue can't starve another (codex P1). `intercept` was classified at ingest with
   *  the precise grammar, so there are no false positives to filter. */
  nextDispatchable(): InboxRow | null {
    return (
      (this.db
        .query(
          `SELECT i.* FROM inbox i
           WHERE i.status = 'pending' AND (
             i.intercept = 1
             OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id = i.conversation_id AND t.status = 'active')
           )
           ORDER BY i.received_at ASC, i.rowid ASC LIMIT 1`,
        )
        .get() as InboxRow) ?? null
    );
  }

  setTaskStreamMessage(taskId: string, messageId: string): void {
    this.db
      .query(`UPDATE tasks SET stream_message_id = ? WHERE task_id = ?`)
      .run(messageId, taskId);
  }

  /** Finalize a terminal task: advance the session, enqueue the reply, mark the inbox done, and
   *  mark the task done (freeing the conversation) — ALL in one transaction, so a crash never
   *  leaves a half-delivered turn or a stuck conversation. Mirrors commitTurn plus the task close. */
  finishTask(args: {
    taskId: string;
    eventId: string;
    conversationId: string;
    chatId: string;
    userId: string;
    responseId?: string;
    replyChunks: string[];
  }): void {
    const now = Date.now();
    const groupKey = `out:${args.eventId}`;
    const tx = this.db.transaction(() => {
      // advance_head=0 means /new reset the thread mid-turn: deliver the answer but leave the fresh
      // thread head untouched (codex P1). Read it inside the tx so the check and the writes are atomic.
      const detached =
        (
          this.db.query(`SELECT advance_head FROM tasks WHERE task_id = ?`).get(args.taskId) as
            | { advance_head: number }
            | undefined
        )?.advance_head === 0;
      if (args.responseId && !detached) {
        this.db
          .query(
            `INSERT INTO sessions (conversation_id, prev_response_id, user_id, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET
               prev_response_id = excluded.prev_response_id, updated_at = excluded.updated_at`,
          )
          .run(args.conversationId, args.responseId, args.userId, now);
      }
      args.replyChunks.forEach((text, i) => {
        this.db
          .query(
            `INSERT OR IGNORE INTO outbox (dedup_key, group_key, conversation_id, chat_id, text, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(`${groupKey}:${i}`, groupKey, args.conversationId, args.chatId, text, now + i);
      });
      this.db.query(`UPDATE inbox SET status = 'done' WHERE event_id = ?`).run(args.eventId);
      // A finalized task has no further use (nothing reads a non-active task), so delete it rather
      // than leaving a 'done' row to accumulate for the bot's lifetime (codex P2). The delete is in
      // the same tx as the inbox-done + outbox writes, so re-attach after a crash is still exact:
      // the row stays 'active' until this atomic finalize.
      this.db.query(`DELETE FROM tasks WHERE task_id = ?`).run(args.taskId);
    });
    tx();
  }

  // --- sessions ----------------------------------------------------------

  getSession(conversationId: string): { prev_response_id: string | null; user_id: string } | null {
    return (
      (this.db
        .query(`SELECT prev_response_id, user_id FROM sessions WHERE conversation_id = ?`)
        .get(conversationId) as { prev_response_id: string | null; user_id: string }) ?? null
    );
  }

  // --- the atomic turn commit -------------------------------------------

  /**
   * Advance the session, enqueue the reply as ordered/grouped outbox rows, and
   * mark the inbox event done - all in ONE transaction. A crash either leaves
   * the event still pending (whole turn re-runs) or fully committed (delivered
   * once). No partial state: never a split reply, never a half-advanced thread.
   * previousResponseId omitted when the reply spends no agent turn (intercepts).
   * resetSession clears the thread (the `/new` command) in the SAME transaction,
   * so a crash never leaves the event done with the old thread still linked.
   */
  commitTurn(args: {
    eventId: string;
    conversationId: string;
    chatId: string;
    userId: string;
    responseId?: string;
    resetSession?: boolean;
    replyChunks: string[];
  }): void {
    const now = Date.now();
    const groupKey = `out:${args.eventId}`;
    const tx = this.db.transaction(() => {
      if (args.resetSession) {
        this.db.query(`DELETE FROM sessions WHERE conversation_id = ?`).run(args.conversationId);
      }
      if (args.responseId) {
        this.db
          .query(
            `INSERT INTO sessions (conversation_id, prev_response_id, user_id, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET
               prev_response_id = excluded.prev_response_id, updated_at = excluded.updated_at`,
          )
          .run(args.conversationId, args.responseId, args.userId, now);
      }
      args.replyChunks.forEach((text, i) => {
        this.db
          .query(
            `INSERT OR IGNORE INTO outbox (dedup_key, group_key, conversation_id, chat_id, text, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(`${groupKey}:${i}`, groupKey, args.conversationId, args.chatId, text, now + i);
      });
      this.db.query(`UPDATE inbox SET status = 'done' WHERE event_id = ?`).run(args.eventId);
    });
    tx();
  }

  // --- outbox delivery ---------------------------------------------------

  /** The oldest queued row - which the caller must deliver strictly in order.
   *  It may be backing off (next_attempt_at in the future); the caller checks and
   *  waits rather than skipping ahead, so a backed-off chunk never lets a later
   *  chunk of the same reply overtake it. */
  nextQueuedOutbox(): OutboxRow | null {
    return (
      (this.db
        .query(
          `SELECT * FROM outbox WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        )
        .get() as OutboxRow) ?? null
    );
  }

  markOutboxSent(dedupKey: string): void {
    this.db
      .query(
        `UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE dedup_key = ?`,
      )
      .run(Date.now(), dedupKey);
  }

  /** Retryable failure: back off (honor Telegram retry_after), dead-letter past the cap. */
  markOutboxRetry(dedupKey: string, retryAfterMs: number): void {
    const row = this.db
      .query(`SELECT group_key, attempts FROM outbox WHERE dedup_key = ?`)
      .get(dedupKey) as { group_key: string; attempts: number } | null;
    if (!row) return;
    if (row.attempts + 1 >= MAX_SEND_ATTEMPTS) {
      this.markGroupDead(row.group_key); // give up on the whole reply, not just this chunk
      return;
    }
    this.db
      .query(`UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE dedup_key = ?`)
      .run(Date.now() + Math.max(0, retryAfterMs), dedupKey);
  }

  /** Permanent failure of a whole reply: dead-letter every remaining chunk so a
   *  partial, out-of-order reply is never delivered. */
  markGroupDead(groupKey: string): void {
    this.db
      .query(
        `UPDATE outbox SET status = 'dead', attempts = attempts + 1 WHERE group_key = ? AND status = 'queued'`,
      )
      .run(groupKey);
  }

  // --- meta (durable long-poll offset, etc.) -----------------------------

  getMeta(key: string): string | null {
    const r = this.db.query(`SELECT value FROM meta WHERE key = ?`).get(key) as {
      value: string;
    } | null;
    return r ? r.value : null;
  }

  setMeta(key: string, value: string | number): void {
    this.db
      .query(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, String(value));
  }

  // --- schedules --------------------------------------------------------

  createSchedule(
    origin: ScheduleOrigin,
    prompt: string,
    spec: ScheduleSpec,
    now = Date.now(),
  ): ScheduleView {
    const id = crypto.randomUUID();
    const nextRunAt = spec.kind === "once" ? Date.parse(spec.runAt) : now + spec.intervalMs;
    this.db
      .query(
        `INSERT INTO schedules
           (id, conversation_id, actor_id, chat_id, prompt, spec_kind, spec_json,
            interval_ms, state, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        origin.conversationId,
        origin.actorId,
        origin.chatId,
        prompt,
        spec.kind,
        JSON.stringify(spec),
        spec.kind === "interval" ? spec.intervalMs : null,
        nextRunAt,
        now,
        now,
      );
    return {
      id,
      state: "active",
      specKind: spec.kind,
      nextRunAt: new Date(nextRunAt).toISOString(),
      prompt,
    };
  }

  listSchedules(origin: ScheduleOrigin): ScheduleView[] {
    const rows = this.db
      .query(
        `SELECT id, state, spec_kind, next_run_at, prompt FROM schedules
         WHERE conversation_id = ? AND actor_id = ? AND chat_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(origin.conversationId, origin.actorId, origin.chatId) as Array<{
      id: string;
      state: string;
      spec_kind: string;
      next_run_at: number | null;
      prompt: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      state: row.state,
      specKind: row.spec_kind,
      nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
      prompt: row.prompt,
    }));
  }

  /** Idempotently cancel an owned schedule; false hides absent and cross-origin ids alike. */
  cancelSchedule(id: string, origin: ScheduleOrigin): boolean {
    const owned = this.db
      .query(
        `SELECT 1 FROM schedules
         WHERE id = ? AND conversation_id = ? AND actor_id = ? AND chat_id = ?`,
      )
      .get(id, origin.conversationId, origin.actorId, origin.chatId);
    if (!owned) return false;
    this.db
      .query(
        `UPDATE schedules SET state = 'cancelled', next_run_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), id);
    return true;
  }

  /** Atomically admit each due occurrence and advance its durable clock. */
  admitDue(now = Date.now()): number {
    let admitted = 0;
    const tx = this.db.transaction(() => {
      const rows = this.db
        .query(
          `SELECT id, conversation_id, actor_id, chat_id, prompt, spec_kind,
                  interval_ms, state, next_run_at
           FROM schedules
           WHERE state = 'active' AND next_run_at <= ?
           ORDER BY next_run_at ASC, rowid ASC`,
        )
        .all(now) as ScheduleRow[];
      for (const row of rows) {
        const scheduled = row.next_run_at;
        if (scheduled === null) continue;
        const inserted = this.db
          .query(
            `INSERT OR IGNORE INTO inbox
               (event_id, conversation_id, actor_id, chat_id, text, attachments, received_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            `schedule:${row.id}:${scheduled}`,
            row.conversation_id,
            row.actor_id,
            row.chat_id,
            `[Scheduled wake at ${new Date(scheduled).toISOString()}]\n${row.prompt}`,
            now,
          );
        admitted += inserted.changes;

        if (row.spec_kind === "interval" && row.interval_ms) {
          const steps = Math.floor(Math.max(0, now - scheduled) / row.interval_ms) + 1;
          const next = scheduled + steps * row.interval_ms;
          this.db
            .query(`UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?`)
            .run(next, now, row.id);
        } else {
          this.db
            .query(
              `UPDATE schedules
               SET state = 'completed', next_run_at = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(now, row.id);
        }
      }
    });
    tx();
    return admitted;
  }
}
