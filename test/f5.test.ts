// F5 smaller wins: per-run act-as-token passthrough, tool-result elision,
// and the native Anthropic Messages API provider path.

import { afterAll, describe, expect, test } from "bun:test";
import { McpRegistry } from "../src/mcp";
import { chat } from "../src/provider";
import { elide, type ToolCtx, type Tools } from "../src/tools";

const stops: Array<() => void> = [];
afterAll(() => {
  for (const s of stops) s();
});

describe("elide (tool-result truncation keeps both ends)", () => {
  test("short text is untouched", () => {
    expect(elide("hello", 100)).toBe("hello");
  });
  test("oversize text keeps head AND tail with a middle elision", () => {
    const text = `START${"x".repeat(50_000)}CONCLUSION`;
    const out = elide(text, 1000);
    expect(out.length).toBeLessThan(1100);
    expect(out.startsWith("START")).toBe(true);
    expect(out.endsWith("CONCLUSION")).toBe(true); // the payoff survives (a tail-cut would drop it)
    expect(out).toContain("elided");
  });
});

describe("per-run act-as-token passthrough (§E P1)", () => {
  test("ctx.authToken overrides the MCP call's Authorization header", async () => {
    const seenAuth: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const rpc = (await req.json()) as { id?: number; method: string };
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        seenAuth.push(req.headers.get("authorization"));
        const result =
          rpc.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {} }
            : rpc.method === "tools/list"
              ? { tools: [{ name: "act", description: "do", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: "ok" }] };
        return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    stops.push(() => server.stop());
    const registry: Tools = new Map();
    // Connect with a STATIC agent token, using the STANDARD capital-A casing —
    // the per-run lowercase override must still replace it, not duplicate it.
    await new McpRegistry(registry).add({
      name: "kb",
      transport: "http",
      url: `http://localhost:${server.port}/mcp`,
      headers: { Authorization: "Bearer agent-static" },
    });
    // …then a run acting as a user overrides it per call.
    const asUser: ToolCtx = { workspace: "/tmp", activate: () => {}, authToken: "user-bob-token" };
    await registry.get("kb__act")?.execute({}, asUser);
    // …and a run without passthrough keeps the static agent token.
    const asAgent: ToolCtx = { workspace: "/tmp", activate: () => {} };
    await registry.get("kb__act")?.execute({}, asAgent);

    const callAuths = seenAuth.filter(Boolean);
    expect(callAuths).toContain("Bearer user-bob-token"); // acted as the user
    expect(callAuths).toContain("Bearer agent-static"); // and as the agent otherwise
    // No call carried a combined/duplicated auth value.
    expect(callAuths.every((a) => (a as string).split("Bearer").length === 2)).toBe(true);
  });
});

describe("native Anthropic Messages API (§C P1)", () => {
  function mockAnthropic(handler: (body: Record<string, unknown>) => string) {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as Record<string, unknown>;
        return new Response(handler(body), { headers: { "content-type": "text/event-stream" } });
      },
    });
    stops.push(() => server.stop());
    return `http://localhost:${server.port}/v1`;
  }

  const sse = (...events: unknown[]) =>
    `${events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("")}`;

  test("sends Anthropic shape (system+cache_control, x-api-key) and assembles text + usage", async () => {
    let captured: Record<string, unknown> = {};
    const url = mockAnthropic((body) => {
      captured = body;
      return sse(
        {
          type: "message_start",
          message: { usage: { input_tokens: 100, cache_read_input_tokens: 80 } },
        },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      );
    });
    const res = await chat(
      {
        baseUrl: url,
        apiKey: "sk-ant",
        models: ["claude-sonnet-5"],
        api: "anthropic",
        maxRetries: 0,
      },
      {
        messages: [
          { role: "system", content: "SPINE" },
          { role: "user", content: "hi" },
        ],
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.message.content).toBe("Hello");
    // Anthropic's input_tokens EXCLUDES cache traffic — Delta normalizes to GROSS
    // (100 fresh + 80 cache-read = 180), matching the OpenAI-wire semantics (codex P1).
    expect(res.usage.input).toBe(180);
    expect(res.usage.cacheRead).toBe(80);
    expect(res.usage.output).toBe(5);
    // system is a top-level content-parts array with a cache breakpoint.
    const system = captured.system as Array<{ text: string; cache_control: unknown }>;
    expect(system[0]?.text).toBe("SPINE");
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    // ROLLING breakpoint (Sprint 2): the final user/tool message carries cache_control too,
    // so each turn's cache entry extends the previous one and the tail stays cache-read.
    expect(captured.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ]);
  });

  test("assembles a streamed tool_use block into a WireToolCall", async () => {
    const url = mockAnthropic(() =>
      sse(
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "add" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"a":2,' },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"b":3}' },
        },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
      ),
    );
    const res = await chat(
      {
        baseUrl: url,
        apiKey: "sk-ant",
        models: ["claude-sonnet-5"],
        api: "anthropic",
        maxRetries: 0,
      },
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
      { id: "toolu_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } },
    ]);
  });

  test("a prior tool call with malformed arguments doesn't throw past chat() (codex P2)", async () => {
    const url = mockAnthropic(() =>
      sse(
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ),
    );
    // A stored assistant tool_call with truncated/invalid JSON arguments.
    const res = await chat(
      { baseUrl: url, apiKey: "x", models: ["m"], api: "anthropic", maxRetries: 0 },
      {
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "t1", type: "function", function: { name: "add", arguments: '{"a":2,' } },
            ],
          },
          { role: "tool", tool_call_id: "t1", content: "4" },
        ],
      },
    );
    expect(res.ok).toBe(true); // translated safely, no throw
  });

  test("an error event becomes ok:false, not a throw", async () => {
    const url = mockAnthropic(() => sse({ type: "error", error: { message: "overloaded" } }));
    const res = await chat(
      { baseUrl: url, apiKey: "x", models: ["m"], api: "anthropic", maxRetries: 0 },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toBe("overloaded");
  });
});
