// M3: telemetry exporter validated against a dummy NDJSON collector.

import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { Events } from "../src/events";
import { Exporter } from "../src/exporter";

function collector() {
  const received: Array<Record<string, unknown>> = [];
  let failNext = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (failNext > 0) {
        failNext--;
        return new Response("down", { status: 503 });
      }
      const body = await req.text();
      for (const line of body.split("\n").filter(Boolean)) received.push(JSON.parse(line));
      return new Response("ok");
    },
  });
  return {
    url: `http://localhost:${server.port}/`,
    received,
    stop: () => server.stop(),
    failTimes: (n: number) => {
      failNext = n;
    },
  };
}

describe("exporter", () => {
  test("ships events as NDJSON with the correlation spine, marks them exported (at-least-once)", async () => {
    const db = openDb(":memory:");
    const events = new Events(db, { agentId: "delta-1" });
    events.emit(
      "model.call",
      { sessionId: "s1", runId: "r1", userId: "u1", turn: 1 },
      { "gen_ai.usage.cost_usd": 0.01 },
    );
    events.emit(
      "tool.call",
      { sessionId: "s1", runId: "r1" },
      { "gen_ai.tool.name": "web_search" },
    );

    const c = collector();
    const exp = new Exporter(db, { url: c.url, capturePayloads: true });
    const shipped = await exp.flush();
    c.stop();

    expect(shipped).toBe(2);
    expect(c.received.length).toBe(2);
    expect(c.received[0]).toMatchObject({
      "event.name": "model.call",
      "agent.id": "delta-1",
      "session.id": "s1",
      "run.id": "r1",
      "user.id": "u1",
      turn: 1,
    });
    // Each record carries a globally-unique, stable event.id (the collector's
    // idempotency key): `<daemon-uuid>:<local-row-id>`, distinct per row.
    const id0 = c.received[0]?.["event.id"] as string;
    const id1 = c.received[1]?.["event.id"] as string;
    expect(id0).toMatch(/^[0-9a-f-]{36}:\d+$/);
    expect(id1).not.toBe(id0);
    expect(id0.split(":")[0]).toBe(id1.split(":")[0]); // same daemon prefix
    // Exported rows aren't shipped twice.
    const c2 = collector();
    const exp2 = new Exporter(db, { url: c2.url, capturePayloads: true });
    expect(await exp2.flush()).toBe(0);
    c2.stop();
  });

  test("a failed POST leaves rows unexported for the next tick (retry)", async () => {
    const db = openDb(":memory:");
    const events = new Events(db);
    events.emit("turn.start", { runId: "r1" }, {});

    const c = collector();
    c.failTimes(1);
    const exp = new Exporter(db, { url: c.url, capturePayloads: true });
    expect(await exp.flush()).toBe(0); // 503
    const unexported = db.query("SELECT COUNT(*) AS n FROM events WHERE exported = 0").get() as {
      n: number;
    };
    expect(unexported.n).toBe(1);
    expect(await exp.flush()).toBe(1); // retry succeeds
    c.stop();
  });

  test("capture_payloads=false strips attributes from payload-bearing events", async () => {
    const db = openDb(":memory:");
    const events = new Events(db);
    events.emit("model.call", { runId: "r1" }, { prompt: "secret user data" });
    events.emit("run.finished", { runId: "r1" }, { status: "done" });

    const c = collector();
    const exp = new Exporter(db, { url: c.url, capturePayloads: false });
    await exp.flush();
    c.stop();

    const modelCall = c.received.find((r) => r["event.name"] === "model.call");
    const runFinished = c.received.find((r) => r["event.name"] === "run.finished");
    expect(modelCall?.attributes).toBeUndefined(); // payload stripped
    expect(runFinished?.attributes).toMatchObject({ status: "done" }); // non-payload kept
  });

  test("drop-on-overflow keeps the outbox bounded", async () => {
    const db = openDb(":memory:");
    const events = new Events(db);
    for (let i = 0; i < 100; i++) events.emit("turn.start", { runId: "r1" }, { i });

    const c = collector();
    // Tiny cap forces a prune of unexported overflow before sending.
    const exp = new Exporter(db, {
      url: c.url,
      capturePayloads: true,
      maxBacklog: 10,
      batchSize: 1000,
    });
    c.failTimes(1000); // never let it export normally
    await exp.flush();
    c.stop();
    const total = db.query("SELECT COUNT(*) AS n FROM events WHERE exported = 0").get() as {
      n: number;
    };
    expect(total.n).toBeLessThanOrEqual(10);
  });

  test("presents the configured bearer to the (authed) collector", async () => {
    const db = openDb(":memory:");
    new Events(db).emit("turn.start", { runId: "r1" }, {});
    let seenAuth: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seenAuth = req.headers.get("authorization");
        await req.text();
        return new Response("ok");
      },
    });
    await new Exporter(db, {
      url: `http://localhost:${server.port}/`,
      capturePayloads: true,
      authToken: "tenant-tok",
    }).flush();
    server.stop();
    expect(seenAuth as string | null).toBe("Bearer tenant-tok");
  });

  test("event.id is restart-stable: a re-shipped row keeps the same id (idempotency)", async () => {
    const db = openDb(":memory:");
    new Events(db).emit("turn.start", { runId: "r1" }, {});

    const c1 = collector();
    await new Exporter(db, { url: c1.url, capturePayloads: true }).flush();
    c1.stop();
    const first = c1.received[0]?.["event.id"] as string;

    // Simulate a crash-before-mark: unset exported, then a fresh Exporter (restart)
    // on the SAME db must re-ship under the SAME event.id (daemon_id persisted),
    // so the collector's ON CONFLICT DO NOTHING dedupes it.
    db.query("UPDATE events SET exported = 0").run();
    const c2 = collector();
    await new Exporter(db, { url: c2.url, capturePayloads: true }).flush();
    c2.stop();
    expect(c2.received[0]?.["event.id"]).toBe(first);
  });
});
