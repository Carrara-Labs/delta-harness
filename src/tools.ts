// SPDX-License-Identifier: Apache-2.0
// Tool registry. M1 carries only the type + test tools (real hands land in M2).
// `idempotent` drives resume semantics: after a crash mid-execution, idempotent
// tools re-fire; non-idempotent tools get a synthetic interrupted result and the
// model decides (spec §B sub-turn resume).

import type { ChatRequest, ModelResult, ToolSpec, Usage } from "./provider";

/** One `recall` hit: a matching earlier message in this thread, with a pointer to the
 * full result on disk if it was spilled. `active` false = compacted out of the live window. */
export type RecallHit = {
  role: string;
  runSeq: number | null;
  active: boolean;
  snippet: string;
  spillPath?: string;
};

/** The agent's per-thread working plan (W3 recitation). */
export type TodoStatus = "pending" | "doing" | "done" | "dropped";
export type TodoItem = { text: string; status: TodoStatus };

export type ToolCtx = {
  /** Workspace root for file tools; absolute path. */
  workspace: string;
  /** Pull more tools into this run's active set (search_tools uses this). */
  activate: (names: string[]) => void;
  /** Search THIS thread's message history — including rows compacted out of the active
   * window — for text the agent saw earlier (the `recall` tool). Session is bound
   * internally so a caller can never search another session. Absent in bare/oneshot
   * contexts (a `:memory:` sub-agent has no shared history). */
  history?: { search: (query: string, limit: number) => RecallHit[] };
  /** The `todo` tool's hands: read / replace THIS thread's working plan (W3). Session-bound so a
   * tool can't touch another thread's plan; absent in bare/oneshot contexts. */
  todo?: { read: () => TodoItem[]; write: (items: TodoItem[]) => TodoItem[] };
  /** The `research` tool's hands (W4): run 1–3 read-only research questions in parallel in-process
   * and get back a distilled summary + artifact path per task. Absent in a research child (depth
   * cap) and in bare/oneshot contexts. */
  research?: (tasks: string[]) => Promise<string>;
  signal?: AbortSignal;
  /** The run's provider — for tools that need a model call (eval_n judging,
   * result summarization). Absent in bare tool contexts. */
  chat?: (req: ChatRequest) => Promise<ModelResult>;
  /** Cheap-model lane for auxiliary calls (judging, summarizing) — falls back to `chat`. */
  chatUtility?: (req: ChatRequest) => Promise<ModelResult>;
  /** Per-run bearer for act-as-user MCP calls (act-as-token passthrough, §E). */
  authToken?: string;
  /** Whether the daemon's model reads images — shapes image-marker phrasing so a
   * non-vision model is told plainly it can't see the pixels. */
  vision?: boolean;
  /** Charge nested model work to this run's durable usage total. */
  chargeUsage?: (usage: Usage) => void;
  /** Fresh-token and dollar budget still available to nested work. */
  remainingBudget?: () => { maxTokens: number; maxCostUsd: number };
  /** Persist the agent's own DELTA.md self-file (the `remember` tool): atomic replace,
   * prior version snapshotted, oversized rejected. Absent in bare/oneshot contexts. */
  writeSelf?: (content: string) => { ok: boolean; error?: string; bytes?: number };
};

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  idempotent: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string>;
  /** Per-tool wall-clock ceiling (ms). Overrides the run default. Set `0` for tools that
   * legitimately run long (the `code`/`codex` CLI, sub-agents) so they're never guillotined
   * — declarative, unlike a model-slug allowlist. Unset → the run's `toolTimeoutMs`. */
  timeoutMs?: number;
};

export type Tools = Map<string, ToolDef>;

/** Bound an oversize tool result while keeping BOTH ends (spec §D P1): head +
 * tail with a middle elision, so the model sees the start (context) AND the end
 * (the conclusion — often where the answer/error lives). Cheap + deterministic;
 * a hard tail-cut throws away exactly the payoff. */
export function elide(text: string, max = 20_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const dropped = text.length - max;
  return `${text.slice(0, head)}\n\n… [elided ${dropped} chars] …\n\n${text.slice(text.length - tail)}`;
}

/** Cap a tool result before it's persisted and re-sent every turn: spill the full output to
 * a file the agent can re-read, and keep head+tail with the spill path in the elision marker
 * (so the model still sees the start AND the conclusion). A single giant tool payload is
 * exactly what pushes the next prompt over the context window — this bounds it at the source.
 * Reuses elide's head/tail split; preserves any leading `[tool error]` prefix. Default 20KB
 * (the old per-builtin inline budget). Spill is lazy — 99% of capped results are never re-read. */
export async function capAndSpill(
  text: string,
  workspace: string,
  runId: string,
  callId: string,
  max = 20_000,
): Promise<string> {
  if (text.length <= max) return text;
  // callId comes from the PROVIDER — sanitize both ids so a hostile `../`-laden id can
  // never escape the spill dir and overwrite an arbitrary path (codex #4).
  const safe = (s: string) => s.replace(/[^\w-]/g, "_").slice(0, 80);
  const path = `${workspace}/.delta/spill/${safe(runId)}.${safe(callId)}.txt`;
  try {
    await Bun.write(path, text);
  } catch {
    return elide(text, max); // spill failed — still cap, just without a re-read path
  }
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const dropped = text.length - max;
  return `${text.slice(0, head)}\n\n… [elided ${dropped} chars — full output saved to ${path}; read that file for the rest] …\n\n${text.slice(text.length - tail)}`;
}

export function toolSpecs(tools: Tools): ToolSpec[] {
  return [...tools.values()].map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Test-only tools, registered when DELTA_TEST_TOOLS is set (crash/resume proofs). */
export function testTools(): Tools {
  const tools: Tools = new Map();
  const add = (t: ToolDef) => tools.set(t.name, t);
  add({
    name: "add",
    description: "Add two numbers and return the sum.",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    idempotent: true,
    execute: async (args) => String(Number(args.a) + Number(args.b)),
  });
  add({
    name: "slow_append",
    description: "Append a line to a scratch file, slowly. Non-idempotent.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, line: { type: "string" }, ms: { type: "number" } },
      required: ["path", "line"],
    },
    idempotent: false,
    execute: async (args) => {
      await Bun.sleep(Number(args.ms ?? 3000));
      const file = String(args.path);
      const prev = (await Bun.file(file)
        .text()
        .catch(() => "")) as string;
      await Bun.write(file, `${prev}${String(args.line)}\n`);
      return "appended";
    },
  });
  return tools;
}
