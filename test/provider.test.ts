import { afterAll, describe, expect, test } from "bun:test";
import { anthropicUsesAdaptive, chat, normalizeEffort, type ProviderConfig } from "../src/provider";

describe("normalizeEffort", () => {
  test("normalizes case/space and passes ANY non-empty value through (the model is the authority)", () => {
    expect(normalizeEffort("high")).toBe("high");
    expect(normalizeEffort(" Medium ")).toBe("medium");
    expect(normalizeEffort("MINIMAL")).toBe("minimal");
    expect(normalizeEffort("none")).toBe("none");
    expect(normalizeEffort("xhigh")).toBe("xhigh");
    // Pass-through: an unrecognized/future tier is NOT gated — it reaches the model, which 4xxs
    // if it doesn't support it (error-as-value). Only empty/non-string → undefined (send nothing).
    expect(normalizeEffort("ultra")).toBe("ultra");
    expect(normalizeEffort("")).toBeUndefined();
    expect(normalizeEffort(undefined)).toBeUndefined();
    expect(normalizeEffort(5)).toBeUndefined();
  });
});

// Scriptable mock of an OpenAI-compatible /chat/completions endpoint.
let script: (callCount: number, body: Record<string, unknown>) => Response = () => sse();
let calls = 0;
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    calls++;
    return script(calls, (await req.json()) as Record<string, unknown>);
  },
});
afterAll(() => server.stop());

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    baseUrl: `http://localhost:${server.port}/v1`,
    apiKey: "test",
    models: ["test/a"],
    maxRetries: 1,
    ...overrides,
  };
}

function sse(...chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function reset(fn: typeof script) {
  calls = 0;
  script = fn;
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ delta: d, finish_reason: finish }],
});

describe("provider streaming", () => {
  test("assembles text deltas and captures usage incl. cost + cache", async () => {
    reset(() =>
      sse(delta({ content: "Hel" }), delta({ content: "lo" }, "stop"), {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cost: 0.0042,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    );
    const result = await chat(cfg(), { messages: [{ role: "user", content: "hi" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.message.content).toBe("Hello");
    expect(result.usage).toEqual({
      input: 100,
      output: 20,
      cacheRead: 80,
      cacheWrite: 0, // openai-wire prompt_tokens is already gross; no separate creation field
      total: 120,
      costUsd: 0.0042,
    });
    expect(result.finishReason).toBe("stop");
  });

  describe("reasoning effort maps per wire", () => {
    let seen: Record<string, unknown> = {};
    const capture = () => {
      seen = {};
      reset((_, body) => {
        seen = body;
        return sse(delta({ content: "ok" }, "stop"));
      });
    };
    const orUrl = `http://localhost:${server.port}/openrouter.ai/v1`; // includes the OR marker

    test("OpenRouter → unified reasoning.effort", async () => {
      capture();
      await chat(cfg({ baseUrl: orUrl, maxRetries: 0 }), {
        messages: [{ role: "user", content: "hi" }],
        reasoningEffort: "high",
      });
      expect(seen.reasoning).toEqual({ effort: "high" });
      expect(seen.reasoning_effort).toBeUndefined();
    });

    test("direct OpenAI-compatible → flat reasoning_effort", async () => {
      capture();
      await chat(cfg({ maxRetries: 0 }), {
        messages: [{ role: "user", content: "hi" }],
        reasoningEffort: "medium",
      });
      expect(seen.reasoning_effort).toBe("medium");
      expect(seen.reasoning).toBeUndefined();
    });

    test("Responses (subscription) → reasoning.effort", async () => {
      capture();
      await chat(cfg({ api: "responses", maxRetries: 0 }), {
        messages: [{ role: "user", content: "hi" }],
        reasoningEffort: "minimal",
      });
      expect(seen.reasoning).toEqual({ effort: "minimal" });
    });

    test("Responses (subscription) → xhigh passes straight through (gpt-5.x top tier)", async () => {
      capture();
      await chat(cfg({ api: "responses", maxRetries: 0 }), {
        messages: [{ role: "user", content: "hi" }],
        reasoningEffort: "xhigh",
      });
      expect(seen.reasoning).toEqual({ effort: "xhigh" });
    });

    test("Anthropic ≤4.5 (legacy) → thinking budget, max_tokens raised above it", async () => {
      capture();
      await chat(cfg({ api: "anthropic", models: ["claude-opus-4-5"], maxRetries: 0 }), {
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 4096,
        reasoningEffort: "high",
      });
      expect(seen.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
      expect(seen.max_tokens as number).toBeGreaterThan(16384); // room for the answer after thinking
      expect(seen.output_config).toBeUndefined();
    });

    test("A8: Anthropic 5.x/4.6+ → adaptive + output_config.effort (NO enabled), max_tokens headroom", async () => {
      for (const model of ["claude-opus-5", "claude-sonnet-4-6", "test/a"]) {
        capture();
        await chat(cfg({ api: "anthropic", models: [model], maxRetries: 0 }), {
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 4096,
          reasoningEffort: "high",
        });
        expect(seen.thinking).toEqual({ type: "adaptive" });
        expect(seen.output_config).toEqual({ effort: "high" });
        // headroom: 4096 base + 16384 (high) so thinking can't truncate the answer at the default cap
        expect(seen.max_tokens).toBe(4096 + 16384);
      }
    });

    test("A8: adaptive effort aliases — none/minimal→low (never disabled) with low's headroom", async () => {
      // Headroom is keyed on the NORMALIZED wire effort, so none/minimal→low get low's 4096 budget
      // (not 0) — a default 4096 cap can't truncate the answer after thinking (codex R2 #2).
      for (const [effort, wire, maxTokens] of [
        ["none", "low", 4096 + 4096],
        ["minimal", "low", 4096 + 4096],
        ["xhigh", "xhigh", 4096 + 32768],
      ] as const) {
        capture();
        await chat(cfg({ api: "anthropic", models: ["claude-opus-5"], maxRetries: 0 }), {
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 4096,
          reasoningEffort: effort,
        });
        // Always adaptive — never thinking:{type:"disabled"} (always-on models 400 on that).
        expect(seen.thinking).toEqual({ type: "adaptive" });
        expect(seen.output_config).toEqual({ effort: wire });
        expect(seen.max_tokens).toBe(maxTokens);
      }
    });

    test("A8: anthropicUsesAdaptive classifies real ids (incl. dated legacy slugs)", () => {
      for (const m of ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-opus-4.8"])
        expect(anthropicUsesAdaptive(m)).toBe(true);
      for (const m of [
        "claude-opus-4-5",
        "claude-sonnet-4-5-20250929", // dated 4.5 — still enabled-only (threshold is 4.6)
        "claude-opus-4-1-20250805",
        "claude-opus-4-20250514", // dated Opus 4.0 — must NOT be read as minor 20250514
        "claude-3-7-sonnet",
      ])
        expect(anthropicUsesAdaptive(m)).toBe(false);
      expect(anthropicUsesAdaptive("some-proxy-alias")).toBe(true); // unknown → modern default
    });

    test("A9: native wire normalizes model id (strip prefix + dots→dashes)", async () => {
      capture();
      await chat(cfg({ api: "anthropic", models: ["anthropic/claude-opus-4.8"], maxRetries: 0 }), {
        messages: [{ role: "user", content: "hi" }],
      });
      expect(seen.model).toBe("claude-opus-4-8"); // primary and fallback both normalize here
    });

    test("no effort → no reasoning field on any wire (provider default)", async () => {
      capture();
      await chat(cfg({ maxRetries: 0 }), { messages: [{ role: "user", content: "hi" }] });
      expect(seen.reasoning).toBeUndefined();
      expect(seen.reasoning_effort).toBeUndefined();
      expect(seen.thinking).toBeUndefined();
    });
  });

  test("assembles fragmented tool calls (id arriving late, args split)", async () => {
    reset(() =>
      sse(
        delta({
          tool_calls: [{ index: 0, id: "call_a", function: { name: "add", arguments: "" } }],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"a":2,' } }] }),
        delta({ tool_calls: [{ index: 1, function: { name: "note", arguments: '{"x":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"b":3}' } }] }),
        delta(
          { tool_calls: [{ index: 1, id: "call_b", function: { arguments: "1}" } }] },
          "tool_calls",
        ),
      ),
    );
    const result = await chat(cfg(), { messages: [{ role: "user", content: "go" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.message.tool_calls).toEqual([
      { id: "call_a", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } },
      { id: "call_b", type: "function", function: { name: "note", arguments: '{"x":1}' } },
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  test("retries a 500 then succeeds", async () => {
    reset((n) =>
      n === 1 ? new Response("boom", { status: 500 }) : sse(delta({ content: "ok" }, "stop")),
    );
    const result = await chat(cfg(), { messages: [{ role: "user", content: "hi" }] });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("does not retry a 400, returns normalized error as value", async () => {
    reset(() =>
      Response.json({ error: { message: "bad request: no such model" } }, { status: 400 }),
    );
    const result = await chat(cfg(), { messages: [{ role: "user", content: "hi" }] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.error).toBe("bad request: no such model");
    expect(calls).toBe(1);
  });

  test("fails over to the next model after retries exhaust", async () => {
    reset((_n, body) =>
      body.model === "test/a"
        ? new Response("down", { status: 503 })
        : sse(delta({ content: "b!" }, "stop")),
    );
    const result = await chat(cfg({ models: ["test/a", "test/b"], maxRetries: 0 }), {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.model).toBe("test/b");
  });

  test("mid-stream error chunk becomes ok:false, never a throw", async () => {
    reset(() => sse(delta({ content: "par" }), { error: { message: "provider melted" } }));
    const result = await chat(cfg({ maxRetries: 0 }), {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("provider melted");
  });

  test("abort surfaces as aborted, not an error to retry", async () => {
    reset(() => sse(delta({ content: "never" }, "stop")));
    const ac = new AbortController();
    ac.abort();
    const result = await chat(cfg(), {
      messages: [{ role: "user", content: "hi" }],
      signal: ac.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.aborted).toBe(true);
  });
});

// Anthropic-wire SSE (typed events; the parser reads only `data:` lines, no [DONE]).
function asse(...events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("reasoning capture (onReasoningDelta)", () => {
  test("OpenAI-compat: reasoning_content + reasoning stream to onReasoningDelta, not content", async () => {
    reset(() =>
      sse(
        delta({ reasoning_content: "let me " }),
        delta({ reasoning: "think… " }),
        delta({ content: "Answer" }, "stop"),
      ),
    );
    const reasoning: string[] = [];
    const result = await chat(cfg({ maxRetries: 0 }), {
      messages: [{ role: "user", content: "hi" }],
      onReasoningDelta: (t) => reasoning.push(t),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(reasoning.join("")).toBe("let me think… ");
    expect(result.message.content).toBe("Answer"); // reasoning never leaks into the answer
  });

  test("Anthropic native: thinking_delta streams, signature_delta is ignored", async () => {
    reset(() =>
      asse(
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "pon" } },
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "der" } },
        { type: "content_block_delta", delta: { type: "signature_delta", signature: "SIG==" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ),
    );
    const reasoning: string[] = [];
    const result = await chat(cfg({ api: "anthropic", maxRetries: 0 }), {
      messages: [{ role: "user", content: "hi" }],
      onReasoningDelta: (t) => reasoning.push(t),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(reasoning.join("")).toBe("ponder"); // signature was not captured
    expect(result.message.content).toBe("Hi");
  });

  // The parity guarantee: reasoning must NOT set the `emitted` failover guard. A stream that
  // emits reasoning then truncates pre-answer must still be retriable — if reasoning poisoned
  // the guard, chat() would refuse the retry and return the truncation error instead.
  test("reasoning does not poison failover — a reasoning-then-truncate stream still retries", async () => {
    // Raw stream with NO [DONE] and NO finish_reason → the parser sees a truncated stream
    // ("stream ended before completion", retriable). If reasoning had set `emitted`, chat()'s
    // poisoned guard would refuse this retry.
    const truncated = () =>
      new Response(
        `data: ${JSON.stringify(delta({ reasoning_content: "thinking, no answer…" }))}\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    reset((n) => (n === 1 ? truncated() : sse(delta({ content: "recovered" }, "stop"))));
    const reasoning: string[] = [];
    const result = await chat(cfg({ maxRetries: 1 }), {
      messages: [{ role: "user", content: "hi" }],
      onReasoningDelta: (t) => reasoning.push(t),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(calls).toBe(2); // it retried — reasoning did not mark the turn as emitted
    expect(result.message.content).toBe("recovered");
  });
});
