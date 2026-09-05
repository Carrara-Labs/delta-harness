// SPDX-License-Identifier: Apache-2.0
// One event stream, three sinks (spec §K). Single emitter: every happening in a
// Run is one structured event carrying the correlation spine user → agent →
// session/run → task → entity → turn. Sink 1 (always-on) is the local SQLite
// `events` table, which doubles as the telemetry outbox; in-process subscribers
// feed SSE (M3). Field names follow OTel GenAI semantic conventions — no OTel SDK.

import type { Database } from "bun:sqlite";
import { providerErrorClass } from "./provider";

export type Spine = {
  userId?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  entityId?: string;
  turn?: number;
};

export type DeltaEvent = Spine & {
  id: number;
  ts: number;
  type: string;
  data: Record<string, unknown>;
};

type Listener = (event: DeltaEvent) => void;

export class Events {
  private listeners = new Set<Listener>();

  constructor(
    private db: Database,
    private base: Spine = {},
  ) {}

  emit(type: string, spine: Spine, data: Record<string, unknown> = {}): void {
    const s = { ...this.base, ...spine };
    const ts = Date.now();
    const row = this.db
      .query(
        `INSERT INTO events (ts, type, user_id, agent_id, session_id, run_id, task_id, entity_id, turn, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        ts,
        type,
        s.userId ?? null,
        s.agentId ?? null,
        s.sessionId ?? null,
        s.runId ?? null,
        s.taskId ?? null,
        s.entityId ?? null,
        s.turn ?? null,
        JSON.stringify(data),
      ) as { id: number };
    const event: DeltaEvent = { id: row.id, ts, type, ...s, data };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {} // a bad subscriber may never break a turn
    }
  }

  // Ephemeral notify — reaches live listeners (SSE) but is NOT persisted to the
  // events table. For high-rate streaming (per-token text deltas) that would
  // bloat the durable log; the structured turn/model.call events keep the record.
  stream(type: string, spine: Spine, data: Record<string, unknown> = {}): void {
    const s = { ...this.base, ...spine };
    const event: DeltaEvent = { id: -1, ts: Date.now(), type, ...s, data };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Live subscriber count — used by tests to assert SSE listeners don't leak. */
  listenerCount(): number {
    return this.listeners.size;
  }
}

/** The four purposes a UTILITY-lane (cheap-model) call can serve. Closed set: it is exported as a
 *  telemetry attribute, so it must not become free text. */
export type UtilityPurpose = "summary" | "research" | "reflection" | "eval_judge";

/** Emit a `model.call` for a utility-lane call (S3, 0.2.13).
 *
 * `model.call` used to fire in exactly ONE place — the main loop — while four paths ran the cheap
 * model and charged the run through `addUsage` without emitting anything. No consumer could see or
 * price the utility tier, and it meant any compaction count derived from telemetry was a floor on
 * attempts rather than a count of them.
 *
 * This helper is the ONLY new writer and it never touches usage, so double-charging is structurally
 * impossible: accounting stays exactly where it was, emission is added beside it.
 *
 * `beforeTurn` exists because a utility call runs BETWEEN turns — compaction is handed
 * `turn: stepCount` while the main call it clears the way for is `stepCount + 1`, so a first-turn
 * compaction legitimately reports turn 0. Rather than renumber and break existing consumers, carry
 * the spine turn as given and name the turn this call enabled. */
export function emitUtilityCall(
  events: Events,
  spine: Spine,
  purpose: UtilityPurpose,
  r: {
    model: string;
    /** Absent on the failure branch of `ModelResult`. */
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite?: number;
      costUsd: number;
    };
    latencyMs?: number;
    error?: string;
    status?: number;
  },
  beforeTurn?: number,
): void {
  // C1 (0.2.16): a failed UTILITY call must be visible. The old "no usage → emit nothing"
  // contract assumed the failure was carried by the retry/error paths — false for children,
  // whose error becomes tool-result TEXT the parent model reads and no operator greps. The
  // Delos D-12 gate run measured the blind spot: 3 child provider 400s in tool results, 0 in
  // stdout, 0 in telemetry (and 24/24 failures hid that way for two weeks before it). One
  // event with the classified enum (never free text — SAFE_ATTRS) plus one stderr line.
  if (!r.usage) {
    if (r.error === undefined) return; // not a ModelResult failure — nothing to say
    events.emit("model.call", spine, {
      "gen_ai.request.model": r.model,
      tier: "utility",
      purpose,
      is_error: true,
      "error.class": providerErrorClass(r.status, r.error),
      ...(beforeTurn !== undefined ? { before_turn: beforeTurn } : {}),
    });
    console.error(
      `delta: ${purpose} model call failed${r.status ? ` (${r.status})` : ""}: ${r.error.slice(0, 200)}`,
    );
    return;
  }
  events.emit("model.call", spine, {
    "gen_ai.request.model": r.model,
    "gen_ai.usage.input_tokens": r.usage.input,
    "gen_ai.usage.output_tokens": r.usage.output,
    "gen_ai.usage.cached_tokens": r.usage.cacheRead,
    ...(r.usage.cacheWrite ? { "gen_ai.usage.cache_write_tokens": r.usage.cacheWrite } : {}),
    "gen_ai.usage.cost_usd": r.usage.costUsd,
    cache_hit_pct: r.usage.input ? Math.round((r.usage.cacheRead / r.usage.input) * 100) : 0,
    tier: "utility",
    purpose,
    ...(r.latencyMs !== undefined ? { latency_ms: r.latencyMs } : {}),
    ...(beforeTurn !== undefined ? { before_turn: beforeTurn } : {}),
  });
}
