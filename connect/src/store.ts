import { Database } from "bun:sqlite";

import type { Inbound } from "./types";

// The durable spine. Three tables carry the correctness boundaries:
//   inbox   - dedup by eventId, so a platform retry is a no-op
//   sessions - conversationId -> previous_response_id, so a chat threads
//   outbox  - idempotent send by dedup_key, so a crash never double-delivers
// SQLite WAL, checkpoint-per-statement. Keyed by session; no shared RAM state.

export type InboxRow = {
  event_id: string;
  conversation_id: string;
  actor_id: string;
  chat_id: string;
  text: string;
  status: string;
  received_at: number;
};

export type OutboxRow = {
  dedup_key: string;
  conversation_id: string;
  chat_id: string;
  text: string;
  status: string;
  attempts: number;
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
        conversation_id TEXT NOT NULL,
        chat_id         TEXT NOT NULL,
        text            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'queued',
        attempts        INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        sent_at         INTEGER
      );
      CREATE INDEX IF NOT EXISTS outbox_queued ON outbox(status, created_at);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // --- inbox -------------------------------------------------------------

  /** Insert, returning true only if this event is new (dedup on eventId). */
  insertInbox(e: Inbound): boolean {
    const r = this.db
      .query(
        `INSERT OR IGNORE INTO inbox (event_id, conversation_id, actor_id, chat_id, text, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(e.eventId, e.conversationId, e.actorId, e.chatId, e.text, Date.now());
    return r.changes > 0;
  }

  nextPending(): InboxRow | null {
    return (this.db
      .query(`SELECT * FROM inbox WHERE status = 'pending' ORDER BY received_at ASC LIMIT 1`)
      .get() as InboxRow) ?? null;
  }

  markInboxDone(eventId: string): void {
    this.db.query(`UPDATE inbox SET status = 'done' WHERE event_id = ?`).run(eventId);
  }

  // --- sessions ----------------------------------------------------------

  getSession(conversationId: string): { prev_response_id: string | null; user_id: string } | null {
    return (this.db
      .query(`SELECT prev_response_id, user_id FROM sessions WHERE conversation_id = ?`)
      .get(conversationId) as { prev_response_id: string | null; user_id: string }) ?? null;
  }

  setSession(conversationId: string, prevResponseId: string, userId: string): void {
    this.db
      .query(
        `INSERT INTO sessions (conversation_id, prev_response_id, user_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           prev_response_id = excluded.prev_response_id,
           updated_at       = excluded.updated_at`,
      )
      .run(conversationId, prevResponseId, userId, Date.now());
  }

  // --- outbox ------------------------------------------------------------

  /** Idempotent enqueue. Same dedup_key twice is a no-op, so a re-run never doubles a reply. */
  enqueueOutbox(dedupKey: string, conversationId: string, chatId: string, text: string): boolean {
    const r = this.db
      .query(
        `INSERT OR IGNORE INTO outbox (dedup_key, conversation_id, chat_id, text, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(dedupKey, conversationId, chatId, text, Date.now());
    return r.changes > 0;
  }

  nextQueuedOutbox(): OutboxRow | null {
    return (this.db
      .query(`SELECT * FROM outbox WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
      .get() as OutboxRow) ?? null;
  }

  markOutboxSent(dedupKey: string): void {
    this.db
      .query(`UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE dedup_key = ?`)
      .run(Date.now(), dedupKey);
  }

  /** Retryable failure: keep queued, count the attempt, dead-letter past the cap. */
  bumpOutboxAttempt(dedupKey: string): void {
    this.db
      .query(
        `UPDATE outbox
         SET attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= ${MAX_SEND_ATTEMPTS} THEN 'dead' ELSE 'queued' END
         WHERE dedup_key = ?`,
      )
      .run(dedupKey);
  }

  /** Permanent failure. */
  markOutboxDead(dedupKey: string): void {
    this.db.query(`UPDATE outbox SET status = 'dead', attempts = attempts + 1 WHERE dedup_key = ?`).run(dedupKey);
  }

  // --- meta (durable long-poll offset, etc.) -----------------------------

  getMeta(key: string): string | null {
    const r = this.db.query(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | null;
    return r ? r.value : null;
  }

  setMeta(key: string, value: string | number): void {
    this.db
      .query(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, String(value));
  }
}
