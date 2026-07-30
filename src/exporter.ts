// SPDX-License-Identifier: Apache-2.0
// Telemetry exporter (spec §K, sink 3): the `events` table is a durable outbox.
// A background pump batches unexported rows as NDJSON to TELEMETRY_URL —
// non-blocking (never on a turn's path), at-least-once (rows marked exported
// only after a 2xx), drop-on-overflow (telemetry may never wedge a daemon).
// Zero deps: fetch + setInterval.

import type { Database } from "bun:sqlite";
import { daemonId } from "./db";

export type ExporterConfig = {
  url: string;
  /** Full prompts/outputs on/off per tenant (spec §K capture_payloads). */
  capturePayloads: boolean;
  /** Bearer presented to the collector (the tenant's control-plane token). The
   *  collector is authed and stamps the tenant from this — omit only for an open
   *  dev collector. */
  authToken?: string;
  batchSize?: number;
  intervalMs?: number;
  /** Cap on the outbox backlog; beyond it, oldest exported rows are pruned and
   *  unexported overflow is dropped (marked exported) so the table stays bounded. */
  maxBacklog?: number;
  fetchImpl?: typeof fetch;
};

type EventRow = {
  id: number;
  ts: number;
  type: string;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  run_id: string | null;
  task_id: string | null;
  entity_id: string | null;
  turn: number | null;
  data: string;
};

const PAYLOAD_EVENTS = new Set(["model.call", "tool.call", "tool.result"]);

/** Attributes on payload-bearing events that are safe to export WITHOUT payload consent:
 * closed enums, counters, and identifiers only — never prompt text, tool arguments, or tool
 * results. Before this allowlist, capture_payloads=false stripped the WHOLE attribute object,
 * so a default deployment exported model.call/tool.result with no tokens, cost, error class,
 * or fallback flag at all (codex 0.2.6 P1 — the "flag people miss" blind spot). */
const SAFE_ATTRS = new Set([
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.request.effort",
  "gen_ai.response.finish_reasons",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cached_tokens",
  "gen_ai.usage.cost_usd",
  "cache_hit_pct",
  "latency_ms",
  "wall_ms",
  "duration_ms",
  "retries",
  "gen_ai.provider",
  "speed",
  "fallback",
  "gen_ai.tool.name",
  "gen_ai.tool.call.id",
  "tool_calls",
  "is_error",
  "error.class",
  "interrupted",
]);

export class Exporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending = false;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly maxBacklog: number;
  private readonly doFetch: typeof fetch;
  /** Stable per-daemon prefix for globally-unique event ids (idempotency key). */
  private readonly daemonId: string;

  constructor(
    private db: Database,
    private cfg: ExporterConfig,
  ) {
    this.batchSize = cfg.batchSize ?? 200;
    this.intervalMs = cfg.intervalMs ?? 2000;
    this.maxBacklog = cfg.maxBacklog ?? 50_000;
    this.doFetch = cfg.fetchImpl ?? fetch;
    this.daemonId = daemonId(db);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Serialize one batch to NDJSON, POST it, mark exported on 2xx. Returns the
   *  number of rows shipped (0 on empty or on a failed send — retried next tick). */
  async flush(): Promise<number> {
    if (this.sending) return 0;
    this.sending = true;
    try {
      this.prune();
      const rows = this.db
        .query("SELECT * FROM events WHERE exported = 0 ORDER BY id LIMIT ?")
        .all(this.batchSize) as EventRow[];
      if (rows.length === 0) return 0;

      const ndjson = `${rows.map((r) => JSON.stringify(this.toRecord(r))).join("\n")}\n`;
      let ok = false;
      try {
        const res = await this.doFetch(this.cfg.url, {
          method: "POST",
          headers: {
            "content-type": "application/x-ndjson",
            ...(this.cfg.authToken ? { authorization: `Bearer ${this.cfg.authToken}` } : {}),
          },
          body: ndjson,
          signal: AbortSignal.timeout(15_000),
        });
        ok = res.ok;
      } catch {
        ok = false; // network error — leave unexported, retry next tick
      }
      if (!ok) return 0;

      const ids = rows.map((r) => r.id);
      this.db
        .query(`UPDATE events SET exported = 1 WHERE id IN (${ids.map(() => "?").join(",")})`)
        .run(...ids);
      return rows.length;
    } finally {
      this.sending = false;
    }
  }

  /** OTel-GenAI-style record (spec §K). Correlation spine as top-level fields;
   *  attributes under `data`. Payload-bearing events drop `data` unless the
   *  tenant opted in — secrets and full prompts never leave without consent. */
  private toRecord(r: EventRow): Record<string, unknown> {
    const includeData = this.cfg.capturePayloads || !PAYLOAD_EVENTS.has(r.type);
    // No payload consent → keep the safe metric/enum subset instead of dropping everything.
    let attributes: Record<string, unknown> | undefined;
    if (includeData) attributes = JSON.parse(r.data);
    else {
      const filtered = Object.fromEntries(
        Object.entries(JSON.parse(r.data) as Record<string, unknown>).filter(([k]) =>
          SAFE_ATTRS.has(k),
        ),
      );
      if (Object.keys(filtered).length) attributes = filtered;
    }
    return {
      // Globally-unique + restart-stable: the collector dedupes on this (the
      // exporter is at-least-once, so a replayed batch must not duplicate).
      "event.id": `${this.daemonId}:${r.id}`,
      "event.name": r.type,
      "event.time_unix_ms": r.ts,
      "user.id": r.user_id,
      "agent.id": r.agent_id,
      "session.id": r.session_id,
      "run.id": r.run_id,
      "task.id": r.task_id,
      "entity.id": r.entity_id,
      turn: r.turn,
      ...(attributes ? { attributes } : {}),
    };
  }

  /** Keep the outbox bounded. Delete already-exported rows first; if unexported
   *  rows alone still exceed the cap, drop the oldest (mark exported) — telemetry
   *  loss beats unbounded local growth (spec §K drop-on-overflow). */
  private prune(): void {
    const total = (this.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    if (total <= this.maxBacklog) return;
    this.db.query("DELETE FROM events WHERE exported = 1").run();
    const remaining = (this.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    if (remaining <= this.maxBacklog) return;
    const overflow = remaining - this.maxBacklog;
    this.db
      .query(
        "UPDATE events SET exported = 1 WHERE id IN (SELECT id FROM events WHERE exported = 0 ORDER BY id LIMIT ?)",
      )
      .run(overflow);
  }
}
