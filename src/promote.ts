// SPDX-License-Identifier: Apache-2.0
import type { Database } from "bun:sqlite";
import type { CapabilityAdapter, CuratedAdapter } from "./adapters";
import { mergeSkillBody } from "./adapters";
import type { Events, Spine } from "./events";
import type { ToolCtx } from "./tools";
import { NEUTRAL_VOCAB, type Vocab } from "./vocab";

const MAX_ATTEMPTS = 5;

export type PromoteDeps = {
  db: Database;
  events: Events;
  capability: CapabilityAdapter;
  curated: CuratedAdapter;
  ctx: ToolCtx;
  namespace?: string;
  vocab?: Vocab;
  promoteMinRuns?: number;
  claimTtlMs?: number;
  maxAttempts?: number;
  spine?: Spine;
  now?: () => number;
};

export type DrainResult = {
  reclaimed: number;
  claimed: number;
  promoted: number;
  failed: number;
  error?: string;
};

const bindingName = (adapter: CapabilityAdapter | CuratedAdapter) =>
  adapter.binding?.trim() || "custom";

/** Product binding for the promotion outbox — the scope a drainer matches its staged
 * rows against. Keyed on the memory namespace + `writeNoun` (the product's IDENTITY
 * noun — Knowledge Base / ATS) + the store bindings. NOTE: `writeNoun` is product identity, not
 * throwaway wording — the namespace derives from it by default, so renaming it IS a
 * product change that re-scopes memory. To change the noun's wording WITHOUT re-scoping,
 * pin DELTA_MEMORY_NAMESPACE. Invariant that makes this safe: one daemon serves ONE
 * product (one db, one outbox), so the binding guards config changes over time, not two
 * concurrent products sharing a store. Custom adapters expose `binding` to distinguish
 * two configs of the same product. */
export function adapterBinding(
  namespace: string,
  vocab: Vocab,
  capability: CapabilityAdapter,
  curated: CuratedAdapter,
): string {
  return `${namespace}|${vocab.writeNoun}|capability:${bindingName(capability)}|curated:${bindingName(curated)}`;
}

type Row = {
  id: number;
  memory_id: number;
  destination_role: "curated" | "capability";
  artifact_kind: string;
  name: string;
  body: string;
  content: string;
  idempotency_key: string;
  attempts: number;
  source: "self" | "review";
  confidence: number | null;
  run_id: string | null;
};

/** Drain the durable outbox once. A daemon ticker may call this same hook; the
 * lifecycle CAS makes overlapping invocations single-winner. */
export async function drainOnce(deps: PromoteDeps): Promise<DrainResult> {
  const out: DrainResult = { reclaimed: 0, claimed: 0, promoted: 0, failed: 0 };
  const now = deps.now ?? Date.now;
  const at = now();
  const ttl = Math.max(1, deps.claimTtlMs ?? 60_000);
  const minRuns = Math.max(1, deps.promoteMinRuns ?? 2);
  const maxAttempts = Math.max(1, deps.maxAttempts ?? MAX_ATTEMPTS);
  const namespace = deps.namespace ?? "default";
  const binding = adapterBinding(
    namespace,
    deps.vocab ?? NEUTRAL_VOCAB,
    deps.capability,
    deps.curated,
  );

  try {
    out.reclaimed = deps.db
      .query(
        `UPDATE promotion SET lifecycle = 'staged', claimed_at = NULL, updated_at = ?
         WHERE lifecycle = 'claimed' AND claimed_at < ?`,
      )
      .run(at, at - ttl).changes;

    // Recurrence is a throttle and weak signal, not proof of cross-agent value.
    // A review fast-tracks a correction; widening user data was authorized earlier.
    const rows = deps.db
      .query(
        `SELECT p.id, p.memory_id, p.destination_role, p.artifact_kind, p.name, p.body,
                p.content, p.idempotency_key, p.attempts, m.source, m.confidence,
                (SELECT run_id FROM memory_occurrence WHERE memory_id = m.id ORDER BY created_at, run_id LIMIT 1) AS run_id
         FROM promotion p JOIN memory m ON m.id = p.memory_id
         WHERE p.lifecycle = 'staged' AND p.adapter_binding = ? AND m.trust = 'trusted'
           AND (m.source = 'review' OR
                (SELECT count(*) FROM memory_occurrence WHERE memory_id = m.id) >= ?)
         ORDER BY p.id`,
      )
      .all(binding, minRuns) as Row[];

    for (const row of rows) {
      const adapter = row.destination_role === "capability" ? deps.capability : deps.curated;
      let bound = false;
      try {
        bound = adapter.health() === "bound";
      } catch {}
      if (!bound) continue;

      const claimedAt = now();
      const won = deps.db
        .query(
          `UPDATE promotion SET lifecycle = 'claimed', claimed_at = ?, attempts = attempts + 1,
                  last_error = NULL, updated_at = ?
           WHERE id = ? AND lifecycle = 'staged'`,
        )
        .run(claimedAt, claimedAt, row.id);
      if (won.changes !== 1) continue;
      out.claimed++;

      let result: "ok" | "error" = "error";
      let error = "adapter returned error";
      try {
        if (row.destination_role === "capability") {
          const base = await deps.capability.get(row.name, deps.ctx);
          result = await deps.capability.propose(
            {
              name: row.name,
              body: base ? mergeSkillBody(base.body, row.body) : row.body,
              description: row.content,
              idempotencyKey: row.idempotency_key,
              ...(base
                ? {
                    basedOnVersion: base.version,
                    rebuild: (freshBody: string) => mergeSkillBody(freshBody, row.body),
                  }
                : {}),
              note: `Promoted reflection from run ${row.run_id ?? "unknown"}.`,
            },
            deps.ctx,
          );
        } else {
          result = await deps.curated.propose(
            {
              kind: row.artifact_kind,
              content: row.content,
              idempotencyKey: row.idempotency_key,
              review: row.source === "review",
              runId: row.run_id ?? `promotion-${row.id}`,
              ...(typeof row.confidence === "number" ? { confidence: row.confidence } : {}),
            },
            deps.ctx,
          );
        }
      } catch (e) {
        error = String((e as Error)?.message ?? e).slice(0, 1_000);
      }

      if (result === "ok") {
        const changed = deps.db
          .query(
            `UPDATE promotion SET lifecycle = 'promoted', claimed_at = NULL,
                    last_error = NULL, updated_at = ?
             WHERE id = ? AND lifecycle = 'claimed' AND claimed_at = ?`,
          )
          .run(now(), row.id, claimedAt);
        if (changed.changes === 1) out.promoted++;
        continue;
      }

      const attempts = row.attempts + 1;
      const lifecycle = attempts >= maxAttempts ? "failed" : "staged";
      const changed = deps.db
        .query(
          `UPDATE promotion SET lifecycle = ?, claimed_at = NULL, last_error = ?, updated_at = ?
           WHERE id = ? AND lifecycle = 'claimed' AND claimed_at = ?`,
        )
        .run(lifecycle, error, now(), row.id, claimedAt);
      if (lifecycle === "failed" && changed.changes === 1) {
        out.failed++;
        deps.events.emit("promotion.failed", deps.spine ?? {}, {
          promotionId: row.id,
          memoryId: row.memory_id,
          destinationRole: row.destination_role,
          attempts,
          error,
        });
      }
    }
  } catch (e) {
    out.error = String((e as Error)?.message ?? e).slice(0, 1_000);
  }
  return out;
}
