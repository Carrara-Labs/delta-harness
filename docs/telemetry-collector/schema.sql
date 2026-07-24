-- Reference telemetry collector — landing table for one Delta agent.
--
-- A Delta daemon with TELEMETRY_URL set POSTs its event stream here as NDJSON
-- (one OTel-GenAI-style record per line). This table is where those records land.
-- It is the single-agent distillation of the multi-tenant table Carrara Labs runs
-- in production; drop in a `tenant_id` column + FK if you collect for many agents.
--
-- Design notes:
--   * The correlation spine (user -> agent -> session/run -> task -> entity -> turn)
--     is stored as top-level, indexed columns so the common dashboard queries
--     (spend per agent, errors per run, activity over time) are cheap.
--   * Free-form OTel attributes go in `attributes` (jsonb) — this is where per-call
--     model, provider, latency, tokens, and tool names live once the daemon runs
--     with DELTA_CAPTURE_PAYLOADS=1.
--   * `event_id` is UNIQUE. The exporter is at-least-once, so the ingest route
--     dedupes replayed batches with ON CONFLICT (event_id) DO NOTHING.
--   * Ids are loose TEXT, never foreign keys: telemetry is append-only fact, and a
--     late or unknown id must never reject a row.

CREATE TABLE IF NOT EXISTS agent_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The exporter's globally-unique, restart-stable id: "<daemon-uuid>:<row-id>".
  event_id       text NOT NULL UNIQUE,
  event_name     text NOT NULL,
  -- Emission time as reported by the daemon (ms since epoch). received_at is ours.
  event_time_ms  bigint NOT NULL,
  -- Correlation spine (all nullable, all loose text).
  user_id        text,
  agent_id       text,
  session_id     text,
  run_id         text,
  task_id        text,
  entity_id      text,
  turn           integer,
  -- OTel attributes. Absent on model.call/tool.call/tool.result unless the daemon
  -- runs with DELTA_CAPTURE_PAYLOADS=1.
  attributes     jsonb,
  received_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_events_agent_idx ON agent_events (agent_id);
CREATE INDEX IF NOT EXISTS agent_events_run_idx   ON agent_events (run_id);
CREATE INDEX IF NOT EXISTS agent_events_task_idx  ON agent_events (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_events_time_idx  ON agent_events (event_time_ms);
CREATE INDEX IF NOT EXISTS agent_events_name_idx  ON agent_events (event_name);
