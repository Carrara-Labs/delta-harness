// SPDX-License-Identifier: Apache-2.0
// One event stream, three sinks (spec §K). Single emitter: every happening in a
// Run is one structured event carrying the correlation spine user → agent →
// session/run → task → entity → turn. Sink 1 (always-on) is the local SQLite
// `events` table, which doubles as the telemetry outbox; in-process subscribers
// feed SSE (M3). Field names follow OTel GenAI semantic conventions — no OTel SDK.

import type { Database } from "bun:sqlite";

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
