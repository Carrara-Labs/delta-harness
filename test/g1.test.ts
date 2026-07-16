// G1: subscription providers. The native OpenAI Responses API variant (§C / G1a —
// the ChatGPT/Codex subscription backend the broker token targets) and the
// cross-provider failover cascade (§C / G1c). Mock-tested end to end; the live
// path is gated on Nic providing the ChatGPT-backend base URL + real creds.

import { afterAll, describe, expect, test } from "bun:test";
import { NoServableToken } from "../src/broker";
import { loadConfig } from "../src/config";
import { chat, chatVia, failoverWorthy, type ProviderConfig } from "../src/provider";

const stops: Array<() => void> = [];
afterAll(() => {
  for (const s of stops) s();
});

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

describe("native Responses API (§C / G1a)", () => {
  function mockResponses(handler: (body: Record<string, unknown>, headers: Headers) => string) {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as Record<string, unknown>;
        return new Response(handler(body, req.headers), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    stops.push(() => server.stop());
    return `http://localhost:${server.port}/v1`;
  }

  test("sends Responses shape (instructions + typed input, bearer + account header) and assembles text + usage", async () => {
    let captured: Record<string, unknown> = {};
    let authSeen = "";
    let acctSeen = "";
    const url = mockResponses((body, headers) => {
      captured = body;
      authSeen = headers.get("authorization") ?? "";
      acctSeen = headers.get("chatgpt-account-id") ?? "";
      return sse(
        { type: "response.output_text.delta", delta: "Hel" },
        { type: "response.output_text.delta", delta: "lo" },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 5,
              total_tokens: 105,
              input_tokens_details: { cached_tokens: 80 },
            },
          },
        },
      );
    });
    const cfg: ProviderConfig = {
      baseUrl: url,
      apiKey: "",
      models: ["gpt-5-codex"],
      api: "responses",
      maxRetries: 0,
      // A broker-style credential: bearer + the chatgpt-account-id header.
      credential: {
        get: async () => ({ token: "sub-token", headers: { "chatgpt-account-id": "acct-1" } }),
      },
    };
    const res = await chat(cfg, {
      messages: [
        { role: "system", content: "SPINE" },
        { role: "user", content: "hi" },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.message.content).toBe("Hello");
    expect(res.usage.input).toBe(100);
    expect(res.usage.cacheRead).toBe(80);
    expect(res.usage.output).toBe(5);
    expect(authSeen).toBe("Bearer sub-token");
    expect(acctSeen).toBe("acct-1");
    expect(captured.instructions).toBe("SPINE"); // system → instructions
    expect(captured.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  test("assembles a streamed function_call item into a WireToolCall", async () => {
    const url = mockResponses(() =>
      sse(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "add" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"a":2,' },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"b":3}' },
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 8 } } },
      ),
    );
    const res = await chat(
      { baseUrl: url, apiKey: "k", models: ["m"], api: "responses", maxRetries: 0 },
      {
        messages: [{ role: "user", content: "add 2 and 3" }],
        tools: [
          { type: "function", function: { name: "add", description: "sum", parameters: {} } },
        ],
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.finishReason).toBe("tool_calls");
    expect(res.message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } },
    ]);
  });

  test("a response.failed event becomes ok:false, not a throw", async () => {
    const url = mockResponses(() =>
      sse({ type: "response.failed", response: { error: { message: "quota exceeded" } } }),
    );
    const res = await chat(
      { baseUrl: url, apiKey: "k", models: ["m"], api: "responses", maxRetries: 0 },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toBe("quota exceeded");
  });

  test("a truncated stream (deltas but no terminal event) is ok:false, not a half-answer (codex P1)", async () => {
    // Text arrives, then the stream just ends — no response.completed.
    const url = mockResponses(() => sse({ type: "response.output_text.delta", delta: "half" }));
    const res = await chat(
      { baseUrl: url, apiKey: "k", models: ["m"], api: "responses", maxRetries: 0 },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("ended before completion");
  });
});

describe("failover cascade (§C / G1c)", () => {
  test("failoverWorthy: falls through on 409/401/403/429/5xx/network, holds on 4xx", () => {
    const err = (status?: number) => ({ ok: false as const, model: "m", error: "x", status });
    expect(failoverWorthy(err(409))).toBe(true); // NoServableToken
    expect(failoverWorthy(err(401))).toBe(true); // auth
    expect(failoverWorthy(err(429))).toBe(true); // rate limit
    expect(failoverWorthy(err(503))).toBe(true); // 5xx
    expect(failoverWorthy(err(undefined))).toBe(true); // network
    expect(failoverWorthy(err(400))).toBe(false); // our bad request — don't burn the next
    expect(failoverWorthy({ ok: false, model: "m", error: "x", aborted: true })).toBe(false);
  });

  // A minimal /chat/completions mock; status !== 200 exercises the failover path.
  function mockChat(status: number) {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        if (status !== 200) return new Response("boom", { status });
        return new Response(
          sse(
            { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
            { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
            "[DONE]",
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    stops.push(() => server.stop());
    return {
      p: (label: string): ProviderConfig => ({
        baseUrl: `http://localhost:${server.port}/v1`,
        apiKey: "k",
        models: ["m"],
        maxRetries: 0,
        label,
      }),
      hits: () => hits,
    };
  }

  test("a dead primary (500) falls through to the next provider; the served label is stamped", async () => {
    const dead = mockChat(500);
    const live = mockChat(200);
    const res = await chatVia([dead.p("openai-sub"), live.p("openrouter")], {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.provider).toBe("openrouter"); // the fallback served
    expect(dead.hits()).toBe(1);
    expect(live.hits()).toBe(1);
  });

  test("a 409 NoServableToken from the primary falls through", async () => {
    const live = mockChat(200);
    const primary: ProviderConfig = {
      baseUrl: "http://unused",
      apiKey: "",
      models: ["m"],
      maxRetries: 0,
      label: "sub",
      credential: {
        get: async () => {
          throw new NoServableToken();
        },
      },
    };
    const res = await chatVia([primary, live.p("openrouter")], {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.provider).toBe("openrouter");
  });

  test("a 4xx from the primary does NOT burn the next provider", async () => {
    const bad = mockChat(400);
    const live = mockChat(200);
    const res = await chatVia([bad.p("a"), live.p("b")], {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.provider).toBe("a"); // stopped at the primary
    expect(live.hits()).toBe(0); // never reached the fallback
  });

  test("does NOT fail over once a provider has streamed text (no concatenated answers, codex P1)", async () => {
    // A primary that streams a delta, THEN errors mid-stream.
    let hits1 = 0;
    const s1 = Bun.serve({
      port: 0,
      fetch: () => {
        hits1++;
        return new Response(
          sse(
            { choices: [{ delta: { content: "partial" } }] },
            { error: { message: "mid-stream boom" } },
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    stops.push(() => s1.stop());
    const live = (() => {
      let hits = 0;
      const s = Bun.serve({
        port: 0,
        fetch: () => {
          hits++;
          return new Response(
            sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      stops.push(() => s.stop());
      return { url: `http://localhost:${s.port}/v1`, hits: () => hits };
    })();

    const seen: string[] = [];
    const res = await chatVia(
      [
        {
          baseUrl: `http://localhost:${s1.port}/v1`,
          apiKey: "k",
          models: ["m"],
          maxRetries: 0,
          label: "a",
        },
        { baseUrl: live.url, apiKey: "k", models: ["m"], maxRetries: 0, label: "b" },
      ],
      { messages: [{ role: "user", content: "hi" }], onDelta: (t) => seen.push(t) },
    );
    expect(res.ok).toBe(false); // returned the mid-stream error, did NOT fail over
    if (res.ok) throw new Error("unreachable");
    expect(res.provider).toBe("a");
    expect(seen).toEqual(["partial"]); // only the primary's bytes — never a second answer
    expect(live.hits()).toBe(0); // fallback never reached (would have concatenated)
    expect(hits1).toBe(1);
  });

  test("loadConfig builds the ordered cascade: primary, then DELTA_PROVIDERS fallbacks", () => {
    const cfg = loadConfig({
      MODEL_BASE_URL: "https://chatgpt.example/v1",
      MODEL_API: "responses",
      DELTA_PROVIDERS: JSON.stringify([
        {
          baseUrl: "https://api.anthropic.com/v1",
          api: "anthropic",
          apiKeyEnv: "ANT_KEY",
          label: "anthropic-sub",
        },
        { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or", label: "openrouter" },
      ]),
      ANT_KEY: "sk-ant",
    });
    expect(cfg.providers.map((p) => p.label)).toEqual(["primary", "anthropic-sub", "openrouter"]);
    expect(cfg.providers[0]?.api).toBe("responses");
    expect(cfg.providers[1]?.api).toBe("anthropic");
    expect(cfg.providers[1]?.apiKey).toBe("sk-ant"); // read from apiKeyEnv
    expect(cfg.providers[2]?.apiKey).toBe("sk-or");
  });

  test("a broker-minted fallback pointed at OpenRouter drops its credential (no metered-host leak, codex P1)", () => {
    const cfg = loadConfig({
      MODEL_BASE_URL: "https://chatgpt.example/v1",
      DELTA_PROVIDERS: JSON.stringify([
        {
          baseUrl: "https://openrouter.ai/api/v1",
          brokerMintUrl: "https://x/mint",
          label: "leaky",
        },
      ]),
    });
    expect(cfg.providers[1]?.label).toBe("leaky");
    expect(cfg.providers[1]?.credential).toBeUndefined(); // refused — would leak the sub token
  });
});
