// SPDX-License-Identifier: Apache-2.0
// Local state (L0): SQLite WAL. Five tables — sessions, runs (the durable queue;
// a completed run IS a seam-level turn), messages (append-only wire-format rows;
// with the journal these ARE the per-step checkpoints — resume = reload active
// rows, compaction = flip `active`), journal (tool executions: intent before,
// result after — non-idempotent tools never silently re-fire), events (the
// observability stream + telemetry outbox). Migrations run on open via PRAGMA
// user_version, so runs survive binary upgrades, not just restarts.

import { Database } from "bun:sqlite";
import type { ChatMsg } from "./provider";
import type { RecallHit, TodoItem, TodoStatus } from "./tools";
import { HARNESS_VERSION } from "./version";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
    request TEXT NOT NULL,
    result TEXT,
    error TEXT,
    usage TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    UNIQUE (session_id, seq)
  );
  CREATE INDEX runs_dispatch ON runs(status, created_at);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    msg TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_session ON messages(session_id, active, id);
  CREATE INDEX messages_run ON messages(run_id, id);

  CREATE TABLE journal (
    run_id TEXT NOT NULL REFERENCES runs(id),
    call_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('intent','done')),
    result TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    PRIMARY KEY (run_id, call_id)
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    user_id TEXT,
    agent_id TEXT,
    session_id TEXT,
    run_id TEXT,
    task_id TEXT,
    entity_id TEXT,
    turn INTEGER,
    data TEXT NOT NULL,
    exported INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX events_outbox ON events(exported, id);
  CREATE INDEX events_run ON events(run_id, id);
  `,
  // M2: tools activated mid-run via search_tools must survive a restart.
  `
  ALTER TABLE runs ADD COLUMN tools TEXT;
  `,
  // M6: the loop's step count and last-call prompt size must survive compaction
  // (which marks older rows inactive) and restarts — else the maxSteps guard
  // resets and the compaction trigger is lost on resume.
  `
  ALTER TABLE runs ADD COLUMN steps INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN last_input INTEGER NOT NULL DEFAULT 0;
  `,
  // F2: scoped memory (spec §G). run/user/agent-self learnings; the fallback for
  // the reflection loop when no a knowledge base is connected (else it proposes to the knowledge base).
  `
  CREATE TABLE memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK (scope IN ('run','user','agent','org')),
    scope_id TEXT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX memory_lookup ON memory(scope, scope_id, created_at);
  `,
  // G2: durable key/value for daemon-scoped identity. Holds the daemon_id used to
  // stamp a globally-unique, restart-stable event.id on exported telemetry so the
  // collector can dedupe (the exporter is at-least-once). Persisted (not per-boot)
  // so a row re-shipped after a restart keeps the SAME id → ON CONFLICT DO NOTHING.
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Sprint 5: memory governance. The store-less rail used to be written and recalled
  // unconditionally (self-poisoning + unbounded growth). confidence gates the write,
  // hash dedupes it (re-learning = confirmation, not duplication), hits/last_used
  // track recall so retention follows usefulness (a promotion gate, inverted),
  // and source separates review-grounded truth from self-narration.
  `
  ALTER TABLE memory ADD COLUMN confidence REAL;
  ALTER TABLE memory ADD COLUMN hash TEXT;
  ALTER TABLE memory ADD COLUMN hits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE memory ADD COLUMN last_used INTEGER;
  ALTER TABLE memory ADD COLUMN source TEXT NOT NULL DEFAULT 'self';
  CREATE UNIQUE INDEX memory_dedup ON memory(scope, scope_id, hash) WHERE hash IS NOT NULL;
  `,
  // v3.1 F0.1: the orthogonal memory model. A new CHECK is not ALTER-able, so the
  // table is REBUILT (rename → create → copy → drop → reindex; all in one migration
  // transaction). The single `scope` enum splits into four independent axes
  // (audience/artifact_kind/trust/source) plus explicit non-NULL identity
  // (namespace/agent_id/user_id/task_type) — a procedure can now be user- OR
  // org-scoped without contradiction, and the unique dedup index can't be dodged by
  // NULLs. Legacy rows map: scope user→audience user (scope_id→user_id); org→org;
  // run/agent→agent (scope_id→agent_id); key→artifact_kind heuristically.
  `
  ALTER TABLE memory RENAME TO memory_old;
  CREATE TABLE memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL DEFAULT 'default',
    agent_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL CHECK (audience IN ('user','task_type','agent','org')),
    task_type TEXT NOT NULL DEFAULT '',
    artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('fact','preference','pitfall','procedure')),
    content TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '',
    confidence REAL,
    trust TEXT NOT NULL DEFAULT 'trusted' CHECK (trust IN ('trusted','untrusted')),
    source TEXT NOT NULL DEFAULT 'self' CHECK (source IN ('self','review')),
    hash TEXT,
    hits INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER,
    created_at INTEGER NOT NULL
  );
  -- Copy first WITHOUT the unique index. Legacy rows can share a new identity
  -- tuple (old NULL scope_id was distinct in the old index; old 'org'/'run' rows —
  -- never written by the shipping code path — collapse to their bucket), and
  -- 'source' had no CHECK, so sanitize it. Creating the unique index before
  -- collapsing those would abort the migration and leave user_version stuck →
  -- a boot loop (codex P1).
  INSERT INTO memory
    (namespace, agent_id, user_id, audience, task_type, artifact_kind,
     content, aliases, confidence, trust, source, hash, hits, last_used, created_at)
  SELECT 'default',
         CASE WHEN scope IN ('agent','run') THEN coalesce(scope_id,'') ELSE '' END,
         CASE WHEN scope = 'user' THEN coalesce(scope_id,'') ELSE '' END,
         CASE scope WHEN 'user' THEN 'user' WHEN 'org' THEN 'org' ELSE 'agent' END,
         '',
         CASE key WHEN 'pitfall' THEN 'pitfall' WHEN 'skill_improvement' THEN 'procedure' ELSE 'fact' END,
         value, '', confidence, 'trusted',
         CASE WHEN source IN ('self','review') THEN source ELSE 'self' END,
         hash, coalesce(hits,0), last_used, created_at
  FROM memory_old;
  DROP TABLE memory_old;
  -- Collapse hash-collisions to the lowest id BEFORE the unique index (null-hash
  -- legacy rows never deduped and are all kept). artifact_kind is part of identity:
  -- a fact and a procedure with identical text are different artifacts.
  DELETE FROM memory WHERE hash IS NOT NULL AND id NOT IN (
    SELECT min(id) FROM memory WHERE hash IS NOT NULL
    GROUP BY namespace, agent_id, audience, user_id, task_type, artifact_kind, hash
  );
  CREATE INDEX memory_recall ON memory(namespace, agent_id, audience, created_at);
  CREATE UNIQUE INDEX memory_dedup
    ON memory(namespace, agent_id, audience, user_id, task_type, artifact_kind, hash) WHERE hash IS NOT NULL;
  `,
  // v3.1 F0.1: occurrence table — one row per (memory, producing run). COUNT(*)
  // is the honest distinct-run signal the Phase-2 promoter gates on (an A→B→A
  // re-distillation counts 2 runs, not 3 — the last_run_id counter v3 proposed
  // would have miscounted; codex P1).
  `
  CREATE TABLE memory_occurrence (
    memory_id INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (memory_id, run_id)
  );
  `,
  // v3.1 F0.1: the promotion outbox — durable, crash-safe local→shared graduation.
  // Carries the FULL body (procedures exceed memory.content's 500-char cap, so
  // staging a skill through the memory row would destroy it — codex P1), a
  // backend-accepted idempotency_key (a crash-after-success retry is a backend
  // no-op, not a duplicate proposal), and an adapter_binding (a reconfigured daemon
  // never promotes an old product's candidate). The Phase-2 promoter claims rows
  // with an atomic CAS on `lifecycle`. Created now so remember()'s eviction can
  // reference it (a row with a pending promotion is exempt from the cap).
  `
  CREATE TABLE promotion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL,
    destination_role TEXT NOT NULL CHECK (destination_role IN ('curated','capability')),
    artifact_kind TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    adapter_binding TEXT NOT NULL,
    lifecycle TEXT NOT NULL DEFAULT 'staged'
      CHECK (lifecycle IN ('staged','claimed','promoted','failed')),
    claimed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX promotion_drain ON promotion(lifecycle, id);
  `,
  // F0.5: one crash-safe writer lease per database. Absence means unheld;
  // expiry permits a new daemon to take over after an ungraceful exit.
  `
  CREATE TABLE lease (
    name TEXT PRIMARY KEY NOT NULL CHECK (name = 'writer'),
    holder_id TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
  );
  `,
  // Cockpit: the true-to-life per-model-call record. The system spine, the exact tool
  // schemas, and the ephemeral retrieval block are assembled fresh each turn and never
  // land in `messages` — so the ONLY way to show a dev "exactly what the model saw on
  // call N" is to snapshot the assembled request here. DEV-ONLY: written solely when
  // DELTA_CAPTURE_CALLS is set (delta dev turns it on); prod never pays the storage.
  // Stored RAW (this is the already-sandboxed WAL); redaction happens on the read path.
  `
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    session_id TEXT,
    turn INTEGER NOT NULL,
    request TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX calls_run ON calls(run_id, turn);
  `,
  // Self-file revisions: every prior version of DELTA.md, snapshotted before the agent's
  // `remember` tool overwrites it. Lives HERE (in the DB, outside the model-writable
  // workspace) so the recovery path can't be deleted by a self-write (codex #2). Bounded
  // retention is enforced on write (self.ts); the Cockpit reads this for diff + revert.
  `
  CREATE TABLE self_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    content TEXT NOT NULL
  );
  `,
  // W3 recitation: the agent's per-thread working plan (todo). Lives HERE (in the DB, outside the
  // model-writable workspace) like self_revisions; re-injected each turn as an ephemeral block so
  // it rides in recent attention and survives compaction (rebuilt from this table, never persisted
  // into history or the cached spine). One row per session; `revision` bumps on every write.
  `
  CREATE TABLE thread_state (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    todo TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  `,
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  // DOWNGRADE GUARD (fail-closed): a database migrated by a NEWER binary carries a
  // user_version this binary doesn't know. Silently proceeding would operate an
  // unrecognized schema — the exact silent-corruption trap weaker schemes ship, which this
  // guards against. Refuse to open; an upgrade is forward-only, a rollback restores a
  // pre-upgrade snapshot (see the guide at https://deltaharness.dev).
  if (version > MIGRATIONS.length) {
    throw new Error(
      `delta: database schema v${version} is newer than this binary supports (v${MIGRATIONS.length}). ` +
        `Refusing to open — a downgrade would corrupt state. Run a daemon at or above the version ` +
        `that wrote this database, or restore a compatible backup.`,
    );
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  // Stamp the binary that last opened this DB. Lets the control plane read an agent's
  // running version straight from its state, and records provenance across upgrades.
  // schema_version mirrors user_version for easy inspection. Best-effort: version metadata
  // must never break opening a DB, so it's skipped if `meta` is somehow absent.
  const hasMeta = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (hasMeta) {
    const stamp = db.query(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    stamp.run("harness_version", HARNESS_VERSION);
    stamp.run("schema_version", String(MIGRATIONS.length));
  }
  return db;
}

/** This daemon's stable identity, minted once and persisted in `meta`. Survives
 * restarts (same DB file) so telemetry re-shipped after a crash carries the same
 * event.id, and is globally unique across VMs so two daemons never collide. */
export function daemonId(db: Database): string {
  const row = db.query("SELECT value FROM meta WHERE key = 'daemon_id'").get() as {
    value: string;
  } | null;
  if (row) return row.value;
  const id = crypto.randomUUID();
  // INSERT OR IGNORE: another connection may have raced us; re-read the winner.
  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('daemon_id', ?)").run(id);
  return (db.query("SELECT value FROM meta WHERE key = 'daemon_id'").get() as { value: string })
    .value;
}

/** The readable text of a wire message, for keyword search + snippeting. */
function msgText(m: ChatMsg): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => ("text" in p ? p.text : "")).join(" ");
  if (m.role === "assistant" && m.tool_calls)
    return m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(" ");
  return "";
}

// capAndSpill's inline marker ("… full output saved to <path>; read that file …").
const SPILL_PATH = /saved to (\/[^\s;]+)/;
// Bound the substring scan: LIKE isn't index-usable, so recall searches the most recent
// SCAN_WINDOW message ids in the session rather than an unbounded full-table scan. Far more
// than any live window; older-than-that results aren't recoverable (documented, acceptable).
const SCAN_WINDOW = 5000;

/** Search THIS session's message history — active AND compacted-out rows — for a keyword.
 * The engine behind the `recall` tool (W1): it makes a result that scrolled out of the live
 * window recoverable, so compaction stops silently truncating long tool-heavy runs. Lexical
 * only — no regex (ReDoS-free), no FTS/vector (the v3 decision keeps semantic recall in the
 * curated store; this is thread-local transcript recovery, a different job). Session is bound
 * by the caller (never a parameter). Candidates are LIKE-matched over the serialized row then
 * RE-checked against the readable text (a match in JSON scaffolding is discarded, so unrelated
 * rows can't starve a real older hit — codex diff-review P1). Tool rows dedupe by their stable
 * `(run_id, tool_call_id)` across the copy compaction makes; other roles by content. Inactive
 * rows surface first (the agent already sees active ones); the live copy wins a dedupe so the
 * `live|compacted` label stays truthful. */
export function searchHistory(
  db: Database,
  sessionId: string,
  query: string,
  limit: number,
): RecallHit[] {
  const q = (query ?? "").trim().slice(0, 200);
  if (!q) return [];
  const n = Math.max(1, Math.min(Math.floor(limit) || 10, 25));
  // Escape LIKE wildcards so a query containing % or _ can't broaden the match.
  const esc = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { floor } = db
    .query("SELECT COALESCE(MAX(id), 0) - ? AS floor FROM messages WHERE session_id = ?")
    .get(SCAN_WINDOW, sessionId) as { floor: number };
  const rows = db
    .query(
      `SELECT m.msg AS msg, m.active AS active, m.run_id AS run_id, r.seq AS seq
       FROM messages m JOIN runs r ON r.id = m.run_id
       WHERE m.session_id = ? AND m.id > ? AND LOWER(m.msg) LIKE LOWER(?) ESCAPE '\\'
       ORDER BY m.id DESC`,
    )
    .all(sessionId, floor, `%${esc}%`) as Array<{
    msg: string;
    active: number;
    run_id: string;
    seq: number;
  }>;
  const ql = q.toLowerCase();
  const seen = new Map<string, RecallHit>();
  for (const row of rows) {
    let m: ChatMsg;
    try {
      m = JSON.parse(row.msg) as ChatMsg;
    } catch {
      continue;
    }
    const text = msgText(m);
    const idx = text.toLowerCase().indexOf(ql);
    if (idx < 0) continue; // matched JSON scaffolding, not readable content — skip
    const key =
      m.role === "tool"
        ? `tool:${row.run_id}:${(m as { tool_call_id: string }).tool_call_id}`
        : `${m.role}:${text.slice(0, 160)}`;
    const prev = seen.get(key);
    if (prev && !(row.active === 1 && !prev.active)) continue; // keep first, or upgrade to live
    // Return the WHOLE finding when the message is reasonably sized — the agent recalls to get the
    // fact back, not a fragment (the competitor gap: snippet-only). Only window a genuinely large
    // message around the match. (A >20k tool result is already a head+tail+spill-path pointer.)
    let snippet: string;
    if (text.length <= 1_500) snippet = text;
    else {
      const start = Math.max(0, idx - 400);
      const end = Math.min(text.length, idx + ql.length + 400);
      snippet = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
    }
    const spillPath = SPILL_PATH.exec(text)?.[1];
    seen.set(key, {
      role: m.role,
      runSeq: row.seq ?? null,
      active: row.active === 1,
      snippet,
      ...(spillPath ? { spillPath } : {}),
    });
  }
  return [...seen.values()].sort((a, b) => Number(a.active) - Number(b.active)).slice(0, n);
}

// --- W3: per-thread working plan (todo) ---
const TODO_MAX_ITEMS = 40;
const TODO_MAX_CHARS = 3_000; // total text budget — re-sent every turn, so still a light anchor, but
// long fact-tracking tasks need more than ~25 terse items; past this, truncation is NON-silent
// (the tool tells the model) so it can offload big findings to a workspace file instead.
const TODO_STATUSES = new Set<TodoStatus>(["pending", "doing", "done", "dropped"]);

/** Read the session's working plan. Empty when unset or the stored JSON is malformed. */
export function readTodo(db: Database, sessionId: string): TodoItem[] {
  const row = db.query("SELECT todo FROM thread_state WHERE session_id = ?").get(sessionId) as {
    todo: string;
  } | null;
  if (!row) return [];
  try {
    const arr = JSON.parse(row.todo) as unknown;
    return Array.isArray(arr) ? (arr as TodoItem[]) : [];
  } catch {
    return [];
  }
}

/** Replace the whole plan (the tool always sends the full list). Text is stripped
 * of control chars / newlines so an item can't forge a fake `# header` in the re-injected block
 * (codex), statuses sanitized, and bounded (≤32 items, ≤1.5k chars). Atomic last-writer-wins:
 * SQLite's write is atomic and JS is single-threaded, so two `todo` calls in one turn serialize
 * deterministically to the later one — correct for full-list-replace, where the model is the sole
 * writer and sends the complete list each call (NOT an expected-revision CAS; `revision` is just
 * an observability counter). Returns what was stored. */
export function writeTodo(db: Database, sessionId: string, items: TodoItem[]): TodoItem[] {
  const clean: TodoItem[] = [];
  let chars = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const text = typeof it?.text === "string" ? it.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    const status: TodoStatus = TODO_STATUSES.has(it?.status as TodoStatus)
      ? (it.status as TodoStatus)
      : "pending";
    if (clean.length >= TODO_MAX_ITEMS || chars + text.length > TODO_MAX_CHARS) break;
    clean.push({ text, status });
    chars += text.length;
  }
  db.query(
    `INSERT INTO thread_state (session_id, todo, revision, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(session_id) DO UPDATE SET todo = excluded.todo, revision = revision + 1, updated_at = excluded.updated_at`,
  ).run(sessionId, JSON.stringify(clean), Date.now());
  return clean;
}
