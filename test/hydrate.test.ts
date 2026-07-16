// F1: task-start kb hydration. A mock kb MCP (mirroring the real
// get_my_dashboard / list_learnings shapes) is connected; the hydration block
// must reach the first model call, scoped to the run's entity, and never re-fire
// on a follow-up turn in the same session.

import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { hydrate, recallAgentMemory } from "../src/hydrate";
import { McpRegistry } from "../src/mcp";
import type { ChatRequest } from "../src/provider";
import { Queue } from "../src/queue";
import type { ToolCtx, ToolDef, Tools } from "../src/tools";
import { exampleVocab, makeDeps, textResult } from "./helpers";

const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

// A mock kb MCP over Streamable HTTP with the two hydration read tools.
function mockKb() {
  const calls: Array<{ name?: string; args: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const rpc = (await req.json()) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const reply = (result: unknown) =>
        new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "initialize")
        return reply({ protocolVersion: "2025-06-18", capabilities: {} });
      if (rpc.method === "tools/list") {
        return reply({
          tools: [
            {
              name: "get_my_dashboard",
              description: "what needs attention",
              inputSchema: { type: "object" },
            },
            {
              name: "list_learnings",
              description: "what-works patterns",
              inputSchema: { type: "object" },
            },
          ],
        });
      }
      if (rpc.method === "tools/call") {
        calls.push({ name: rpc.params?.name, args: rpc.params?.arguments ?? {} });
        const text =
          rpc.params?.name === "get_my_dashboard"
            ? '{"reminders":["ship Delta"],"tasks_due":2}'
            : '{"learnings":["Roger prefers terse updates"]}';
        return reply({ content: [{ type: "text", text }] });
      }
      return reply({});
    },
  });
  return { url: `http://localhost:${server.port}/mcp`, stop: () => server.stop(), calls };
}

describe("hydrate()", () => {
  test("calls the configured tools, scopes by entity, concatenates a context block", async () => {
    const kb = mockKb();
    const registry: Tools = new Map();
    await new McpRegistry(registry).add({ name: "kb", transport: "http", url: kb.url });
    const block = await hydrate(registry, ctx, {
      toolNames: ["kb__get_my_dashboard", "kb__list_learnings"],
      subject: { entity: "roger" },
    });
    kb.stop();
    expect(block).toContain("Task-start context");
    expect(block).toContain("ship Delta");
    expect(block).toContain("Roger prefers terse updates");
    // list_learnings was scoped to the entity.
    const learnCall = kb.calls.find((c) => c.name === "list_learnings");
    expect(learnCall?.args.entity).toBe("roger");
  });

  test("no-op when the hydration tools aren't registered (no kb connected)", async () => {
    const block = await hydrate(new Map(), ctx, { toolNames: ["kb__get_my_dashboard"] });
    expect(block).toBeNull();
  });

  test("task-keyed search surfaces relevant knowledge, keyed on the ask (G3a)", async () => {
    let seenQuery: unknown;
    const search: ToolDef = {
      name: "kb__search_text",
      description: "semantic search",
      parameters: { type: "object" },
      idempotent: true,
      execute: async (args) => {
        seenQuery = args.query;
        return '{"hits":["Q3 pricing was set at $49/mo"]}';
      },
    };
    const tools: Tools = new Map([[search.name, search]]);
    const block = await hydrate(tools, ctx, {
      toolNames: [],
      query: "what did we decide on pricing?",
      searchTool: "kb__search_text",
    });
    expect(seenQuery).toBe("what did we decide on pricing?");
    expect(block).toContain("relevant to this task");
    expect(block).toContain("$49/mo");
  });
});

describe("recallAgentMemory (G3c — the local table is finally read)", () => {
  test("reads recent agent-scope learnings back for a later run", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    db.query(
      "INSERT INTO memory (namespace, agent_id, audience, artifact_kind, content, created_at) VALUES ('default', 'delta-1', 'agent', 'fact', 'Roger prefers terse updates', ?)",
    ).run(now);
    db.query(
      "INSERT INTO memory (namespace, agent_id, audience, artifact_kind, content, created_at) VALUES ('default', 'other', 'agent', 'fact', 'not mine', ?)",
    ).run(now);
    const block = recallAgentMemory(db, "delta-1");
    expect(block).toContain("Roger prefers terse updates");
    expect(block).not.toContain("not mine"); // scoped to this agent
  });

  test("null when the agent has no prior learnings", () => {
    expect(recallAgentMemory(openDb(":memory:"), "delta-1")).toBeNull();
  });

  test("user-scoped learnings surface ONLY to their own user (no cross-user bleed, codex P1)", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    db.query(
      "INSERT INTO memory (namespace, agent_id, user_id, audience, artifact_kind, content, created_at) VALUES ('default','delta-1','alice','user','preference','Alice wants bullets', ?)",
    ).run(now);
    db.query(
      "INSERT INTO memory (namespace, agent_id, audience, artifact_kind, content, created_at) VALUES ('default','delta-1','agent','fact','shared agent lesson', ?)",
    ).run(now);
    // Bob gets the shared agent lesson but NOT Alice's user-scoped preference.
    const forBob = recallAgentMemory(db, "delta-1", "bob");
    expect(forBob).toContain("shared agent lesson");
    expect(forBob).not.toContain("Alice wants bullets");
    // Alice gets both her own + the shared one.
    const forAlice = recallAgentMemory(db, "delta-1", "alice");
    expect(forAlice).toContain("Alice wants bullets");
    expect(forAlice).toContain("shared agent lesson");
  });
});

describe("hydration in the run loop", () => {
  test("prepends the context block before the ask, once per run, not on the next turn", async () => {
    const kb = mockKb();
    const registry: Tools = new Map();
    await new McpRegistry(registry).add({ name: "kb", transport: "http", url: kb.url });

    const seen: string[] = [];
    const deps = {
      ...makeDeps(
        async (req: ChatRequest) => {
          seen.push(JSON.stringify(req.messages));
          return textResult("done");
        },
        registry,
        { vocab: exampleVocab },
      ),
      hydrateTools: ["kb__get_my_dashboard", "kb__list_learnings"],
    };
    const queue = new Queue(deps);
    const first = await queue.wait(
      queue.enqueue({ input: "write the update", metadata: { entity: "roger" } }).id,
    );
    // Turn 1 saw the hydration block before the ask.
    expect(seen[0]).toContain("Task-start context");
    expect(seen[0]).toContain("Roger prefers terse updates");
    expect(seen[0]).toContain("write the update");

    // A follow-up turn in the same session does NOT re-hydrate.
    const callsAfterFirst = kb.calls.length;
    await queue.wait(queue.enqueue({ input: "again", previous_response_id: first.id }).id);
    kb.stop();
    expect(kb.calls.length).toBe(callsAfterFirst); // no new hydration calls
  });

  test("entity_id (task-path key) reaches BOTH the event spine and hydration (G2b)", async () => {
    const kb = mockKb();
    const registry: Tools = new Map();
    await new McpRegistry(registry).add({ name: "kb", transport: "http", url: kb.url });
    const deps = {
      ...makeDeps(async () => textResult("done"), registry, { vocab: exampleVocab }),
      hydrateTools: ["kb__list_learnings"],
    };
    const queue = new Queue(deps);
    // The task path sends `entity_id`/`user_id` (not `entity`). Both must flow.
    await queue.wait(
      queue.enqueue({ input: "brief me", metadata: { entity_id: "roger", user_id: "u1" } }).id,
    );
    kb.stop();
    // Hydration scoped to the entity (proves entity_id reached the subject).
    expect(kb.calls.find((c) => c.name === "list_learnings")?.args.entity).toBe("roger");
    // …and the correlation spine on events carries it too.
    const ev = deps.db
      .query("SELECT entity_id, user_id FROM events WHERE entity_id IS NOT NULL LIMIT 1")
      .get() as { entity_id: string; user_id: string } | null;
    expect(ev?.entity_id).toBe("roger");
    expect(ev?.user_id).toBe("u1");
  });

  test("does NOT hydrate without a subject (no entity/person) — no cross-user bleed (codex P1)", async () => {
    const kb = mockKb();
    const registry: Tools = new Map();
    await new McpRegistry(registry).add({ name: "kb", transport: "http", url: kb.url });
    const seen: string[] = [];
    const deps = {
      ...makeDeps(
        async (req: ChatRequest) => {
          seen.push(JSON.stringify(req.messages));
          return textResult("done");
        },
        registry,
        { vocab: exampleVocab },
      ),
      hydrateTools: ["kb__get_my_dashboard", "kb__list_learnings"],
    };
    const queue = new Queue(deps);
    // No entity/person in metadata → hydration must be skipped entirely.
    await queue.wait(queue.enqueue({ input: "who am I?", metadata: { user_id: "bob" } }).id);
    kb.stop();
    expect(kb.calls.length).toBe(0);
    expect(seen[0]).not.toContain("Task-start context");
  });

  test("subject-less run WITH a search tool → ONLY the org-scoped search fires (Sprint 5 §3.4)", async () => {
    const kb = mockKb();
    const registry: Tools = new Map();
    await new McpRegistry(registry).add({ name: "kb", transport: "http", url: kb.url });
    let searchQuery: unknown;
    const search: ToolDef = {
      name: "kb__search_text",
      description: "org search",
      parameters: { type: "object" },
      idempotent: true,
      execute: async (args) => {
        searchQuery = args.query;
        return '{"hits":["the harness deploys with the release CLI"]}';
      },
    };
    registry.set(search.name, search);
    const seen: string[] = [];
    const deps = {
      ...makeDeps(
        async (req: ChatRequest) => {
          seen.push(JSON.stringify(req.messages));
          return textResult("done");
        },
        registry,
        { vocab: exampleVocab },
      ),
      hydrateTools: ["kb__get_my_dashboard", "kb__list_learnings"],
      hydrateSearchTool: "kb__search_text",
    };
    const queue = new Queue(deps);
    // WITHOUT an act-as token: no knowledge-base read at all — a subject-less search would
    // otherwise run as the daemon principal on a shared daemon (codex critical #2).
    await queue.wait(queue.enqueue({ input: "anything here?", metadata: { user_id: "bob" } }).id);
    expect(searchQuery).toBeUndefined();
    // WITH the per-run act-as token: the org-scoped search fires under the USER's
    // ACLs, so the run no longer starts blind.
    await queue.wait(
      queue.enqueue({
        input: "how do we deploy?",
        metadata: { user_id: "bob", authToken: "user-scoped-jwt" },
      }).id,
    );
    kb.stop();
    // Subject-scoped recency reads did NOT fire (cross-user bleed guard holds)…
    expect(kb.calls.length).toBe(0);
    // …but the task-keyed org search did.
    expect(searchQuery).toBe("how do we deploy?");
    expect(seen[1]).toContain("the release CLI");
  });
});

describe("hydration budget (tokens, not rows — Sprint 5 §3.4)", () => {
  test("blocks share one total budget; the search reserve survives a huge recency dump", async () => {
    const big: ToolDef = {
      name: "kb__get_my_dashboard",
      description: "dump",
      parameters: { type: "object" },
      idempotent: true,
      execute: async () => "D".repeat(50_000),
    };
    const search: ToolDef = {
      name: "kb__search_text",
      description: "search",
      parameters: { type: "object" },
      idempotent: true,
      execute: async () => `RELEVANT: ${"s".repeat(100)}`,
    };
    const tools: Tools = new Map([
      [big.name, big],
      [search.name, search],
    ]);
    const block = await hydrate(tools, ctx, {
      toolNames: [big.name],
      subject: { entity: "roger" },
      query: "what matters?",
      searchTool: search.name,
    });
    expect(block).toBeTruthy();
    // The 50k dump was elided into the shared budget (16k default), not 20k-per-block…
    expect((block as string).length).toBeLessThan(17_500);
    // …and the search block still made it in (its reserve can't be crowded out).
    expect(block).toContain("RELEVANT:");
  });
});
