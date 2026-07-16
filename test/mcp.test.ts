// M4: MCP client — Streamable HTTP + stdio transports, discovery, namespacing,
// result truncation, error-as-value, hot add/remove. A mock MCP server (both
// SSE and plain-JSON replies) stands in; the live the skill registry proof is in the smoke.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpRegistry } from "../src/mcp";
import type { ToolCtx, Tools } from "../src/tools";

const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

// A minimal MCP server over Streamable HTTP. `sse` toggles the reply framing so
// we prove the client parses both application/json and text/event-stream.
function mockMcp(opts: { sse: boolean } = { sse: true }) {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const rpc = (await req.json()) as { id: number; method: string; params?: { name?: string } };
      const reply = (result: unknown) => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
        return opts.sse
          ? new Response(`event: message\ndata: ${payload}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            })
          : new Response(payload, { headers: { "content-type": "application/json" } });
      };
      if (rpc.method === "initialize")
        return reply({ protocolVersion: "2025-06-18", capabilities: {} });
      if (rpc.method === "tools/list") {
        return reply({
          tools: [
            {
              name: "echo",
              description: "Echo a message back.",
              inputSchema: { type: "object", properties: { msg: { type: "string" } } },
            },
            { name: "explode", description: "Always errors." },
            { name: "big", description: "Returns a huge blob." },
          ],
        });
      }
      if (rpc.method === "tools/call") {
        const name = rpc.params?.name;
        if (name === "explode") {
          return reply({ content: [{ type: "text", text: "kaboom" }], isError: true });
        }
        if (name === "big") {
          return reply({ content: [{ type: "text", text: "x".repeat(50_000) }] });
        }
        return reply({ content: [{ type: "text", text: "echoed: hi" }] });
      }
      return reply({});
    },
  });
  return { url: `http://localhost:${server.port}/mcp`, stop: () => server.stop() };
}

describe("MCP client (HTTP)", () => {
  test("discovers tools, namespaces them, and folds into the registry", async () => {
    const mock = mockMcp({ sse: true });
    const registry: Tools = new Map();
    const mcp = new McpRegistry(registry);
    const r = await mcp.add({ name: "skills", transport: "http", url: mock.url });
    expect(r.ok).toBe(true);
    expect(r.tools).toBe(3);
    expect([...registry.keys()]).toEqual(["skills__echo", "skills__explode", "skills__big"]);
    // read-only heuristic: none of these look read-only → non-idempotent.
    expect(registry.get("skills__echo")?.idempotent).toBe(false);
    mock.stop();
  });

  test("parses plain-JSON replies too (not just SSE)", async () => {
    const mock = mockMcp({ sse: false });
    const registry: Tools = new Map();
    const r = await new McpRegistry(registry).add({ name: "s", transport: "http", url: mock.url });
    expect(r.ok).toBe(true);
    expect(await registry.get("s__echo")?.execute({ msg: "hi" }, ctx)).toBe("echoed: hi");
    mock.stop();
  });

  test("tool-call errors come back as values; big results pass through RAW (central cap+spill owns truncation)", async () => {
    const mock = mockMcp();
    const registry: Tools = new Map();
    await new McpRegistry(registry).add({ name: "s", transport: "http", url: mock.url });
    expect(await registry.get("s__explode")?.execute({}, ctx)).toContain("[tool error] kaboom");
    const big = (await registry.get("s__big")?.execute({}, ctx)) ?? "";
    // No pre-elide here anymore — run.ts's capAndSpill caps AND spills the full output so it
    // stays recoverable (codex #7). A clip here would silently bypass the spill.
    expect(big).not.toContain("[elided");
    expect(big.length).toBeGreaterThan(21_000);
    mock.stop();
  });

  test("a dead server fails soft — returned, not thrown; daemon-startable", async () => {
    const registry: Tools = new Map();
    const r = await new McpRegistry(registry).add({
      name: "dead",
      transport: "http",
      url: "http://localhost:1/mcp",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(registry.size).toBe(0);
  });

  test("hot add/remove: tools appear and disappear on a running registry", async () => {
    const mock = mockMcp();
    const registry: Tools = new Map();
    const mcp = new McpRegistry(registry);
    await mcp.add({ name: "s", transport: "http", url: mock.url });
    expect(registry.has("s__echo")).toBe(true);
    expect(mcp.list()).toEqual(["s"]);
    mcp.remove("s");
    expect(registry.has("s__echo")).toBe(false);
    expect(mcp.list()).toEqual([]);
    mock.stop();
  });
});

describe("MCP protocol compliance (codex fixes)", () => {
  test("captures Mcp-Session-Id on initialize and sends it on every later request", async () => {
    const sessions: Array<string | null> = [];
    let initialized = false;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const rpc = (await req.json()) as { id?: number; method: string };
        if (rpc.method === "notifications/initialized") {
          initialized = true;
          return new Response(null, { status: 202 });
        }
        sessions.push(req.headers.get("mcp-session-id"));
        const result =
          rpc.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {} }
            : { tools: [{ name: "go", description: "x", inputSchema: { type: "object" } }] };
        return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`, {
          headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-xyz" },
        });
      },
    });
    const registry: Tools = new Map();
    const r = await new McpRegistry(registry).add({
      name: "s",
      transport: "http",
      url: `http://localhost:${server.port}/mcp`,
    });
    server.stop();
    expect(r.ok).toBe(true);
    expect(initialized).toBe(true); // notifications/initialized was sent
    // initialize carried no session; tools/list carried the captured one.
    expect(sessions[0]).toBeNull();
    expect(sessions[1]).toBe("sess-xyz");
  });

  test("ignores notification frames, returns the frame matching the request id", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const rpc = (await req.json()) as { id?: number; method: string };
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          rpc.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {} }
            : { tools: [{ name: "go", description: "x", inputSchema: { type: "object" } }] };
        // Emit a progress notification BEFORE the real response frame.
        const body =
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n` +
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const registry: Tools = new Map();
    const r = await new McpRegistry(registry).add({
      name: "s",
      transport: "http",
      url: `http://localhost:${server.port}/mcp`,
    });
    server.stop();
    expect(r.ok).toBe(true);
    expect(registry.has("s__go")).toBe(true); // the real result, not the notification
  });

  test("drops tools whose namespaced name violates the model API charset", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const rpc = (await req.json()) as { id?: number; method: string };
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          rpc.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {} }
            : {
                tools: [
                  { name: "good_tool", description: "ok", inputSchema: { type: "object" } },
                  { name: "bad tool!", description: "evil", inputSchema: { type: "object" } },
                ],
              };
        return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const registry: Tools = new Map();
    const r = await new McpRegistry(registry).add({
      name: "s",
      transport: "http",
      url: `http://localhost:${server.port}/mcp`,
    });
    server.stop();
    expect(r.tools).toBe(1); // only the valid one survives
    expect(registry.has("s__good_tool")).toBe(true);
    expect([...registry.keys()].some((k) => k.includes("bad"))).toBe(false);
  });
});

describe("MCP client (stdio)", () => {
  test("spawns a child MCP server and calls it over stdin/stdout", async () => {
    // A tiny newline-delimited JSON-RPC MCP server as a throwaway script.
    const script = join(tmpdir(), `mock-mcp-${Date.now()}.ts`);
    writeFileSync(
      script,
      `
      for await (const line of console) {
        const rpc = JSON.parse(line);
        let result = {};
        if (rpc.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {} };
        if (rpc.method === "tools/list") result = { tools: [{ name: "ping", description: "returns pong", inputSchema: { type: "object", properties: {} } }] };
        if (rpc.method === "tools/call") result = { content: [{ type: "text", text: "pong" }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }) + "\\n");
      }
      `,
    );
    const registry: Tools = new Map();
    const mcp = new McpRegistry(registry);
    const r = await mcp.add({ name: "child", transport: "stdio", command: ["bun", script] });
    expect(r.ok).toBe(true);
    expect(registry.has("child__ping")).toBe(true);
    expect(await registry.get("child__ping")?.execute({}, ctx)).toBe("pong");
    mcp.closeAll();
  }, 15_000);
});
