// SPDX-License-Identifier: Apache-2.0
// The Run object: a durable, resumable unit of work. Knows nothing about HTTP.
// One run = one seam-level turn: model call → tool phase → … → final text.
// Every message row and journal entry is committed as it happens, so resume
// after kill -9 is: reload active rows, reconcile the journal, continue.
// Budgets (steps/tokens/cost) cap the loop — never wall-clock. Error-as-value
// throughout — a provider/tool failure finalizes a clean turn.

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SkillRegistryAdapter } from "./adapter-defaults";
import type { CapabilityAdapter } from "./adapters";
import { maybeCompact, retainedTailBudget } from "./compaction";
import { listArtifacts, readArtifact, readTodo, searchHistory, writeTodo } from "./db";
import { type Events, emitUtilityCall, type Spine } from "./events";
import { expandImageMarkers } from "./files";
import { hydrate, type RecalledMemory, recallAgentMemory } from "./hydrate";
import type { Policy } from "./policy";
import { renderPolicy } from "./policy";
import { getProfile, grantSelfWrite, SAFE_FLOOR } from "./profiles";
import { renderTemplate, turnVars } from "./promptcontext";
import type {
  AssistantMsg,
  ChatMsg,
  ChatRequest,
  ModelResult,
  ReasoningEffort,
  ToolSpec,
  Usage,
} from "./provider";
import {
  KNOWN_EFFORTS,
  normalizeEffort,
  OVERFLOW,
  outputCapped,
  providerErrorClass,
} from "./provider";
import { childTools, researchRunPrefix, runResearch } from "./research";
import { retrieveSkills } from "./retrieval";
import { redactSecretValues, scrubText } from "./scrub";
import { type Charter, currentSelf, loadSelf, parseCharterMarkdown, writeSelf } from "./self";
import { buildSpine } from "./spine";
import {
  capAndSpill,
  elide,
  elidedArgsRejection,
  spillRunPrefix,
  type ToolCtx,
  type ToolDef,
  type Tools,
  toolSpecs,
} from "./tools";
import type { Vault } from "./vault";
import { NEUTRAL_VOCAB, type Vocab } from "./vocab";

/** Hard cap on resident (pinned) tool schemas. Keeps any profile — even a mis-set all-pinned one —
 *  from booting a token-budget-blowing payload (the 464-tool brick); the overflow rides search_tools.
 *  ~60 tools is comfortably under the 400k per-turn budget. */
const MAX_RESIDENT_TOOLS = 60;

// --- W2 pre-send compaction sizing ---
const IMAGE_TOKEN_RESERVE = 4_000; // conservative per-image allowance (billed as resized image tokens)
const SUMMARY_RESERVE_TOKENS = 4_000; // headroom for the ask-pin + summary compaction inserts

/** Conservative token estimate of the fully-serialized request. Uses UTF-8 bytes of
 * `JSON.stringify({messages, tools})` (assistant tool_calls dwarf `content` and must be counted)
 * ÷3 ×1.2 + per-message/tool protocol overhead + a FIXED reserve per attached image — base64 data
 * URIs bill as resized image tokens, not raw bytes, so counting them as text would estimate
 * millions. Estimate on the TEXT history (pre image-expansion) + this reserve. */
function estimateTokens(messages: ChatMsg[], tools: ToolSpec[], images: number): number {
  const bytes = new TextEncoder().encode(JSON.stringify({ messages, tools })).length;
  return (
    Math.ceil((bytes / 3) * 1.2) +
    messages.length * 12 +
    tools.length * 24 +
    images * IMAGE_TOKEN_RESERVE
  );
}

// --- S1 prefix identity (0.2.13) ---
// The prompt cache keys on IDENTITY, not size: a segment that mutates without changing length
// breaks the cached prefix exactly as hard as one that shrinks, and is invisible to a byte counter.
// Three rounds of a 2026-08 investigation were spent measuring size for that reason.

/** Per-daemon digest salt. These attributes export WITHOUT payload consent, and the spine carries
 * DELTA.md, POLICY.md and operator context — low-entropy enough that an UNSALTED digest is
 * dictionary-testable by anyone holding the telemetry ("not reversible" ≠ "carries no PII", codex).
 * Salting per process preserves the only comparison we need — consecutive turns of one daemon —
 * and destroys cross-daemon correlation. Never exported. */
const DIGEST_SALT = randomBytes(16).toString("hex");

/** 12-hex digest of an engine-assembled prompt segment. Detects CHANGE; it does not authenticate,
 * so `Bun.hash` (wyhash, in-runtime, zero deps) is right and sha256 would be ~20× the cost for a
 * property we don't need. Consecutive-turn comparison means a false match needs a collision between
 * two specific values (~2⁻⁴⁸).
 * NOTE: this digests the ENGINE-ASSEMBLED input, NOT the serialized request body — the provider
 * renames and reshapes both segments downstream (`toAnthropic` lifts system into a content block and
 * renames `parameters`→`input_schema`; the Responses path flattens both). A wire-format change is
 * already reported by `gen_ai.provider` + `fallback` on this same event, so the gap is bounded. */
export const prefixDigest = (s: string): string =>
  Bun.hash(DIGEST_SALT + s)
    .toString(16)
    .padStart(16, "0")
    .slice(0, 12);

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");
const msgBytes = (ms: ChatMsg[]): number => utf8(JSON.stringify(ms));

/** Count image markers eligible for wire expansion. Scoped to the last 2 user turns (the same
 * window expandImageMarkers uses) so stale/echoed markers deeper in history don't over-reserve
 * and trigger needless compaction; capped at the expander's max. It's an estimate — a slightly
 * high count only compacts a touch early, never under-reserves (codex). */
function countImages(history: ChatMsg[]): number {
  let userTurns = 0;
  let n = 0;
  for (let i = history.length - 1; i >= 0 && userTurns < 2; i--) {
    const m = history[i];
    if (m?.role === "user") userTurns++;
    if (typeof m?.content === "string") n += (m.content.match(/\[delta:image /g) ?? []).length;
  }
  return Math.min(n, 4);
}

// The lean resident core (spec §D). Builtins are bare names (web_search, code, …); MCP tools are
// namespaced `<server>__<tool>`. "core" pinning keeps ALL builtins resident + the product's everyday
// verbs (vocab.coreVerbs — the knowledge base by default), and leaves every connector tool discoverable via
// search_tools. Matched by the `__<verb>` suffix so it's robust to the MCP server's exact name.
/** The lean pinned set: builtins + the product's curated core. Everything else stays searchable. */
function corePinned(names: Iterable<string>, coreVerbs: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (!n.includes("__"))
      out.push(n); // builtins are bare; MCP tools are `<server>__<tool>`
    else if (coreVerbs.some((s) => n.endsWith(`__${s}`))) out.push(n); // curated product core
  }
  return out;
}

export type Deps = {
  db: Database;
  events: Events;
  chat: (req: ChatRequest) => Promise<ModelResult>;
  /** Cheap-model lane for auxiliary calls that don't need the frontier model —
   * compaction summaries, reflection, eval_n judging (2–5× cheaper each). Falls
   * back to `chat` on failure; absent → everything rides the main cascade. */
  chatUtility?: (req: ChatRequest) => Promise<ModelResult>;
  tools: Tools;
  workspace: string;
  /** Engine scratch root; defaults to the workspace (see config.scratchDir). */
  scratchDir?: string;
  agentId?: string;
  /** Placement profile ceiling; requests may narrow, never escalate. */
  profile?: string;
  /** Operator-selected neutral recovery branch; bypasses profile/env expansion. */
  safeMode?: boolean;
  /** Grant `remember` self-write to a chat placement (trusted-gateway deployments). */
  allowSelfWrite?: boolean;
  /** Compact older turns once a call's prompt exceeds this many input tokens. */
  compactAtTokens: number;
  /** Registry tools to call at task start for knowledge-base context hydration (§E). */
  hydrateTools?: string[];
  /** Knowledge-base search tool for task-keyed relevance hydration (§E / G3a). */
  hydrateSearchTool?: string;
  /** The Secret Vault (0.2.10) — present only when DELTA_VAULT_KEY is set and this isn't a
   * safe-mode boot. Carried on deps so the server can serve the intake surface and MCP egress
   * can dereference `{{vault:NAME}}`; NOTHING in the run loop reads a value. */
  vault?: Vault;
  /** Boot snapshot of DELTA.md's parsed identity — used by reflection's success rubric.
   * The SPINE reads its own run-local snapshot each run (a self-edit takes effect next run). */
  charter?: Charter;
  /** POLICY.md — the fixed contract, loaded once at boot; part of the cached spine. */
  policy?: Policy;
  /** DELTA.md self-write byte cap — the `remember` capability rejects larger writes. */
  selfMaxBytes?: number;
  /** PROMPT_CONTEXT.md ## Turn template — rendered per turn into a user message (dynamic vars). */
  contextTurn?: string;
  /** PROMPT_CONTEXT.md ## Stable block, already rendered at boot — rides the cached spine. */
  contextStable?: string;
  /** The configured primary model id — exposed to the turn context as {{model}}. */
  primaryModel?: string;
  /** The active model family reads images (Sprint 8). False/unset → image markers
   * stay plain text (their own placeholder) and no bytes ever hit the wire. */
  vision?: boolean;
  /** Fire the post-run reflection/learning loop by default (§H). Per-run
   * metadata.reflect overrides when this is unset. */
  reflect?: boolean;
  /** Product vocabulary for the review loop (portability seam); knowledge-base default. */
  vocab?: Vocab;
  /** Versioned procedure store (portability seam); the skill registry over the allowed tool map by default. */
  capability?: CapabilityAdapter;
  /** Capability backend selector; undefined is the historical MCP default. */
  skills?: "mcp" | "local" | "off";
  /** Number of task-relevant capabilities surfaced ephemerally per run. */
  capabilitySearchK?: number;
  /** Reasoning effort for the main model (extended thinking); per-run metadata overrides. */
  reasoningEffort?: ReasoningEffort;
  memoryNamespace?: string;
  /** Shared multi-agent DB: exclude the anonymous (agent_id='') memory bucket from recall so one
   *  agent can't read another's unbound rows (DELTA_ISOLATE_AGENT_MEMORY, S5b). Default off. */
  isolateAgentMemory?: boolean;
  promoteMinRuns?: number;
  promoteClaimTtlMs?: number;
  /** Per-tool wall-clock ceiling (ms) when a tool sets none; 0/unset = unbounded.
   * A hung tool then returns a clean `[tool error]` turn instead of wedging the run. */
  toolTimeoutMs?: number;
  /** Max chars of a tool result kept inline before it's spilled to a re-readable file.
   * Bounds the single biggest cause of a mid-run context-window overflow. */
  toolResultCap?: number;
  toolArgCap?: number;
  /** Cockpit true-to-life capture (DELTA_CAPTURE_CALLS): snapshot the exact assembled
   * request (system spine + full messages + tool schemas) and response for each model
   * call into the `calls` table, so the dev UI can show precisely what the model saw.
   * DEV-ONLY — off in prod (no storage cost). */
  captureCalls?: boolean;
};

export type RunRequest = {
  input?: string;
  instructions?: string;
  previous_response_id?: string;
  store?: boolean;
  stream?: boolean; // server-only: stream the sync turn over SSE (§A)
  /** Dispatch idempotency for fire-and-forget callers (e.g. an async POST /v1/tasks). When set,
   *  enqueue returns any existing NON-terminal run carrying the same key instead of starting a second
   *  one — so a re-dispatch (a client retry, or a controller re-driving a slow-but-alive task) can't
   *  spawn a duplicate run. Distinct from the OpenAI `store` flag and from previous_response_id. */
  idempotency_key?: string;
  /** Caller opt-in to exactly-once semantics: also dedupe against a TERMINAL run carrying this key,
   *  not only a live one. A fire-and-forget caller whose key is unique per intent (Connect's async
   *  turns) may retry after a lost 202; with this set, the re-POST re-attaches to the accepted run
   *  even once it finished instead of starting a second (codex P1). Owner-scoped like all dedupe, so
   *  it only affects the caller's own key. Default (unset) preserves the free-the-key-at-terminal
   *  contract, so a stable key reused later still runs fresh. Requires a durable run (store !== false). */
  idempotency_terminal?: boolean;
  metadata?: Record<string, unknown>;
};

export type RunRow = {
  id: string;
  session_id: string;
  seq: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  request: string;
  result: string | null;
  error: string | null;
  usage: string | null;
  tools: string | null;
  steps: number;
  last_input: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

export type ExecOptions = { resuming?: boolean; signal?: AbortSignal };

export function rid(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function getRun(db: Database, id: string): RunRow | null {
  return db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null;
}

/** Read a metadata value tolerant of snake_case/camelCase aliases (the two entry
 * paths — chat vs task — populate metadata differently; §K / G2b). */
function metaStr(m: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = m[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function spineOf(run: RunRow, req: RunRequest): Spine {
  const m = req.metadata ?? {};
  const userId = metaStr(m, "user_id", "userId");
  const agentId = metaStr(m, "agent_id", "agentId");
  const taskId = metaStr(m, "task_id", "taskId");
  // Entity flows to BOTH the event spine AND hydration — accept either key so a
  // caller never sets one and silently loses the other from the correlation spine.
  const entityId = metaStr(m, "entity_id", "entityId", "entity");
  return {
    sessionId: run.session_id,
    runId: run.id,
    ...(userId ? { userId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(entityId ? { entityId } : {}),
  };
}

export const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  costUsd: 0,
});

/** Accumulate one call's usage into the run total (in place). */
function addUsage(into: Usage, add: Usage): void {
  into.input += add.input;
  into.output += add.output;
  into.cacheRead += add.cacheRead;
  into.cacheWrite += add.cacheWrite;
  into.total += add.total;
  into.costUsd += add.costUsd;
}

export async function executeRun(
  deps: Deps,
  runId: string,
  opts: ExecOptions = {},
): Promise<RunRow> {
  const { db, events } = deps;
  const run = getRun(db, runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  const req = JSON.parse(run.request) as RunRequest;
  const spine = spineOf(run, req);
  // Reasoning effort applies to the MAIN model only (the utility lane's cheap
  // summarize/pick calls don't need it). A per-run metadata override beats the daemon
  // default; an invalid value falls through to the default rather than erroring.
  const reasoningEffort: ReasoningEffort | undefined =
    normalizeEffort(metaStr(req.metadata ?? {}, "reasoning_effort", "reasoningEffort")) ??
    deps.reasoningEffort;
  // Placement ceiling (untrusted metadata may only narrow it), then the
  // trusted-gateway self-write grant (off by default). See grantSelfWrite.
  const profile = deps.safeMode
    ? structuredClone(SAFE_FLOOR)
    : grantSelfWrite(getProfile(req.metadata?.profile, deps.profile), deps.allowSelfWrite ?? false);
  const vocab = deps.vocab ?? NEUTRAL_VOCAB;
  // Run-local snapshot of the writable self-file (codex #9/#10): DELTA.md is read ONCE
  // here and used for every turn of this run. A self-edit during the run lands on disk
  // but is invisible to THIS run — it takes effect on the next run. Never read from a
  // shared deps field, so concurrent runs can't race on it.
  const selfMaxBytes = deps.selfMaxBytes ?? 3200;
  const self: Awaited<ReturnType<typeof loadSelf>> = deps.safeMode
    ? { charter: {}, bytes: 0, elided: false }
    : await loadSelf(resolve(deps.workspace), Math.max(1, Math.floor(selfMaxBytes / 4)));
  // Self-file pressure guard: an over-cap DELTA.md is silently ELIDED in every prompt (the
  // agent runs with a hole in its own identity) and a nearly-full one refuses every `remember`
  // (no room left to learn). Both were found live in production bundles by the 2026-07-30
  // effort lab — a config that cannot work must be loud, not discovered by forensics. Fires
  // once per run (runs are minutes, not milliseconds).
  if (self.bytes > 0 && (self.elided || self.bytes > selfMaxBytes * 0.9)) {
    console.error(
      `[self] DELTA.md is ${self.bytes}B against the ${selfMaxBytes}B cap` +
        `${self.elided ? " and was ELIDED in the prompt" : ""} — ` +
        `${Math.max(0, selfMaxBytes - self.bytes)}B of learning headroom; ` +
        `raise DELTA_SELF_MAX_TOKENS or slim the seed (keep it ≤ half the cap)`,
    );
    events.emit("self.pressure", spine, {
      bytes: self.bytes,
      cap: selfMaxBytes,
      elided: self.elided,
    });
  }
  let resuming = opts.resuming ?? false;

  // Tool directory (spec §D): the profile allows a subset of the registry and
  // pins some schemas from step one; the rest activate via search_tools and the
  // activation survives restarts (runs.tools).
  const allowedMap: Tools = new Map(
    [...deps.tools].filter(([n]) => profile.allowed === "*" || profile.allowed.includes(n)),
  );
  // Resolve the pinned (resident-schema) set. GUARDRAIL: any profile whose pins exceed
  // MAX_RESIDENT_TOOLS falls back to the lean core, so no tool surface — however large — can blow
  // the per-turn token budget before step 1. The overflow stays discoverable via search_tools.
  let pinnedNames =
    profile.pinned === "*"
      ? [...allowedMap.keys()]
      : profile.pinned === "core"
        ? corePinned(allowedMap.keys(), vocab.coreVerbs)
        : profile.pinned.filter((n) => allowedMap.has(n));
  if (pinnedNames.length > MAX_RESIDENT_TOOLS) {
    console.warn(
      `[delta] ${pinnedNames.length} pinned tools exceeds the resident cap ${MAX_RESIDENT_TOOLS} → core-pinned; the rest are search_tools-discoverable`,
    );
    pinnedNames = corePinned(allowedMap.keys(), vocab.coreVerbs);
  }
  const active = new Set<string>(pinnedNames);
  // Mid-run activations (search_tools results) are intentional — re-add them uncapped.
  for (const n of JSON.parse(run.tools ?? "[]") as string[]) if (allowedMap.has(n)) active.add(n);
  // A4 breaker: a tool that returns the SAME [tool error] N times is categorically dead (missing
  // binary, persistent schema reject) — quarantine it for the run instead of looping the model
  // (bc8e877e burned $3.50 retrying a missing CLI). In-memory per run; a resume re-arms it. See
  // the tally in execCall. `disabled` is subtracted in effectiveTools so it also survives re-search.
  const breaker: Breaker = { disabled: new Set<string>(), fails: new Map(), turn: [] };
  // Mutates memory only; persisted inside execCall's journal transaction so a
  // crash can never leave the active set ahead of the recorded tool result.
  const activate = (names: string[]) => {
    for (const n of names) if (allowedMap.has(n)) active.add(n);
  };
  const persistActive = () =>
    db.query("UPDATE runs SET tools = ? WHERE id = ?").run(JSON.stringify([...active]), run.id);
  // Spread over zeroUsage: a row persisted before cacheWrite existed rehydrates with 0.
  const usage: Usage = run.usage
    ? { ...zeroUsage(), ...(JSON.parse(run.usage) as Partial<Usage>) }
    : zeroUsage();
  const searchTool: ToolDef = {
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
      const hits = [...allowedMap.values()]
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
  const effectiveTools = (): Tools => {
    const map: Tools = new Map();
    for (const n of active) {
      if (breaker.disabled.has(n)) continue; // A4: quarantined — drop from the advertised schema
      const def = allowedMap.get(n);
      if (def) map.set(n, def);
    }
    if (allowedMap.size > active.size) map.set(searchTool.name, searchTool);
    return map;
  };
  let researchSeq = 0; // distinct artifact dirs per `research` call within this run
  let researchInFlight = false; // at most one research batch per turn (bounds N + budget across calls)
  // Turn-failure integrity (0.2.7): a `remember` write commits DELTA.md the instant it succeeds
  // (durable, snapshotted) — even if the turn later hits the budget wall. Track it so finalize can
  // acknowledge the committed side effect instead of returning a bare "failed", which reads as
  // "nothing happened" and violates error-as-value.
  let committedSelfWrite = false;
  const selfWriteNote = (why: string): string =>
    committedSelfWrite
      ? `${why}\n\n[note: a change to your self-file (DELTA.md) was saved during this turn and persists — it was not rolled back.]`
      : why;
  // The run's owning principal (the session's seam-canonicalized user_id), so a tool calling back to
  // the gateway can assert which user it acts for (schedule_self binds to the right conversation).
  const runOwner =
    (
      db.query("SELECT user_id FROM sessions WHERE id = ?").get(run.session_id) as {
        user_id: string | null;
      } | null
    )?.user_id ?? null;
  /** Budget claimed by nested work that is still in flight (see `reserveBudget`). */
  let reservedTokens = 0;
  let reservedCost = 0;
  const remainingBudget = () => ({
    maxTokens: Math.max(
      0,
      profile.budget.maxTokens - (Math.max(0, usage.input - usage.cacheRead) + usage.output),
    ),
    maxCostUsd: Math.max(0, profile.budget.maxCostUsd - usage.costUsd),
  });
  const scratchRoot = resolve(deps.scratchDir ?? deps.workspace);
  const ctx: ToolCtx = {
    workspace: resolve(deps.workspace),
    scratchDir: scratchRoot,
    ...(deps.toolResultCap !== undefined ? { resultCap: deps.toolResultCap } : {}),
    activate,
    owner: runOwner,
    // `recall` reads THIS thread's history, active + compacted-out. Session bound here so a
    // tool can never search another session (W1 + the S0 ownership boundary at the seam).
    history: {
      search: (query, limit) => searchHistory(db, run.session_id, query, limit),
      // The elided-argument manifest + archive (0.2.12), session-bound the same way.
      artifacts: (limit) =>
        listArtifacts(db, run.session_id, limit).map(({ runId: _runId, ...a }) => a),
      read: (ref, offset, maxChars) => readArtifact(db, run.session_id, ref, offset, maxChars),
    },
    // `todo` reads/replaces THIS thread's working plan (W3), session-bound the same way.
    todo: {
      read: () => readTodo(db, run.session_id),
      write: (items) => writeTodo(db, run.session_id, items),
    },
    // `research` (W4): run parallel sub-agents in-process, each with the SAME rights as this run —
    // the parent's provider + full tool registry minus the withheld set (one-level nesting cap) +
    // the run's act-as token. Children are built from the same spine (identity + norms + self +
    // policy) and start resident on the parent's pinned set, searching for the rest. `researchSeq`
    // keeps each call's artifacts on distinct paths; the in-flight guard stops two concurrent
    // `research` calls in one turn from each admitting N children and over-spending the budget (codex).
    research: async (tasks) => {
      if (researchInFlight)
        return "[tool error] a research batch is already running this turn — wait for it to finish";
      researchInFlight = true;
      try {
        // Carry the parent's spine layers so children are built from the SAME buildSpine — same
        // identity, engine safety norms, self, and policy (codex): a child with write/act-as tools
        // is bound by the same norms + POLICY as the parent.
        const wtn = [...allowedMap.keys()].find((n) => n.endsWith(vocab.writeVerbSuffix));
        const childPolicy =
          deps.policy && (deps.policy.fromFile || wtn)
            ? renderPolicy(deps.policy.template, vocab, wtn ?? "your review-rail write tool")
            : undefined;
        return await runResearch(
          tasks,
          {
            tools: childTools(allowedMap),
            pinned: pinnedNames,
            ...(deps.agentId ? { agentId: deps.agentId } : {}),
            ...(self.text ? { self: self.text } : {}),
            ...(childPolicy ? { policy: childPolicy } : {}),
            ...(deps.contextStable ? { context: deps.contextStable } : {}),
          },
          deps.chatUtility ?? deps.chat,
          ctx,
          run.id,
          String(researchSeq++),
        );
      } finally {
        researchInFlight = false;
      }
    },
    chat: deps.chat,
    ...(deps.chatUtility ? { chatUtility: deps.chatUtility } : {}),
    // S3: the reporting seam for utility-lane calls made inside tools (research fan-out, eval_n
    // judging). A closure rather than `events`+`spine` on ToolCtx — both are already captured here,
    // and this keeps the surface one optional field wide. Observational only: it never charges.
    onUtilityCall: (purpose, r) =>
      emitUtilityCall(events, { ...spine, turn: stepCount }, purpose, r, stepCount + 1),
    ...(typeof req.metadata?.authToken === "string" ? { authToken: req.metadata.authToken } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    vision: deps.vision === true, // explicit false → MCP image markers say "can't view"
    chargeUsage: (childUsage) => {
      addUsage(usage, childUsage);
      db.query("UPDATE runs SET usage = ? WHERE id = ?").run(JSON.stringify(usage), run.id);
    },
    remainingBudget,
    // A live reservation, so N concurrent children cannot each spend the whole remainder. Held
    // across the child's lifetime and released in a `finally`, so a crash or timeout cannot leak
    // it. Per-RUN state on purpose: the tool registry is built once per process, so a closure
    // there would let one run's children shrink another's budget.
    reserveBudget: (share) => {
      const left = remainingBudget();
      const maxTokens = Math.max(0, Math.floor((left.maxTokens - reservedTokens) * share));
      const maxCostUsd = Math.max(0, (left.maxCostUsd - reservedCost) * share);
      reservedTokens += maxTokens;
      reservedCost += maxCostUsd;
      let released = false;
      return {
        maxTokens,
        maxCostUsd,
        release: () => {
          if (released) return; // idempotent — a double release would inflate the pool
          released = true;
          reservedTokens -= maxTokens;
          reservedCost -= maxCostUsd;
        },
      };
    },
    // The `remember` tool's hands: atomically replace DELTA.md (snapshotted + size-checked).
    // Gated on the profile explicitly (codex #10 — defense in depth, not just tool-map
    // filtering): a `chat` (untrusted-inbound) placement gets no self-write capability at all.
    // On success, refresh the boot charter so THIS run's reflection rubric sees the new
    // identity (codex #5) — the spine already uses the run-local snapshot.
    ...(profile.allowed === "*" || profile.allowed.includes("remember")
      ? {
          // Optimistic-concurrency base: the raw DELTA.md this run last observed. Starts at the
          // hydration read; advances to the just-written content on success, or to the current
          // on-disk content on a conflict — so a merge-and-retry within the run lines up.
          writeSelf: (() => {
            let selfBase = currentSelf(resolve(deps.workspace));
            return (content: string) => {
              const r = writeSelf(db, resolve(deps.workspace), content, selfMaxBytes, selfBase);
              if (r.ok) {
                deps.charter = parseCharterMarkdown(content);
                selfBase = content;
                committedSelfWrite = true; // durable side effect — finalize must acknowledge it
              } else if (r.conflict && typeof r.current === "string") {
                selfBase = r.current; // the model will merge from this and retry
              }
              return r;
            };
          })(),
        }
      : {}),
  };
  const retrievalBlock =
    deps.skills !== "off" && typeof req.input === "string" && req.input.trim()
      ? await Promise.race([
          retrieveSkills(deps.capability ?? new SkillRegistryAdapter(allowedMap), req.input, ctx, {
            k: deps.capabilitySearchK ?? 5,
            events,
            spine,
          }),
          Bun.sleep(20_000).then(() => null),
        ])
      : null;

  // On a fresh run (resume-safe: guarded by "no rows for this run yet"):
  if (!db.query("SELECT 1 FROM messages WHERE run_id = ? LIMIT 1").get(run.id)) {
    // Hydrate task-start context from the knowledge base ONCE per session (spec §E) — the
    // first run of a conversation, before its ask; not re-fetched every turn.
    // ONLY when the run carries a subject to scope to (entity/person) — otherwise a
    // shared daemon could inject one user's knowledge-base context into another's prompt.
    const m = req.metadata ?? {};
    // Subject extraction is vocab-driven (Sprint 6): each subjectKey K is probed
    // as K, K_id, and KId — the same alias tolerance as the event spine (G2b),
    // generalized past the knowledge base's entity/person. Aliases derive from BOTH casings
    // so a multi-word key (candidate_profile / candidateProfile) probes all four
    // spellings (codex 6+7 #9).
    const subject: Record<string, string> = {};
    for (const k of vocab.subjectKeys) {
      const snake = k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      const camel = snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      const val = metaStr(m, ...new Set([k, `${snake}_id`, `${camel}Id`]));
      if (val) subject[k] = val;
    }
    const sessionEmpty = !db
      .query("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1")
      .get(run.session_id);
    let block: string | null = null;
    const recalled: RecalledMemory[] = [];
    if (sessionEmpty && !deps.safeMode) {
      // Subject-scoped recency reads still require a subject (no cross-user bleed).
      // The task-keyed search runs ONLY under a per-run act-as token — with or
      // without a subject: the knowledge base's search_text ignores subject args entirely,
      // so on a shared daemon a token-less search would evaluate ACLs as the
      // DAEMON principal and could surface another user's hits (codex 6+7 #2).
      // No token → no search, exactly the pre-Sprint-5 behavior.
      const hasSubject = Object.keys(subject).length > 0;
      const searchOk = Boolean(deps.hydrateSearchTool && ctx.authToken);
      const kbBlock =
        deps.hydrateTools?.length || searchOk
          ? // Hydration is internal machinery (it calls knowledge-base read-tools directly to build the
            // task-start context), not model-facing — so it reads from the full allowed set, never
            // the lean pinned set. Otherwise core-pinning would starve it of its knowledge-base read-tools.
            // Raced against a ceiling: hydrate calls tools directly (no execCall timeout),
            // and a hung MCP read must not block the first model call forever.
            await Promise.race([
              hydrate(allowedMap, ctx, {
                toolNames: hasSubject ? (deps.hydrateTools ?? []) : [],
                ...(hasSubject ? { subject } : {}),
                ...(typeof req.input === "string" && req.input ? { query: req.input } : {}),
                ...(searchOk ? { searchTool: deps.hydrateSearchTool } : {}),
              }),
              Bun.sleep(20_000).then(() => null),
            ])
          : null;
      // Local recall is scoped to this agent's user-less learnings + the current
      // user's own (never another user's) — see recallAgentMemory (codex P1).
      // The ask keys relevance: recall surfaces what MATCHES, not just what's new.
      // Resolve the user the SAME way reflection does when it WRITES user rows —
      // metadata OR the session's bound user_id — else a session-scoped user whose id
      // isn't repeated in this request's metadata would never recall their own memories
      // (write-scope and read-scope must match; codex audit P1).
      const sessionUid = (
        db.query("SELECT user_id FROM sessions WHERE id = ?").get(run.session_id) as {
          user_id: string | null;
        } | null
      )?.user_id;
      const uid = metaStr(m, "user_id", "userId") ?? sessionUid ?? undefined;
      // Phase 4 middle tier: a caller-declared canonical use-case key surfaces the
      // shared task_type learnings for this run (never invented — recall only reaches
      // what reflection could route, keyed on the same metadata field).
      const taskType = metaStr(m, "task_type", "taskType");
      const localBlock = recallAgentMemory(
        db,
        deps.agentId,
        uid,
        typeof req.input === "string" ? req.input : undefined,
        undefined,
        // Read the SAME namespace reflection writes (memoryNamespace, vocab-derived
        // a product namespace) — else recall reads "default" and never finds the
        // agent's own writes (the whole local rail read-back is dead in production).
        deps.memoryNamespace,
        taskType,
        recalled, // provenance sink — which learnings were surfaced
        // Exclude the anonymous agent bucket on a shared multi-agent DB so this agent can't
        // recall another's unbound rows (S5b). Default keeps the '' bucket (single-agent DB).
        !deps.isolateAgentMemory,
      );
      block = [kbBlock, localBlock].filter(Boolean).join("\n\n") || null;
    }
    // Both rows commit atomically — a crash can't land the hydration block without
    // the user's ask (which would make resume skip the fresh-run block and lose it).
    db.transaction(() => {
      if (block) insertMessage(db, run, { role: "user", content: block });
      insertMessage(db, run, { role: "user", content: req.input ?? "" });
    })();
    if (block) events.emit("hydrate", spine, { tools: deps.hydrateTools, chars: block.length });
    // Recall provenance (spec §5): surface WHICH local learnings were recalled, so the
    // Cockpit can show the memories that primed this run. The event is PERSISTED and
    // exported to telemetry, so scrub the content for credential shapes before it lands
    // — a secret stored in a learning must not leak through the event pipeline (codex P1).
    if (recalled.length)
      events.emit("recall", spine, {
        count: recalled.length,
        items: recalled.map((r) => ({
          kind: r.kind,
          audience: r.audience,
          content: scrubText(r.content.slice(0, 160)),
        })),
      });
  }

  // Tracks the model that ACTUALLY served — updated from result.model after each successful
  // call. Seeded with the configured primary so turn 1 has an honest value before the first
  // call resolves; the {{model}} context var then reflects the real (post-fallback) model
  // from turn 2 on. Also carried into finalize telemetry.
  let model = deps.primaryModel ?? "";
  // Persistent across compaction (which deactivates rows) AND restarts, so the
  // maxSteps guard can't reset and the compaction trigger survives resume.
  let stepCount = run.steps;
  let budgetWarned = false; // one-shot: the ~85% wrap-up nudge is shown once, not every step
  let lastInputTokens = run.last_input;
  // Byte-estimate of the request the last model call actually sent — paired with lastInputTokens
  // (the provider's REAL gross input for it) to project the next call's size (W2/S7). In-memory
  // only: 0 means "no anchor from this process yet" (fresh run OR resume), which degrades the
  // pre-send gate to its prior behavior. Reset to 0 whenever lastInputTokens is (post-compaction).
  let lastEstimate = 0;
  // One context-overflow rescue per turn: reset after each successful call, so a recoverable
  // "prompt too long" triggers a forced compaction + retry instead of a terminal failure.
  let overflowRetried = false;

  for (;;) {
    if (opts.signal?.aborted)
      return finalize(deps, run, spine, "cancelled", { user: "cancelled" }, model, usage);

    const tools = effectiveTools();
    const last = lastRunMessage(db, run.id);
    // S9: reconcile off the last row when it IS the assistant (today's path, byte-identical), and
    // ONLY when it is a tool result fall back to the batch's own caller. A turn's calls run under
    // Promise.all, so a crash mid-batch can commit call A's result and leave call B unexecuted —
    // after which the last row is A's tool message, `pending` was never computed, and the next
    // request carried an unanswered tool_use the provider rejects. Reaching back unconditionally
    // would be wrong: on an ordinary run that finished a batch and then answered, it would select
    // the OLDER tool-calling assistant and never finalize.
    const assistant =
      last?.role === "assistant"
        ? (last as AssistantMsg)
        : last?.role === "tool"
          ? batchCaller(db, run.id)
          : null;

    if (assistant?.tool_calls?.length) {
      const pending = pendingCalls(db, run, assistant);
      if (pending.length > 0) {
        await Promise.all(
          pending.map((call) =>
            execCall(
              deps,
              tools,
              ctx,
              run,
              { ...spine, turn: stepCount },
              call,
              resuming,
              persistActive,
              breaker,
            ),
          ),
        );
        // A4: decide quarantine once the whole batch has settled. `allowedMap` sizes the schema a
        // latch withdraws, which is what makes the cache cost of a quarantine visible (S4).
        aggregateBreaker(db, run, breaker, events, { ...spine, turn: stepCount }, allowedMap);
        resuming = false;
        continue;
      }
      // all tool results in — fall through to the next model call
    } else if (assistant) {
      return finalize(deps, run, spine, "done", { user: assistant.content ?? "" }, model, usage);
    }

    // Budget guard — the only thing that bounds the loop (spec §B: no wall-clock).
    // Uses the persistent step count so compaction can never reset it.
    const b = profile.budget;
    // Count FRESH tokens, not gross: `usage.input` (prompt_tokens) includes cache-reads, and every
    // step re-sends the growing context, so a gross count charges the same cached context over and
    // over — strangling legit multi-step runs even though cache-reads are ~free ($ + latency). Bill
    // only the non-cached prompt + output, matching what actually costs.
    const billed = Math.max(0, usage.input - usage.cacheRead) + usage.output;
    if (stepCount >= b.maxSteps || billed >= b.maxTokens || usage.costUsd >= b.maxCostUsd) {
      const why = `budget exhausted: ${stepCount}/${b.maxSteps} steps, ${billed}/${b.maxTokens} tokens, $${usage.costUsd.toFixed(4)}/$${b.maxCostUsd}`;
      events.emit("error", spine, { "error.type": "budget", message: why });
      return finalize(
        deps,
        run,
        spine,
        "failed",
        { user: exhaustionHandoff(deps, run, committedSelfWrite), diagnostic: selfWriteNote(why) },
        model,
        usage,
      );
    }

    // Build the turn's STABLE parts once — the spine, the ephemeral blocks, and the tool
    // schemas don't change when compaction runs; only `history` does.
    // POLICY.md renders when the operator supplied it (always) or a write rail is present
    // (the embedded default's review-rail prose only makes sense with one). The write-tool
    // name resolves from the full allowed registry (codex #19), not just the pinned subset,
    // so the fixed contract never omits its write-rail rule before a tool activates.
    const writeToolName = [...allowedMap.keys()].find((n) => n.endsWith(vocab.writeVerbSuffix));
    const policyText =
      !deps.safeMode && deps.policy && (deps.policy.fromFile || writeToolName)
        ? renderPolicy(deps.policy.template, vocab, writeToolName ?? "your review-rail write tool")
        : undefined;
    const system = buildSpine({
      ...(deps.agentId ? { agentId: deps.agentId } : {}),
      pinned: [...tools.values()].filter((t) => t.name !== searchTool.name),
      searchable: allowedMap.size - active.size,
      ...(!deps.safeMode && deps.contextStable ? { context: deps.contextStable } : {}),
      ...(self.text ? { self: self.text } : {}),
      ...(policyText ? { policy: policyText } : {}),
      ...(deps.safeMode ? { safeMode: true } : {}),
    });
    // Ephemeral user-role blocks, appended after history and re-built each turn (never
    // persisted): the dynamic per-turn context, the caller's task instructions, and the
    // retrieval block. They ride USER messages — NOT the cached system spine — so volatile
    // values never bust the prefix (context) and per-turn instructions specialize the task
    // rather than override the Policy (codex #13).
    const ephemeral: ChatMsg[] = [];
    if (!deps.safeMode && deps.contextTurn) {
      // Cap the rendered block (codex #12): even with per-value + key-count caps on the
      // caller's request.* metadata, bound the whole thing so a big template can't bloat
      // the per-turn prompt. Elide keeps head + tail.
      const rendered = elide(
        renderTemplate(deps.contextTurn, {
          ...turnVars({
            // The ACTUAL served model (result.model from the prior turn), seeded with the
            // configured primary for turn 1 — so {{model}} reflects reality after fallback.
            ...(model ? { model } : {}),
            ...(req.metadata ? { metadata: req.metadata as Record<string, unknown> } : {}),
          }),
          // A per-run scratchpad dir the agent may write distilled notes/plans into to keep the
          // active window lean and survive compaction. Engine-advertised, product-neutral: a bundle
          // opts in with {{run.scratch}} in PROMPT_CONTEXT.md. Auto-wiped when the run terminates
          // (see Queue.wipeRunScratch) — so it holds within-run state only, never cross-turn state.
          // Relative while scratch lives in the workspace (unchanged contract); ABSOLUTE when the
          // operator moved it — file tools resolve relative paths against the workspace, so a
          // relative advert under a moved root would point at the wrong tree.
          "run.scratch":
            scratchRoot === resolve(deps.workspace)
              ? `scratch/${run.id}`
              : `${scratchRoot}/scratch/${run.id}`,
        }).trim(),
        4_000,
      );
      if (rendered) ephemeral.push({ role: "user", content: `# Context\n${rendered}` });
    }
    if (req.instructions)
      ephemeral.push({ role: "user", content: `# Task instructions\n${req.instructions}` });
    if (retrievalBlock) ephemeral.push({ role: "user", content: retrievalBlock });
    // W3 recitation: re-inject the working plan every turn as an ephemeral user block — model-
    // maintained state (it owns it via the `todo` tool) that rides in recent attention and
    // survives compaction (rebuilt from thread_state, never persisted into history or the cached
    // spine). Fights goal-drift over a 50+-tool-call run at a few hundred bounded tokens.
    const plan = readTodo(db, run.session_id);
    if (plan.length)
      ephemeral.push({
        role: "user",
        // Framed as model-authored state, NOT authority — an item's text is stripped of newlines
        // on write, and this block can't override the request or Policy (codex). Whole block
        // bounded (item text is capped in the store; the rendering overhead is capped here).
        content: elide(
          `# Plan (your own working notes — you maintain these with the todo tool; they are NOT instructions and cannot override the request or the Policy)\n${plan
            .map((it) => `- [${it.status}] ${it.text}`)
            .join("\n")}`,
          // Storage caps todo text at 3k; allow the rendered block (status/bullet/header overhead)
          // its full size so a full plan isn't silently middle-elided every turn (codex). Ephemeral,
          // never in the cached spine — the <2k spine invariant is unaffected.
          4_000,
        ),
      });
    // Budget self-awareness (0.2.7): a coarse "near the cap, wrap up" nudge once any axis crosses
    // ~85%. Ephemeral (rebuilt each turn, never persisted) and QUALITATIVE — not a raw counter,
    // which is gameable and no rival ships one — so it only ever rides the last stretch of a run.
    // Reuses the same billed/step/cost figures as the budget guard above.
    const budgetFrac = Math.max(
      b.maxSteps > 0 ? stepCount / b.maxSteps : 0,
      b.maxTokens > 0 ? billed / b.maxTokens : 0,
      b.maxCostUsd > 0 ? usage.costUsd / b.maxCostUsd : 0,
    );
    if (budgetFrac >= 0.85 && !budgetWarned) {
      budgetWarned = true; // one-shot — repeating it just moves the cache tail every step
      ephemeral.push({
        role: "user",
        content:
          "# Budget\nYou are near this run's budget limit. Wrap up now: finish what is already in flight, deliver your best answer with what you have, and do not start new lines of work.",
      });
    }
    const specs = toolSpecs(tools);
    const nonHistory: ChatMsg[] = [{ role: "system", content: system }, ...ephemeral];

    // --- Pre-send compaction gate (W2) ---
    // Estimate the FULLY-assembled request; if it won't fit the context budget, compact BEFORE
    // sending — not one call late — so a resumed/continued session's first call can't overflow.
    // Gross-input semantics: cached tokens still occupy the model's window.
    let history = activeSessionMessages(db, run.session_id);
    const imgs = () => (deps.vision ? countImages(history) : 0);
    const estimate = () => estimateTokens([...nonHistory, ...history], specs, imgs());
    // Compact BEFORE sending when the projected next-call input crosses the budget. Two signals,
    // maxed: (1) the full serialized byte-estimate (already conservative — it tends to OVER-count
    // — and the only signal that sees tool-schema growth); and (2) a PROVIDER-ANCHORED projection:
    // the last call's REAL gross input (lastInputTokens) plus a byte-estimate of only what's been
    // appended since it (byteEstimate - lastEstimate). The anchor corrects the byte rule's per-token
    // bias on the bulk the provider already measured, so we catch "the prior call sat just under
    // budget and this turn's tool results pushed it over" a call earlier, instead of leaning on the
    // post-provider overflow retry (codex). We project only with a real anchor from THIS process
    // (lastEstimate>0); on resume this degrades to the prior max(byte-estimate, persisted lastInput)
    // with no risk of over-compacting, and the clamp keeps a post-compaction shrink from going
    // negative.
    const byteEstimate = estimate();
    const projected = Math.max(
      byteEstimate,
      lastInputTokens + (lastEstimate > 0 ? Math.max(0, byteEstimate - lastEstimate) : 0),
    );
    if (projected > deps.compactAtTokens) {
      // Dynamic recent-tail budget: the space actually LEFT for history after the fixed parts
      // (spine + tools + ephemeral) and the ask-pin + summary the compaction will insert. Clamp to
      // 0 (never a floor above the real remainder) — a fixed floor could exceed the budget when
      // the fixed parts are large; budget 0 keeps only the minimal tail (codex).
      const fixed = estimateTokens(nonHistory, specs, imgs());
      // S5: the ceiling-derived remainder is a CAP, not the target. Deriving the retained tail FROM
      // the trigger meant a 200k ceiling kept a ~180k tail: compaction landed at ~99% of budget and
      // the next turn's tool results pushed it straight back over, so one event became a per-turn
      // tax and `spec-compaction-tail` measured 94 failures out of 94. pi and openclaw both keep a
      // FLAT target (`keepRecentTokens`, 20k / operator int) fully decoupled from the trigger, and
      // we already had the right constant — the call site was overriding it.
      // `Math.max(0, …)` still wins when the fixed parts are large, so a tight ceiling behaves
      // exactly as before. It does NOT guarantee the request fits: compaction always keeps two
      // protocol units and demotion only shrinks spilled results, so an irreducible tail still
      // reaches `context_irreducible` below and the overflow retry remains the backstop (codex).
      const recentBudget = retainedTailBudget(deps.compactAtTokens, fixed, SUMMARY_RESERVE_TOKENS);
      const cu = await maybeCompact(
        db,
        events,
        deps.chatUtility ?? deps.chat, // summaries don't need the frontier model
        run.session_id,
        { ...spine, turn: stepCount },
        {
          recentBudgetTokens: recentBudget,
          workspace: deps.workspace,
          scratchDir: scratchRoot,
          argCap: deps.toolArgCap ?? 0,
          anchorRunId: run.id, // S5: reset the stale anchor INSIDE the rewrite transaction
        },
      );
      if (cu) {
        addUsage(usage, cu.usage); // charge the summary call regardless of whether it shrank
        // The summary is a real model call — re-run the budget guard before the main call, or a
        // summary could exhaust the budget and we'd still spend on the frontier model (codex).
        const billed2 = Math.max(0, usage.input - usage.cacheRead) + usage.output;
        if (stepCount >= b.maxSteps || billed2 >= b.maxTokens || usage.costUsd >= b.maxCostUsd) {
          const why = `budget exhausted (post-compaction): ${stepCount}/${b.maxSteps} steps, ${billed2}/${b.maxTokens} tokens, $${usage.costUsd.toFixed(4)}/$${b.maxCostUsd}`;
          events.emit("error", spine, { "error.type": "budget", message: why });
          return finalize(
            deps,
            run,
            spine,
            "failed",
            {
              user: exhaustionHandoff(deps, run, committedSelfWrite),
              diagnostic: selfWriteNote(why),
            },
            model,
            usage,
          );
        }
        if (cu.shrank) {
          history = activeSessionMessages(db, run.session_id); // re-fetch the shrunken history
          lastInputTokens = 0; // the gross backstop measured the pre-compaction prompt; reset it
          lastEstimate = 0; // and its paired byte-anchor — the next call re-establishes both
          // `last_input` is already 0 on disk: maybeCompact cleared it INSIDE the rewrite
          // transaction (S5), so a crash between the two can no longer resume with a compacted
          // history and a pre-compaction anchor. Usage stays here — it is monotonic, so a replayed
          // update is harmless, which is exactly what the anchor was not.
          db.query("UPDATE runs SET usage = ? WHERE id = ?").run(JSON.stringify(usage), run.id);
          // If it STILL won't fit, compaction can't help (fixed parts too big / irreducible tail).
          // Warn and proceed — the post-provider overflow path is the final backstop.
          if (estimate() > deps.compactAtTokens)
            events.emit("error", spine, {
              "error.type": "context_irreducible",
              message: "assembled request still exceeds the context budget after compaction",
            });
        } else {
          db.query("UPDATE runs SET usage = ? WHERE id = ?").run(JSON.stringify(usage), run.id);
        }
      }
    }

    // Attach RECENT image markers as real wire blocks (Sprint 8) — ephemeral + derived, never
    // persisted; done on the FINAL (post-compaction) history, once. Markers past the window stay
    // text: that's the prune (an image re-billed every turn is where the token money goes).
    const withImages = deps.vision
      ? await expandImageMarkers([...history], resolve(deps.workspace))
      : history;
    const messages: ChatMsg[] = [{ role: "system", content: system }, ...withImages, ...ephemeral];
    // S1: prefix identity, measured on the EXACT values about to be sent. Only the two segments
    // ahead of history get a digest — they are the only ones that can mutate at constant length.
    // History is append-only except for two writers that now announce themselves (compaction's own
    // event, and the breaker latch's in-place row rewrite at ~:1381), and ephemeral rides behind the
    // breakpoints. Both are sized, not digested: digesting history would cost a full ~1MB
    // serialization every turn to answer a question two events already answer.
    // Sized on the PRE-expansion history, matching estimateTokens — expanded base64 would swamp the
    // number with a separately-tracked axis.
    const prefix = {
      spine_bytes: utf8(system),
      spine_hash: prefixDigest(system),
      tools_bytes: utf8(JSON.stringify(specs)),
      tools_hash: prefixDigest(JSON.stringify(specs)),
      // Disambiguators. `buildSpine` embeds the pinned tool index AND the `searchable` count
      // (spine.ts:34-36), so an activation moves spine_hash and tools_hash TOGETHER; without
      // `tools_n` a reader would blame the spine for every activation:
      //   tools_n changed             → activation or breaker withdrawal (S4 says which)
      //   tools_n same, spine moved   → the self-file, stable context, or policy
      // `self_bytes` narrows that second row ACROSS runs but not within one: `self` is a per-run
      // snapshot (run.ts ~:332 — a mid-run `remember` lands on disk and takes effect next run), so
      // it is constant for every turn of a run by construction. A same-size self edit between runs
      // therefore still reads as context/policy drift. Stated rather than papered over: the spec's
      // table claimed within-run resolution it does not have (codex).
      tools_n: specs.length,
      self_bytes: self.bytes,
      history_bytes: msgBytes(history),
      ephemeral_bytes: msgBytes(ephemeral),
    };
    const turn = stepCount + 1;
    events.emit("turn.start", { ...spine, turn }, { step: turn });
    const callT0 = Date.now();
    let retries = 0;
    const result = await deps.chat({
      messages,
      // The SAME array the digest above measured — recomputing `toolSpecs(tools)` here would let the
      // digest and the wire drift apart, which is the one failure this instrument cannot survive.
      tools: specs,
      cacheKey: run.session_id, // cache affinity: rolling breakpoints / prompt_cache_key
      // The trailing DERIVED blocks, so the rolling cache breakpoints can skip them and land
      // on persisted transcript instead. They are rebuilt every turn (`# Context` carries a
      // clock), so a prefix ending in one can never match the next request.
      ephemeralCount: ephemeral.length,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      // Stream text deltas as ephemeral events (SSE consumers see them live;
      // not persisted). Cheap no-op when nobody is listening.
      onDelta: (text) => events.stream("output_text.delta", { ...spine, turn }, { delta: text }),
      // Extended-thinking deltas, same ephemeral channel. Observational: never persisted,
      // never affects the model call. Cheap no-op when nobody is listening.
      onReasoningDelta: (text) =>
        events.stream("reasoning.delta", { ...spine, turn }, { delta: text }),
      // PERSISTED (unlike the deltas): a host polling /v1/tasks/:id/events must be able
      // to say "provider is retrying" instead of shimmering through a silent stall —
      // the 2026-07-29 field data showed ~300s of turn-1 dead air with zero events.
      // Telemetry hygiene (codex): a stable error CLASS + a short sanitized message,
      // never 300 chars of provider-controlled text as an exported attribute.
      onRetry: (info) => {
        retries++;
        const errorClass = providerErrorClass(info.status, info.error);
        events.emit(
          "model.retry",
          { ...spine, turn },
          {
            kind: info.kind,
            "gen_ai.request.model": info.model,
            ...(info.provider ? { "gen_ai.provider": info.provider } : {}),
            attempt: info.attempt,
            ...(info.status !== undefined ? { status: info.status } : {}),
            "error.type": errorClass,
            "error.class": errorClass,
            message: info.error.replace(/\s+/g, " ").slice(0, 160),
            next_delay_ms: info.nextDelayMs,
          },
        );
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (!result.ok) {
      if (result.aborted)
        return finalize(deps, run, spine, "cancelled", { user: "cancelled" }, model, usage);
      // Context overflow is recoverable, not fatal: a big tool result or a long history blew the
      // window. Force a compaction and retry the SAME turn ONCE rather than terminal-failing an
      // hours-long task. Only retry if compaction actually shed tokens (else we'd re-overflow).
      if (OVERFLOW.test(result.error) && !overflowRetried) {
        overflowRetried = true;
        // The pre-send estimate was optimistic — shed AGGRESSIVELY (budget 0 → keep only the
        // minimal tail) and retry once. If maybeCompact returns null (nothing left to shed),
        // fall through and fail honestly rather than re-overflow. No DB mutation: archive intact.
        const cu = await maybeCompact(
          db,
          events,
          deps.chatUtility ?? deps.chat,
          run.session_id,
          { ...spine, turn: stepCount },
          // force: the provider already refused this prompt, so accept ANY shrink rather than
          // holding out for a material one and failing the turn instead.
          {
            recentBudgetTokens: 0,
            force: true,
            workspace: deps.workspace,
            scratchDir: scratchRoot,
            argCap: deps.toolArgCap ?? 0,
            // S5: the overflow-recovery path needs the atomic anchor reset just as much as the
            // proactive one — arguably more, since it runs on a turn that already failed. Omitting
            // it here left the crash gap open on exactly this path (codex P1).
            anchorRunId: run.id,
          },
        );
        if (cu) {
          addUsage(usage, cu.usage); // charge the summary call whether or not it shed
          db.query("UPDATE runs SET usage = ? WHERE id = ?").run(JSON.stringify(usage), run.id);
          // Only retry if it ACTUALLY shrank — a summary that grew the context would re-overflow
          // worse (codex). If it didn't shrink, fall through and fail honestly.
          if (cu.shrank) {
            lastInputTokens = 0;
            lastEstimate = 0;
            // Already 0 on disk — cleared inside the rewrite transaction (S5).
            events.emit(
              "error",
              { ...spine, turn },
              { "error.type": "overflow_recovered", message: result.error },
            );
            continue; // retry with the smaller prompt
          }
        }
      }
      events.emit(
        "error",
        { ...spine, turn },
        {
          "error.type": "model",
          "error.class": providerErrorClass(result.status, result.error),
          message: result.error,
        },
      );
      return finalize(deps, run, spine, "failed", { user: result.error }, result.model, usage);
    }

    model = result.model;
    // S10 (Aperture canary, 2026-08-08): the HONEST cache health metric, captured BEFORE
    // `lastInputTokens` is overwritten below.
    //
    // `cache_hit_pct` is a ratio whose DENOMINATOR moves: appending a big tool result grows this
    // turn's input, so the same perfectly-cached prefix reads as a lower percentage. Aperture's
    // canary measured 65-100% swings on 42 turns whose prefix was byte-identical throughout —
    // and part of the "cache decay" they originally escalated to us was that artifact.
    //
    // A healthy turn re-reads the ENTIRE previous request from cache, so `cacheRead` should equal
    // the previous turn's gross input. The gap is the only number that means anything: the three
    // genuine misses stood out at 466, 4,993 and 7,172 against a floor of 45. Absolute, not a
    // ratio, so nothing about how much history was appended can move it.
    //
    // THE FLOOR IS `ephemeral_bytes`, and it is structural, not waste. The ephemeral blocks sit
    // LAST in `messages` and are rebuilt every turn, so the reusable prefix can never extend past
    // where the previous turn's ephemerals began: their size is re-read forever. Aperture traced
    // their 45 to a 123-byte `# Context` block carrying a `now:` clock. Removing the clock would
    // take the floor to zero and save ~45 tokens a turn (0.05% of their run), which is not worth
    // an agent that cannot tell the time. On a lane that also mounts retrieval or plan blocks the
    // floor is proportionally larger — which is the operator lesson `ephemeral_bytes` exists to
    // surface: every byte of ephemeral is paid on every single turn.
    //
    // Per-RUN by construction: `lastInputTokens` is this run's own anchor, so the first call of a
    // run has nothing to compare against and emits nothing rather than a misleading zero. That is
    // the right scope for the long autonomous tasks this measures (Aperture's engagements run 19-23
    // model calls inside one run); a chat-shaped session of many one-call runs will see it only
    // when a run makes more than one call.
    //
    // Bounded by THIS turn's gross input as well as the previous turn's. A request cannot re-read
    // more than it contains, so when the current turn is SMALLER than its predecessor — which is
    // precisely what compaction produces — the unbounded form reports a large shortfall for a turn
    // that cached perfectly. Floored at 0 for the same reason. Pi's harness derived the identical
    // `min(prev, current) - cacheRead` independently, which is the strongest evidence available
    // that the shape is right (`docs/research/competitor-cache-instrumentation-2026-08-10.md`).
    const shortfall =
      lastInputTokens > 0
        ? Math.max(0, Math.min(lastInputTokens, result.usage.input) - result.usage.cacheRead)
        : undefined;
    lastInputTokens = result.usage.input;
    // Pair the real gross input with a byte-estimate of the SAME (final, post-compaction) request,
    // so next turn can project growth off a provider-measured anchor (S7). `history` is unchanged
    // between the send above and here (tool results are appended later in the loop).
    lastEstimate = estimate();
    stepCount++;
    overflowRetried = false; // fresh overflow budget for the next turn
    addUsage(usage, result.usage);
    // Per-turn cache-hit% = share of input tokens served from the prompt cache (the stable-prefix
    // win). Computed once, emitted on model.call so a host polling /v1/tasks/:id/events sees live
    // cache warmth per turn (A1) instead of deriving it, AND logged below for local tuning.
    const cacheHit = result.usage.input
      ? Math.round((result.usage.cacheRead / result.usage.input) * 100)
      : 0;
    // Served ≠ configured primary means the failover cascade won — a purity break the
    // operator must see without diffing model names per call (the 2026-07-30 effort lab
    // found 27% of an arm's turns silently served by the fallback model).
    const fellBack = Boolean(deps.primaryModel && result.model !== deps.primaryModel);
    events.emit(
      "model.call",
      { ...spine, turn },
      {
        "gen_ai.request.model": result.model,
        "gen_ai.response.finish_reasons": [result.finishReason],
        "gen_ai.usage.input_tokens": result.usage.input,
        "gen_ai.usage.output_tokens": result.usage.output,
        "gen_ai.usage.cached_tokens": result.usage.cacheRead,
        "gen_ai.usage.cost_usd": result.usage.costUsd,
        // NOT a health metric — its denominator grows with appended history. Kept because
        // consumers already chart it, but score on `cache_shortfall_tokens` instead.
        cache_hit_pct: cacheHit,
        // The number that actually says whether the cache is working (see above). Absent on the
        // first call of a run and after a compaction, where there is no previous request to
        // re-read and a "shortfall" would be meaningless rather than zero.
        ...(shortfall !== undefined ? { cache_shortfall_tokens: shortfall } : {}),
        // S1: which part of the cached prefix changed this turn. A miss with a moved hash names its
        // own culprit; a miss with both hashes stable says the prefix was intact and the cause is
        // elsewhere. That second reading is the one that can falsify the standing prediction.
        ...prefix,
        tier: "main",
        latency_ms: result.latencyMs,
        // Wall time of the WHOLE cascade (retries + failover + the winning attempt) —
        // `wall_ms - latency_ms` is the invisible pre-call stall the waterfall hunts.
        wall_ms: Date.now() - callT0,
        ...(retries ? { retries } : {}),
        ...(result.provider ? { "gen_ai.provider": result.provider } : {}),
        // What was ASKED (effort) and what the server says it SERVED (speed) — so an
        // experiment arm's calls are self-labeling in telemetry, no config cross-reference.
        // Effort passes through to the wire unvalidated (the model 4xxs an unknown tier), but
        // the exported ATTRIBUTE stays a closed set: request metadata is untrusted, and an
        // arbitrary string here would be a high-cardinality leak to a second off-box sink.
        ...(reasoningEffort
          ? {
              "gen_ai.request.effort": (KNOWN_EFFORTS as readonly string[]).includes(
                reasoningEffort,
              )
                ? reasoningEffort
                : "other",
            }
          : {}),
        ...(result.usage.speed ? { speed: result.usage.speed } : {}),
        ...(fellBack ? { fallback: true } : {}),
        tool_calls: result.message.tool_calls?.map((c) => c.function.name) ?? [],
      },
    );
    if (fellBack)
      events.emit(
        "model.fallback",
        { ...spine, turn },
        {
          "gen_ai.request.model": deps.primaryModel as string,
          "gen_ai.response.model": result.model,
          ...(result.provider ? { "gen_ai.provider": result.provider } : {}),
          ...(retries ? { retries } : {}),
        },
      );
    console.error(
      `[turn ${turn}] ${result.model} in=${result.usage.input} out=${result.usage.output} cache=${cacheHit}% $${result.usage.costUsd.toFixed(4)} ${result.latencyMs}ms · run $${usage.costUsd.toFixed(4)}${fellBack ? ` · FALLBACK (primary ${deps.primaryModel})` : ""}`,
    );

    // Cockpit capture (dev-only): snapshot the EXACT request/response for this call.
    // We rebuild the message list from `system` + the pre-expansion `history` + the SAME
    // ephemeral user-blocks the wire got (context / instructions / retrieval) — byte-
    // identical to the wire except image markers stay markers (never the base64 bytes).
    const capture = deps.captureCalls
      ? {
          req: JSON.stringify({
            messages: [
              { role: "system", content: system },
              ...history,
              ...ephemeral.map((m) => ({ ...m, ephemeral: true })),
            ],
            tools: toolSpecs(tools),
            reasoning_effort: reasoningEffort ?? null,
            cache_key: run.session_id,
          }),
          res: JSON.stringify({
            model: result.model,
            finish_reason: result.finishReason,
            usage: result.usage,
            latency_ms: result.latencyMs,
            ...(result.provider ? { provider: result.provider } : {}),
            message: result.message,
          }),
        }
      : null;
    const cappedCalls = outputCapped(result.finishReason) ? (result.message.tool_calls ?? []) : [];
    const capResult = (name: string) =>
      `[tool error] output cap (${result.finishReason}) may have truncated '${name}'; ` +
      "the call was not executed. Reissue a smaller/chunked call.";
    // Assistant message + tool intents commit atomically. Output-capped calls land
    // already answered/done, so neither normal execution nor resume can fire them.
    db.transaction(() => {
      insertMessage(db, run, result.message);
      db.query("UPDATE runs SET usage = ?, steps = ?, last_input = ? WHERE id = ?").run(
        JSON.stringify(usage),
        stepCount,
        lastInputTokens,
        run.id,
      );
      for (const call of result.message.tool_calls ?? []) {
        if (cappedCalls.includes(call)) {
          const synthetic = capResult(call.function.name);
          db.query(
            `INSERT INTO journal
               (run_id, call_id, tool, args, status, result, created_at, finished_at)
             VALUES (?, ?, ?, ?, 'done', ?, ?, ?)
             ON CONFLICT (run_id, call_id) DO UPDATE SET
               status='done', result=excluded.result, finished_at=excluded.finished_at`,
          ).run(
            run.id,
            call.id,
            call.function.name,
            call.function.arguments,
            synthetic,
            Date.now(),
            Date.now(),
          );
          insertMessage(db, run, { role: "tool", tool_call_id: call.id, content: synthetic });
        } else {
          db.query(
            `INSERT OR IGNORE INTO journal (run_id, call_id, tool, args, status, created_at)
             VALUES (?, ?, ?, ?, 'intent', ?)`,
          ).run(run.id, call.id, call.function.name, call.function.arguments, Date.now());
        }
      }
      if (capture)
        db.query(
          `INSERT INTO calls (run_id, session_id, turn, request, response, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(run.id, run.session_id, turn, capture.req, capture.res, Date.now());
    })();
    for (const call of cappedCalls)
      events.emit(
        "tool.result",
        { ...spine, turn },
        {
          "gen_ai.tool.name": call.function.name,
          is_error: true,
          "error.class": "tool_args_truncated",
        },
      );
    events.emit(
      "checkpoint",
      { ...spine, turn },
      { messages: sessionMessageCount(db, run.session_id) },
    );
    events.emit("turn.end", { ...spine, turn }, {});
    resuming = false;
  }
}

function pendingCalls(db: Database, run: RunRow, assistant: AssistantMsg) {
  const answered = new Set(
    (db.query("SELECT msg FROM messages WHERE run_id = ?").all(run.id) as { msg: string }[])
      .map((r) => JSON.parse(r.msg) as ChatMsg)
      .filter((m) => m.role === "tool")
      .map((m) => (m as { tool_call_id: string }).tool_call_id),
  );
  return (assistant.tool_calls ?? []).filter((c) => !answered.has(c.id));
}

/** A4 retry-loop breaker state (per run, in-memory). `disabled` = tools quarantined this run;
 * `fails` = per tool the byte-identical categorical error and how many CONSECUTIVE TURNS it has
 * repeated; `turn` = this turn's per-call outcomes, drained and aggregated once the whole batch
 * settles (below). Aggregating per turn — not per call — means a fan-out can't inflate the count
 * AND a single success anywhere in the turn vetoes the latch (a tool that ever succeeds isn't dead). */
type Breaker = {
  disabled: Set<string>;
  /** `gap` = how far the last self-write attempt still overshot its cap, and `attempts` = how many
   * consecutive turns this tool has failed the same way regardless of progress (the hard ceiling). */
  fails: Map<string, { err: string; n: number; gap?: number; attempts: number }>;
  turn: { name: string; callId: string; categorical: string | null; gap?: number }[];
};
const CATEGORICAL_TOOL_FAIL_LIMIT = 3;
/** A self-write refusal resets the streak only if it closed a MATERIAL fraction of the gap — the
 * same discipline as compaction's `MATERIAL`, and for the same reason: progress must be measured by
 * the quantity that matters, not by a proxy. `STORM_CLASSES` keys every cap refusal to one constant
 * so the varying byte counts cannot defeat equality matching, which was the right fix for the
 * 2026-07-30 grinding storm and also discarded the only signal separating grinding from converging.
 * Aperture measured a run go 6,654 → 6,482 → 6,445 against a 6,400 cap and get cut off at three,
 * 45 bytes short and shrinking. Their own first suggestion — exempt monotone shrinking — is
 * unbounded: one byte per attempt would grind forever. */
const SELF_CAP_CONVERGENCE = 0.95;
/** The ceiling that makes convergence safe to honour: however well it is converging, stop here. */
const CONVERGING_ATTEMPT_MAX = 8;
/** The refusal carries landed-size vs cap, and that detail is what made the attempts converge at
 * all — keep it in the message (Aperture). Here it is also the progress signal. */
const SELF_CAP_GAP = /DELTA\.md would be (\d+) bytes \(cap (\d+)\)/;

/** How far a self-write refusal overshot its cap, or undefined if this isn't one. */
function selfCapGap(result: string): number | undefined {
  const m = SELF_CAP_GAP.exec(result);
  if (!m) return undefined;
  const bytes = Number(m[1]);
  const cap = Number(m[2]);
  return Number.isFinite(bytes) && Number.isFinite(cap) ? Math.max(0, bytes - cap) : undefined;
}
/** Categorical = the failure can't fix itself by retrying (the report's ENOENT / not-found /
 * schema-invalid class). Transient wins if both match — a "timed out" is never categorical.
 * Deliberately does NOT include "unavailable" (a service being unavailable is usually transient). */
const CATEGORICAL_TOOL_ERROR =
  /ENOENT|not found|no such file|command not found|executable|posix_spawn|unknown tool|failed to parse|invalid arguments?|schema/i;
const TRANSIENT_TOOL_ERROR =
  /time(?:d)? ?out|rate.?limit|\b429\b|\b503\b|unavailable|overloaded|fetch failed|network|ECONN|socket|temporarily/i;
/** The pre-cap error string if this result is a categorical [tool error], else null (a success OR
 * a non-categorical/transient error — both veto the latch). */
const categoricalErr = (result: string): string | null =>
  result.startsWith("[tool error]") &&
  CATEGORICAL_TOOL_ERROR.test(result) &&
  !TRANSIENT_TOOL_ERROR.test(result)
    ? result
    : null;

/** Low-cardinality class for a failed tool result, exported on tool.result telemetry.
 * The 2026-07-30 effort lab burned a day on a wrong root cause because telemetry said
 * only is_error=true — the self-write refusals were unclassifiable (size cap vs conflict
 * vs policy). Matches OUR OWN fixed error strings (pinned by test), self-write first
 * because those messages embed variable content (byte counts, the current file) that
 * defeats equality-based aggregation. Returns undefined when no class fits — emit
 * nothing rather than a junk bucket. */
export function toolErrorClass(result: string): string | undefined {
  if (!result.startsWith("[tool error]")) return undefined;
  if (result.includes("output cap (") && result.includes("the call was not executed"))
    return "tool_args_truncated";
  if (result.includes("arguments failed to parse")) return "tool_args_invalid";
  if (/DELTA\.md would be \d+ bytes \(cap /.test(result)) return "self_cap";
  // The echo guard (0.2.12). Classified explicitly so its retryability is a CONTRACT: today it
  // dodges the categorical regex by luck of wording, and adding "invalid arguments" or "schema" to
  // that message later would quarantine a perfectly good tool after three echoes (codex).
  if (result.includes("contains an engine placeholder")) return "tool_args_elided";
  if (result.includes("DELTA.md was updated by another run")) return "self_conflict";
  if (result.includes("looks like your whole system prompt")) return "self_spine_echo";
  if (result.includes("refusing to write an empty DELTA.md")) return "self_empty";
  if (result.includes("self-write is not available")) return "self_unavailable";
  if (result.includes("DELTA.md is your own living file")) return "self_protected";
  if (/exceeded \d+ms timeout/.test(result)) return "timeout";
  if (TRANSIENT_TOOL_ERROR.test(result)) return "transient";
  if (CATEGORICAL_TOOL_ERROR.test(result)) return "categorical";
  return undefined;
}

/** `remember`-targeted self-write refusals whose messages vary per call (byte counts, the
 * current file text) and so never compare equal — the class key is what lets them latch.
 * `self_conflict` is EXCLUDED (the conflict guard hands back the current file for a
 * merge-and-retry designed to succeed); transient/timeout never latch. `self_protected` is
 * also NOT here: its message is fixed (no varying content, so it never had the equality
 * problem this set solves), it is produced by the GENERIC write_file/move/delete guard, and
 * latching it would quarantine a general-purpose tool run-wide as collateral — a cost the
 * lab never showed a benefit for (the observed storm was `remember`/self_cap, not write_file). */
const STORM_CLASSES = new Set(["self_cap", "self_spine_echo", "self_empty", "self_unavailable"]);

/** The breaker's aggregation key for a failed result: a stable per-class key for storm
 * classes, else the exact categorical error (pre-existing behavior). Without the class key,
 * the effort lab's `remember` grinding (100+ same-cause refusals in one arm, ~$10 of waste)
 * never tripped the 3-strike quarantine because each size-cap message embeds a different byte
 * count. Classifying BEFORE the exact-categorical check is load-bearing: a conflict/transient/
 * timeout must NEVER latch even when its body echoes text the categorical regex matches (a
 * real conflict appends the current DELTA.md, which can contain words like "schema"/"not
 * found"). Exported for tests. */
export function breakerKey(result: string): string | null {
  const cls = toolErrorClass(result);
  if (
    cls === "self_conflict" ||
    cls === "transient" ||
    cls === "timeout" ||
    cls === "tool_args_invalid" ||
    cls === "tool_args_truncated" ||
    // An echoed placeholder is ALWAYS retryable: the model is told exactly what to send instead,
    // and it self-corrects. Latching here would kill a working tool for the rest of the run.
    cls === "tool_args_elided"
  )
    return null;
  if (cls && STORM_CLASSES.has(cls)) return `[class] ${cls}`;
  return categoricalErr(result);
}

/** Aggregate one settled tool-call batch (A4). A tool is a fresh categorical failure this turn ONLY
 * if EVERY call to it returned the SAME categorical error (no success, no different/transient
 * result). That increments its consecutive-turn streak; anything else resets it. At the limit the
 * tool is quarantined for the run and a one-line norm is appended to its last error message so the
 * model reads the way out inline. Returns nothing; mutates `breaker` and the message row. */
function aggregateBreaker(
  db: Database,
  run: RunRow,
  breaker: Breaker,
  events: Events,
  spine: Spine,
  allowed: Tools,
): void {
  const byTool = new Map<string, { callId: string; categorical: string | null; gap?: number }[]>();
  for (const o of breaker.turn) {
    const list = byTool.get(o.name) ?? [];
    list.push({
      callId: o.callId,
      categorical: o.categorical,
      ...(o.gap !== undefined ? { gap: o.gap } : {}),
    });
    byTool.set(o.name, list);
  }
  breaker.turn = [];
  for (const [name, calls] of byTool) {
    const err = calls[0]?.categorical ?? null;
    const allSame = err !== null && calls.every((c) => c.categorical === err);
    if (!allSame) {
      breaker.fails.delete(name); // a success / different / transient result this turn resets it
      continue;
    }
    const f = breaker.fails.get(name);
    const same = f && f.err === err;
    const gap = calls[calls.length - 1]?.gap;
    // An attempt that closed a material fraction of the remaining gap is CONVERGING, not grinding,
    // so it resets the streak — bounded by `attempts`, which never resets while the error repeats.
    const converging =
      same && gap !== undefined && f.gap !== undefined && gap < f.gap * SELF_CAP_CONVERGENCE;
    const n = same && !converging ? f.n + 1 : 1;
    const attempts = same ? f.attempts + 1 : 1;
    breaker.fails.set(name, { err, n, attempts, ...(gap !== undefined ? { gap } : {}) });
    const lastCall = calls[calls.length - 1]?.callId;
    const latch = n >= CATEGORICAL_TOOL_FAIL_LIMIT || attempts >= CONVERGING_ATTEMPT_MAX;
    if (latch && !breaker.disabled.has(name) && lastCall) {
      breaker.disabled.add(name);
      // S4: a latch withdraws the tool's schema from `effectiveTools()` next turn AND rewrites a
      // past tool-result row in place below — two independent prefix breaks, previously silent.
      // A whole round of the 2026-08 cache investigation could not be tested because this left no
      // trace. Emitted ONCE per tool (guarded by `disabled.has` above), never per later failure.
      const def = allowed.get(name);
      events.emit("tool.breaker", spine, {
        "gen_ai.tool.name": name, // a resolved registry name — bounded, already on the allowlist
        attempts,
        schema_bytes_withdrawn: def
          ? utf8(
              JSON.stringify({
                name: def.name,
                description: def.description,
                parameters: def.parameters,
              }),
            )
          : 0,
      });
      const norm = `\n[norm] '${name}' has failed the same way ${attempts}× this run and is now disabled for the rest of it — use another approach; retrying it cannot succeed.`;
      db.query(
        "UPDATE messages SET msg = json_set(msg, '$.content', json_extract(msg, '$.content') || ?) WHERE run_id = ? AND json_extract(msg, '$.tool_call_id') = ?",
      ).run(norm, run.id, lastCall);
    }
  }
}

function escapeLiteralControls(raw: string): string {
  let out = "";
  let quoted = false;
  let escaped = false;
  for (const ch of raw) {
    if (!quoted) {
      out += ch;
      if (ch === '"') quoted = true;
    } else if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === "\\") {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      out += ch;
      quoted = false;
    } else {
      out += ch.charCodeAt(0) < 0x20 ? JSON.stringify(ch).slice(1, -1) : ch;
    }
  }
  return out;
}

/** Parse once as-is, then make one bounded syntax-only repair pass. */
export function parseToolArgs(raw: string): {
  args?: Record<string, unknown>;
  repaired: boolean;
} {
  const parseObject = (text: string): Record<string, unknown> | undefined => {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  };
  try {
    return { args: parseObject(raw || "{}"), repaired: false };
  } catch {}
  if (raw.length > 64_000) return { repaired: false };
  const fixed = escapeLiteralControls(raw).replace(/,\s*([}\]])/g, "$1");
  try {
    return { args: parseObject(fixed), repaired: fixed !== raw };
  } catch {
    return { repaired: false };
  }
}

async function execCall(
  deps: Deps,
  tools: Tools,
  ctx: ToolCtx,
  run: RunRow,
  spine: Spine,
  call: NonNullable<AssistantMsg["tool_calls"]>[number],
  resuming: boolean,
  persistActive: () => void,
  breaker: Breaker,
): Promise<void> {
  const { db, events } = deps;
  const name = call.function.name;
  const tool = tools.get(name);
  const journal = db
    .query("SELECT status, result FROM journal WHERE run_id = ? AND call_id = ?")
    .get(run.id, call.id) as { status: string; result: string | null } | null;

  let result: string;
  /** The arguments as PARSED for execution, so the commit-time elision never parses twice. */
  let executedArgs: Record<string, unknown> | undefined;
  if (journal?.status === "done") {
    // Crashed after execution, before the message row landed — replay, never re-fire.
    result = journal.result ?? "";
  } else if (resuming && tool && !tool.idempotent) {
    result = `[interrupted] The daemon restarted while '${name}' was executing; it may or may not have taken effect. Verify the outcome before firing it again.`;
    events.emit("tool.result", spine, { "gen_ai.tool.name": name, interrupted: true });
  } else if (!tool) {
    // A-2: the last silent rejection in the loop. A CLOSED reason enum (safe to export bare);
    // the raw requested name is model-controlled free text under injection, so it rides as
    // payload — local unless DELTA_CAPTURE_PAYLOADS is on. Telemetry only: the model-facing
    // error string is unchanged, and no execution semantics move (that is A-3, which waits
    // for this event's data).
    const reason = breaker.disabled.has(name)
      ? "breaker_disabled"
      : deps.tools.has(name)
        ? "not_allowed"
        : "unknown";
    events.emit("tool.rejected", spine, { requested_tool: name, reason });
    result = `[tool error] unknown tool '${name}'`;
  } else {
    events.emit("tool.call", spine, { "gen_ai.tool.name": name, "gen_ai.tool.call.id": call.id });
    const start = performance.now();
    // Wall-clock ceiling: the tool's own timeoutMs (0 = unbounded for long-runners like the
    // code CLI / sub-agents), else the run default. We compose a signal INTO ctx so signal-aware
    // tools (bash/code) get killed, AND race a rejecting timeout so a signal-ignoring tool still
    // unblocks the loop. A raced-out tool keeps running detached; the journal marks it done so it
    // can't re-fire — same net effect as the existing non-idempotent interrupted semantics.
    // KNOWN LIMIT (codex #2): a tool that blocks the event loop SYNCHRONOUSLY (busy loop, sync
    // I/O) can't be preempted in-process — no timer runs. Delta's builtins are all async I/O
    // (fetch/Bun.spawn); true preemption needs process isolation (backlog: exec/fs seam).
    const toolMs = tool.timeoutMs ?? deps.toolTimeoutMs ?? 0;
    try {
      const parsed = parseToolArgs(call.function.arguments);
      if (!parsed.args)
        throw new Error(
          `tool '${name}' arguments failed to parse as a JSON object after one bounded repair; ` +
            `reissue valid arguments (use a smaller/chunked payload if they were cut)`,
        );
      const args = parsed.args;
      // Refuse a call that echoes an engine placeholder back at us, BEFORE it executes. Silent
      // acceptance means the tool persists the marker as if it were real content.
      // Gated on the cap: with elision disabled the engine never emits a marker, so no echo is
      // possible and the guard has no job. This is what makes default-off genuinely OFF — a
      // consumer who never enabled the feature cannot be affected by machinery that exists only to
      // serve it (codex).
      const echoed = (deps.toolArgCap ?? 0) > 0 ? elidedArgsRejection(args) : null;
      if (echoed) throw new Error(echoed.replace("[tool error] ", ""));
      executedArgs = args; // reused by the elision below — the object is parsed exactly once
      if (toolMs > 0) {
        // Compose the caller's cancel with a fresh timeout controller; the timer is cleared the
        // moment the tool settles, so a fast call leaves no lingering timer.
        const ac = new AbortController();
        const sig = ctx.signal ? AbortSignal.any([ctx.signal, ac.signal]) : ac.signal;
        const timer = setTimeout(() => ac.abort(), toolMs);
        const timeout = new Promise<never>((_, reject) => {
          // Steer the model away from a blind re-fire (codex #3): the detached loser may
          // still commit its side effect — same contract as the resume-interrupted message.
          const onAbort = () =>
            reject(
              new Error(
                `tool '${name}' exceeded ${toolMs}ms timeout; it was left running and may still complete — verify its outcome before firing it again`,
              ),
            );
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        });
        timeout.catch(() => {}); // swallow a late rejection if the tool already won the race
        try {
          result = await Promise.race([tool.execute(args, { ...ctx, signal: sig }), timeout]);
        } finally {
          clearTimeout(timer);
        }
      } else {
        result = await tool.execute(args, ctx);
      }
    } catch (e) {
      result = `[tool error] ${String(e).slice(0, 2000)}`;
    }
    // THE redaction choke point (0.2.10). Every tool result funnels through here, so redacting
    // once — BEFORE breaker classification, capAndSpill (spill files land clean), the journal,
    // the message row, and the telemetry snippet — covers every downstream sink in one line.
    // Cleanup, not containment: no tool returns a vault value, this catches reflections.
    result = redactSecretValues(result);
    // A4: record this call's outcome for the batch aggregation (below, after Promise.all). Classify
    // on the RAW pre-cap result — capAndSpill embeds this call's id in its spill-path notice, so an
    // oversized error would look different every call and never compare equal.
    breaker.turn.push({
      name,
      callId: call.id,
      categorical: breakerKey(result),
      // ONLY for `remember`: `toolErrorClass` matches the refusal SHAPE, so any MCP tool could
      // otherwise return shrinking fake "DELTA.md would be …" text and buy itself the converging
      // allowance instead of latching at three (codex P2).
      ...(name === "remember" && selfCapGap(result) !== undefined
        ? { gap: selfCapGap(result) }
        : {}),
    });
    // Cap oversized output at the source — it's persisted AND re-sent every turn, and a single
    // giant payload is the top cause of a mid-run context-window overflow. Spill keeps it re-readable.
    result = await capAndSpill(
      result,
      ctx.scratchDir ?? ctx.workspace,
      run.id,
      call.id,
      deps.toolResultCap,
    );
    const errClass = toolErrorClass(result);
    const isErr = result.startsWith("[tool error]");
    events.emit("tool.result", spine, {
      "gen_ai.tool.name": name,
      duration_ms: Math.round(performance.now() - start),
      is_error: isErr,
      ...(errClass ? { "error.class": errClass } : {}),
      // Bounded snippet so a refusal storm is diagnosable WITHOUT shelling into the box —
      // the effort lab's misdiagnosis happened because telemetry had no error text at all.
      // Deliberately NOT in the exporter's SAFE_ATTRS: it leaves the box only with payload
      // consent (capture_payloads), locally it is always queryable.
      ...(isErr ? { "error.message": result.replace(/\s+/g, " ").slice(0, 200) } : {}),
    });
  }

  db.transaction(() => {
    db.query(
      `INSERT INTO journal (run_id, call_id, tool, args, status, result, created_at, finished_at)
       VALUES (?, ?, ?, ?, 'done', ?, ?, ?)
       ON CONFLICT (run_id, call_id) DO UPDATE SET status='done', result=excluded.result, finished_at=excluded.finished_at`,
      // Store what actually EXECUTED. `parseToolArgs` repairs trailing commas and literal control
      // characters, and keeping the original malformed string meant a later `recall` readback
      // could not parse the row and reported a retained body as pruned (codex).
    ).run(
      run.id,
      call.id,
      name,
      executedArgs ? JSON.stringify(executedArgs) : call.function.arguments,
      result,
      Date.now(),
      Date.now(),
    );
    insertMessage(db, run, { role: "tool", tool_call_id: call.id, content: result });
    persistActive(); // tool activations commit atomically with the result
  })();
}

/** D-9-min: a budget-exhausted run hands back what it already has — the plan and the artifact
 * paths already on disk — instead of one sentence of counters. Pointers, not prose: the cheap
 * final "answer from context" call is 0.2.16 scope. Three properties hold by construction:
 * (1) RUN-scoped — paths are enumerated from the filesystem under this run's sanitized-id
 * prefix (the same one the writers used), never parsed out of model-visible rows, so nothing
 * stale or forged can enter and no DB scan is needed; (2) fail-open — a block that throws is
 * dropped, never the finalize; (3) bounded — 10 KiB by UTF-8 bytes, 20 paths per family.
 * Ephemeral (store:false, non-idempotent-terminal) runs get no paths at all: queue.ts wipes
 * this run's spill AND research right after settle, so a pointer would be dead on arrival.
 * The model's scratchpad (`scratch/<runId>`) is never listed for the same reason — queue.ts
 * wipes it for EVERY terminal run. */
const HANDOFF_CAP_BYTES = 10_240;
const HANDOFF_MAX_PER_FAMILY = 20;

function exhaustionHandoff(deps: Deps, run: RunRow, committedSelfWrite: boolean): string {
  const parts: string[] = ["This run hit its budget before finishing. Nothing below was lost."];
  try {
    const plan = readTodo(deps.db, run.session_id);
    if (plan.length)
      parts.push(
        elide(
          `Current plan (session working notes) at the point it stopped:\n${plan
            .map((it) => `- [${it.status}] ${it.text}`)
            .join("\n")}`,
          4_000,
        ),
      );
  } catch {}
  let ephemeral = false;
  try {
    const req = JSON.parse(run.request) as RunRequest;
    ephemeral = req.store === false && !req.idempotency_terminal;
  } catch {}
  if (ephemeral) {
    parts.push("Intermediate results were not retained (this was an ephemeral turn).");
  } else {
    try {
      const root = resolve(deps.scratchDir ?? deps.workspace);
      const family = (dir: string, prefix: string): string[] => {
        try {
          return readdirSync(dir)
            .filter((e) => e.startsWith(prefix))
            .sort()
            .map((e) => `${dir}/${e}`);
        } catch {
          return []; // most runs spill/research nothing — the dir may not exist
        }
      };
      const spills = family(`${root}/.delta/spill`, spillRunPrefix(run.id));
      // Research artifacts are FILES inside per-call dirs — list the files, which is what
      // read_file takes (the dirs alone would send the user somewhere read_file rejects).
      const research = family(`${root}/.delta/research`, researchRunPrefix(run.id)).flatMap((d) =>
        family(d, ""),
      );
      const bounded = (paths: string[]): string[] => {
        const head = paths.slice(0, HANDOFF_MAX_PER_FAMILY).map((p) => `- ${p}`);
        if (paths.length > head.length) head.push(`- …and ${paths.length - head.length} more`);
        return head;
      };
      const listed = [...bounded(spills), ...bounded(research)];
      if (listed.length)
        parts.push(
          `Full results already on disk (read_file these, or recall a keyword):\n${listed.join("\n")}`,
        );
    } catch {}
  }
  if (committedSelfWrite)
    parts.push(
      "[note: a change to your self-file (DELTA.md) was saved during this turn and persists — it was not rolled back.]",
    );
  parts.push(
    "The work was too large to finish in one run. Narrow the question rather than repeating it.",
  );
  let out = parts.join("\n\n");
  // Byte-true cap: elide counts chars, so shrink until the UTF-8 measure agrees.
  while (Buffer.byteLength(out, "utf8") > HANDOFF_CAP_BYTES)
    out = elide(out, Math.floor(out.length * 0.8));
  return out;
}

/** The driver-compatible Responses payload. Every terminal state gets one —
 * including cancellations that never started (queue.cancel uses this too). */
export function responsePayload(
  run: RunRow,
  status: "done" | "failed" | "cancelled",
  text: string,
  model: string,
  usage: Usage,
) {
  const outputText = status === "done" ? text : `[delta] turn ${status}: ${text}`;
  return {
    id: run.id,
    object: "response" as const,
    model: model || "delta",
    status: status === "done" ? "completed" : status,
    output_text: outputText,
    output: [
      {
        type: "message" as const,
        role: "assistant" as const,
        content: [{ type: "output_text" as const, text: outputText }],
      },
    ],
    previous_response_id: (JSON.parse(run.request) as RunRequest).previous_response_id ?? null,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.total,
      cost_usd: usage.costUsd,
    },
  };
}

/** What a terminal run hands each audience: `user` becomes output_text (and, on failure, the
 *  transcript row); `diagnostic` is the operator string for `runs.error` (defaults to `user`).
 *  Split so a budget failure can carry the D-9 handoff to the user while the counters stay
 *  where operators look. Mandatory at every call site — a bare string landing in the wrong
 *  field is the exact confusion this shape exists to prevent. */
type Outcome = { user: string; diagnostic?: string };

function finalize(
  deps: Deps,
  run: RunRow,
  spine: Spine,
  status: "done" | "failed" | "cancelled",
  out: Outcome,
  model: string,
  usage: Usage,
): RunRow {
  const { db, events } = deps;
  const payload = responsePayload(run, status, out.user, model, usage);
  const outputText = payload.output_text;
  db.transaction(() => {
    if (status !== "done") {
      // Keep the chain valid for the next turn: drop this run's partial rows and
      // land a clean user→assistant pair explaining what happened.
      db.query(
        "UPDATE messages SET active = 0 WHERE run_id = ? AND json_extract(msg, '$.role') != 'user'",
      ).run(run.id);
      insertMessage(db, run, { role: "assistant", content: outputText });
    }
    db.query(
      "UPDATE runs SET status = ?, result = ?, error = ?, usage = ?, finished_at = ? WHERE id = ?",
    ).run(
      status,
      JSON.stringify(payload),
      status === "done" ? null : (out.diagnostic ?? out.user),
      JSON.stringify(usage),
      Date.now(),
      run.id,
    );
    db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), run.session_id);
  })();
  events.emit("run.finished", spine, {
    status,
    "gen_ai.usage.input_tokens": usage.input,
    "gen_ai.usage.output_tokens": usage.output,
    // cacheRead is a subset of input (cache never applies to output) — surface it plus the
    // in+out total so the run summary can show true-to-life volume and cache warmth.
    "gen_ai.usage.cached_tokens": usage.cacheRead,
    "gen_ai.usage.total_tokens": usage.total,
    "gen_ai.usage.cost_usd": usage.costUsd,
  });
  return getRun(db, run.id) as RunRow;
}

function insertMessage(db: Database, run: RunRow, msg: ChatMsg): void {
  db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES (?, ?, ?, ?)").run(
    run.id,
    run.session_id,
    JSON.stringify(msg),
    Date.now(),
  );
}

/** The assistant row that issued the batch the last tool result belongs to — i.e. the newest active
 * assistant of this run, but ONLY if it carries tool_calls. Returning null when the newest assistant
 * is a plain answer is the safety property: it means this can never reach back past a completed
 * exchange and re-open it. */
function batchCaller(db: Database, runId: string): AssistantMsg | null {
  const rows = db
    .query("SELECT msg FROM messages WHERE run_id = ? AND active = 1 ORDER BY id DESC")
    .all(runId) as { msg: string }[];
  for (const row of rows) {
    let m: ChatMsg;
    try {
      m = JSON.parse(row.msg) as ChatMsg;
    } catch {
      continue;
    }
    if (m.role !== "assistant") continue;
    const a = m as AssistantMsg;
    return a.tool_calls?.length ? a : null;
  }
  return null;
}

function lastRunMessage(db: Database, runId: string): ChatMsg | null {
  const row = db
    .query("SELECT msg FROM messages WHERE run_id = ? AND active = 1 ORDER BY id DESC LIMIT 1")
    .get(runId) as { msg: string } | null;
  return row ? (JSON.parse(row.msg) as ChatMsg) : null;
}

function activeSessionMessages(db: Database, sessionId: string): ChatMsg[] {
  return (
    db
      .query("SELECT msg FROM messages WHERE session_id = ? AND active = 1 ORDER BY id")
      .all(sessionId) as { msg: string }[]
  ).map((r) => JSON.parse(r.msg) as ChatMsg);
}

function sessionMessageCount(db: Database, sessionId: string): number {
  return (
    db
      .query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND active = 1")
      .get(sessionId) as {
      n: number;
    }
  ).n;
}
