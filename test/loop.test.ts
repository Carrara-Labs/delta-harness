// M2: budget guard, tool directory (search_tools activation, profile scoping),
// spine size discipline.

import { describe, expect, test } from "bun:test";
import { PROFILES } from "../src/profiles";
import type { ChatRequest, ModelResult } from "../src/provider";
import { Queue } from "../src/queue";
import { buildSpine } from "../src/spine";
import type { ToolDef, Tools } from "../src/tools";
import { testTools } from "../src/tools";
import { exampleVocab, makeDeps, textResult, toolCallResult } from "./helpers";

function fakeTool(name: string, description: string): ToolDef {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
    idempotent: true,
    execute: async () => `${name} ran`,
  };
}

describe("budget guard", () => {
  test("a run that never converges stops at the step budget, as a clean turn", async () => {
    const deps = makeDeps(
      async () => toolCallResult("add", { a: 1, b: 1 }, `call_${Math.random()}`),
      testTools(),
    );
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "loop forever", metadata: { profile: "chat" } }).id,
    );
    expect(done.status).toBe("failed");
    expect(done.error).toContain("budget exhausted");
    expect(done.error).toContain(`${PROFILES.chat?.budget.maxSteps}`);
    const payload = JSON.parse(done.result ?? "{}");
    expect(payload.output_text).toContain("budget exhausted");
  });

  test("cost budget triggers too", async () => {
    // Must stay a subset of `work` or the ceiling silently overrides it.
    PROFILES.pennywise = {
      name: "pennywise",
      allowed: "*",
      pinned: "*",
      budget: { maxSteps: 40, maxTokens: 400_000, maxCostUsd: 0.0025 },
    };
    const deps = makeDeps(
      async () => toolCallResult("add", { a: 1, b: 1 }, `call_${Math.random()}`),
      testTools(),
    );
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "burn money", metadata: { profile: "pennywise" } }).id,
    );
    expect(done.status).toBe("failed");
    expect(done.error).toContain("budget exhausted");
    // usage1 costs $0.001/call → the third model call must never have happened.
    const usage = JSON.parse(done.usage ?? "{}");
    expect(usage.costUsd).toBeLessThan(0.004);
  });
});

describe("tool directory", () => {
  test("pinned schemas ride along; the rest activate via search_tools and persist", async () => {
    PROFILES.narrow = {
      name: "narrow",
      allowed: "*",
      pinned: ["alpha"],
      budget: { maxSteps: 20, maxTokens: 400_000, maxCostUsd: 1 },
    };
    const registry: Tools = new Map();
    registry.set("alpha", fakeTool("alpha", "the pinned one"));
    registry.set("beacon_finder", fakeTool("beacon_finder", "finds beacons in the fog"));
    registry.set("gamma", fakeTool("gamma", "unrelated"));

    const toolNamesSeen: string[][] = [];
    let call = 0;
    const deps = makeDeps(async (req: ChatRequest) => {
      call++;
      toolNamesSeen.push((req.tools ?? []).map((t) => t.function.name));
      if (call === 1) return toolCallResult("search_tools", { query: "beacon fog" }, "call_s");
      if (call === 2) return toolCallResult("beacon_finder", {}, "call_b");
      return textResult("done");
    }, registry);
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "find the beacon", metadata: { profile: "narrow" } }).id,
    );
    expect(done.status).toBe("done");
    // Call 1: only the pinned tool + search_tools were resident.
    expect(toolNamesSeen[0]).toEqual(["alpha", "search_tools"]);
    // Call 2: beacon_finder activated by the search.
    expect(toolNamesSeen[1]).toContain("beacon_finder");
    expect(toolNamesSeen[1]).not.toContain("gamma");
    // Activation is durable (survives a restart mid-run).
    expect(JSON.parse(done.tools ?? "[]")).toContain("beacon_finder");
    // And the run actually used it.
    const journal = deps.db
      .query("SELECT result FROM journal WHERE run_id = ? AND call_id = 'call_b'")
      .get(done.id) as { result: string };
    expect(journal.result).toBe("beacon_finder ran");
  });

  test('"core" pins builtins + knowledge-base core; connectors ride search_tools', async () => {
    const registry: Tools = new Map();
    registry.set("web_search", fakeTool("web_search", "builtin, bare name")); // builtin → pinned
    registry.set("kb__get_my_user", fakeTool("kb__get_my_user", "who am I")); // knowledge-base core → pinned
    registry.set("kb__list_learnings", fakeTool("kb__list_learnings", "learnings")); // non-core kb → searchable
    registry.set(
      "composio_gmail_acme__GMAIL_SEND_EMAIL",
      fakeTool("composio_gmail_acme__GMAIL_SEND_EMAIL", "send email"), // connector → searchable
    );

    const seen: string[][] = [];
    const deps = makeDeps(
      async (req: ChatRequest) => {
        seen.push((req.tools ?? []).map((t) => t.function.name));
        return textResult("done");
      },
      registry,
      { vocab: exampleVocab },
    );
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "hi", metadata: { profile: "work" } }).id);
    // Resident: the builtin + the knowledge-base core + search_tools — NOT the connector or non-core kb tool.
    expect(seen[0]).toContain("web_search");
    expect(seen[0]).toContain("kb__get_my_user");
    expect(seen[0]).toContain("search_tools");
    expect(seen[0]).not.toContain("composio_gmail_acme__GMAIL_SEND_EMAIL");
    expect(seen[0]).not.toContain("kb__list_learnings");
  });

  test("resident cap: an all-pinned profile with a huge tool set falls back to core", async () => {
    PROFILES.allpinned = {
      name: "allpinned",
      allowed: "*",
      pinned: "*",
      budget: { maxSteps: 5, maxTokens: 400_000, maxCostUsd: 1 },
    };
    const registry: Tools = new Map();
    registry.set("web_search", fakeTool("web_search", "builtin"));
    registry.set("kb__get_my_user", fakeTool("kb__get_my_user", "knowledge-base core"));
    // 80 connector tools — over the 60 resident cap (the 464-tool brick, in miniature).
    for (let i = 0; i < 80; i++) {
      registry.set(`composio_slack_acme__T_${i}`, fakeTool(`composio_slack_acme__T_${i}`, `t${i}`));
    }
    const seen: string[][] = [];
    const deps = makeDeps(
      async (req: ChatRequest) => {
        seen.push((req.tools ?? []).map((t) => t.function.name));
        return textResult("done");
      },
      registry,
      { vocab: exampleVocab },
    );
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "hi", metadata: { profile: "allpinned" } }).id);
    // The guardrail forced core-pinning: resident is lean, not all 82.
    expect(seen[0]?.length ?? 0).toBeLessThanOrEqual(10);
    expect(seen[0]).toContain("web_search");
    expect(seen[0]).toContain("kb__get_my_user");
    expect(seen[0]).toContain("search_tools");
    expect(seen[0]).not.toContain("composio_slack_acme__T_0");
  });

  test("token budget bills FRESH tokens, not gross re-sent (cached) context", async () => {
    // maxTokens 500: each step re-sends a 600-token prompt that's 590 cache-reads → only 15 tokens
    // actually cost. GROSS billing would exhaust at step 1 (605 > 500); FRESH billing (15/step) runs
    // to the step cap instead. Proves cache-reads aren't charged over and over (the Slack-run fix).
    // Must be a subset of the work ceiling (isSubset), so budgets ≤ work's (100 / 2M / $5).
    PROFILES.cachey = {
      name: "cachey",
      allowed: "*",
      pinned: "*",
      budget: { maxSteps: 5, maxTokens: 500, maxCostUsd: 1 },
    };
    const cachedCall = (): ModelResult => ({
      ok: true,
      model: "m",
      finishReason: "tool_calls",
      latencyMs: 1,
      usage: { input: 600, output: 5, cacheRead: 590, cacheWrite: 0, total: 605, costUsd: 0.0001 },
      message: {
        role: "assistant",
        content: null,
        // Unique call id per step (a repeated id reads as already-journaled → no progress).
        tool_calls: [
          { id: `c${Math.random()}`, type: "function", function: { name: "add", arguments: "{}" } },
        ],
      },
    });
    const deps = makeDeps(async () => cachedCall(), testTools());
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "loop", metadata: { profile: "cachey" } }).id,
    );
    expect(done.status).toBe("failed");
    // Hit the STEP cap, not the token cap — and the reported billed tokens are the FRESH count
    // (~75), not the gross re-sent total (~3000).
    expect(done.error).toContain("5/5 steps");
    expect(done.error).toContain("/500 tokens");
    expect(done.error).not.toContain("605/500");
    const usage = JSON.parse(done.usage ?? "{}");
    expect(usage.total).toBeGreaterThan(2000); // gross accumulated, but budget billed only the fresh
  });

  test("chat profile cannot reach disallowed tools even by name", async () => {
    const registry: Tools = new Map();
    registry.set("web_search", fakeTool("web_search", "search the web"));
    registry.set("code", fakeTool("code", "run a coding CLI"));
    let call = 0;
    const deps = makeDeps(async () => {
      call++;
      if (call === 1) return toolCallResult("code", { task: "rm -rf" }, "call_c");
      return textResult("finished");
    }, registry);
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "hi", metadata: { profile: "chat" } }).id);
    expect(done.status).toBe("done");
    const journal = deps.db.query("SELECT result FROM journal WHERE run_id = ?").get(done.id) as {
      result: string;
    };
    expect(journal.result).toContain("unknown tool 'code'");
  });
});

describe("profile ceiling (codex P1)", () => {
  test("request metadata cannot escalate past the daemon's profile", async () => {
    const registry: Tools = new Map();
    registry.set("web_search", fakeTool("web_search", "search the web"));
    registry.set("code", fakeTool("code", "run a coding CLI"));
    let call = 0;
    const deps = {
      ...makeDeps(async () => {
        call++;
        if (call === 1) return toolCallResult("code", { task: "escalate" }, "call_e");
        return textResult("done");
      }, registry),
      profile: "chat", // this daemon IS a chat placement
    };
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "pwn", metadata: { profile: "work" } }).id, // escalation attempt
    );
    expect(done.status).toBe("done");
    const journal = deps.db.query("SELECT result FROM journal WHERE run_id = ?").get(done.id) as {
      result: string;
    };
    expect(journal.result).toContain("unknown tool 'code'");
  });

  test("narrowing below the ceiling is allowed", async () => {
    const { getProfile } = await import("../src/profiles");
    expect(getProfile("chat", "work").name).toBe("chat");
    expect(getProfile("work", "chat").name).toBe("chat");
    expect(getProfile(undefined, "chat").name).toBe("chat");
  });
});

describe("spine", () => {
  test("stays far under the 2k-token budget with a full builtin index", async () => {
    const { builtinTools } = await import("../src/builtins");
    const tools = builtinTools({
      workspace: "/tmp/ws",
      exaKey: "x",
      codeCli: ["codex"],
      selfCmd: ["delta"],
      subagentDepth: 0,
    });
    const spine = buildSpine({
      agentId: "delta-test",
      pinned: [...tools.values()],
      searchable: 100,
      self: "# Persona\nYou work for Nic. Keep answers tight.",
    });
    // ~4 chars/token heuristic; hard ceiling 2k tokens ⇒ 8k chars. Target much less.
    // Live-measured at 1,573 input tokens TOTAL (spine + tool schemas + msg).
    expect(spine.length).toBeLessThan(4000);
  });

  test("cache-stable: same inputs → byte-identical spine (per-turn instructions ride a user message, not the spine)", async () => {
    const { builtinTools } = await import("../src/builtins");
    const pinned = [
      ...builtinTools({
        workspace: "/t",
        codeCli: ["c"],
        selfCmd: ["d"],
        subagentDepth: 0,
      }).values(),
    ];
    const base = { agentId: "d1", pinned, searchable: 5, self: "id", policy: "rule" };
    // The whole spine is deterministic — no per-turn slot inside it, so it's fully cached.
    expect(buildSpine(base)).toBe(buildSpine(base));
    // Per-turn instructions are NOT part of the spine anymore.
    expect(buildSpine(base)).not.toContain("This turn's instructions");
  });
});

describe("prompt caching (Anthropic prefix)", () => {
  test("marks the system message with cache_control only for Anthropic models", async () => {
    const seen: Array<{ model: string; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { model: string; messages: unknown };
        seen.push({ model: body.model, body: body.messages });
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const { chat } = await import("../src/provider");
    const base = { baseUrl: `http://localhost:${server.port}/v1`, apiKey: "k", maxRetries: 0 };
    const msgs = [
      { role: "system" as const, content: "SPINE" },
      { role: "user" as const, content: "hi" },
    ];
    await chat({ ...base, models: ["anthropic/claude-sonnet-5"] }, { messages: msgs });
    await chat({ ...base, models: ["openai/gpt-5"] }, { messages: msgs });
    server.stop();

    // Anthropic: system becomes a content-parts array with a cache breakpoint.
    const anthropicSystem = (seen[0]?.body as Array<{ role: string; content: unknown }>)[0];
    expect(Array.isArray(anthropicSystem?.content)).toBe(true);
    expect(
      (anthropicSystem?.content as Array<{ cache_control?: unknown }>)[0]?.cache_control,
    ).toEqual({
      type: "ephemeral",
    });
    // OpenAI: untouched string content (it caches automatically, ignores the marker).
    const openaiSystem = (seen[1]?.body as Array<{ role: string; content: unknown }>)[0];
    expect(openaiSystem?.content).toBe("SPINE");
  });
});
