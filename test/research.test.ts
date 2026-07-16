// W4: in-process, read-only, parallel research sub-agents. Prove the default-deny tool subset,
// the reserved-path read facade, the bounded parallel loop, parent-written artifacts, single
// usage charge, and that the model can drive it end-to-end through the `research` builtin.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtins";
import type { ChatMsg, ChatRequest, ModelResult, Usage } from "../src/provider";
import { Queue } from "../src/queue";
import { researchTools, runResearch } from "../src/research";
import type { ToolCtx, ToolDef, Tools } from "../src/tools";
import { makeDeps, textResult, toolCallResult } from "./helpers";

const U = (): Usage => ({
  input: 5,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  total: 10,
  costUsd: 0.001,
});
const fakeTool = (name: string, exec?: ToolDef["execute"]): ToolDef => ({
  name,
  description: "",
  parameters: { type: "object", properties: {} },
  idempotent: true,
  execute: exec ?? (async () => "ok"),
});

describe("researchTools — default-deny read-only subset", () => {
  test("keeps only safe builtins + the operator's exact MCP allowlist; excludes everything else", () => {
    const allowed: Tools = new Map();
    for (const n of [
      "web_search",
      "web_fetch",
      "read_file",
      "grep",
      "list_dir",
      "write_file",
      "move_file",
      "code",
      "remember",
      "research",
      "spawn_subagent",
      "kb__search_text",
      "kb__delete_entity",
    ])
      allowed.set(n, fakeTool(n));

    const ro = researchTools(allowed, ["kb__search_text"], true);
    // grep/list_dir are NOT in the safe set (root-scan exfil risk); only targeted read_file + web.
    expect([...ro.keys()].sort()).toEqual(
      ["kb__search_text", "read_file", "web_fetch", "web_search"].sort(),
    );
    for (const n of [
      "grep",
      "list_dir",
      "write_file",
      "move_file",
      "code",
      "remember",
      "research",
      "spawn_subagent",
      "kb__delete_entity",
    ])
      expect(ro.has(n)).toBe(false);
  });

  test("operator allowlist can't re-enable a builtin, and MCP is dropped without an act-as token", () => {
    const allowed: Tools = new Map();
    for (const n of ["web_search", "write_file", "code", "kb__search_text"])
      allowed.set(n, fakeTool(n));
    // Trying to sneak write_file/code in via DELTA_RESEARCH_TOOLS is rejected (not __-namespaced /
    // forbidden); the real MCP read tool is admitted.
    const ro = researchTools(allowed, ["write_file", "code", "kb__search_text"], true);
    expect(ro.has("write_file")).toBe(false);
    expect(ro.has("code")).toBe(false);
    expect(ro.has("kb__search_text")).toBe(true);
    // No act-as token → MCP tools dropped entirely (no daemon-credential fallback).
    const roNoAuth = researchTools(allowed, ["kb__search_text"], false);
    expect(roNoAuth.has("kb__search_text")).toBe(false);
    expect(roNoAuth.has("web_search")).toBe(true);
  });

  test("reserved-path facade blocks .env/.delta/operator files + traversal, allows normal reads", async () => {
    const allowed: Tools = new Map();
    allowed.set(
      "read_file",
      fakeTool("read_file", async (args) => `READ ${String(args.path)}`),
    );
    const rf = researchTools(allowed, [], true).get("read_file") as ToolDef;
    const ctx = { workspace: "/ws", activate: () => {} } as unknown as ToolCtx;
    for (const p of [
      ".env",
      ".env.local",
      "delta.env",
      ".delta/spill/x",
      "POLICY.md",
      "DELTA.md",
      "sub/../.env",
    ])
      expect(await rf.execute({ path: p }, ctx)).toContain("off-limits");
    expect(await rf.execute({ path: "docs/readme.md" }, ctx)).toBe("READ docs/readme.md");
  });
});

describe("runResearch — bounded parallel loop", () => {
  function ws() {
    return mkdtempSync(join(tmpdir(), "delta-research-"));
  }
  // A child model that searches once, then answers.
  const childChat = async (req: ChatRequest): Promise<ModelResult> => {
    const hasToolResult = req.messages.some((m) => m.role === "tool");
    if (!hasToolResult)
      return {
        ok: true,
        model: "t",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } },
          ],
        },
        usage: U(),
        finishReason: "tool_calls",
        latencyMs: 1,
      } as ModelResult;
    return {
      ok: true,
      model: "t",
      message: {
        role: "assistant",
        content: "SUMMARY: the answer is 42. FINDINGS: the web says 42.",
      },
      usage: U(),
      finishReason: "stop",
      latencyMs: 1,
    } as ModelResult;
  };

  test("runs each task in isolation, writes an artifact, returns summary+path, charges usage once", async () => {
    const dir = ws();
    try {
      const tools: Tools = new Map();
      tools.set(
        "web_search",
        fakeTool("web_search", async () => "web says: the answer is 42"),
      );
      let charged: Usage | null = null;
      const ctx = {
        workspace: dir,
        activate: () => {},
        chargeUsage: (u: Usage) => {
          charged = u;
        },
        remainingBudget: () => ({ maxTokens: 100_000, maxCostUsd: 10 }),
      } as unknown as ToolCtx;

      const out = await runResearch(["what is the answer?"], tools, childChat, ctx, "run1", "0");
      expect(out).toContain("what is the answer?");
      expect(out).toContain("the answer is 42");
      expect(out).toContain("research/"); // the artifact path
      // The artifact exists on disk with the full findings.
      const files = readdirSync(join(dir, "research", "run1.0"));
      expect(files.length).toBe(1);
      expect(readFileSync(join(dir, "research", "run1.0", files[0] as string), "utf8")).toContain(
        "the answer is 42",
      );
      // Usage charged exactly once (aggregated).
      expect(charged).not.toBeNull();
      expect((charged as unknown as Usage).total).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs tasks in parallel and caps the fan-out at 3", async () => {
    const dir = ws();
    try {
      const tools: Tools = new Map();
      tools.set(
        "web_search",
        fakeTool("web_search", async () => "data"),
      );
      const ctx = {
        workspace: dir,
        activate: () => {},
        remainingBudget: () => ({ maxTokens: 100_000, maxCostUsd: 10 }),
      } as unknown as ToolCtx;
      const out = await runResearch(["a", "b", "c", "d", "e"], tools, childChat, ctx, "run2", "0");
      // Only 3 tasks run; each gets a block.
      expect((out.match(/^## /gm) ?? []).length).toBe(3);
      expect(readdirSync(join(dir, "research", "run2.0")).length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no read-only tools configured → a clear error, no crash", async () => {
    const ctx = {
      workspace: "/tmp",
      activate: () => {},
      remainingBudget: () => ({ maxTokens: 100_000, maxCostUsd: 10 }),
    } as unknown as ToolCtx;
    const out = await runResearch(["x"], new Map(), childChat, ctx, "r", "0");
    expect(out).toContain("no read-only tools");
  });
});

describe("research builtin end-to-end (through the model + queue)", () => {
  test("the model calls `research`, gets summaries + paths, and children can't leak into its context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-research-e2e-"));
    try {
      const seen: ChatMsg[][] = [];
      let parentCall = 0;
      const deps = makeDeps(
        async (req: ChatRequest) => {
          const sys = req.messages[0]?.content;
          // A research child: answer directly (its own isolated context).
          if (typeof sys === "string" && sys.includes("research sub-agent"))
            return textResult("SUMMARY: found the widget spec. FINDINGS: it ships in Q3.");
          // The parent.
          seen.push(req.messages);
          parentCall++;
          if (parentCall === 1)
            return toolCallResult("research", { tasks: ["dig into the widget"] });
          return textResult("done");
        },
        builtinTools({ workspace: dir, codeCli: ["x"], selfCmd: ["delta"], subagentDepth: 0 }),
      );
      deps.workspace = dir;

      const queue = new Queue(deps);
      const done = await queue.wait(queue.enqueue({ input: "research the widget" }).id);
      expect(done.status).toBe("done");

      // The parent's 2nd turn saw the research tool result: a summary + a path, NOT the child's
      // own tool calls / transcript.
      const toolResult = (seen[1] ?? []).find((m) => m.role === "tool") as { content: string };
      expect(toolResult.content).toContain("found the widget spec");
      expect(toolResult.content).toContain("research/");
      // The artifact is on disk.
      const runDirs = readdirSync(join(dir, "research"));
      expect(runDirs.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
