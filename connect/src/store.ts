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

  nextPending(): InboxRow | null {
    return (
      (this.db
        // rowid tiebreak: two updates in the same ms still drain in arrival order.
        .query(
          `SELECT * FROM inbox WHERE status = 'pending' ORDER BY received_at ASC, rowid ASC LIMIT 1`,
        )
        .get() as InboxRow) ?? null
    );
  }

  markInboxDone(eventId: string): void {
    this.db.query(`UPDATE inbox SET status = 'done' WHERE event_id = ?`).run(eventId);
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
}
