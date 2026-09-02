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
import { ELIDED_KEY, type RecallHit, type TodoItem, type TodoStatus } from "./tools";

/** One tool call as stored on an assistant message row. */
type AssistantToolCall = { id: string; function: { name: string; arguments: string } };

import { HARNESS_VERSION } from "./version";

export const MIGRATIONS: string[] = [
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
  // The Secret Vault (0.2.10): third-party credentials, encrypted at rest (AES-256-GCM,
  // key from DELTA_VAULT_KEY, never stored). Lives HERE — in the daemon DB, outside the
  // model-writable workspace — so the confined file tools cannot reach even the ciphertext.
  // Nothing reads a value except engine egress code (vault.ts).
  `
  CREATE TABLE vault (
    name       TEXT PRIMARY KEY,
    purpose    TEXT NOT NULL DEFAULT '',
    value_enc  BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 0.2.12: the artifact-manifest scan needs a bounded id range within a session, and so does its
  // floor query. `messages_session(session_id, active, id)` cannot serve `MAX(id)` or an ORDER BY
  // without a temp b-tree, so a long durable session paid a full-range scan to compute the floor
  // before the bounded scan even began (codex P1). IF NOT EXISTS so replaying migrations over a
  // database that already has it is a no-op.
  `
  CREATE INDEX IF NOT EXISTS messages_session_id ON messages(session_id, id);
  `,
  // Long-horizon (2026-09-02): a real index for `recall`. This migration has never shipped in a
  // release, so its trigger set was completed in place rather than by a follow-up migration; the
  // first published version carrying v16 carries all three triggers. Four review rounds of LIKE-scan designs
  // ended at the same wall: any-term matching over a 5,000-row window of ~20KB rows is either a
  // memory bound (materialize the window) or a CPU bound (one pass per term) on a 1-vCPU 512MB
  // machine. FTS5 is neither: word-level, unicode-folded (diacritics removed), bm25-ranked, and
  // O(log) per term. External-content over `messages` (no second copy of the text; the index
  // holds tokens only), kept in step by triggers. The only writer that deletes message rows is
  // the session wipe in queue.ts, covered by the delete trigger. Backfilled here in one pass.
  `
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    msg, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
  );
  INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, msg) VALUES (new.id, new.msg);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, msg) VALUES ('delete', old.id, old.msg);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF msg ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, msg) VALUES ('delete', old.id, old.msg);
    INSERT INTO messages_fts(rowid, msg) VALUES (new.id, new.msg);
  END;
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
    // The refusal is correct and stays. What was missing is what the operator does NEXT: a lane
    // rolled back to an older image crash-loops to its restart cap, and the obvious recovery —
    // destroy the volume — also destroys the agent's LEARNED DELTA.md, which is a workspace file
    // and not in this database at all. Aperture hit exactly this rolling Speed Lab back from
    // 0.2.12 to 0.2.11. So say what is salvageable before someone reaches for the destructive fix.
    throw new Error(
      `delta: database schema v${version} is newer than this binary supports (v${MIGRATIONS.length}). ` +
        `Refusing to open — a downgrade would corrupt state.\n` +
        `  Fix: run a daemon at or above the version that wrote this database. An upgrade is ` +
        `one-way; roll FORWARD, not back.\n` +
        `  Before destroying this volume: your workspace is NOT in this database and is intact on ` +
        `disk. Copy the WHOLE directory at $DELTA_WORKSPACE (the container default is ` +
        `/data/workspace, not /data) off first — it holds DELTA.md, the agent's learned self-file. ` +
        `Recreating the volume loses everything the agent has learned, permanently. Verify the ` +
        `copy is non-empty before you destroy anything.`,
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
/** Candidate rows the index returns per search, best bm25 first. Bounded memory whatever the
 * corpus: the index does the ranking, JS only renders snippets and dedupes. */
const SCAN_ROWS = 60;
/** Words that carry no recall signal; a search of only these returns nothing rather than everything.
 * Small on purpose: an unknown word is far likelier to be an identifier than a function word. */
const STOPWORDS = new Set(
  "the and for with that this from are was were has have had not but you your our their they them who what when where which how all any into over under about after before than then there here its it's been being does did done can could would should will just also very more most some such only same each both out off up down per via".split(
    " ",
  ),
);
/** Query words, tokenized on word boundaries (the model writes "Maria Delgado, Acme"), stopwords
 * dropped, capped at 6 distinct terms. Shared by the index query, the JS ranking pass and the
 * archive search so a multi-word query behaves the same everywhere (codex P2). */
/** Case and diacritics folded, the same way the index tokenizer folds them, so the JS re-check on
 * readable text agrees with what the index matched ("Martínez" answers "martinez"). */
export const fold = (x: string): string =>
  x
    .normalize("NFD")
    // Only marks that follow a LATIN base letter are stripped, which is exactly what the index
    // tokenizer's `remove_diacritics 2` does; Greek, Hebrew and Arabic marks stay so the JS
    // re-check agrees with the index on those scripts too (codex P2).
    .replace(/([A-Za-z\u00C0-\u024F])\p{M}+/gu, "$1")
    .replace(/\u017F/g, "s") // long s, folded by unicode61 too (codex P3)
    .normalize("NFC")
    .toLowerCase();
export function recallTerms(q: string): string[] {
  return [
    ...new Set(
      fold(q)
        .split(/[^\p{L}\p{M}\p{N}@._/%-]+/u)
        .map((w) => w.replace(/^[._/-]+|[._/-]+$/g, ""))
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ].slice(0, 6);
}

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
  // Word-level, ranked (2026-09-02). The phrase LIKE this replaced required the whole query to
  // appear contiguously: "Maria Delgado Acme" missed a row that said "Maria Delgado, at Acme".
  // The recall eval on real compactions scored that backend at a 0-25% hit rate on facts known
  // to be in the archive. Now every word of 3+ chars is a term; a row qualifies on ANY term and
  // ranks by how many distinct terms it carries, then by recency, so a whole-phrase hit still
  // wins and a partial one is found instead of nothing. Each term is LIKE-escaped.
  const terms = recallTerms(q);
  if (!terms.length) return []; // an all-stopword query matches everything and ranks nothing
  const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  // The window is the newest SCAN_WINDOW rows OF THIS SESSION, not a span of global ids: ids are
  // shared across sessions, so a busy sibling session could push this session's compacted rows
  // out of a global-id window while they were the only rows here (codex P2). The recovery footer
  // promises compacted rows stay searchable; this is what makes that true.
  const { floor } = db
    .query(
      `SELECT COALESCE((SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?), 0) - 1 AS floor`,
    )
    .get(sessionId, SCAN_WINDOW - 1) as { floor: number };
  // The index answers "which rows carry ANY of these words", ranked by bm25 (rare words weigh
  // more, so a common word cannot bury a rare one), bounded to SCAN_ROWS candidates and scoped to
  // this session's newest SCAN_WINDOW rows. Each term is a quoted prefix token (`"delgad"*`), so
  // a stem or a truncated identifier still hits; FTS quoting neutralizes query syntax. The JS pass
  // below re-checks readable text, dedupes and renders the snippet exactly as before.
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
  const rows = db
    .query(
      // CROSS JOIN pins the plan: the index probe runs ONCE and drives the row lookups. Left to
      // the planner, `messages_session_id` went first and the FTS probe re-ran per row: ~15s for
      // one common term over a 100MB window (codex P1). Pinned by a query-plan test.
      `SELECT m.msg AS msg, m.active AS active, m.run_id AS run_id, r.seq AS seq
       FROM messages_fts f
       CROSS JOIN messages m ON m.id = f.rowid
       JOIN runs r ON r.id = m.run_id
       WHERE messages_fts MATCH ? AND m.session_id = ? AND m.id > ?
       ORDER BY bm25(messages_fts), m.id DESC
       LIMIT ?`,
    )
    .all(match, sessionId, floor, SCAN_ROWS) as Array<{
    msg: string;
    active: number;
    run_id: string;
    seq: number;
  }>;
  const ql = fold(q);
  const seen = new Map<string, RecallHit & { score: number }>();
  /** Per (run_id, call_id): the query terms a VISIBLE hit already covers. The archive pass skips an
   * elided body only when every term it carries is already represented by that visible hit; a
   * body matching a term the visible arguments do not is new evidence, not a duplicate (codex P1). */
  const matched = new Map<string, Set<string>>();
  const cover = (key: string, ts: string[]) => {
    const set = matched.get(key) ?? new Set<string>();
    for (const t of ts) set.add(t);
    matched.set(key, set);
  };
  for (const row of rows) {
    let m: ChatMsg & { tool_calls?: AssistantToolCall[] };
    try {
      m = JSON.parse(row.msg) as ChatMsg & { tool_calls?: AssistantToolCall[] };
    } catch {
      continue;
    }
    const text = msgText(m);
    const lower = fold(text);
    // Rank: a whole-phrase hit scores above any partial; otherwise the distinct terms present.
    const phraseIdx = lower.indexOf(ql);
    const hitTerms = terms.filter((t) => lower.includes(t));
    if (!hitTerms.length) continue; // matched JSON scaffolding, not readable content — skip
    const score = (phraseIdx >= 0 ? terms.length + 1 : 0) + hitTerms.length;
    const idx = phraseIdx >= 0 ? phraseIdx : lower.indexOf(hitTerms[0] as string);
    if (m.role === "tool")
      cover(`${row.run_id}:${(m as { tool_call_id: string }).tool_call_id}`, hitTerms);
    // Only the call whose VISIBLE arguments carry the term is covered by this hit. Marking every
    // call on a multi-call assistant would let a match in call A suppress the archived body of
    // call B, which is a silent loss rather than a dedupe (codex P1).
    for (const c of m.tool_calls ?? []) {
      const al = fold(c.function.arguments);
      const argTerms = terms.filter((t) => al.includes(t));
      if (argTerms.length) cover(`${row.run_id}:${c.id}`, argTerms);
    }
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
      score,
      ...(spillPath ? { spillPath } : {}),
    });
  }
  // Archived (compacted-out) hits first, as before, then by rank, then recency (insertion order).
  const transcript = [...seen.values()]
    .sort((a, b) => Number(a.active) - Number(b.active) || b.score - a.score)
    .slice(0, n)
    .map(({ score: _score, ...hit }) => hit);
  // Fill any REMAINING slots from the archive, never the other way round: a run with many elided
  // payloads must not crowd unrelated live or compacted hits out of the limit (codex P1).
  if (transcript.length >= n) return transcript;
  return [...transcript, ...searchArchive(db, sessionId, q, n - transcript.length, matched)];
}

/** Keyword-search the bodies that S1 elided out of the window. Without this, eliding an argument
 * would DELETE a capability: `msgText` renders assistant calls as `name(arguments)`, so today
 * `recall("ABC-123")` finds an identifier inside a stored payload, and an agent that can no longer
 * find what it filed is worse than one that pays to remember it.
 *
 * Bounded by construction: the candidate set comes from the manifest scan (a small explicit list of
 * references), and each body is then fetched by PRIMARY KEY. Journal growth cannot slow this down,
 * and nothing ever LIKEs `journal.args`. */
function searchArchive(
  db: Database,
  sessionId: string,
  query: string,
  limit: number,
  matched: Map<string, Set<string>>,
): RecallHit[] {
  const terms = recallTerms(query);
  const ql = fold(query);
  const out: RecallHit[] = [];
  const emitted = new Set<string>(); // one hit per (run, call): two elided fields are one finding
  for (const ref of listArtifacts(db, sessionId)) {
    if (out.length >= limit) break;
    if (emitted.has(`${ref.runId}:${ref.callId}`)) continue;
    const row = db
      .query("SELECT args FROM journal WHERE run_id = ? AND call_id = ?")
      .get(ref.runId, ref.callId) as { args: string } | null;
    if (!row) continue; // body pruned by the journal's ordinary retention — nothing to search
    let value: unknown;
    try {
      const parsed = JSON.parse(row.args) as Record<string, unknown>;
      value = ref.field === null ? parsed : parsed[ref.field];
    } catch {
      continue;
    }
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    const lower = fold(text);
    // Same contract as the transcript pass: whole phrase first, else any term (codex P2).
    const phraseIdx = lower.indexOf(ql);
    const bodyTerms = terms.filter((t) => lower.includes(t));
    if (phraseIdx < 0 && !bodyTerms.length) continue;
    // Deduped against the transcript by (run_id, call_id) AND by term: skipped only when the
    // visible hit already covered every term this body carries (codex P1).
    const covered = matched.get(`${ref.runId}:${ref.callId}`);
    if (covered && bodyTerms.every((t) => covered.has(t))) continue;
    const idx = phraseIdx >= 0 ? phraseIdx : lower.indexOf(bodyTerms[0] as string);
    emitted.add(`${ref.runId}:${ref.callId}`);
    const start = Math.max(0, idx - 400);
    const end = Math.min(text.length, idx + ql.length + 400);
    out.push({
      role: "archived",
      runSeq: ref.runSeq,
      active: false,
      snippet:
        `[${ref.tool}.${ref.field}, ${ref.bytes} bytes, dropped from context — ` +
        `read it back with recall({artifact:{run_seq:${ref.runSeq},call_id:${JSON.stringify(ref.callId)},field:${JSON.stringify(ref.field)}}})]\n` +
        `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    });
  }
  return out;
}

// --- 0.2.12: the elided-argument archive ---
//
// S1 replaces an over-budget tool-call argument value with a ~60-byte marker in the message row and
// leaves the full arguments in `journal.args`. That split is deliberate: the MANIFEST (what did I
// file, and how much) is small enough to keep for the life of the message, while the BODY is large,
// rarely needed, and stays under the journal's EXISTING retention. Nothing here pins a row or adds
// a retention exception — durable recall, no session expiry and a hard storage ceiling cannot all
// be true, so the permanent thing is the one that costs ~60 bytes.
//
// Discovery runs off the manifest, never off a filesystem path parsed out of model-visible prose:
// scan the same bounded id window `searchHistory` uses for marker-bearing rows, which yields a
// small explicit set of (run_id, call_id, field) references, then hit `journal` by PRIMARY KEY.
// Journal growth therefore cannot slow this down.

/** One elided argument value, as named by the manifest in the transcript. */
export type ArtifactRef = {
  runId: string;
  runSeq: number | null;
  callId: string;
  tool: string;
  /** The elided key, or null for a whole-object collapse. */
  field: string | null;
  bytes: number;
};

/** How many distinct CALLS one manifest scan will surface. Bounding raw field references instead
 * let a single newer call with 200 elided fields hide every older call from the archive search
 * (codex P1) — the limit has to be on the thing the search iterates. */
const ARTIFACT_MAX_CALLS = 200;

/** Default bytes of an archived body per `recall` read. The CALLER passes the run's real result cap
 * so the page can never itself trip `capAndSpill` and write a spill file into a durable session
 * (codex P1) — a fixed 8KB was wrong the moment an operator set a smaller cap. The agent pages
 * through with `offset` instead. */
export const ARTIFACT_CHUNK = 8_000;

/** The manifest for THIS session: every elided argument value still named in the transcript,
 * newest first. Deduped by (run_id, call_id, field) so compaction's re-inserted tail copies count
 * once. Inactive rows are included — compaction deactivates originals and a failed finalize only
 * deactivates, and the agent's own record of what it filed must survive both. */
export function listArtifacts(
  db: Database,
  sessionId: string,
  limit = ARTIFACT_MAX_CALLS,
): ArtifactRef[] {
  // The window is the newest SCAN_WINDOW rows OF THIS SESSION, not a span of global ids: ids are
  // shared across sessions, so a busy sibling session could push this session's compacted rows
  // out of a global-id window while they were the only rows here (codex P2). The recovery footer
  // promises compacted rows stay searchable; this is what makes that true.
  const { floor } = db
    .query(
      `SELECT COALESCE((SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?), 0) - 1 AS floor`,
    )
    .get(sessionId, SCAN_WINDOW - 1) as { floor: number };
  // `_` is a LIKE wildcard — escape it, or this matches far more than the marker. The id range and
  // the floor above both ride `messages_session_id(session_id, id)`, added for exactly this.
  const rows = db
    .query(
      `SELECT m.msg AS msg, m.run_id AS run_id, r.seq AS seq
         FROM messages m JOIN runs r ON r.id = m.run_id
        WHERE m.session_id = ? AND m.id > ? AND m.msg LIKE ? ESCAPE '\\'
        ORDER BY m.id DESC`,
    )
    .all(sessionId, floor, `%\\${ELIDED_KEY}%`) as Array<{
    msg: string;
    run_id: string;
    seq: number;
  }>;
  const seen = new Map<string, ArtifactRef>();
  const calls = new Set<string>(); // the limit counts CALLS, not fields
  for (const row of rows) {
    if (calls.size >= limit) break;
    let m: ChatMsg & { tool_calls?: AssistantToolCall[] };
    try {
      m = JSON.parse(row.msg) as ChatMsg & { tool_calls?: AssistantToolCall[] };
    } catch {
      continue;
    }
    for (const call of m.tool_calls ?? []) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      // The whole-object collapse: `elideArgs` returns ONE root marker when the key count alone
      // blows the cap. Without this it would be invisible to enumeration, search and readback.
      const callKey = `${row.run_id}:${call.id}`;
      if (!seen.size || calls.has(callKey) || calls.size < limit) calls.add(callKey);
      else continue;
      const rootBytes = elidedBytes(args);
      if (rootBytes !== null) {
        const key = JSON.stringify([row.run_id, call.id, null]);
        if (!seen.has(key))
          seen.set(key, {
            runId: row.run_id,
            runSeq: row.seq ?? null,
            callId: call.id,
            tool: call.function.name,
            field: null, // the whole argument object
            bytes: rootBytes,
          });
        continue;
      }
      for (const [field, value] of Object.entries(args)) {
        const bytes = elidedBytes(value);
        if (bytes === null) continue;
        const key = JSON.stringify([row.run_id, call.id, field]); // colons occur in call ids AND field names
        if (seen.has(key)) continue;
        seen.set(key, {
          runId: row.run_id,
          runSeq: row.seq ?? null,
          callId: call.id,
          tool: call.function.name,
          field,
          bytes,
        });
      }
    }
  }
  return [...seen.values()];
}

/** The marker's byte count, or null if this value is not one. Shape-checked, not name-checked:
 * a legitimate argument could contain the key, and readback resolves from the journal anyway, so a
 * forged marker can only ever produce a phantom manifest entry — never a false body. */
function elidedBytes(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const mark = (value as Record<string, unknown>)[ELIDED_KEY];
  if (!mark || typeof mark !== "object") return null;
  const n = (mark as { bytes?: unknown }).bytes;
  return typeof n === "number" ? n : null;
}

/** Read one archived value back, a chunk at a time. Session-bound through `journal → runs`, and the
 * reference must be named by a real manifest entry, so no caller can aim this at another session or
 * at a call the transcript never made. Returns null when the reference is unknown; returns
 * `retained: false` when the journal has since pruned the body, which is the honest answer rather
 * than an empty one — the marker never promised a file, so nothing here can rot into a lie. */
export function readArtifact(
  db: Database,
  sessionId: string,
  ref: { runSeq: number; callId: string; field: string | null },
  offset = 0,
  maxChars = ARTIFACT_CHUNK,
): { text: string; offset: number; total: number; more: boolean; retained: boolean } | null {
  const named = listArtifacts(db, sessionId).find(
    (a) => a.runSeq === ref.runSeq && a.callId === ref.callId && a.field === ref.field,
  );
  if (!named) return null;
  const row = db
    .query(
      `SELECT j.args AS args FROM journal j JOIN runs r ON r.id = j.run_id
        WHERE j.run_id = ? AND j.call_id = ? AND r.session_id = ?`,
    )
    .get(named.runId, named.callId, sessionId) as { args: string } | null;
  if (!row) return { text: "", offset: 0, total: named.bytes, more: false, retained: false };
  let value: unknown;
  try {
    const parsed = JSON.parse(row.args) as Record<string, unknown>;
    value = ref.field === null ? parsed : parsed[ref.field];
  } catch {
    return { text: "", offset: 0, total: named.bytes, more: false, retained: false };
  }
  // A marker-shaped value in the JOURNAL means the model itself sent one — nothing was elided here,
  // so there is no body to hand back and claiming otherwise would be a false artifact.
  if (value === undefined || elidedBytes(value) !== null)
    return { text: "", offset: 0, total: named.bytes, more: false, retained: false };
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const start = Math.max(0, Math.floor(offset) || 0);
  // Leave room for the tool's own framing line, which is also counted against the result cap.
  const room = Math.max(200, Math.min(ARTIFACT_CHUNK, Math.floor(maxChars * 0.6)));
  const slice = text.slice(start, start + room);
  return {
    text: slice,
    offset: start,
    total: text.length,
    more: start + slice.length < text.length,
    retained: true,
  };
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
