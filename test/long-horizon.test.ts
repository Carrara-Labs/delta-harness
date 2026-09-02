// Long-horizon instruments (2026-09-02, docs/study-long-horizon-synthesis.md H1a + H5).
// Telemetry only: nothing here changes what the model sees. Three claims are pinned:
//  1. the first post-compaction call reports its reload as `cache_shortfall_tokens`, labeled by
//     `turns_since_compaction: 0` (it used to be suppressed as "meaningless");
//  2. `history_prefix_hash` on turn N+1 equals `history_hash` on turn N when history was only
//     appended to, and is ABSENT right after a compaction (no comparable span);
//  3. the Anthropic wire sends the cache-diagnosis header + field ONLY when asked, and normalizes
//     the provider's four response states to a closed enum.

import { afterAll, describe, expect, test } from "bun:test";
import { CACHE_DIAGNOSIS_BETA, type ChatRequest, chat, type ProviderConfig } from "../src/provider";
import { Queue } from "../src/queue";
import { type Tools, testTools } from "../src/tools";
import { makeDeps, ok, textResult } from "./helpers";

// ── wire ──────────────────────────────────────────────────────────────────────

let script: () => Response = () => new Response("");
let lastHeaders: Headers | undefined;
let lastBody: Record<string, unknown> = {};
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    lastHeaders = req.headers;
    lastBody = (await req.json()) as Record<string, unknown>;
    return script();
  },
});
afterAll(() => server.stop());

const cfg = (): ProviderConfig => ({
  baseUrl: `http://localhost:${server.port}/v1`,
  apiKey: "test",
  models: ["claude-opus-5"],
  maxRetries: 0,
  api: "anthropic",
});

function sse(...chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const stream = (message: Record<string, unknown>) =>
  sse(
    { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 }, ...message } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "message_delta", usage: { output_tokens: 1 }, delta: { stop_reason: "end_turn" } },
  );
const hi: ChatRequest = { messages: [{ role: "user", content: "hi" }] };

describe("H5: Anthropic cache diagnosis on the wire", () => {
  test("off by default: no beta header, no diagnostics field, and the id still comes back", async () => {
    script = () => stream({});
    const r = await chat(cfg(), hi);
    expect(lastHeaders?.get("anthropic-beta")).toBeNull();
    expect(lastBody.diagnostics).toBeUndefined();
    expect(r.ok && r.responseId).toBe("msg_1");
    expect(r.ok && r.cacheMiss).toBeUndefined();
  });

  test("opt in with null on a first call: header + field travel together", async () => {
    script = () => stream({ diagnostics: null });
    const r = await chat(cfg(), { ...hi, diagnosticsPrevId: null });
    expect(lastHeaders?.get("anthropic-beta")).toBe(CACHE_DIAGNOSIS_BETA);
    expect(lastBody.diagnostics).toEqual({ previous_message_id: null });
    expect(r.ok && r.cacheMiss).toEqual({ reason: "none" });
  });

  test("the previous id is forwarded verbatim; pending and *_changed verdicts normalize", async () => {
    script = () => stream({ diagnostics: { cache_miss_reason: null } });
    let r = await chat(cfg(), { ...hi, diagnosticsPrevId: "msg_0" });
    expect(lastBody.diagnostics).toEqual({ previous_message_id: "msg_0" });
    expect(r.ok && r.cacheMiss).toEqual({ reason: "pending" });

    script = () =>
      stream({
        diagnostics: {
          cache_miss_reason: { type: "messages_changed", cache_missed_input_tokens: 41_850 },
        },
      });
    r = await chat(cfg(), { ...hi, diagnosticsPrevId: "msg_0" });
    expect(r.ok && r.cacheMiss).toEqual({ reason: "messages_changed", missedTokens: 41_850 });
  });

  test("an unlisted server value is `unknown`, never exported free text", async () => {
    script = () => stream({ diagnostics: { cache_miss_reason: { type: "brand_new_reason" } } });
    const r = await chat(cfg(), { ...hi, diagnosticsPrevId: "msg_0" });
    expect(r.ok && r.cacheMiss).toEqual({ reason: "unknown" });
  });

  test("a response without the field (beta not honored) leaves cacheMiss absent", async () => {
    script = () => stream({});
    const r = await chat(cfg(), { ...hi, diagnosticsPrevId: "msg_0" });
    expect(r.ok && r.cacheMiss).toBeUndefined();
  });
});

// ── run loop ──────────────────────────────────────────────────────────────────

/** A long tool-heavy run with a tiny ceiling so compaction fires mid-run, and a provider that
 * reports realistic usage: every call's gross input grows with the request and the cache serves
 * everything but a 45-token floor, so the shortfall is the honest constant on ordinary turns. */
async function longRun(turns: number, extra: Partial<ReturnType<typeof makeDeps>> = {}) {
  const bloat: Tools = new Map(testTools());
  bloat.set("bloat", {
    name: "bloat",
    description: "returns a lot of text",
    parameters: { type: "object", properties: {} },
    idempotent: true,
    execute: async () => "x".repeat(2000),
  });
  let call = 0;
  const deps = makeDeps(async (req: ChatRequest) => {
    const sys = req.messages[0]?.content;
    // Both summarizer prompts: the first cut ("You compact") and every merge after it.
    if (
      typeof sys === "string" &&
      (sys.startsWith("You compact") || sys.startsWith("You are UPDATING"))
    )
      return ok({ role: "assistant", content: "Goal: g\nProgress: p\nNext: n\nArtifacts: a" });
    call++;
    const input = Math.round(req.messages.reduce((n, m) => n + JSON.stringify(m).length, 0) / 3);
    const r =
      call > turns
        ? textResult("done")
        : ok({
            role: "assistant",
            content: null,
            tool_calls: [
              { id: `c${call}`, type: "function", function: { name: "bloat", arguments: "{}" } },
            ],
          });
    if (!r.ok) return r;
    return {
      ...r,
      responseId: `msg_${call}`,
      usage: {
        input,
        output: 5,
        cacheRead: Math.max(0, input - 45),
        cacheWrite: 45,
        total: input + 5,
        costUsd: 0,
      },
    };
  }, bloat);
  deps.compactAtTokens = 5000;
  deps.profile = "longrun";
  Object.assign(deps, extra);
  const { PROFILES } = await import("../src/profiles");
  PROFILES.longrun = {
    name: "longrun",
    allowed: "*",
    pinned: "*",
    budget: { maxSteps: 200, maxTokens: 100_000_000, maxCostUsd: 1000 },
  };
  const seen: Array<{ type: string; turn?: number; data: Record<string, unknown> }> = [];
  deps.events.on((e) => {
    if (e.type === "model.call" || e.type === "compaction")
      seen.push({ type: e.type, turn: e.turn, data: e.data as Record<string, unknown> });
  });
  const queue = new Queue(deps);
  const done = await queue.wait(
    queue.enqueue({ input: "keep going", metadata: { profile: "longrun" } }).id,
  );
  expect(done.status).toBe("done");
  const main = seen.filter((e) => e.type === "model.call" && e.data.tier === "main");
  const compactions = seen.filter((e) => e.type === "compaction" && e.data.shrank === true);
  expect(compactions.length).toBeGreaterThan(0);
  return { main, compactions, seen };
}

describe("H1a: the post-compaction reload is labeled, not suppressed", () => {
  test("turns_since_compaction is absent before any compaction, 0 on the reload call, then counts up", async () => {
    const { main, seen } = await longRun(14);
    // Before the first compaction: no label at all (absent, not -1).
    const firstCompactIdx = seen.findIndex(
      (e) => e.type === "compaction" && e.data.shrank === true,
    );
    const before = seen
      .slice(0, firstCompactIdx)
      .filter((e) => e.type === "model.call" && e.data.tier === "main");
    expect(before.length).toBeGreaterThan(0);
    for (const e of before) expect(e.data.turns_since_compaction).toBeUndefined();
    // The first main call AFTER that compaction is the reload: 0, then 1, 2 ... until the next.
    const after = seen
      .slice(firstCompactIdx + 1)
      .filter((e) => e.type === "model.call" && e.data.tier === "main");
    expect(after[0]?.data.turns_since_compaction).toBe(0);
    if (after[1] && after[1].data.turns_since_compaction !== 0)
      expect(after[1].data.turns_since_compaction).toBe(1);
    // And the label is on every later call.
    for (const e of after) expect(typeof e.data.turns_since_compaction).toBe("number");
    expect(main.length).toBeGreaterThan(after.length);
  }, 20_000);

  test("the reload call carries a real shortfall instead of nothing, and ordinary turns keep the floor", async () => {
    const { main } = await longRun(14);
    const reload = main.find((e) => e.data.turns_since_compaction === 0);
    expect(reload).toBeDefined();
    // The rewritten prompt is smaller than the previous one and the mock cache serves all but 45
    // of it, so min(prev, cur) - cacheRead = 45 here too; what matters is that it is PRESENT and a
    // number on the reload call, where 0.2.16 emitted nothing and 30.6% of a lane's spend hid.
    expect(typeof reload?.data.cache_shortfall_tokens).toBe("number");
    // The first call of the run is the only one without an anchor.
    expect(main[0]?.data.cache_shortfall_tokens).toBeUndefined();
    for (const e of main.slice(1)) expect(typeof e.data.cache_shortfall_tokens).toBe("number");
    // Burst width rides every call as a bounded scalar.
    expect(main[0]?.data.tool_calls_n).toBe(1);
  }, 20_000);
});

describe("H5: history digest names the segment nobody measured", () => {
  test("append-only turns: next turn's prefix digest equals this turn's whole-history digest", async () => {
    const { main } = await longRun(14);
    let compared = 0;
    for (let i = 1; i < main.length; i++) {
      const prev = main[i - 1]?.data as Record<string, unknown>;
      const cur = main[i]?.data as Record<string, unknown>;
      if (cur.turns_since_compaction === 0) {
        // Right after a compaction there is no comparable span: suppressed, not a false mismatch.
        expect(cur.history_prefix_hash).toBeUndefined();
        continue;
      }
      if (cur.history_prefix_hash === undefined) continue; // first call of the run
      expect(cur.history_prefix_hash).toBe(prev.history_hash as string);
      expect(cur.history_n as number).toBeGreaterThan(prev.history_n as number);
      compared++;
    }
    expect(compared).toBeGreaterThan(3);
    for (const e of main) {
      expect(typeof e.data.history_hash).toBe("string");
      expect((e.data.history_hash as string).length).toBe(12);
      expect(typeof e.data.history_n).toBe("number");
    }
  }, 20_000);

  test("the diagnostics anchor is threaded per run: null first, then the previous response id", async () => {
    const ids: Array<string | null | undefined> = [];
    const bloat: Tools = new Map(testTools());
    let call = 0;
    const deps = makeDeps(async (req: ChatRequest) => {
      ids.push(req.diagnosticsPrevId);
      call++;
      if (call > 2) return textResult("done");
      const r = ok({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `c${call}`,
            type: "function",
            function: { name: "add", arguments: '{"a":1,"b":2}' },
          },
        ],
      });
      return r.ok ? { ...r, responseId: `msg_${call}` } : r;
    }, bloat);
    deps.cacheDiagnosis = true;
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "add" }).id);
    expect(done.status).toBe("done");
    expect(ids).toEqual([null, "msg_1", "msg_2"]);
  });

  test("a call served without an id (non-Anthropic fallback) keeps the last anchor instead of dropping it", async () => {
    const ids: Array<string | null | undefined> = [];
    let call = 0;
    const deps = makeDeps(async (req: ChatRequest) => {
      ids.push(req.diagnosticsPrevId);
      call++;
      if (call > 3) return textResult("done");
      const r = ok({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `c${call}`,
            type: "function",
            function: { name: "add", arguments: '{"a":1,"b":2}' },
          },
        ],
      });
      if (!r.ok) return r;
      // Call 2 is served by a provider that returns no id (and a free-text verdict, which must
      // never leave the box as-is).
      return call === 2
        ? { ...r, cacheMiss: { reason: "totally custom", missedTokens: -3 } }
        : { ...r, responseId: `msg_${call}` };
    }, testTools());
    deps.cacheDiagnosis = true;
    const seen: Record<string, unknown>[] = [];
    deps.events.on((e) => {
      if (e.type === "model.call") seen.push(e.data as Record<string, unknown>);
    });
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "add" }).id);
    expect(done.status).toBe("done");
    // msg_1 survives the id-less call 2 and anchors call 3; call 4 then carries msg_3.
    expect(ids).toEqual([null, "msg_1", "msg_1", "msg_3"]);
    // The export boundary re-allowlists: unknown reason, invalid count dropped.
    expect(seen[1]?.cache_miss_reason).toBe("unknown");
    expect(seen[1]?.cache_missed_input_tokens).toBeUndefined();
  });

  test("with the feature off the request never carries the field", async () => {
    const ids: Array<string | null | undefined> = [];
    const deps = makeDeps(async (req: ChatRequest) => {
      ids.push(req.diagnosticsPrevId);
      return textResult("done");
    }, testTools());
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "hi" }).id);
    expect(ids).toEqual([undefined]);
  });
});

describe("slice 2: shadow observations, no behavior change", () => {
  test("loop.repeat fires on three identical tool+args+result calls and never touches execution", async () => {
    let call = 0;
    const deps = makeDeps(async () => {
      call++;
      if (call > 4) return textResult("done");
      return ok({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `c${call}`,
            type: "function",
            function: { name: "add", arguments: '{"a":1,"b":2}' },
          },
        ],
      });
    }, testTools());
    const repeats: Record<string, unknown>[] = [];
    deps.events.on((e) => {
      if (e.type === "loop.repeat") repeats.push(e.data as Record<string, unknown>);
    });
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "add" }).id);
    // Four identical calls ran to completion: the run finished normally and every call executed.
    expect(done.status).toBe("done");
    expect(call).toBe(5);
    // Observed at the third identical call and again at the fourth (the window keeps sliding).
    expect(repeats.length).toBe(2);
    expect(repeats[0]).toEqual({ "gen_ai.tool.name": "add", repeats: 3, window: 3 });
  });

  test("a changing argument is not a repeat", async () => {
    let call = 0;
    const deps = makeDeps(async () => {
      call++;
      if (call > 4) return textResult("done");
      return ok({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `c${call}`,
            type: "function",
            function: { name: "add", arguments: `{"a":${call},"b":2}` },
          },
        ],
      });
    }, testTools());
    let repeats = 0;
    deps.events.on((e) => {
      if (e.type === "loop.repeat") repeats++;
    });
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "add" }).id);
    expect(repeats).toBe(0);
  });

  test("compaction events carry the generation index, the summarizer's finish reason and the body size", async () => {
    const { compactions } = await longRun(14);
    const gens = compactions
      .filter((c) => c.data.reason === "committed")
      .map((c) => c.data.generation as number);
    expect(gens.length).toBeGreaterThan(1);
    // `generation` = how many engine summaries sat in the summarized PREFIX plus one, i.e. the
    // merge depth. It starts at 1, never decreases, and reaches 2+ once a merge has happened. It
    // is NOT the ordinal of the cut: a summary retained in the tail is not merged yet.
    expect(gens[0]).toBe(1);
    for (let i = 1; i < gens.length; i++)
      expect(gens[i]).toBeGreaterThanOrEqual(gens[i - 1] as number);
    expect(Math.max(...gens)).toBeGreaterThanOrEqual(2);
    for (const c of compactions.filter((c) => c.data.reason === "committed")) {
      expect(c.data.summary_finish_reason).toBe("stop");
      expect(c.data.summary_chars as number).toBeGreaterThan(10);
    }
  }, 20_000);
});
