// D-12: the ChatGPT/Codex subscription backend rejects `max_output_tokens` outright, at any
// value — parent turns never send one, so the same connection works for the parent and 400s
// every child (24 starts, 24 failures on one observed run). Deny the one host we have wire
// proof about; every other Responses endpoint keeps the cap. Suffix-deny is the safe
// direction: only OpenAI controls *.chatgpt.com DNS, and a denied param costs nothing while
// a 400 costs the call.

import { afterEach, describe, expect, test } from "bun:test";
import { acceptsMaxOutputTokens, chat, type ProviderConfig } from "../src/provider";

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
