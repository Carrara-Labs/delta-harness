// SPDX-License-Identifier: Apache-2.0
// W4: in-process, read-only, parallel research sub-agents. A research child runs a BOUNDED agent
// loop in memory — never a subprocess, never a DB row — reusing the parent's provider + a
// DEFAULT-DENY read-only tool subset + the parent's act-as token for MCP reads. Its transcript
// stays inside this function; the parent only ever absorbs a distilled summary + an artifact path
// the PARENT writes. Ephemeral by design: nothing to resume, no reflection, no session.
//
// Security posture (codex-reviewed twice): no mutation tools (default-deny; operator MCP allowlist
// can ONLY add `__`-namespaced tools, never re-enable a builtin); MCP reads only when the run's
// act-as token is present (else no daemon-credential fallback); a confine-canonicalized reserved
// read facade (read_file only — grep/list_dir root-scans are excluded, a documented deferral);
// bounded steps + per-turn/total tool calls + per-child token budget + maxTokens on every call;
// parent writes the artifact under a realpath-verified in-workspace dir; N≤3 with one batch in
// flight per turn. Residual/deferred: scoped server-validated child token, transport MCP proxy,
// stdio-MCP act-as, per-session FS snapshot, research-safe grep/list_dir, durable/async handles.

import { mkdirSync, realpathSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { confine } from "./files";
import type { ChatMsg, ChatRequest, ModelResult, Usage } from "./provider";
import { elide, type ToolCtx, type ToolDef, type Tools, toolSpecs } from "./tools";

const RESEARCH_SYSTEM =
  "You are a research sub-agent working one question in isolation. Investigate using ONLY your read-only tools (web search/fetch, targeted file reads, and any provided data-read tools). You CANNOT write files, run code, schedule, or take any action — read and report only. Be thorough, then finish with a tight, outcome-first answer: a one-paragraph SUMMARY, then detailed FINDINGS (facts, numbers, sources, file paths).";

// Default read-only builtins a research child may use. grep/list_dir are EXCLUDED — a root scan
// (`grep .`) would read secrets/operator files, and making them reserved-aware is deferred; the
// child reads targeted files via read_file (facade-guarded). MCP read tools are opt-in by EXACT
// `__`-namespaced id via DELTA_RESEARCH_TOOLS — read-only is never inferred from a name.
const RESEARCH_SAFE_BUILTINS = new Set(["web_search", "web_fetch", "read_file"]);
// Never allowlistable, even by exact name — belt-and-suspenders against a mis-set operator env.
const FORBIDDEN = new Set([
  "write_file",
  "move_file",
  "delete_file",
  "code",
  "remember",
  "research",
  "spawn_subagent",
  "eval_n",
  "schedule_self",
  "list_schedules",
  "cancel_schedule",
]);
const FILE_TOOLS = new Set(["read_file"]);
const RESERVED_FILES = new Set(["POLICY.md", "vocab.json", "PROMPT_CONTEXT.md", "DELTA.md"]);

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

/** True if `p` resolves (symlinks canonicalized via confine) to a secrets/state/operator file, or
 * escapes the workspace. confine does realpath so a `public/x -> ../.env` alias is caught; for a
 * not-yet-existent path confine throws, so we fall back to a lexical `..`-normalized resolve. */
function reservedPath(workspace: string, p: string): boolean {
  let abs: string;
  try {
    abs = confine(workspace, p);
  } catch {
    const lex = resolve(workspace, p);
    if (lex !== workspace && !lex.startsWith(`${workspace}/`)) return true; // escapes
    abs = lex;
  }
  if (abs !== workspace && !abs.startsWith(`${workspace}/`)) return true;
  const rel = abs === workspace ? "" : abs.slice(workspace.length + 1);
  return (
    rel === ".env" ||
    rel.startsWith(".env.") ||
    rel === "delta.env" ||
    rel === ".delta" ||
    rel.startsWith(".delta/") ||
    RESERVED_FILES.has(rel)
  );
}

/** Wrap read_file so a research child can't read secrets/state/operator files (symlinks included). */
function withReadFacade(name: string, def: ToolDef): ToolDef {
  if (!FILE_TOOLS.has(name)) return def;
  return {
    ...def,
    execute: async (args, ctx) => {
      const p = String(args.path ?? args.file ?? ".");
      if (reservedPath(ctx.workspace, p))
        return "[tool error] that path is off-limits to research sub-agents (secrets/state/operator files)";
      return def.execute(args, ctx);
    },
  };
}

/** The read-only tool subset a research child gets: safe builtins + the operator's EXACT MCP
 * allowlist (`__`-namespaced only, never a builtin, never a forbidden name), each resolved from the
 * parent's live registry. MCP tools are included ONLY when the run has an act-as token (else an MCP
 * read would fall back to the broader daemon credential — codex). Default-deny everything else. */
export function researchTools(
  allowed: Tools,
  operatorAllow: string[],
  hasAuthToken: boolean,
): Tools {
  const allow = new Set<string>(RESEARCH_SAFE_BUILTINS);
  if (hasAuthToken)
    for (const n of operatorAllow) if (n.includes("__") && !FORBIDDEN.has(n)) allow.add(n); // MCP-only, never a builtin
  const out: Tools = new Map();
  for (const [name, def] of allowed)
    if (allow.has(name) && !FORBIDDEN.has(name)) out.set(name, withReadFacade(name, def));
  return out;
}

type Outcome = { task: string; ok: boolean; text: string; usage: Usage };

/** One bounded read-only research loop (in-memory). Never throws — always returns an Outcome
 * carrying whatever usage was spent, so the parent charges every child exactly once. */
async function researchOne(
  task: string,
  tools: Tools,
  chat: (req: ChatRequest) => Promise<ModelResult>,
  childCtx: ToolCtx,
  opts: { maxTokens: number; signal?: AbortSignal },
): Promise<Outcome> {
  const usage = zero();
  const messages: ChatMsg[] = [
    { role: "system", content: RESEARCH_SYSTEM },
    { role: "user", content: task },
  ];
  const specs = toolSpecs(tools);
  let toolCalls = 0;
  try {
    for (let step = 0; step < CHILD_MAX_STEPS; step++) {
      if (opts.signal?.aborted) return { task, ok: false, text: "[research cancelled]", usage };
      const remaining = opts.maxTokens - billed(usage);
      const overBudget = remaining <= 0 || toolCalls >= MAX_TOOLCALLS_TOTAL;
      const res = await chat({
        messages,
        ...(overBudget ? {} : { tools: specs }), // out of budget → force a final answer, no tools
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
              out = `[tool error] '${call.function.name}' is not available to research sub-agents (read-only)`;
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

/** Parent-owned artifact write (the child has no write tools): temp + atomic rename under a
 * realpath-verified in-workspace dir (a `research -> /outside` symlink can't escape), UTF-8
 * byte-bounded. Returns the workspace-relative path the agent can `read_file`. */
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

/** Run 1–3 read-only research tasks in parallel, each in its own bounded context. Writes each
 * child's full findings to a file and returns only a per-task summary + path — the children's
 * transcripts never enter the parent's context. Charges ALL child usage to the parent ONCE. */
export async function runResearch(
  tasks: string[],
  tools: Tools,
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
  if (tools.size === 0)
    return "[tool error] no read-only tools are configured for research (enable web_search, or set DELTA_RESEARCH_TOOLS for MCP reads)";

  // Admission ONCE: reserve a parent synthesis share (÷ N+1); reject if the slice is too small to
  // do useful work rather than launching zero-budget children (codex).
  const rem = ctx.remainingBudget?.() ?? { maxTokens: 200_000, maxCostUsd: 10 };
  const perChildTokens = Math.floor(rem.maxTokens / (picked.length + 1));
  if (perChildTokens < MIN_CHILD_TOKENS)
    return `[tool error] not enough token budget left for research (${rem.maxTokens} remaining) — narrow the task or run fewer`;

  // The child tool context carries NO chat/write tools; the parent's act-as token rides along ONLY
  // for the (already read-only) MCP tools that were allowlisted.
  const childCtx: ToolCtx = {
    workspace: ctx.workspace,
    activate: () => {},
    ...(ctx.authToken ? { authToken: ctx.authToken } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.vision !== undefined ? { vision: ctx.vision } : {}),
  };

  const settled = await Promise.allSettled(
    picked.map((task) =>
      researchOne(task, tools, chat, childCtx, {
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
