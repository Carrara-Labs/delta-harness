# Reference telemetry collector

A complete, minimal collector for a Delta agent's telemetry: a Postgres table and
a ~60-line Bun HTTP handler. Point a daemon's `TELEMETRY_URL` at it and you have
durable, queryable telemetry — spend, tokens, tool calls, errors, latency — for the
cost of a Postgres.

This is the single-agent distillation of the multi-tenant collector Carrara Labs runs
in production. See the [Telemetry and events](https://github.com/Carrara-Labs/delta-harness/blob/main/site/public/guide.md#telemetry-and-events)
section of the guide for the full contract.

## Run it

```sh
# 1. Create the table
psql "$DATABASE_URL" -f docs/telemetry-collector/schema.sql

# 2. Start the collector
DATABASE_URL=postgres://…  COLLECTOR_TOKEN=a-long-random-secret  PORT=4000 \
  bun run docs/telemetry-collector/server.ts
```

## Point a Delta agent at it

Set these on the daemon and restart it:

```dotenv
TELEMETRY_URL=https://your-host:4000/telemetry/ingest
TELEMETRY_TOKEN=a-long-random-secret        # must equal COLLECTOR_TOKEN
DELTA_CAPTURE_PAYLOADS=1                     # per-call model, provider, latency, tokens, tool names
```

Within a couple of seconds of the agent doing work, rows appear in `agent_events`.

## Query it — the dashboard is SQL

```sql
-- Spend and tokens per run (from run.finished)
SELECT agent_id,
       count(*)                                                          AS runs,
       round(sum((attributes->>'gen_ai.usage.cost_usd')::numeric), 4)    AS cost_usd,
       sum((attributes->>'gen_ai.usage.input_tokens')::numeric)::bigint  AS input_tokens,
       sum((attributes->>'gen_ai.usage.output_tokens')::numeric)::bigint AS output_tokens
FROM agent_events WHERE event_name = 'run.finished' GROUP BY 1 ORDER BY cost_usd DESC;

-- Which model / provider is actually executing (needs DELTA_CAPTURE_PAYLOADS=1)
SELECT attributes->>'gen_ai.request.model' AS model,
       attributes->>'gen_ai.provider'      AS provider,
       count(*)                            AS calls,
       round(avg((attributes->>'latency_ms')::numeric))         AS avg_latency_ms
FROM agent_events WHERE event_name = 'model.call' GROUP BY 1, 2 ORDER BY calls DESC;

-- Most-used tools (needs DELTA_CAPTURE_PAYLOADS=1)
SELECT attributes->>'gen_ai.tool.name' AS tool, count(*) AS calls
FROM agent_events WHERE event_name = 'tool.call' GROUP BY 1 ORDER BY calls DESC;

-- Errors, clustered by type
SELECT attributes->>'error.type' AS error_type, count(*) AS n
FROM agent_events WHERE event_name = 'error' GROUP BY 1 ORDER BY n DESC;
```

## Notes

- The collector dedupes on `event_id`, so the exporter's at-least-once retries never
  double-count.
- It answers `2xx` for accepted batches, `413` for oversize, `401` for a bad token, and
  `5xx` only when the database write fails (which makes the daemon retry — no data loss).
- For many agents, add a `tenant_id` column + a `tenants` FK and stamp it from the authed
  token (never from the wire), exactly as the production collector does.
