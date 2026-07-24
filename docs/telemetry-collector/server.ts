// Reference telemetry collector for Delta — a complete, paste-able receiver.
//
//   bun run docs/telemetry-collector/server.ts
//
// Env:
//   DATABASE_URL     Postgres connection string (schema.sql applied first)
//   COLLECTOR_TOKEN  shared secret; must equal the agent's TELEMETRY_TOKEN
//   PORT             listen port (default 4000)
//
// Point a Delta daemon at it:
//   TELEMETRY_URL=https://your-host/telemetry/ingest
//   TELEMETRY_TOKEN=<same as COLLECTOR_TOKEN>
//   DELTA_CAPTURE_PAYLOADS=1     # so model/tool events carry attributes
//
// The contract that keeps a daemon's export pump healthy:
//   * dedupe on event.id (the exporter is at-least-once) via ON CONFLICT DO NOTHING
//   * skip malformed LINES, never fail the whole batch on one bad line
//   * always answer 2xx for accepted work; only 401 (auth) and 413 (oversize) reject
//   * a DB failure returns 5xx ON PURPOSE — the daemon then retries, so nothing is lost
//   * derive trust from the token, never from ids in the payload

import { SQL } from "bun";

const db = new SQL(process.env.DATABASE_URL ?? "");
const TOKEN = process.env.COLLECTOR_TOKEN ?? "";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // exporter ships <=200 small records/tick
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

Bun.serve({
  port: Number(process.env.PORT ?? 4000),
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/telemetry/ingest")
      return new Response("not found", { status: 404 });

    // Auth from the bearer token — never trust identity in the payload.
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`)
      return Response.json({ error: "unauthorized" }, { status: 401 });

    // Bound the batch so an authed client can't OOM the collector.
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
      return Response.json({ error: "batch too large" }, { status: 413 });
    const body = await req.text();
    if (body.length > MAX_BODY_BYTES)
      return Response.json({ error: "batch too large" }, { status: 413 });

    // Parse NDJSON -> rows. Dedupe within the batch by event_id (last line wins);
    // drop malformed lines rather than failing the whole pump.
    const byId = new Map<string, Record<string, unknown>>();
    let malformed = 0;
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      const eventId = str(rec["event.id"]);
      const eventName = str(rec["event.name"]);
      const eventTimeMs = num(rec["event.time_unix_ms"]);
      if (!eventId || !eventName || eventTimeMs === null) {
        malformed++;
        continue;
      }
      byId.set(eventId, {
        event_id: eventId,
        event_name: eventName,
        event_time_ms: eventTimeMs,
        user_id: str(rec["user.id"]),
        agent_id: str(rec["agent.id"]),
        session_id: str(rec["session.id"]),
        run_id: str(rec["run.id"]),
        task_id: str(rec["task.id"]),
        entity_id: str(rec["entity.id"]),
        turn: num(rec.turn),
        attributes: rec.attributes ? JSON.stringify(rec.attributes) : null,
      });
    }

    // Insert. A DB error throws -> 500 -> the daemon retries the batch (no data loss).
    let inserted = 0;
    try {
      for (const r of byId.values()) {
        const done = await db`
          INSERT INTO agent_events (event_id, event_name, event_time_ms, user_id,
            agent_id, session_id, run_id, task_id, entity_id, turn, attributes)
          VALUES (${r.event_id}, ${r.event_name}, ${r.event_time_ms}, ${r.user_id},
            ${r.agent_id}, ${r.session_id}, ${r.run_id}, ${r.task_id}, ${r.entity_id},
            ${r.turn}, ${r.attributes}::jsonb)
          ON CONFLICT (event_id) DO NOTHING
          RETURNING 1`;
        inserted += done.length;
      }
    } catch (err) {
      console.error("ingest DB error:", err);
      return Response.json({ error: "storage failed" }, { status: 500 });
    }

    const received = byId.size;
    return Response.json({ received, inserted, duplicates: received - inserted, malformed });
  },
});

console.log(`telemetry collector listening on :${process.env.PORT ?? 4000}`);
