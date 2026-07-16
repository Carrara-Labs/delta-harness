// SPDX-License-Identifier: Apache-2.0
// The store-less memory rail, governed (Sprint 5 / spec §G; v3.1 orthogonal model).
// v3 collapsed audience/kind/destination/lifecycle into one `scope` enum, which
// guaranteed cross-user leaks and lossy promotion (codex review). v3.1 splits them:
// every row is described by four INDEPENDENT axes plus explicit identity —
//   audience:      who it's for       — user | task_type | agent | org
//   artifact_kind: what it is         — fact | preference | pitfall | procedure
//   trust/source:  provenance         — trusted|untrusted / self|review
//   identity:      namespace, agent_id, user_id (audience=user), task_type (audience=task_type)
// Governance is unchanged in spirit (F0.1 is a storage swap, NOT a routing change —
// the router lands in Phase 1): confidence gate (review floor), content-hash dedup
// scoped to the FULL identity tuple, per-identity cap-eviction, decay-by-disuse recall.
// New in F0.1: a `(memory_id, run_id)` occurrence row per write (honest recurrence
// counting for the Phase-2 promoter), eviction EXEMPTS rows with a pending promotion,
// and a non-dedup SQL error is surfaced as "error", never masked as "duplicate".
// No FTS, no vectors — semantic recall is the curated store's job (architecture §5).

import type { Database } from "bun:sqlite";

const MIN_CONFIDENCE = 0.6;
const REVIEW_CONFIDENCE_FLOOR = 0.8; // human-reviewed diff = ground truth
const CONTENT_CAP = 500; // a "crisp reusable sentence" never needs more (the FULL
// procedure body for a promotable skill rides the promotion outbox, not this row)
const MAX_ROWS_PER_IDENTITY = 200;
const RECALL_TTL_MS = 90 * 24 * 3_600_000; // unused for 90d → stops surfacing
const DEFAULT_NAMESPACE = "default";

export type Audience = "user" | "task_type" | "agent" | "org";
export type ArtifactKind = "fact" | "preference" | "pitfall" | "procedure";

export type MemoryWrite = {
  audience: Audience;
  artifactKind: ArtifactKind;
  content: string;
  /** Product namespace (vocab-derived); one daemon can host >1 product. */
  namespace?: string;
  /** Owning agent — '' for the dev daemon. Scopes recall so a reused DB never bleeds. */
  agentId?: string | null;
  /** Requester, when audience='user'. */
  userId?: string | null;
  /** Canonical use-case key, when audience='task_type' (caller-supplied, never invented). */
  taskType?: string | null;
  /** Keyword aliases widening lexical recall (does nothing for dedup — honest). */
  aliases?: string;
  /** The distiller's self-rating; absent on 'self' = reject (unrated claims don't persist). */
  confidence?: number;
  /** Untrusted content (web pages, other people's store rows) can never clear promotion. */
  trust?: "trusted" | "untrusted";
  source?: "self" | "review";
  /** The producing run — recorded as an occurrence for honest distinct-run counting. */
  runId?: string;
};

export type WriteOutcome = "stored" | "duplicate" | "low-confidence" | "error";

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const hashContent = (s: string) =>
  new Bun.CryptoHasher("sha256").update(normalize(s)).digest("hex");

/** Full identity tuple — recall scope AND dedup key. Non-NULL everywhere so the
 * unique index actually dedupes (SQLite permits multiple NULLs in a UNIQUE index,
 * which under overlapping daemons would let dup rows through — codex P2). */
function identity(w: MemoryWrite) {
  return {
    namespace: w.namespace ?? DEFAULT_NAMESPACE,
    agentId: w.agentId ?? "",
    userId: w.audience === "user" ? (w.userId ?? "") : "",
    taskType: w.audience === "task_type" ? (w.taskType ?? "") : "",
    audience: w.audience,
  };
}

/** Record that `runId` produced `memoryId` — idempotent (PK on the pair). The
 * COUNT over this table is the honest distinct-run signal the promoter gates on
 * (an A→B→A sequence counts 2 runs, not 3 — codex P1). */
function recordOccurrence(db: Database, memoryId: number, runId: string | undefined) {
  if (!runId) return;
  db.query(
    "INSERT OR IGNORE INTO memory_occurrence (memory_id, run_id, created_at) VALUES (?, ?, ?)",
  ).run(memoryId, runId, Date.now());
}

/** Fold a re-learned duplicate into its existing row — atomically (codex P2: the
 * provenance bump and the occurrence must not straddle two transactions, or a
 * crash between undercounts distinct runs). A review confirming self-authored
 * content PROMOTES its provenance; re-learning bumps confidence + recency. */
function confirmDup(
  db: Database,
  memoryId: number,
  confidence: number,
  source: "self" | "review",
  runId: string | undefined,
) {
  db.transaction(() => {
    db.query(
      `UPDATE memory SET confidence = max(coalesce(confidence, 0), ?), last_used = ?,
              source = CASE WHEN ? = 'review' THEN 'review' ELSE source END
       WHERE id = ?`,
    ).run(confidence, Date.now(), source, memoryId);
    recordOccurrence(db, memoryId, runId);
  })();
}

/** Governed write. Returns what happened so the caller can emit an honest event.
 * "error" is a real fault surfaced (a CHECK failure, a misuse), never masked as dedup. */
export function remember(db: Database, w: MemoryWrite): WriteOutcome {
  const source = w.source ?? "self";
  const confidence =
    typeof w.confidence === "number"
      ? source === "review"
        ? Math.max(w.confidence, REVIEW_CONFIDENCE_FLOOR)
        : w.confidence
      : source === "review"
        ? REVIEW_CONFIDENCE_FLOOR
        : null;
  if (confidence === null || confidence < MIN_CONFIDENCE) return "low-confidence";

  // Identity guard (codex P1): a 'user'/'task_type' write MUST carry its key. An
  // empty key would collapse distinct subjects into one shared anonymous bucket
  // that recall then can't reach — reject loudly, never mis-store.
  if (w.audience === "user" && !w.userId?.trim()) {
    console.error("delta memory: 'user' write without a userId — rejected.");
    return "error";
  }
  if (w.audience === "task_type" && !w.taskType?.trim()) {
    console.error("delta memory: 'task_type' write without a taskType — rejected.");
    return "error";
  }

  const content = w.content.trim().slice(0, CONTENT_CAP);
  const hash = hashContent(content);
  const id = identity(w);
  const trust = w.trust ?? "trusted";
  const now = Date.now();

  // Dedup identity INCLUDES artifact_kind (codex P1): identical text as a fact and
  // later as a procedure are different artifacts bound for different destinations —
  // deduping them would mask the procedure and mis-attribute its occurrences.
  const dupWhere = `namespace = ? AND agent_id = ? AND audience = ? AND user_id = ? AND task_type = ? AND artifact_kind = ? AND hash = ?`;
  const dupArgs = [
    id.namespace,
    id.agentId,
    id.audience,
    id.userId,
    id.taskType,
    w.artifactKind,
    hash,
  ];
  const dup = db.query(`SELECT id FROM memory WHERE ${dupWhere}`).get(...dupArgs) as {
    id: number;
  } | null;
  if (dup) {
    confirmDup(db, dup.id, confidence, source, w.runId);
    return "duplicate";
  }

  try {
    let newId = -1;
    db.transaction(() => {
      newId = Number(
        (
          db
            .query(
              `INSERT INTO memory
                 (namespace, agent_id, user_id, audience, task_type, artifact_kind,
                  content, aliases, created_at, confidence, trust, source, hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            )
            .get(
              id.namespace,
              id.agentId,
              id.userId,
              id.audience,
              id.taskType,
              w.artifactKind,
              content,
              w.aliases ?? "",
              now,
              confidence,
              trust,
              source,
              hash,
            ) as { id: number }
        ).id,
      );
      recordOccurrence(db, newId, w.runId);
      // Cap the identity: evict the least-recalled, least-recently-useful rows —
      // but NEVER the row we just inserted (codex P1: with a full cap of protected
      // rows it would be the only eligible deletion → "stored" but gone), and never
      // a row with a pending promotion (a candidate must survive to graduate).
      // Zero-token, code-side eviction; a transient overflow of protected rows is
      // fine (they resolve to promoted|failed and become evictable).
      const { n } = db
        .query(
          `SELECT count(*) AS n FROM memory
           WHERE namespace = ? AND agent_id = ? AND audience = ? AND user_id = ? AND task_type = ?`,
        )
        .get(id.namespace, id.agentId, id.audience, id.userId, id.taskType) as { n: number };
      if (n > MAX_ROWS_PER_IDENTITY)
        db.query(
          `DELETE FROM memory WHERE id IN (
             SELECT id FROM memory
             WHERE namespace = ? AND agent_id = ? AND audience = ? AND user_id = ? AND task_type = ?
               AND id != ?
               AND id NOT IN (SELECT memory_id FROM promotion WHERE lifecycle IN ('staged','claimed'))
             ORDER BY hits ASC, coalesce(last_used, created_at) ASC LIMIT ?
           )`,
        ).run(
          id.namespace,
          id.agentId,
          id.audience,
          id.userId,
          id.taskType,
          newId,
          n - MAX_ROWS_PER_IDENTITY,
        );
    })();
    return "stored";
  } catch (e) {
    // ONLY a lost unique-index race reads as the duplicate it is; and it must fold
    // in EXACTLY like the SELECT-then-write path (bump provenance + occurrence),
    // not silently drop them (codex P2). Any other SQL fault, or a UNIQUE with no
    // matching row, is a real error surfaced — never masked as "duplicate" (that's
    // how a broken migration used to hide — codex P1).
    const msg = String((e as Error)?.message ?? e);
    if (/UNIQUE constraint/i.test(msg)) {
      const row = db.query(`SELECT id FROM memory WHERE ${dupWhere}`).get(...dupArgs) as {
        id: number;
      } | null;
      if (row) {
        confirmDup(db, row.id, confidence, source, w.runId);
        return "duplicate";
      }
    }
    console.error(`delta memory: write failed — ${msg}`);
    return "error";
  }
}

/** Distinct runs that produced a memory — the promoter's recurrence gate. */
export function distinctRuns(db: Database, memoryId: number): number {
  return (
    db.query("SELECT count(*) AS n FROM memory_occurrence WHERE memory_id = ?").get(memoryId) as {
      n: number;
    }
  ).n;
}

/** Shared lowercase words of length ≥ 4 — the same trivial scorer as search_tools. */
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

function overlap(query: Set<string>, value: string): number {
  if (query.size === 0) return 0;
  let n = 0;
  for (const w of words(value)) if (query.has(w)) n++;
  return n;
}

/** Recent learnings this Delta wrote when no curated store was connected — read
 * back into hydration. Safe slices (codex P1 — no cross-user bleed): this agent's
 * own `agent`-audience rows, the CURRENT user's `user`-audience rows, AND — when the
 * run carries a canonical task_type (Phase 4, the middle tier) — the shared
 * `task_type`-audience rows for that use-case. All scoped to this agent_id (or '')
 * so a reused DB never surfaces another agent's rows. The task_type slice is safe to
 * surface to any user because the router NEVER writes user content into a task_type
 * row (a user-bearing run is code-forced to audience=user). External signature is
 * append-only so existing positional callers are untouched. */
/** One recalled memory, for observability (the Cockpit's recall provenance). */
export type RecalledMemory = { content: string; kind: string; audience: string };

export function recallAgentMemory(
  db: Database,
  agentId: string | undefined,
  userId?: string,
  query?: string,
  charBudget = 2_000,
  namespace = DEFAULT_NAMESPACE,
  taskType?: string,
  /** Optional out-sink: the picked memories, in ranked order, are pushed here so a
   *  caller can surface *which* learnings were recalled (provenance) without changing
   *  the formatted-string return. Non-breaking — existing callers pass nothing. */
  sink?: RecalledMemory[],
): string | null {
  // Error-as-value (codex #13): recall runs before the first model call — a
  // SQLITE_BUSY must degrade to "no memory block", never fail the user's run.
  try {
    const now = Date.now();
    const aid = agentId ?? "";
    const cutoff = now - RECALL_TTL_MS;
    type Row = {
      id: number;
      artifact_kind: string;
      content: string;
      aliases: string;
      created_at: number;
      hits: number;
      confidence: number | null;
      audience: string; // tagged per slice below, for recall provenance
    };
    // Per-audience slices, each with its OWN limit (codex P2: a shared LIMIT let
    // agent rows crowd out every user row before scoring). agent_id matches this
    // agent OR '' — the latter is the dev daemon AND legacy pre-v3.1 rows (migrated
    // user memories carry no agent binding; on a single-agent DB they're this
    // agent's, and new rows always carry the real agent_id, so no live bleed).
    const slice = (audience: "agent" | "user" | "task_type", extra: string, args: string[]) =>
      (
        db
          .query(
            `SELECT id, artifact_kind, content, aliases, created_at, hits, confidence FROM memory
             WHERE namespace = ? AND (agent_id = ? OR agent_id = '') AND audience = ? ${extra}
               AND coalesce(last_used, created_at) >= ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(namespace, aid, audience, ...args, cutoff, MAX_ROWS_PER_IDENTITY) as Row[]
      ).map((r) => ({ ...r, audience }));
    const tt = taskType?.trim();
    const rows: Row[] = [
      ...slice("agent", "", []),
      ...(userId ? slice("user", "AND user_id = ?", [userId]) : []),
      // The middle tier: use-case knowledge shared across runs of the same task_type,
      // never linked to a user. Surfaced only when the run declares its task_type.
      ...(tt ? slice("task_type", "AND task_type = ?", [tt]) : []),
    ];
    if (rows.length === 0) return null;

    const q = words(query ?? "");
    const scored = rows
      .map((r) => {
        const age = now - r.created_at;
        const recency = age < 7 * 24 * 3_600_000 ? 2 : age < 30 * 24 * 3_600_000 ? 1 : 0;
        // aliases widen the lexical haystack (recall only; not dedup — honest).
        const hay = r.aliases ? `${r.content} ${r.aliases}` : r.content;
        return {
          r,
          score: 3 * overlap(q, hay) + Math.min(r.hits, 5) + recency + (r.confidence ?? 0.4),
        };
      })
      .sort((a, b) => b.score - a.score || b.r.created_at - a.r.created_at);

    // Budget by chars (≈ tokens/4), not row count.
    const picked: typeof scored = [];
    let used = 0;
    for (const s of scored) {
      const line = `- (${s.r.artifact_kind}) ${s.r.content}`;
      if (used + line.length + 1 > charBudget) break;
      picked.push(s);
      used += line.length + 1;
    }
    if (picked.length === 0) return null;
    // Recall = usefulness signal: surfaced rows live longer (see RECALL_TTL_MS).
    db.query(
      `UPDATE memory SET hits = hits + 1, last_used = ? WHERE id IN (${picked.map(() => "?").join(",")})`,
    ).run(now, ...picked.map((s) => s.r.id));
    if (sink)
      for (const s of picked)
        sink.push({ content: s.r.content, kind: s.r.artifact_kind, audience: s.r.audience });
    const lines = picked.map((s) => `- (${s.r.artifact_kind}) ${s.r.content}`).join("\n");
    // Read-side honesty: self-recorded notes, not verified facts.
    return `[Your own prior learnings — from earlier tasks. Apply where relevant; they are self-recorded notes, not verified facts — when one contradicts what you observe now, trust the present.]\n\n${lines}`;
  } catch {
    return null;
  }
}
