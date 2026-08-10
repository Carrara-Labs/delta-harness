// Sprint 2 (harness v2): rolling cache breakpoint, utility-model lane, compaction elide,
// pricing coverage. The breakpoint tests capture the REAL request body a provider would
// receive — placement bugs here silently burn money, so we pin the wire shape exactly.

import { afterAll, describe, expect, test } from "bun:test";
import { BAKED_PRICES, resolvePrice } from "../src/pricing";
import {
  acceptsPromptCacheKey,
  CACHE_LOOKBACK_BLOCKS,
  type ChatMsg,
  type ChatRequest,
  chat,
  type ModelResult,
  rollingScanFrom,
  usesMaxCompletionTokens,
} from "../src/provider";
import { untrustedToolResult } from "../src/untrusted";

type Captured = { messages?: unknown[]; system?: unknown; prompt_cache_key?: string };
let captured: Captured = {};

// One capture server for all wire shapes: records the body, answers minimally per path.
const srv = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Captured & { input?: unknown[] };
    captured = body;
    const p = new URL(req.url).pathname;
    if (p.endsWith("/messages"))
      return new Response(
        [
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (p.endsWith("/responses"))
      return new Response(
        [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`,
          `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}`,
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    return new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
afterAll(() => srv.stop(true));
const base = `http://localhost:${srv.port}`;

const history: ChatMsg[] = [
  { role: "system", content: "SPINE" },
  { role: "user", content: "do the task" },
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }],
  },
  { role: "tool", tool_call_id: "c1", content: "search results here" },
];

describe("rolling cache breakpoint", () => {
  test("openai-wire (OpenRouter) path: system AND the last tool message carry cache_control", async () => {
    await chat(
      { baseUrl: base, apiKey: "t", models: ["anthropic/claude-sonnet-5"], maxRetries: 0 },
      { messages: history },
    );
    const msgs = captured.messages as Array<{
      role: string;
      content: unknown;
      tool_call_id?: string;
    }>;
    // system rewritten to parts with the breakpoint
    const sys = msgs.find((m) => m.role === "system");
    expect((sys?.content as Array<{ cache_control?: unknown }>)[0]?.cache_control).toEqual({
      type: "ephemeral",
    });
    // the FINAL tool message (the rolling tail) rewritten to parts with the breakpoint
    const tail = msgs[msgs.length - 1];
    expect(tail?.role).toBe("tool");
    expect(tail?.tool_call_id).toBe("c1");
    const part = (tail?.content as Array<{ text?: string; cache_control?: unknown }>)[0];
    expect(part?.text).toBe(untrustedToolResult("search results here"));
    expect(part?.cache_control).toEqual({ type: "ephemeral" });
    // ONE rolling mark here, not two: the second is held a full 20-block lookback window behind
    // the first (see `rollingMarks`), and this 4-message fixture has nowhere to put it. Two
    // ADJACENT marks — which is what this asserted before 2026-08-10 — cover a single block more
    // than one mark does while providing none of the second window they were added for. The
    // spacing itself is pinned by "the two rolling marks are a full lookback apart" below.
    const rollingMarked = msgs.filter(
      (m) =>
        m.role !== "system" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ cache_control?: unknown }>).some((p) => p.cache_control),
    );
    expect(rollingMarked.length).toBe(1);
  });

  // Field bug, 2026-08-03: both rolling marks were landing on the TRAILING derived blocks the
  // engine appends every turn (`# Context` carries a clock, plus the skills block). A cached
  // prefix ending in one can never be matched, so every turn wrote a large unreadable cache and
  // only the system block was ever read back — measured on a live agent as cache reads pinned at
  // 6,507 tokens while the request grew to 59k, on calls 9 seconds apart.
  test("rolling marks skip the trailing derived blocks and land on persisted transcript", async () => {
    const derived = [
      { role: "user" as const, content: "# Context\nnow: 2026-08-03T08:10:00Z" },
      { role: "user" as const, content: "[Relevant skills — untrusted directory data]" },
    ];
    await chat(
      { baseUrl: base, apiKey: "t", models: ["anthropic/claude-sonnet-5"], maxRetries: 0 },
      { messages: [...history, ...derived], ephemeralCount: derived.length },
    );
    const msgs = captured.messages as Array<{ role: string; content: unknown }>;
    const marked = (m: { content: unknown } | undefined) =>
      Array.isArray(m?.content) &&
      (m.content as Array<{ cache_control?: unknown }>)[0]?.cache_control !== undefined;
    // the two derived blocks stay plain strings — never marked
    expect(marked(msgs[msgs.length - 1])).toBe(false);
    expect(marked(msgs[msgs.length - 2])).toBe(false);
    // and the mark moved onto the real transcript: the tool result
    expect(marked(msgs.find((m) => m.role === "tool"))).toBe(true);
    // the stable prefix is still marked regardless
    expect(marked(msgs.find((m) => m.role === "system"))).toBe(true);
  });

  test("an over-large ephemeralCount still marks the system prefix", async () => {
    await chat(
      { baseUrl: base, apiKey: "t", models: ["anthropic/claude-sonnet-5"], maxRetries: 0 },
      { messages: history, ephemeralCount: 99 },
    );
    const msgs = captured.messages as Array<{ role: string; content: unknown }>;
    const sys = msgs.find((m) => m.role === "system");
    expect((sys?.content as Array<{ cache_control?: unknown }>)[0]?.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  test("openai-wire path: non-Anthropic models are untouched (they auto-cache)", async () => {
    await chat(
      { baseUrl: base, apiKey: "t", models: ["openai/gpt-5.5"], maxRetries: 0 },
      { messages: history },
    );
    const msgs = captured.messages as Array<{ role: string; content: unknown }>;
    for (const m of msgs) expect(typeof m.content === "string" || m.content === null).toBe(true);
  });

  test("anthropic-native path: the last message's last block carries the rolling breakpoint (tool_result too)", async () => {
    await chat(
      { baseUrl: base, apiKey: "t", models: ["claude-sonnet-5"], api: "anthropic", maxRetries: 0 },
      { messages: history },
    );
    const msgs = captured.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    const tail = msgs[msgs.length - 1];
    const block = tail?.content[tail.content.length - 1];
    expect(block?.type).toBe("tool_result"); // tool results are user-role blocks natively
    expect(block?.cache_control).toEqual({ type: "ephemeral" });
    // One rolling mark + the system block. The second rolling mark needs a full 20-block lookback
    // window of clearance behind the first and this fixture is 4 messages long; see the spacing
    // test below for the case that matters.
    const marked = msgs.flatMap((m) => m.content).filter((b) => b.cache_control);
    expect(marked.length).toBe(1);
  });

  // codex P1 on the first cut of this fix: it threaded the exclusion into the OpenAI-compatible
  // serializer only, leaving anthropic-native — the path the affected live agent actually runs —
  // reproducing the original bug in full. Both serializers now share `rollingScanFrom`.
  test("anthropic-native path: rolling marks skip the trailing derived blocks", async () => {
    const derived = [
      { role: "user" as const, content: "# Context\nnow: 2026-08-03T08:10:00Z" },
      { role: "user" as const, content: "[Relevant skills — untrusted directory data]" },
    ];
    await chat(
      { baseUrl: base, apiKey: "t", models: ["claude-sonnet-5"], api: "anthropic", maxRetries: 0 },
      { messages: [...history, ...derived], ephemeralCount: derived.length },
    );
    const msgs = captured.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    const isMarked = (m: { content: Array<Record<string, unknown>> } | undefined) =>
      Boolean(m?.content.some((b) => b.cache_control));
    // the two derived blocks are the last two messages and must be untouched
    expect(isMarked(msgs[msgs.length - 1])).toBe(false);
    expect(isMarked(msgs[msgs.length - 2])).toBe(false);
    // the mark moved back onto the persisted transcript
    const marked = msgs.flatMap((m) => m.content).filter((b) => b.cache_control);
    expect(marked.length).toBe(1);
    expect(marked.some((b) => b.type === "tool_result")).toBe(true);
  });

  test("anthropic-native path: a message carrying an image is never a rolling mark", async () => {
    const withImage = [
      ...history,
      {
        role: "user" as const,
        content: [{ type: "image_url" as const, image_url: { url: "data:image/png;base64,AAAA" } }],
      },
    ];
    await chat(
      { baseUrl: base, apiKey: "t", models: ["claude-sonnet-5"], api: "anthropic", maxRetries: 0 },
      { messages: withImage },
    );
    const msgs = captured.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    const last = msgs[msgs.length - 1];
    expect(last?.content.some((b) => b.type === "image")).toBe(true);
    expect(last?.content.some((b) => b.cache_control)).toBe(false);
    // codex P3: proving the image is unmarked is not enough — a regression that aborted the
    // rolling scan entirely would also pass. Assert the coverage SURVIVED and moved back.
    const marked = msgs.flatMap((m) => m.content).filter((b) => b.cache_control);
    expect(marked.length).toBe(1);
    expect(marked.some((b) => b.type === "tool_result")).toBe(true);
  });

  // THE 2026-08-10 FIX. Anthropic's lookback is 20 BLOCKS per breakpoint, and it finds only
  // entries earlier requests already WROTE: "if a growing conversation pushes your breakpoint 20
  // or more blocks past the last write, the lookback window misses it. Add a second breakpoint
  // closer to that position from the start so a write accumulates there before you need it."
  // Two ADJACENT marks share one window instead of starting two, so a turn appending >=20 blocks
  // outran BOTH and re-billed the whole prefix. Enumerating the old walker put the marks exactly
  // ONE block apart on every parallel tool burst at any width — precisely the case the second
  // mark was added for (codex #7). A width-N burst is ~2N blocks (N tool_use + N results), so
  // ~10 parallel calls was enough. Assert the SPACING, because the count was never the bug.
  // Anthropic's published number, hard-coded ON PURPOSE. Asserting against the imported
  // CACHE_LOOKBACK_BLOCKS made these tests vacuous: setting the constant to 0 also set the
  // threshold to 0, so `expect(gap 1).toBeGreaterThanOrEqual(0)` passed and the mutation check
  // came back green on a broken build. A test of "do we agree with the vendor" must carry the
  // vendor's value, not ours. `CACHE_LOOKBACK_BLOCKS === 20` is pinned separately below.
  const DOCUMENTED_LOOKBACK = 20;

  const burstHistory = (): ChatMsg[] => {
    const h: ChatMsg[] = [{ role: "system", content: "SPINE" }];
    for (let i = 0; i < 30; i++)
      h.push(i % 2 ? { role: "assistant", content: `a${i}` } : { role: "user", content: `u${i}` });
    h.push({
      role: "assistant",
      content: null,
      tool_calls: Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`,
        type: "function" as const,
        function: { name: "f", arguments: "{}" },
      })),
    });
    for (let i = 0; i < 6; i++) h.push({ role: "tool", tool_call_id: `t${i}`, content: `r${i}` });
    return h;
  };
  /** Block indices carrying a breakpoint, counted in wire order the way the PROVIDER counts
   *  blocks: an assistant turn with N tool_calls is N tool_use blocks (this is the compat wire,
   *  where tool_calls ride a sibling field rather than the content array), a parts array is one
   *  block per part, everything else is one. Counting messages instead of blocks here would let a
   *  parallel tool burst read as ~1 block and quietly agree with a mis-measured fix. */
  const markedBlockIndices = (
    msgs: Array<{ content: unknown; tool_calls?: unknown[] }>,
  ): number[] => {
    const out: number[] = [];
    let n = 0;
    for (const m of msgs) {
      const parts = (Array.isArray(m.content) ? m.content : [m.content]) as Array<{
        cache_control?: unknown;
      }>;
      for (const b of parts) {
        if (b?.cache_control) out.push(n);
        n++;
      }
      n += m.tool_calls?.length ?? 0; // tool_use blocks carry no breakpoint, but they occupy space
    }
    return out;
  };

  test("anthropic-native: the two rolling marks sit a full lookback window apart", async () => {
    await chat(
      { baseUrl: base, apiKey: "t", models: ["claude-sonnet-5"], api: "anthropic", maxRetries: 0 },
      { messages: burstHistory() },
    );
    const idx = markedBlockIndices(captured.messages as Array<{ content: unknown }>);
    expect(idx.length).toBe(2); // spacing must not cost us the second mark on a real transcript
    expect((idx[1] as number) - (idx[0] as number)).toBeGreaterThanOrEqual(DOCUMENTED_LOOKBACK);
  });

  test("openai-wire: the two rolling marks sit a full lookback window apart", async () => {
    await chat(
      { baseUrl: base, apiKey: "t", models: ["anthropic/claude-sonnet-5"], maxRetries: 0 },
      { messages: burstHistory() },
    );
    // The system mark is inside `messages` on this wire, so drop it before measuring the rolling
    // pair. Both serializers must agree: the first cut of an earlier breakpoint fix shipped to
    // this path only and left native — the wire the affected agent runs — unfixed (codex P1).
    const msgs = (captured.messages as Array<{ role: string; content: unknown }>).filter(
      (m) => m.role !== "system",
    );
    const idx = markedBlockIndices(msgs);
    expect(idx.length).toBe(2);
    expect((idx[1] as number) - (idx[0] as number)).toBeGreaterThanOrEqual(DOCUMENTED_LOOKBACK);
  });

  test("the lookback constant matches Anthropic's documented window", () => {
    // Pinned separately from the spacing tests so the two cannot drift together.
    expect(CACHE_LOOKBACK_BLOCKS).toBe(DOCUMENTED_LOOKBACK);
  });

  // codex P3: the documented clamping was asserted only through one finite value. Pin the
  // hostile inputs directly — a NaN silently disabling the exclusion is the dangerous one,
  // because it restores the original bug without failing anything.
  test("rollingScanFrom clamps hostile counts", () => {
    expect(rollingScanFrom(10, 2)).toBe(7);
    expect(rollingScanFrom(10, 0)).toBe(9);
    expect(rollingScanFrom(10, -5)).toBe(9); // negative → exclude nothing
    expect(rollingScanFrom(10, 2.7)).toBe(7); // fractional → floor
    expect(rollingScanFrom(10, 99)).toBe(-1); // over-length → no rolling marks
    expect(rollingScanFrom(10, Number.NaN)).toBe(9); // non-finite → exclude nothing
    expect(rollingScanFrom(10, Number.POSITIVE_INFINITY)).toBe(9);
    expect(rollingScanFrom(10, undefined)).toBe(9);
  });

  // OpenAI documents prompt_cache_key on Chat Completions (not Responses-only) and says it is
  // REQUIRED for reliable matching on GPT-5.6+. OpenRouter forwards it as its sticky routing
  // key. We were sending it on the Responses wire only.
  test("openai-compat path: prompt_cache_key is sent when the endpoint accepts it", async () => {
    const key = `sess_${"y".repeat(100)}`;
    await chat(
      { baseUrl: base, apiKey: "t", models: ["gpt-5.5"], maxRetries: 0, promptCacheKey: true },
      { messages: history, cacheKey: key },
    );
    expect(captured.prompt_cache_key).toBe(key.slice(0, 64));
  });

  // codex P1: an unknown top-level field is a legitimate 400 on a strict OpenAI-compatible
  // server, and a plain 4xx is NOT failover-worthy here — so guessing would turn an arbitrary
  // MODEL_BASE_URL from "uncached" into "completely unusable". Absence is the safety property.
  test("openai-compat path: an unknown endpoint is never sent prompt_cache_key", async () => {
    await chat(
      { baseUrl: base, apiKey: "t", models: ["gpt-5.5"], maxRetries: 0 },
      { messages: history, cacheKey: "sess_abc" },
    );
    expect("prompt_cache_key" in captured).toBe(false);
  });

  test("acceptsPromptCacheKey gates on the parsed hostname, not a substring", () => {
    expect(acceptsPromptCacheKey({ baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
    expect(acceptsPromptCacheKey({ baseUrl: "https://api.openai.com/v1" })).toBe(true);
    // a lookalike host must not opt itself in
    expect(acceptsPromptCacheKey({ baseUrl: "https://openrouter.ai.attacker.test/v1" })).toBe(
      false,
    );
    expect(acceptsPromptCacheKey({ baseUrl: "https://notopenai.com/v1" })).toBe(false);
    expect(acceptsPromptCacheKey({ baseUrl: "http://127.0.0.1:8080" })).toBe(false);
    expect(acceptsPromptCacheKey({ baseUrl: "not a url" })).toBe(false);
    // explicit override wins in both directions
    expect(acceptsPromptCacheKey({ baseUrl: "http://proxy.internal", promptCacheKey: true })).toBe(
      true,
    );
    expect(
      acceptsPromptCacheKey({ baseUrl: "https://api.openai.com/v1", promptCacheKey: false }),
    ).toBe(false);
  });

  test("responses path: prompt_cache_key carries the session id, clamped to 64", async () => {
    await chat(
      { baseUrl: base, apiKey: "t", models: ["gpt-5.5"], api: "responses", maxRetries: 0 },
      { messages: history, cacheKey: `sess_${"x".repeat(100)}` },
    );
    expect(captured.prompt_cache_key?.length).toBe(64);
    expect(captured.prompt_cache_key?.startsWith("sess_")).toBe(true);
  });
});

describe("utility-model lane", () => {
  test("falls back to the main chat when the utility call fails (never loses a call)", async () => {
    // Mirrors index.ts's chatUtility composition.
    const utility = async (): Promise<ModelResult> => ({
      ok: false,
      model: "haiku",
      error: "model not found",
    });
    const main = async (): Promise<ModelResult> => ({
      ok: true,
      model: "sonnet",
      message: { role: "assistant", content: "main answered" },
      finishReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, costUsd: 0 },
      latencyMs: 1,
    });
    const chatUtility = async (_req: ChatRequest) => {
      const res = await utility();
      return res.ok || res.aborted ? res : main();
    };
    const out = await chatUtility({ messages: [] });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.message.content).toBe("main answered");
  });
});

describe("pricing (Sprint 2)", () => {
  test("fleet GLMs are priced (no more invisible $0 on subscription paths)", () => {
    expect(resolvePrice("z-ai/glm-5.2", BAKED_PRICES)).toEqual({
      in: 0.84,
      out: 2.64,
      cacheRead: 0.156,
    });
    expect(resolvePrice("glm-5", BAKED_PRICES)).toEqual({ in: 0.6, out: 1.92, cacheRead: 0.12 });
  });
  test("prefix fallback: a dated slug inherits its base price; longest key wins", () => {
    expect(resolvePrice("anthropic/claude-sonnet-5-20260115", BAKED_PRICES)).toEqual(
      BAKED_PRICES["claude-sonnet-5"] as never,
    );
    // glm-5.2 must NOT fall back to glm-5 (exact key exists; also 5.2 startsWith "glm-5" —
    // longest-key-wins keeps it honest)
    expect(resolvePrice("z-ai/glm-5.2-air", BAKED_PRICES)).toEqual({
      in: 0.84,
      out: 2.64,
      cacheRead: 0.156,
    });
  });
  test("an unrelated slug that merely CONTAINS a key no longer matches", () => {
    expect(resolvePrice("not-a-claude-sonnet-5", BAKED_PRICES)).toBeNull();
  });
});

// OpenAI deprecated max_tokens on Chat Completions in favour of max_completion_tokens, and the
// o-series rejects it outright. Only OpenAI's own host is switched: OpenRouter normalises the old
// name (verified live against openai/gpt-5.5) and an arbitrary compatible server may know only it.
describe("deprecated parameter names", () => {
  test("only OpenAI's own endpoint gets max_completion_tokens", () => {
    expect(usesMaxCompletionTokens("https://api.openai.com/v1")).toBe(true);
    expect(usesMaxCompletionTokens("https://openrouter.ai/api/v1")).toBe(false);
    expect(usesMaxCompletionTokens("http://127.0.0.1:8080/v1")).toBe(false);
    expect(usesMaxCompletionTokens("https://api.openai.com.attacker.test/v1")).toBe(false);
    expect(usesMaxCompletionTokens("not a url")).toBe(false);
  });
});
