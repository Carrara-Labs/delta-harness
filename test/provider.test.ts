import { afterAll, describe, expect, test } from "bun:test";
import { chat, normalizeEffort, type ProviderConfig } from "../src/provider";

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

    test("Anthropic native → thinking budget, max_tokens raised above it", async () => {
      capture();
      await chat(cfg({ api: "anthropic", maxRetries: 0 }), {
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 4096,
        reasoningEffort: "high",
      });
      expect(seen.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
      expect(seen.max_tokens as number).toBeGreaterThan(16384); // room for the answer after thinking
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
