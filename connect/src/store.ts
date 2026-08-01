import { Database } from "bun:sqlite";

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
  }

  // --- inbox -------------------------------------------------------------

  /** Insert, returning true only if this event is new (dedup on eventId). */
  insertInbox(e: Inbound): boolean {
    const r = this.db
      .query(
        `INSERT OR IGNORE INTO inbox (event_id, conversation_id, actor_id, chat_id, text, attachments, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.eventId,
        e.conversationId,
        e.actorId,
        e.chatId,
        e.text,
        e.attachments?.length ? JSON.stringify(e.attachments) : null,
        Date.now(),
      );
    return r.changes > 0;
  }

  /** The oldest pending message WHOSE CONVERSATION HAS NO ACTIVE TASK (0.3.2). A conversation with
   *  an in-flight async turn is skipped, not blocked, so one long turn never stalls the global
   *  inbox — other conversations keep flowing while it runs (codex must-fix: per-conversation
   *  serialization without head-of-line blocking). Its own next message just waits, in order. */
  nextPending(): InboxRow | null {
    return (
      (this.db
        // rowid tiebreak: two updates in the same ms still drain in arrival order.
        .query(
          `SELECT * FROM inbox WHERE status = 'pending'
             AND conversation_id NOT IN (SELECT conversation_id FROM tasks WHERE status = 'active')
           ORDER BY received_at ASC, rowid ASC LIMIT 1`,
        )
        .get() as InboxRow) ?? null
    );
  }

  markInboxDone(eventId: string): void {
    this.db.query(`UPDATE inbox SET status = 'done' WHERE event_id = ?`).run(eventId);
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

  activeTasks(): TaskRow[] {
    return this.db
      .query(`SELECT * FROM tasks WHERE status = 'active' ORDER BY created_at ASC, rowid ASC`)
      .all() as TaskRow[];
  }

  /** Resolve the origin of an active task by its daemon-asserted user_id — the async replacement
   *  for the single in-flight `activeOrigin`, so schedule_self binds to the right chat even with
   *  several conversations' tasks running at once. */
  activeTaskByUser(userId: string): TaskRow | null {
    return (
      (this.db
        .query(
          `SELECT * FROM tasks WHERE status = 'active' AND user_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(userId) as TaskRow) ?? null
    );
  }

  /** The most-recently-started active task — the async replacement for the single in-flight
   *  `activeOrigin` that binds a schedule_self call to a chat. Exact for a single-conversation
   *  agent; a best-effort pick when several conversations run tasks at once (the daemon's
   *  schedule_self POST carries no identity, so this is the leanest binding without a harness change). */
  mostRecentActiveTask(): TaskRow | null {
    return (
      (this.db
        .query(
          `SELECT * FROM tasks WHERE status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get() as TaskRow) ?? null
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
      this.db.query(`UPDATE tasks SET status = 'done' WHERE task_id = ?`).run(args.taskId);
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
