// SPDX-License-Identifier: Apache-2.0
// Run-lease / single-writer (F0.5, plan H3). A coarse guard that stops TWO machines
// from writing to one DB (on a shared/reattached volume) with the same knowledge-base principal —
// the token-family-revocation hazard. Identity is MACHINE-scoped (config.leaseHolder),
// so a crashed daemon's restart on the SAME machine reclaims instantly; a different
// machine waits out the TTL. Known, accepted bounds (documented, not bugs):
//   • Wall-clock, not a logical clock (codex P1): cross-machine skew can steal/lock-out
//     for the skew duration. Bounded in practice — Fly machines are NTP-synced (sub-second)
//     and the TTL (≥5s, default 30s) dwarfs it. Not worth a logical clock here.
//   • Coarse, not per-write fenced (codex P1): after an event-loop pause > TTL a stale
//     holder could write before its heartbeat detects the loss. A >TTL Bun pause is
//     extreme; the Phase-2 promoter's CAS/idempotency is the real double-write backstop.
//   • config.leaseHolder MUST be unique per machine. The default (FLY_MACHINE_ID ??
//     hostname) is; a duplicated DELTA_LEASE_HOLDER override across machines defeats
//     exclusion (both match the holder_id branch). Same-machine double-start is caught
//     separately by the port bind (index.ts), before any work resumes.
import type { Database } from "bun:sqlite";

export function acquireLease(
  db: Database,
  holderId: string,
  ttlMs: number,
  now: () => number = Date.now,
): boolean {
  try {
    const at = now();
    return db.transaction(() => {
      // Take the lease iff it's unheld (INSERT), expired, OR already ours. The
      // same-holder branch is the crash-restart path: a killed daemon's fast restart
      // on the same machine reclaims AND refreshes its own lease atomically, instead of
      // waiting out the TTL. A DIFFERENT live holder → WHERE false → 0 changes → false.
      const result = db
        .query(
          `INSERT INTO lease (name, holder_id, acquired_at, expires_at, heartbeat_at)
           VALUES ('writer', ?, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET
             holder_id = excluded.holder_id,
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at,
             heartbeat_at = excluded.heartbeat_at
           WHERE lease.expires_at <= ? OR lease.holder_id = ?`,
        )
        .run(holderId, at, at + ttlMs, at, at, holderId);
      return result.changes === 1;
    })();
  } catch {
    return false;
  }
}

export function renewLease(
  db: Database,
  holderId: string,
  ttlMs: number,
  now: () => number = Date.now,
): boolean {
  try {
    const at = now();
    return (
      db
        .query(
          `UPDATE lease SET expires_at = ?, heartbeat_at = ?
           WHERE name = 'writer' AND holder_id = ? AND expires_at > ?`,
        )
        .run(at + ttlMs, at, holderId, at).changes === 1
    );
  } catch {
    return false;
  }
}

export function releaseLease(db: Database, holderId: string): void {
  try {
    db.query("DELETE FROM lease WHERE name = 'writer' AND holder_id = ?").run(holderId);
  } catch {}
}
