// SPDX-License-Identifier: Apache-2.0
// Local diagnostic-state retention. `events` and `journal` are pure local observability:
// the Cockpit reads them, and the Exporter ships `events` to a collector WHEN telemetry is
// wired. The catch is who bounds them — the Exporter prunes `events` ONLY when telemetry is
// configured (index.ts), and NOTHING has ever bounded `journal`. So a telemetry-less Delta
// (every `delta dev` agent, and any prod agent without TELEMETRY_URL) grows both tables
// without limit — the exact hole the Sprint-1 plan flagged. This sweep caps both by age AND
// row-count, independent of telemetry.
//
// No VACUUM: deleted pages go to SQLite's freelist and are reused by later inserts, so the
// file is bounded by the live-row high-water mark (which these caps bound) WITHOUT a full
// rewrite. A VACUUM on the live single-writer connection would take the write lock and
// rewrite the whole DB on the serving path — cost we don't pay for a diagnostic table.

import type { Database } from "bun:sqlite";

export type RetentionOpts = {
  /** Wall clock for the age cutoff — passed in so the sweep is deterministic under test. */
  now: number;
  /** Age cutoff: rows older than now-retentionMs are dropped. */
  retentionMs: number;
  /** Hard row cap on `events` — the newest N survive (a backstop when a burst outruns age). */
  maxEvents: number;
  /** Hard row cap on `journal` — the newest N survive. */
  maxJournal: number;
  /** Byte budget for `calls` (request+response text). Bounded by BYTES rather than rows because
   *  a captured call ranges from ~95KB to ~700KB across lanes, so any row count that is generous
   *  for one is ruinous for the other. The newest calls that fit survive. */
  maxCallBytes: number;
  /** When telemetry is ON the Exporter owns `events` pruning: it must keep rows the outbox
   *  hasn't shipped yet, so this sweep leaves `events` untouched and only bounds `journal`.
   *  When OFF, nothing ever marks events exported, so we bound them here as well. */
  telemetryActive: boolean;
};

/** Prune the local diagnostic tables (`journal`, `events`, `calls`). Pure DELETEs — safe on a live
 *  single-writer WAL DB, no transaction needed. Returns the rows deleted (for VACUUM gating +
 *  tests). */
export function pruneLocalState(db: Database, opts: RetentionOpts): number {
  const cutoff = opts.now - opts.retentionMs;
  let deleted = 0;
  // journal — pure-local, always bounded: age first, then a hard count cap on what's left.
  deleted += db.query("DELETE FROM journal WHERE created_at < ?").run(cutoff).changes;
  deleted += db
    .query(
      // Keep the newest maxJournal rows; delete everything past that offset. `journal` has no
      // autoincrement id, so order by its timestamp (rowid breaks same-ms ties deterministically).
      "DELETE FROM journal WHERE rowid IN (SELECT rowid FROM journal ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
    )
    .run(opts.maxJournal).changes;
  // events — leave to the Exporter when telemetry is on (un-shipped rows must survive); bound
  // here only when it's off. id is monotonic, so newest-N = highest ids (mirrors exporter/self).
  if (!opts.telemetryActive) {
    deleted += db.query("DELETE FROM events WHERE ts < ?").run(cutoff).changes;
    deleted += db
      .query("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)")
      .run(opts.maxEvents).changes;
  }
  // calls — the DELTA_CAPTURE_CALLS debug capture. Until 0.2.14 NOTHING bounded it: only deleting
  // a session cleared it, so an operator who turned the flag on and forgot grew the biggest table
  // in the database without limit. Measured on a live agent: 174 rows, 16.5MB, 45% of the file, on
  // a 1GB volume, from a flag staged as temporary a week earlier. A diagnostic that has to be
  // remembered will not be, so it is bounded here whether it is remembered or not.
  deleted += db.query("DELETE FROM calls WHERE created_at < ?").run(cutoff).changes;
  deleted += db
    .query(
      // Keep the newest calls whose CUMULATIVE size fits the budget. The running total is taken
      // over rows STRICTLY NEWER than each candidate (`- own size`), so the newest row is always
      // kept even when it alone exceeds the budget — a bound that could empty the table on a lane
      // with one huge call would make the capture useless exactly where it is needed most.
      // Consequence, and it is the right trade: the retained set can exceed the budget by at most
      // ONE call, because a row is judged on what sits newer than it rather than on the total
      // including itself. Bounded overshoot beats a bound that discards the turn being debugged.
      `DELETE FROM calls WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  SUM(LENGTH(request) + LENGTH(response)) OVER (ORDER BY id DESC)
                    - (LENGTH(request) + LENGTH(response)) AS newer_bytes
             FROM calls
         ) WHERE newer_bytes >= ?
       )`,
    )
    .run(opts.maxCallBytes).changes;
  return deleted;
}
