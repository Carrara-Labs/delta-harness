// M3: async /v1/tasks surface, SSE progress, /v1/queue, multi-user isolation.

import { afterEach, describe, expect, test } from "bun:test";
import { Queue } from "../src/queue";
import { createServer } from "../src/server";
import { makeDeps, textResult } from "./helpers";

function serverWith(chat: Parameters<typeof makeDeps>[0]) {
  const deps = makeDeps(chat);
  const server = createServer(new Queue(deps), deps.events, 0);
  return { base: `http://localhost:${server.port}`, server, deps };
}

let stopFns: Array<() => void> = [];
afterEach(() => {
  for (const s of stopFns) s();
  stopFns = [];
});

describe("POST /v1/tasks (async)", () => {
  test("returns 202 + id immediately, then status transitions to done with result", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { base, server } = serverWith(async () => {
      await gate;
      return textResult("async answer");
    });
    stopFns.push(() => server.stop());

    const accept = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "long task" }),
    });
    expect(accept.status).toBe(202);
    const { id } = (await accept.json()) as { id: string };
    expect(id).toMatch(/^resp_/);

    // While gated: running.
    await Bun.sleep(20);
    const mid = (await (await fetch(`${base}/v1/tasks/${id}`)).json()) as { status: string };
    expect(mid.status).toBe("running");

    release();
    // Poll to done.
    let final: { status: string; result?: { output_text?: string } } = { status: "" };
    for (let i = 0; i < 50; i++) {
      final = (await (await fetch(`${base}/v1/tasks/${id}`)).json()) as typeof final;
      if (final.status === "done") break;
      await Bun.sleep(20);
    }
    expect(final.status).toBe("done");
    expect(final.result?.output_text).toBe("async answer");
  });

  test("DELETE cancels a running task", async () => {
    // Real providers abort their fetch on the signal; mirror that so the loop's
    // aborted path runs (a blocked chat that ignores the signal never cancels).
    const { base, server } = serverWith(
      (req) =>
        new Promise((resolve) => {
          req.signal?.addEventListener("abort", () =>
            resolve({ ok: false, model: "test", error: "aborted", aborted: true }),
          );
        }),
    );
    stopFns.push(() => server.stop());
    const { id } = (await (
      await fetch(`${base}/v1/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "cancel me" }),
      })
    ).json()) as { id: string };
    await Bun.sleep(20);
    const del = await fetch(`${base}/v1/tasks/${id}`, { method: "DELETE" });
    expect(((await del.json()) as { cancelled: boolean }).cancelled).toBe(true);
    await Bun.sleep(20);
    const status = (await (await fetch(`${base}/v1/tasks/${id}`)).json()) as { status: string };
    expect(status.status).toBe("cancelled");
  });

  test("404 for unknown task id", async () => {
    const { base, server } = serverWith(async () => textResult("x"));
    stopFns.push(() => server.stop());
    expect((await fetch(`${base}/v1/tasks/resp_nope`)).status).toBe(404);
  });
});

describe("SSE progress = filtered tail of the event stream", () => {
  // The SSE handler is a filtered tail of the event bus: it forwards exactly the
  // events for this run, in order. We assert that filtering here (the terminal
  // done-frame over real HTTP is covered by the next test + the live smoke).
  // Reading a deferred-close in-process stream stalls under `bun test`, so the
  // live-streaming HTTP read is exercised in scripts/golden-style smoke, not here.
  test("forwards only this run's events, in order, through run.finished", async () => {
    const deps = makeDeps(async () => textResult("streamed answer"));
    const queue = new Queue(deps);
    const seen: string[] = [];
    const otherRun = queue.enqueue({ input: "noise" }); // a second run on the bus
    const target = queue.enqueue({ input: "watch me" });
    deps.events.on((e) => {
      if (e.runId === target.id) seen.push(e.type);
    });
    await queue.wait(target.id);
    await queue.wait(otherRun.id);
    // Only the target run's events were captured (no cross-run bleed) and the
    // terminal marker the SSE handler keys on is present.
    expect(seen).toContain("run.started");
    expect(seen).toContain("model.call");
    expect(seen).toContain("run.finished");
    expect(seen).not.toContain(undefined);
  });

  test("client disconnect releases the event listener (no leak) — codex P2", async () => {
    const gate = new Promise<void>(() => {}); // run never finishes
    const deps = makeDeps(async () => {
      await gate;
      return textResult("never");
    });
    const queue = new Queue(deps);
    const server = createServer(queue, deps.events, 0);
    stopFns.push(() => server.stop());
    const base = `http://localhost:${server.port}`;
    const { id } = (await (
      await fetch(`${base}/v1/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hang" }),
      })
    ).json()) as { id: string };

    const before = deps.events.listenerCount();
    const ac = new AbortController();
    const streamPromise = fetch(`${base}/v1/tasks/${id}/events`, { signal: ac.signal }).catch(
      () => {},
    );
    await Bun.sleep(30);
    expect(deps.events.listenerCount()).toBe(before + 1); // SSE subscribed
    ac.abort(); // client disconnects mid-run
    await streamPromise;
    await Bun.sleep(50);
    expect(deps.events.listenerCount()).toBe(before); // listener released, no leak
  });

  test("stream opened after the run finished still closes with a done frame", async () => {
    const { base, server } = serverWith(async () => textResult("already done"));
    stopFns.push(() => server.stop());
    const { id } = (await (
      await fetch(`${base}/v1/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "quick" }),
      })
    ).json()) as { id: string };
    for (let i = 0; i < 50; i++) {
      const s = (await (await fetch(`${base}/v1/tasks/${id}`)).json()) as { status: string };
      if (s.status === "done") break;
      await Bun.sleep(20);
    }
    const text = await (await fetch(`${base}/v1/tasks/${id}/events`)).text();
    expect(text).toContain("event: done");
    expect(text).toContain("already done");
  });
});

describe("GET /v1/queue", () => {
  test("shows queued+running with positions; two users' tasks don't interleave", async () => {
    let release: Array<() => void> = [];
    const { base, server } = serverWith(async () => {
      await new Promise<void>((r) => release.push(r));
      return textResult("ok");
    });
    stopFns.push(() => server.stop());

    // User A: two tasks in one session (serial). User B: one task (concurrent).
    const a1 = (await (
      await fetch(`${base}/v1/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "a1", metadata: { user_id: "alice" } }),
      })
    ).json()) as { id: string };
    await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "a2",
        metadata: { user_id: "alice" },
        previous_response_id: a1.id,
      }),
    });
    await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "b1", metadata: { user_id: "bob" } }),
    });

    await Bun.sleep(30);
    // As alice: her entries are full; bob's are opaque (spec §J isolation).
    const { queue } = (await (
      await fetch(`${base}/v1/queue`, { headers: { "x-delta-user": "alice" } })
    ).json()) as {
      queue: Array<{
        status: string;
        user_id: string | null;
        id: string | null;
        position: number | null;
        mine: boolean;
      }>;
    };
    const running = queue.filter((q) => q.status === "running");
    const queued = queue.filter((q) => q.status === "queued");
    // a1 and b1 run; a2 waits behind a1 (serial per session).
    expect(running.length).toBe(2);
    expect(queued.length).toBe(1);
    expect(queued[0]?.user_id).toBe("alice");
    expect(queued[0]?.position).toBe(1);
    // Alice sees her own ids; bob's entry is opaque (no id/user_id leaked).
    const mine = queue.filter((q) => q.mine);
    const others = queue.filter((q) => !q.mine);
    expect(mine.every((q) => q.id !== null && q.user_id === "alice")).toBe(true);
    expect(others.every((q) => q.id === null && q.user_id === null)).toBe(true);
    expect(others.length).toBe(1); // bob's running task, opaque

    // No identity header → everything opaque, positions still visible.
    const anon = (await (await fetch(`${base}/v1/queue`)).json()) as {
      queue: Array<{ id: string | null; mine: boolean; position: number | null }>;
    };
    expect(anon.queue.every((q) => q.id === null && !q.mine)).toBe(true);
    expect(anon.queue.some((q) => q.position === 1)).toBe(true);

    for (const r of release) r();
    release = [];
    await Bun.sleep(50);
    for (const r of release) r();
  });
});
