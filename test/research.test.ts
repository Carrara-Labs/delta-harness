// W4: in-process, parallel research sub-agents that are READ-ONLY (S6). Prove children get only the
// parent's read-only tools (positive, fail-closed admission — a mutating or unmarked tool never
// reaches a child), the pinned + search_tools resident model, that a child CANNOT mutate, the
// bounded parallel loop, parent-written artifacts, a single usage charge, and model-driven
// end-to-end through `research`.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtins";
import type { ChatMsg, ChatRequest, ModelResult, Usage } from "../src/provider";
import { Queue } from "../src/queue";
import { childTools, RESEARCH_ROLE, runResearch } from "../src/research";
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
const fakeTool = (name: string, exec?: ToolDef["execute"], readonly = false): ToolDef => ({
  name,
  description: "",
  parameters: { type: "object", properties: {} },
  idempotent: true,
  ...(readonly ? { readonly: true } : {}), // default: mutating (fail-closed), as in production
  execute: exec ?? (async () => "ok"),
});

describe("childTools — read-only tools only (positive, fail-closed admission, S6)", () => {
  test("admits ONLY read-only tools; drops every mutating/unmarked tool by default", () => {
    const allowed: Tools = new Map();
    // Read-only tools (marked): the child's whole legitimate universe.
    for (const n of ["web_search", "web_fetch", "read_file", "grep", "list_dir", "kb__search_text"])
      allowed.set(n, fakeTool(n, undefined, true));
    // Mutating tools (unmarked = default mutating): must NEVER reach a child — write, move,
    // delete, arbitrary code, self-file rewrite, a KB write, and the delegation/scheduling set.
    for (const n of [
      "write_file",
      "move_file",
      "delete_file",
      "code",
      "remember",
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
    for (const n of ["web_search", "web_fetch", "read_file", "grep", "list_dir", "kb__search_text"])
      expect(child.has(n)).toBe(true);
    for (const n of [
      "write_file",
      "move_file",
      "delete_file",
      "code",
      "remember",
      "kb__delete_entity",
      "research",
      "spawn_subagent",
      "eval_n",
      "schedule_self",
      "list_schedules",
      "cancel_schedule",
    ])
      expect(child.has(n)).toBe(false);
    // The admitted def is the parent's exact def (guards ride along), and NOTHING mutating slipped
    // through — the child universe is a strict subset of the read-only tools.
    expect(child.get("read_file")).toBe(allowed.get("read_file"));
    for (const def of child.values()) expect(def.readonly).toBe(true);
  });

  test("an unmarked NEW tool is excluded by default (a forgotten flag can't leak a write)", () => {
    const allowed: Tools = new Map([["some_new_tool", fakeTool("some_new_tool")]]);
    expect(childTools(allowed).has("some_new_tool")).toBe(false);
  });

  // THE PROSE LOCK. Children became read-only in 0.2.4 and FIVE places went on saying otherwise
  // for ten releases: the tool description, this file's header, the ChildConfig comment, the
  // published guide, and — the one that actually costs something — the child's own role prompt,
  // which instructed it to write files the engine would refuse.
  //
  // A per-tool-name assertion is not implementable here: the description is built statically in
  // `builtinTools`, before any run-specific universe exists, and listing every child tool would
  // bloat the schema the searchable-tool design exists to keep small. So lock the CAPABILITY
  // CLASS instead, on both surfaces at once. Loosening `childTools` without rewriting the prose
  // now fails, and so does softening the prose while the filter still enforces read-only.
  test("the enforced filter and the prose the model reads cannot drift apart", () => {
    const universe: Tools = new Map([
      ["read_file", fakeTool("read_file", undefined, true)],
      ["write_file", fakeTool("write_file")],
      ["remember", fakeTool("remember")],
    ]);
    // Enforcement: read-only, and nothing else, gets in.
    const admitted = [...childTools(universe).values()];
    expect(admitted.length).toBeGreaterThan(0); // a filter that admits nothing proves nothing
    for (const def of admitted) expect(def.readonly).toBe(true);

    // The child is told exactly that, in the one place it can act on before choosing a tool.
    expect(RESEARCH_ROLE).toMatch(/read-only/i);

    // And so is the parent, in the description it plans against.
    const research = builtinTools({
      workspace: "/tmp/delta-prose-lock",
      codeCli: ["true"],
      selfCmd: ["true"],
      subagentDepth: 0,
    }).get("research");
    expect(research?.description).toMatch(/read-only/i);
    // Naming the restriction beats implying it: the parent plans better against "cannot write"
    // than against "read-only", and this is the sentence that was wrong for ten releases.
    expect(research?.description).toMatch(/cannot[^.]*(write|remember|run code)/i);
    // The literal claim that shipped from 0.2.4 to 0.2.13, on both surfaces. Blunt on purpose:
    // a regex over prose cannot prove a description is honest, but it can stop this exact
    // sentence coming back, and this exact sentence is what an agent planned around.
    expect(research?.description).not.toMatch(/same (tools|rights)/i);
    expect(RESEARCH_ROLE).not.toMatch(/same (tools|rights)/i);
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
      expect(out).toContain(".delta/research/"); // the artifact path (D-7 layout)
      const files = readdirSync(join(dir, ".delta", "research", "run1.0"));
      expect(files.length).toBe(1);
      expect(
        readFileSync(join(dir, ".delta", "research", "run1.0", files[0] as string), "utf8"),
      ).toContain("the answer is 42");
      expect(charged).not.toBeNull();
      expect((charged as unknown as Usage).total).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a child CANNOT mutate — childTools strips the write tool before it can run (S6)", async () => {
    const dir = ws();
    try {
      const written: Record<string, string> = {};
      // The parent's registry has a real write tool (mutating, unmarked) plus a read tool.
      const parent: Tools = new Map();
      parent.set(
        "write_file",
        fakeTool("write_file", async (args) => {
          written[String(args.path)] = String(args.content); // must NEVER fire from a child
          return "wrote";
        }),
      );
      parent.set(
        "read_file",
        fakeTool("read_file", async () => "file contents", true),
      );
      // Production builds the child universe through childTools — the security boundary.
      const universe = childTools(parent);
      expect(universe.has("write_file")).toBe(false); // stripped: not read-only
      expect(universe.has("read_file")).toBe(true);

      // A (misbehaving) child model tries to write anyway; it must be refused.
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
        // It sees the refusal in the tool result and gives up.
        return {
          ok: true,
          model: "t",
          message: { role: "assistant", content: "SUMMARY: could not write; reported findings." },
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
        ["try to write a note"],
        { tools: universe, pinned: ["read_file"] },
        writeChild,
        ctx,
        "w",
        "0",
      );
      expect(out).toContain("could not write");
      expect(written["note.md"]).toBeUndefined(); // the write never happened
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
      expect(readdirSync(join(dir, ".delta", "research", "run2.0")).length).toBe(3);
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
      expect(toolResult.content).toContain(".delta/research/");
      const runDirs = readdirSync(join(dir, ".delta", "research"));
      expect(runDirs.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
