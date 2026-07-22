// W4: in-process, parallel sub-agents with the SAME rights as the parent. Prove children get the
// parent's full registry minus the delegation trio (one-level nesting cap), the pinned + search_tools
// resident model, that a child can ACT (write) like its parent, the bounded parallel loop,
// parent-written artifacts, a single usage charge, and model-driven end-to-end through `research`.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtins";
import type { ChatMsg, ChatRequest, ModelResult, Usage } from "../src/provider";
import { Queue } from "../src/queue";
import { childTools, runResearch } from "../src/research";
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

describe("childTools — the parent's registry minus the withheld set", () => {
  test("keeps read/write/code/remember/kb tools; drops delegation + scheduling tools", () => {
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
      "kb__search_text",
      "kb__delete_entity",
      "research",
      "spawn_subagent",
      "eval_n",
      "schedule_self",
      "list_schedules",
      "cancel_schedule",
    ])
      allowed.set(n, fakeTool(n));

    const child = childTools(allowed);
    // Same rights as the parent — every non-withheld tool rides along, guards intact.
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
      "kb__search_text",
      "kb__delete_entity",
    ])
      expect(child.has(n)).toBe(true);
    // Withheld: the delegation trio (in-process recursion) AND the scheduling tools (a child could
    // queue a fresh ROOT run that re-delegates — escaping the one-level cap by a side door).
    for (const n of [
      "research",
      "spawn_subagent",
      "eval_n",
      "schedule_self",
      "list_schedules",
      "cancel_schedule",
    ])
      expect(child.has(n)).toBe(false);
    // The child def is the parent's exact def (same guards ride along).
    expect(child.get("write_file")).toBe(allowed.get("write_file"));
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

      const out = await runResearch(
        ["what is the answer?"],
        { tools, pinned: ["web_search"] },
        childChat,
        ctx,
        "run1",
        "0",
      );
      expect(out).toContain("what is the answer?");
      expect(out).toContain("the answer is 42");
      expect(out).toContain("research/"); // the artifact path
      const files = readdirSync(join(dir, "research", "run1.0"));
      expect(files.length).toBe(1);
      expect(readFileSync(join(dir, "research", "run1.0", files[0] as string), "utf8")).toContain(
        "the answer is 42",
      );
      expect(charged).not.toBeNull();
      expect((charged as unknown as Usage).total).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a child can ACT — write a file — with the parent's own write tool (same rights)", async () => {
    const dir = ws();
    try {
      const written: Record<string, string> = {};
      const tools: Tools = new Map();
      tools.set(
        "write_file",
        fakeTool("write_file", async (args) => {
          written[String(args.path)] = String(args.content);
          return "wrote";
        }),
      );
      // Child model: write once, then answer.
      const writeChild = async (req: ChatRequest): Promise<ModelResult> => {
        if (!req.messages.some((m) => m.role === "tool"))
          return {
            ok: true,
            model: "t",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "w1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "note.md", content: "hi from a child" }),
                  },
                },
              ],
            },
            usage: U(),
            finishReason: "tool_calls",
            latencyMs: 1,
          } as ModelResult;
        return {
          ok: true,
          model: "t",
          message: { role: "assistant", content: "SUMMARY: wrote the note." },
          usage: U(),
          finishReason: "stop",
          latencyMs: 1,
        } as ModelResult;
      };
      const ctx = {
        workspace: dir,
        activate: () => {},
        remainingBudget: () => ({ maxTokens: 100_000, maxCostUsd: 10 }),
      } as unknown as ToolCtx;
      const out = await runResearch(
        ["write a note"],
        { tools, pinned: ["write_file"] },
        writeChild,
        ctx,
        "w",
        "0",
      );
      expect(out).toContain("wrote the note");
      expect(written["note.md"]).toBe("hi from a child");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-pinned tool is reachable via the child's own search_tools", async () => {
    const dir = ws();
    try {
      let searched = false;
      const tools: Tools = new Map();
      tools.set(
        "kb__search_text",
        fakeTool("kb__search_text", async () => {
          searched = true;
          return "found: Oxygen";
        }),
      );
      // Child model: search_tools (to activate the non-resident kb tool), then call it, then answer.
      const searchChild = async (req: ChatRequest): Promise<ModelResult> => {
        const calls = req.messages.filter((m) => m.role === "tool").length;
        if (calls === 0)
          return {
            ok: true,
            model: "t",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "s1",
                  type: "function",
                  function: { name: "search_tools", arguments: JSON.stringify({ query: "kb" }) },
                },
              ],
            },
            usage: U(),
            finishReason: "tool_calls",
            latencyMs: 1,
          } as ModelResult;
        if (calls === 1)
          return {
            ok: true,
            model: "t",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "b1",
                  type: "function",
                  function: { name: "kb__search_text", arguments: "{}" },
                },
              ],
            },
            usage: U(),
            finishReason: "tool_calls",
            latencyMs: 1,
          } as ModelResult;
        return {
          ok: true,
          model: "t",
          message: { role: "assistant", content: "SUMMARY: routed to Oxygen." },
          usage: U(),
          finishReason: "stop",
          latencyMs: 1,
        } as ModelResult;
      };
      const ctx = {
        workspace: dir,
        activate: () => {},
        remainingBudget: () => ({ maxTokens: 100_000, maxCostUsd: 10 }),
      } as unknown as ToolCtx;
      // pinned = [] → the kb tool is NOT resident; the child must search_tools to reach it.
      const out = await runResearch(
        ["route it"],
        { tools, pinned: [] },
        searchChild,
        ctx,
        "s",
        "0",
      );
      expect(searched).toBe(true);
      expect(out).toContain("routed to Oxygen");
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
      const out = await runResearch(
        ["a", "b", "c", "d", "e"],
        { tools, pinned: ["web_search"] },
        childChat,
        ctx,
        "run2",
        "0",
      );
      expect((out.match(/^## /gm) ?? []).length).toBe(3);
      expect(readdirSync(join(dir, "research", "run2.0")).length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no tools available → a clear error, no crash", async () => {
    const ctx = {
      workspace: "/tmp",
      activate: () => {},
      remainingBudget: () => ({ maxTokens: 100_000, maxCostUsd: 10 }),
    } as unknown as ToolCtx;
    const out = await runResearch(
      ["x"],
      { tools: new Map(), pinned: [] },
      childChat,
      ctx,
      "r",
      "0",
    );
    expect(out).toContain("no tools");
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
          // A research child: identity comes from the shared spine, so it's told apart by the
          // sub-agent ROLE framing that rides its user message. Answer directly (isolated context).
          const isChild = req.messages.some(
            (m) =>
              typeof m.content === "string" && m.content.includes("sub-agent working one task"),
          );
          if (isChild)
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

      const toolResult = (seen[1] ?? []).find((m) => m.role === "tool") as { content: string };
      expect(toolResult.content).toContain("found the widget spec");
      expect(toolResult.content).toContain("research/");
      const runDirs = readdirSync(join(dir, "research"));
      expect(runDirs.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
