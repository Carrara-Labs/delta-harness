// SPDX-License-Identifier: Apache-2.0
// W4: in-process, parallel sub-agents with the SAME rights as the parent. A child runs a BOUNDED
// agent loop in memory — never a subprocess, never a DB row — reusing the parent's provider, tool
// registry, and act-as token. It gets the parent's full tool set MINUS the delegation trio
// (research/spawn_subagent/eval_n) so nesting stays exactly ONE level deep — the load-bearing
// invariant: an in-process child that could re-spawn would fork-bomb the shared budget. Everything
// else the parent can do — read, write, code, knowledge-base reads AND writes, remember — a child can do,
// gated by the parent's OWN per-tool guards (guardWrite reserved files, MCP act-as token, etc.), not
// a research-specific facade. Its transcript stays inside this function; the parent only ever absorbs
// a distilled summary + an artifact path the PARENT writes. Ephemeral by design: nothing to resume,
// no reflection, no session.
//
// Context management mirrors the parent: a child starts from the parent's pinned resident set and can
// `search_tools` to activate anything else in its universe — so a 90-tool registry never blows the
// child's own token budget on step one. N≤3, one batch in flight per turn, per-child token slice.

import { mkdirSync, realpathSync, renameSync } from "node:fs";
import type { ChatMsg, ChatRequest, ModelResult, Usage } from "./provider";
import { buildSpine } from "./spine";
import { elide, type ToolCtx, type ToolDef, type Tools, toolSpecs } from "./tools";

// The sub-agent role framing — rides a USER message ahead of the task, exactly as the parent's
// per-turn instructions do (the engine identity + safety norms + self + policy come from the shared
// spine, so a child inherits the parent's operating rules, not just a claim of them — codex).
const RESEARCH_ROLE =
  "You are a sub-agent working one task in isolation for the agent that spawned you. Use whatever of your tools the task needs. You run CONCURRENTLY with sibling sub-agents in the SAME workspace: prefer reads, and if you must write, use a unique path so you don't clobber a sibling. Be thorough, then finish with a tight, outcome-first answer: a one-paragraph SUMMARY, then detailed FINDINGS (facts, numbers, sources, file paths). Your full answer is saved to a file but only the SUMMARY returns to your parent — put the signal in the summary.\n\nYour task:";

// Withheld from children so the "one level of nesting" invariant actually holds: the delegation
// trio would let an in-process child recurse; the scheduling tools would let a child queue a FRESH
// ROOT run (depth 0) that can itself delegate — escaping the cap by a side door (codex). These are
// the ONLY capabilities a child loses relative to the parent.
const WITHHELD = new Set([
  "research",
  "spawn_subagent",
  "eval_n",
  "schedule_self",
  "list_schedules",
  "cancel_schedule",
]);

/** A child's callable universe + its resident set + the parent's spine layers (self / rendered policy
 * / boot-stable context). Passing the spine layers means a child is built from the SAME buildSpine as
 * the parent — same identity, same engine safety norms, same policy — so it inherits the parent's
 * OPERATING RULES along with its rights: same-rights AND same-rules, not powerful-but-unconstrained. */
export type ChildConfig = {
  tools: Tools;
  pinned: string[];
  agentId?: string;
  self?: string;
  policy?: string;
  context?: string;
};

const MAX_TASKS = 3;
const CHILD_MAX_STEPS = 8;
const MAX_TOOLCALLS_PER_TURN = 6;
const MAX_TOOLCALLS_TOTAL = 20;
const MIN_CHILD_TOKENS = 2_000;
const OUTPUT_CAP = 4_000; // per-model-call output ceiling (also the synthesis cap)
const ARTIFACT_MAX_BYTES = 200_000;
const SUMMARY_CHARS = 1_200;

const zero = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  costUsd: 0,
});
function addUsage(a: Usage, b: Usage) {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.total += b.total;
  a.costUsd += b.costUsd;
}
const billed = (u: Usage): number => Math.max(0, u.input - u.cacheRead) + u.output;

/** A child's callable universe: the parent's full tool registry minus the withheld set (delegation +
 * run-scheduling). Same rights as the parent — the parent's own per-tool guards ride along on each
 * def — and exactly one level of nesting. `search_tools` is added per-child (not here); it is never
 * in the parent registry. */
export function childTools(allowed: Tools): Tools {
  const out: Tools = new Map();
  for (const [name, def] of allowed) if (!WITHHELD.has(name)) out.set(name, def);
  return out;
}

/** A child-scoped `search_tools`: activates matches into THIS child's active set (never the
 * parent's), mirroring run.ts so a child manages its resident schemas exactly like the parent. */
function childSearchTool(
  universe: Tools,
  active: Set<string>,
  activate: (names: string[]) => void,
): ToolDef {
  return {
    name: "search_tools",
    description: "Find and activate more tools by keyword; matches become callable next turn.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    idempotent: true,
    execute: async (args) => {
      const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [...universe.values()]
        .filter((t) => !active.has(t.name))
        .map((t) => {
          const hay = `${t.name} ${t.description}`.toLowerCase();
          return { t, score: words.filter((w) => hay.includes(w)).length };
        })
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      if (hits.length === 0) return "no matching tools";
      activate(hits.map((h) => h.t.name));
      return `activated:\n${hits.map((h) => `- ${h.t.name} — ${h.t.description}`).join("\n")}`;
    },
  };
}

type Outcome = { task: string; ok: boolean; text: string; usage: Usage };

/** One bounded sub-agent loop (in-memory), with the parent's tools. Never throws — always returns an
 * Outcome carrying whatever usage was spent, so the parent charges every child exactly once. Starts
 * resident on `pinned` and self-serves the rest via `search_tools`, like the parent's own loop. */
async function researchOne(
  task: string,
  child: ChildConfig,
  chat: (req: ChatRequest) => Promise<ModelResult>,
  baseCtx: ToolCtx,
  opts: { maxTokens: number; signal?: AbortSignal },
): Promise<Outcome> {
  const usage = zero();
  const universe = child.tools;
  // The child's resident set + its own activation — a mirror of run.ts's active/activate/search.
  const active = new Set<string>(child.pinned.filter((n) => universe.has(n)));
  const activate = (names: string[]) => {
    for (const n of names) if (universe.has(n)) active.add(n);
  };
  const searchTool = childSearchTool(universe, active, activate);
  const childCtx: ToolCtx = { ...baseCtx, activate };
  const callable = (): Tools => {
    const map: Tools = new Map();
    for (const n of active) {
      const def = universe.get(n);
      if (def) map.set(n, def);
    }
    if (universe.size > active.size) map.set(searchTool.name, searchTool);
    return map;
  };

  // Build the child's system message from the SAME spine as the parent — engine identity + safety
  // norms (proposal-only shared writes, untrusted web/document content) + self + policy — over the
  // child's OWN resident tool list. The role framing + task ride a user message, exactly as the
  // parent's per-turn instructions do (codex — a child must inherit the parent's norms, not just its
  // rights). Built once from the initial resident set; the API `tools` field is what actually gates
  // each step, so a later search_tools activation isn't lost even if the index hint goes stale.
  const initial = callable();
  const system = buildSpine({
    ...(child.agentId ? { agentId: child.agentId } : {}),
    pinned: [...initial.values()].filter((t) => t.name !== searchTool.name),
    searchable: universe.size - active.size,
    ...(child.self ? { self: child.self } : {}),
    ...(child.policy ? { policy: child.policy } : {}),
    ...(child.context ? { context: child.context } : {}),
  });
  const messages: ChatMsg[] = [
    { role: "system", content: system },
    { role: "user", content: `${RESEARCH_ROLE} ${task}` },
  ];
  let toolCalls = 0;
  try {
    for (let step = 0; step < CHILD_MAX_STEPS; step++) {
      if (opts.signal?.aborted) return { task, ok: false, text: "[research cancelled]", usage };
      const tools = callable();
      const remaining = opts.maxTokens - billed(usage);
      const overBudget = remaining <= 0 || toolCalls >= MAX_TOOLCALLS_TOTAL;
      const res = await chat({
        messages,
        ...(overBudget ? {} : { tools: toolSpecs(tools) }), // out of budget → force a final answer
        maxTokens: Math.max(256, Math.min(OUTPUT_CAP, remaining)),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) {
        if (res.aborted) return { task, ok: false, text: "[research cancelled]", usage };
        return { task, ok: false, text: `[research failed: ${res.error}]`, usage };
      }
      addUsage(usage, res.usage);
      const assistant = res.message;
      if (assistant.tool_calls?.length && !overBudget) {
        messages.push(assistant);
        let inTurn = 0;
        for (const call of assistant.tool_calls) {
          // EVERY tool_call id must get a result or the provider rejects the message list.
          let out: string;
          if (opts.signal?.aborted) out = "[research cancelled]";
          else if (inTurn >= MAX_TOOLCALLS_PER_TURN || toolCalls >= MAX_TOOLCALLS_TOTAL)
            out = "[tool error] tool-call budget reached — give your final answer now";
          else {
            const def = tools.get(call.function.name);
            if (!def)
              out = `[tool error] '${call.function.name}' is not active — search_tools for it first`;
            else {
              try {
                const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
                out = elide(await def.execute(args, childCtx)); // in-memory only — no disk spill
              } catch (e) {
                out = `[tool error] ${String(e).slice(0, 300)}`;
              }
            }
            inTurn++;
            toolCalls++;
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: out });
        }
        continue;
      }
      return { task, ok: true, text: assistant.content ?? "(no findings)", usage };
    }
    return { task, ok: true, text: "(research inconclusive — step budget exhausted)", usage };
  } catch (e) {
    return { task, ok: false, text: `[research error] ${String(e).slice(0, 200)}`, usage };
  }
}

/** Parent-owned artifact write: temp + atomic rename under a realpath-verified in-workspace dir (a
 * `research -> /outside` symlink can't escape), UTF-8 byte-bounded. Returns the workspace-relative
 * path the agent can `read_file`. Written by the parent so a child's full findings survive even
 * though only its summary re-enters context. */
async function writeArtifact(
  workspace: string,
  runId: string,
  seq: string,
  index: number,
  task: string,
  text: string,
): Promise<string> {
  const safe = (s: string) => s.replace(/[^\w-]/g, "_").slice(0, 40) || "x";
  const dir = `${workspace}/research/${safe(runId)}.${safe(seq)}`;
  mkdirSync(dir, { recursive: true });
  // Realpath BOTH sides (the workspace path itself may traverse symlinks, e.g. /tmp→/private/tmp)
  // so the check only fires on a genuine escape like `research -> /outside`.
  const realWs = realpathSync(workspace);
  const real = realpathSync(dir);
  if (real !== realWs && !real.startsWith(`${realWs}/`))
    throw new Error("artifact dir escaped the workspace");
  const path = `${dir}/${index}-${safe(task)}.md`;
  const enc = new TextEncoder().encode(`# ${task}\n\n${text}`);
  const body =
    enc.length > ARTIFACT_MAX_BYTES
      ? new TextDecoder().decode(enc.slice(0, ARTIFACT_MAX_BYTES))
      : `# ${task}\n\n${text}`;
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, body);
  renameSync(tmp, path);
  return path.slice(workspace.length + 1);
}

/** Run 1–3 sub-agent tasks in parallel, each in its own bounded context with the parent's tools.
 * Writes each child's full findings to a file and returns only a per-task summary + path — the
 * children's transcripts never enter the parent's context. Charges ALL child usage to the parent
 * ONCE. `child` bundles the callable universe (childTools(parent registry)), the parent's resident
 * `pinned` set, and the parent's identity+policy `context`. */
export async function runResearch(
  tasks: string[],
  child: ChildConfig,
  chat: (req: ChatRequest) => Promise<ModelResult>,
  ctx: ToolCtx,
  runId: string,
  seq: string,
): Promise<string> {
  const picked = tasks
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, MAX_TASKS);
  if (!picked.length) return "[tool error] no valid research tasks";
  if (child.tools.size === 0)
    return "[tool error] no tools are available to sub-agents in this context";

  // Admission ONCE: reserve a parent synthesis share (÷ N+1). Under the engine's soft-budget model
  // (billed input+output is checked BETWEEN calls, not pre-reserved — the parent's own loop works the
  // same way), each child targets ~remaining/(N+1), so the batch stays near the parent's remaining
  // rather than N× over it. Reject a batch too small to do useful work — or with no dollar budget
  // left — rather than launching zero-budget children (codex).
  const rem = ctx.remainingBudget?.() ?? { maxTokens: 200_000, maxCostUsd: 10 };
  const perChildTokens = Math.floor(rem.maxTokens / (picked.length + 1));
  if (rem.maxCostUsd <= 0)
    return "[tool error] no cost budget left for research — the run is at its dollar ceiling";
  if (perChildTokens < MIN_CHILD_TOKENS)
    return `[tool error] not enough token budget left for research (${rem.maxTokens} remaining) — narrow the task or run fewer`;

  // The child ctx carries the parent's capabilities MINUS delegation (no research/chat → no
  // recursion) and MINUS the parent-thread-bound hands (history/todo → a child is isolated, no
  // session). `activate` is replaced per-child in researchOne so a child's search_tools mutates its
  // own resident set, never the parent's. writeSelf rides along for `remember` parity.
  const baseCtx: ToolCtx = {
    workspace: ctx.workspace,
    activate: () => {},
    ...(ctx.authToken ? { authToken: ctx.authToken } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.vision !== undefined ? { vision: ctx.vision } : {}),
    ...(ctx.writeSelf ? { writeSelf: ctx.writeSelf } : {}),
  };

  const settled = await Promise.allSettled(
    picked.map((task) =>
      researchOne(task, child, chat, baseCtx, {
        maxTokens: perChildTokens,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    ),
  );

  const total = zero();
  const blocks: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i] as (typeof settled)[number];
    const task = picked[i] as string;
    if (s.status === "rejected") {
      blocks.push(`## ${task}\n[research error] ${String(s.reason).slice(0, 200)}`);
      continue;
    }
    addUsage(total, s.value.usage);
    const full = s.value.text || "(no findings)";
    let path = "";
    try {
      path = await writeArtifact(ctx.workspace, runId, seq, i, task, full);
    } catch {
      path = "";
    }
    const summary = full.length > SUMMARY_CHARS ? `${full.slice(0, SUMMARY_CHARS)} …` : full;
    const tail = path ? `\n(full findings on disk: ${path} — read_file it)` : "";
    blocks.push(`## ${task}\n${summary}${tail}`);
  }

  ctx.chargeUsage?.(total); // charge all child usage to the parent ONCE (children keep no rows)
  return blocks.join("\n\n");
}
