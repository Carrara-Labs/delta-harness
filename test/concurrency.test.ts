// Concurrency scaling: the queue dispatches up to N concurrent RUNS (one per active session).
// These tests isolate the harness mechanism (pump, claim-race, busy-set, event bus, SQLite) from
// the provider with a fast mock chat, so they prove the machinery scales cleanly to high N — the
// real-world ceiling (provider rate limits, per-run context memory) is a separate, live concern.

import { describe, expect, test } from "bun:test";
import { Queue } from "../src/queue";
import { makeDeps, textResult } from "./helpers";

describe("concurrency scaling (mechanism)", () => {
  test("respects the cap, runs many in parallel, completes all, wedges none (N=32, 300 tasks)", async () => {
    let inFlight = 0;
    let peak = 0;
    let completed = 0;
    const deps = makeDeps(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(3); // hold the slot so runs genuinely overlap
      inFlight--;
      completed++;
      return textResult("ok");
    });
    const N = 32;
    const M = 300; // 300 distinct sessions → all eligible to run concurrently
    const queue = new Queue(deps, N);
    // store:true so the terminal rows persist for the DB assertions (store:false purges them).
    const ids = Array.from({ length: M }, () => queue.enqueue({ input: "t", store: true }).id);
    await Promise.all(ids.map((id) => queue.wait(id)));

    expect(completed).toBe(M); // every task actually executed
    expect(peak).toBeGreaterThan(8); // real concurrency happened (not serialized)
    expect(peak).toBeLessThanOrEqual(N); // ...but NEVER exceeded the configured cap
    const rows = deps.db.query("SELECT status, count(*) AS n FROM runs GROUP BY status").all() as {
      status: string;
      n: number;
    }[];
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    expect(by.done).toBe(M); // all terminal-done
    expect((by.queued ?? 0) + (by.running ?? 0)).toBe(0); // none wedged in a live state
  }, 20_000);

  test("a session stays SERIAL even under a high cap — its runs never overlap", async () => {
    // Same-session runs must never run at once (they share the memory chain). Fire a chain of
    // continuations in one session while the cap is huge, and assert at most one is ever in flight
    // for that session.
    let sessionInFlight = 0;
    let sessionPeak = 0;
    const deps = makeDeps(async () => {
      sessionInFlight++;
      sessionPeak = Math.max(sessionPeak, sessionInFlight);
      await Bun.sleep(3);
      sessionInFlight--;
      return textResult("ok");
    });
    const queue = new Queue(deps, 64); // huge cap
    const first = queue.enqueue({ input: "start" });
    // 10 continuations of the SAME session, all enqueued up front.
    let prev = first.id;
    const ids = [first.id];
    for (let i = 0; i < 10; i++) {
      const r = queue.enqueue({ input: `step ${i}`, previous_response_id: prev });
      ids.push(r.id);
      prev = r.id;
    }
    await Promise.all(ids.map((id) => queue.wait(id)));
    expect(sessionPeak).toBe(1); // the session's runs were strictly serialized despite the cap
  }, 20_000);

  test("scales to a very high cap without breaking (N=128, 500 tasks, all correct)", async () => {
    let completed = 0;
    let peak = 0;
    let inFlight = 0;
    const deps = makeDeps(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(1);
      inFlight--;
      completed++;
      return textResult("ok");
    });
    const queue = new Queue(deps, 128);
    const M = 500;
    const ids = Array.from({ length: M }, () => queue.enqueue({ input: "t", store: false }).id);
    await Promise.all(ids.map((id) => queue.wait(id)));
    expect(completed).toBe(M);
    expect(peak).toBeGreaterThan(32); // genuinely deep concurrency
    expect(peak).toBeLessThanOrEqual(128);
    const wedged = deps.db
      .query("SELECT count(*) AS n FROM runs WHERE status IN ('queued','running')")
      .get() as { n: number };
    expect(wedged.n).toBe(0);
  }, 30_000);
});
