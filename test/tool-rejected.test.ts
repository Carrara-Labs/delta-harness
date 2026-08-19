// A-2: the unknown-tool branch was the last silent rejection in the loop — the model calls a
// name, gets "[tool error] unknown tool", routes around it, and no counter anywhere records the
// class. tool.rejected carries a CLOSED reason enum (unknown / not_allowed / breaker_disabled);
// the raw model-controlled name is payload (free text under injection) and stays local unless
// payload capture is on.

import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { Events } from "../src/events";
import { Exporter } from "../src/exporter";
import { PROFILES } from "../src/profiles";
import { Queue } from "../src/queue";
import { testTools } from "../src/tools";
import { makeDeps, textResult, toolCallResult } from "./helpers";

function collector() {
  const received: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      for (const line of (await req.text()).split("\n").filter(Boolean))
        received.push(JSON.parse(line));
      return new Response("ok");
    },
  });
  return { url: `http://localhost:${server.port}/`, received, stop: () => server.stop() };
}

describe("tool.rejected (A-2)", () => {
  test("a hallucinated name emits tool.rejected with reason 'unknown'", async () => {
    let asked = false;
    const deps = makeDeps(async () => {
      if (asked) return textResult("giving up");
      asked = true;
      return toolCallResult("definitely_not_real", {}, "call_x");
    }, testTools());
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "go" }).id);
    expect(done.status).toBe("done");
    const rows = deps.db
      .query("SELECT data FROM events WHERE type='tool.rejected' AND run_id=?")
      .all(done.id) as { data: string }[];
    expect(rows.length).toBe(1);
    const data = JSON.parse(rows[0]?.data ?? "{}") as Record<string, unknown>;
    expect(data.reason).toBe("unknown");
    expect(data.requested_tool).toBe("definitely_not_real");
  });

  test("a registered-but-not-offered name maps to 'not_allowed'", async () => {
    PROFILES.narrow = {
      name: "narrow",
      allowed: ["add"],
      pinned: ["add"],
      budget: { maxSteps: 20, maxTokens: 400_000, maxCostUsd: 1 },
    };
    let asked = false;
    const deps = makeDeps(async () => {
      if (asked) return textResult("giving up");
      asked = true;
      // `slow_append` exists in the registry (testTools) but the profile allows only `add`.
      return toolCallResult("slow_append", {}, "call_y");
    }, testTools());
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "go", metadata: { profile: "narrow" } }).id,
    );
    const rows = deps.db
      .query("SELECT data FROM events WHERE type='tool.rejected' AND run_id=?")
      .all(done.id) as { data: string }[];
    expect(rows.length).toBe(1);
    expect((JSON.parse(rows[0]?.data ?? "{}") as { reason: string }).reason).toBe("not_allowed");
  });

  test("exporter: reason survives without payload consent; the raw name does not", async () => {
    const db = openDb(":memory:");
    const events = new Events(db);
    events.emit(
      "tool.rejected",
      { runId: "r1" },
      { requested_tool: "exfil_SECRET_abc123", reason: "unknown" },
    );
    const c = collector();
    const exp = new Exporter(db, { url: c.url, capturePayloads: false });
    await exp.flush();
    c.stop();
    const ev = c.received.find((r) => r["event.name"] === "tool.rejected");
    expect(ev).toBeDefined();
    expect(ev?.attributes).toEqual({ reason: "unknown" });
  });
});
