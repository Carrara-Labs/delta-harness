// D-12: the ChatGPT/Codex subscription backend rejects `max_output_tokens` outright, at any
// value — parent turns never send one, so the same connection works for the parent and 400s
// every child (24 starts, 24 failures on one observed run). Deny the one host we have wire
// proof about; every other Responses endpoint keeps the cap. Suffix-deny is the safe
// direction: only OpenAI controls *.chatgpt.com DNS, and a denied param costs nothing while
// a 400 costs the call.

import { afterEach, describe, expect, test } from "bun:test";
import { acceptsMaxOutputTokens, chat, toAnthropic, type ProviderConfig } from "../src/provider";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("acceptsMaxOutputTokens (D-12)", () => {
  test("denies the subscription host, keeps everyone else", () => {
    expect(acceptsMaxOutputTokens("https://chatgpt.com/backend-api/codex")).toBe(false);
    expect(acceptsMaxOutputTokens("https://api.openai.com/v1")).toBe(true);
    expect(acceptsMaxOutputTokens("https://openrouter.ai/api/v1")).toBe(true);
    // hostMatches suffix semantics: a chatgpt.com SUBDOMAIN is OpenAI-controlled DNS and gets
    // the param denied too — the safe direction (review 2026-08-19 inverted the spec's draft).
    expect(acceptsMaxOutputTokens("https://evil.chatgpt.com/v1")).toBe(false);
    // …but a lookalike that merely CONTAINS the string is untouched.
    expect(acceptsMaxOutputTokens("https://notchatgpt.com/v1")).toBe(true);
  });
});

describe("Responses body assembly (D-12)", () => {
  async function capturedBody(baseUrl: string): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return new Response(
        [
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { usage: {} } },
        ]
          .map((e) => `data: ${JSON.stringify(e)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const cfg: ProviderConfig = {
      baseUrl,
      apiKey: "x",
      models: ["gpt-5.6-sol"],
      api: "responses",
      maxRetries: 0,
    };
    const r = await chat(cfg, {
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 4000,
      reasoningEffort: "low",
    });
    expect(r.ok).toBe(true);
    return body;
  }

  test("chatgpt.com: no max_output_tokens KEY at all; store:false and reasoning still ride", async () => {
    const body = await capturedBody("https://chatgpt.com/backend-api/codex");
    // Key ABSENCE, not a falsy value — `store: false` on the same wire shows the difference matters.
    expect("max_output_tokens" in body).toBe(false);
    expect(body.store).toBe(false);
    expect((body.reasoning as { effort: string }).effort).toBe("low");
  });

  test("api.openai.com keeps the cap", async () => {
    const body = await capturedBody("https://api.openai.com/v1");
    expect(body.max_output_tokens).toBe(4000);
    expect(body.store).toBe(false);
  });

  test("openrouter keeps the cap", async () => {
    const body = await capturedBody("https://openrouter.ai/api/v1");
    expect(body.max_output_tokens).toBe(4000);
  });
});

describe("Responses usage parsing (M3, 0.2.16)", () => {
  test("nested cache_write_tokens reaches usage.cacheWrite (and cost bills it at 1.25×)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          { type: "response.output_text.delta", delta: "ok" },
          {
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 2_600,
                output_tokens: 10,
                total_tokens: 2_610,
                // The 5.6+ shape: BOTH cache fields nested under input_tokens_details
                // (caching guide + openai-python ResponseUsage). A top-level read would miss it.
                input_tokens_details: { cached_tokens: 2_000, cache_write_tokens: 400 },
              },
            },
          },
        ]
          .map((e) => `data: ${JSON.stringify(e)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const cfg: ProviderConfig = {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "x",
      models: ["gpt-5.6-sol"],
      api: "responses",
      maxRetries: 0,
    };
    const r = await chat(cfg, { messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usage.cacheRead).toBe(2_000);
    expect(r.usage.cacheWrite).toBe(400);
    // fresh 200*$5 + read 2000*$0.5 + write 400*$6.25 + out 10*$30 = 4800/1e6
    expect(r.usage.costUsd).toBeCloseTo(0.0048, 8);
  });
});

// ── M1 (0.2.16): ReasoningCarry + phase carry ────────────────────────────────────────────────
// Live-wire proven 2026-08-19 against api.openai.com (fixtures in the session scratchpad):
// reasoning items arrive via `response.output_item.done` carrying `encrypted_content` when the
// request includes `include:["reasoning.encrypted_content"]`; message items carry `phase`
// (e.g. "final_answer"); replaying [reasoning, function_call, function_call_output] verbatim
// and the message item WITH phase both return 200. chatgpt.com is default-denied (D-12 rule).

function sse(events: unknown[]): Response {
  return new Response(
    events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const RS = {
  id: "rs_1",
  type: "reasoning",
  content: [],
  encrypted_content: "gAAAAABo-opaque-blob-1234567890",
  summary: [],
};

function mockCapture(events: unknown[]): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    return sse(events);
  }) as unknown as typeof fetch;
  return { body: () => captured };
}

describe("ReasoningCarry capture (M1)", () => {
  const cfg = (baseUrl: string): ProviderConfig => ({
    baseUrl,
    apiKey: "x",
    models: ["gpt-5.6-sol"],
    api: "responses",
    maxRetries: 0,
  });

  test("reasoning item + phase ride the assistant message, captured from output_item.done", async () => {
    const cap = mockCapture([
      { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning" } },
      { type: "response.output_item.done", output_index: 0, item: RS },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "get_weather", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":"Paris"}' },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: { id: "msg_1", type: "message", role: "assistant", phase: "intermediate", content: [] },
      },
      { type: "response.completed", response: { usage: {} } },
    ]);
    const r = await chat(cfg("https://api.openai.com/v1"), {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The finalized item, VERBATIM — the in-progress `added` shape has no encrypted_content.
    expect(r.message.reasoningItems).toEqual([RS]);
    expect(r.message.phase).toBe("intermediate");
    // The request asked for the encrypted payload (documented opt-in; default-on is not relied on).
    expect(cap.body().include).toEqual(["reasoning.encrypted_content"]);
  });

  test("a reasoning item without encrypted_content is a husk — not captured", async () => {
    mockCapture([
      { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { usage: {} } },
    ]);
    const r = await chat(cfg("https://api.openai.com/v1"), {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message.reasoningItems).toBeUndefined();
  });

  test("chatgpt.com: include is NOT sent (unprobed surface, D-12 rule)", async () => {
    const cap = mockCapture([
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { usage: {} } },
    ]);
    const r = await chat(cfg("https://chatgpt.com/backend-api/codex"), {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    expect("include" in cap.body()).toBe(false);
  });
});

describe("ReasoningCarry replay (M1)", () => {
  const history: import("../src/provider").ChatMsg[] = [
    { role: "user", content: "look up Paris weather" },
    {
      role: "assistant",
      content: "checking",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      reasoningItems: [RS],
      phase: "intermediate",
    },
    { role: "tool", tool_call_id: "call_1", content: "24C, clear" },
  ];
  const done = [
    { type: "response.output_text.delta", delta: "ok" },
    { type: "response.completed", response: { usage: {} } },
  ];

  test("api.openai.com: reasoning replays verbatim BEFORE the turn's text and calls; phase rides the message item", async () => {
    const cap = mockCapture(done);
    const r = await chat(
      { baseUrl: "https://api.openai.com/v1", apiKey: "x", models: ["gpt-5.6-sol"], api: "responses", maxRetries: 0 },
      { messages: history },
    );
    expect(r.ok).toBe(true);
    const input = cap.body().input as Array<Record<string, unknown>>;
    const types = input.map((i) => (i.type as string) ?? `msg:${i.role}`);
    expect(types).toEqual(["msg:user", "reasoning", "msg:assistant", "function_call", "function_call_output"]);
    expect(input[1]).toEqual(RS); // verbatim — the payload is opaque and must not be reshaped
    expect(input[2]?.phase).toBe("intermediate");
  });

  test("chatgpt.com: no reasoning items, no phase on the wire (default-denied until probed)", async () => {
    const cap = mockCapture(done);
    const r = await chat(
      { baseUrl: "https://chatgpt.com/backend-api/codex", apiKey: "x", models: ["gpt-5.6"], api: "responses", maxRetries: 0 },
      { messages: history },
    );
    expect(r.ok).toBe(true);
    const input = cap.body().input as Array<Record<string, unknown>>;
    expect(input.some((i) => i.type === "reasoning")).toBe(false);
    expect(input.some((i) => "phase" in i)).toBe(false);
  });

  test("chat wire strips carry fields (a Responses-origin field must never 400 a failover)", async () => {
    const cap = mockCapture([
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      "[DONE]",
    ]);
    const r = await chat(
      { baseUrl: "https://openrouter.ai/api/v1", apiKey: "x", models: ["anthropic/claude-sonnet-5"], maxRetries: 0 },
      { messages: history },
    );
    expect(r.ok).toBe(true);
    const msgs = cap.body().messages as Array<Record<string, unknown>>;
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect("reasoningItems" in (assistant ?? {})).toBe(false);
    expect("phase" in (assistant ?? {})).toBe(false);
    expect(assistant?.content).toBe("checking"); // everything else intact
  });

  test("toAnthropic ignores carry fields — the Anthropic wire is byte-identical", () => {
    const bare = history.map((m) =>
      m.role === "assistant" ? { role: m.role, content: m.content, tool_calls: m.tool_calls } : m,
    ) as import("../src/provider").ChatMsg[];
    expect(toAnthropic(history)).toEqual(toAnthropic(bare));
  });
});

describe("Responses tuning knobs (M4, 0.2.16)", () => {
  // Both wire-proven on api.openai.com 2026-08-19 (probes B and D: 200).
  const done = [
    { type: "response.output_text.delta", delta: "ok" },
    { type: "response.completed", response: { usage: {} } },
  ];
  const cfg = (baseUrl: string): ProviderConfig => ({
    baseUrl,
    apiKey: "x",
    models: ["gpt-5.6-sol"],
    api: "responses",
    maxRetries: 0,
    textVerbosity: "low",
    reasoningSummary: "auto",
  });

  test("api.openai.com: verbosity + summary render; summary composes with effort", async () => {
    const cap = mockCapture(done);
    const r = await chat(cfg("https://api.openai.com/v1"), {
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "low",
    });
    expect(r.ok).toBe(true);
    expect(cap.body().text).toEqual({ verbosity: "low" });
    expect(cap.body().reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  test("summary rides alone when no effort is set", async () => {
    const cap = mockCapture(done);
    const r = await chat(cfg("https://api.openai.com/v1"), {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    expect(cap.body().reasoning).toEqual({ summary: "auto" });
  });

  test("chatgpt.com: neither knob is sent (unprobed surface)", async () => {
    const cap = mockCapture(done);
    const r = await chat(cfg("https://chatgpt.com/backend-api/codex"), {
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "low",
    });
    expect(r.ok).toBe(true);
    expect("text" in cap.body()).toBe(false);
    expect(cap.body().reasoning).toEqual({ effort: "low" });
  });
});
