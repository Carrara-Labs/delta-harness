// Sprint 2 (harness v2): rolling cache breakpoint, utility-model lane, compaction elide,
// pricing coverage. The breakpoint tests capture the REAL request body a provider would
// receive — placement bugs here silently burn money, so we pin the wire shape exactly.

import { afterAll, describe, expect, test } from "bun:test";
import { BAKED_PRICES, resolvePrice } from "../src/pricing";
import { type ChatMsg, type ChatRequest, chat, type ModelResult } from "../src/provider";
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
    // the user message is the SECOND rolling mark (last two user/tool marked — survives
    // Anthropic's ~20-block cache lookback after a big parallel-tool turn; codex #7)
    const mid = msgs.find((m) => m.role === "user");
    const midPart = (mid?.content as Array<{ cache_control?: unknown }>)[0];
    expect(midPart?.cache_control).toEqual({ type: "ephemeral" });
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
    // exactly TWO rolling marks (the last two user-role messages) + the system block = 3 of 4
    const marked = msgs.flatMap((m) => m.content).filter((b) => b.cache_control);
    expect(marked.length).toBe(2);
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
