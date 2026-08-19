// SPDX-License-Identifier: Apache-2.0
// Tool registry. M1 carries only the type + test tools (real hands land in M2).
// `idempotent` drives resume semantics: after a crash mid-execution, idempotent
// tools re-fire; non-idempotent tools get a synthetic interrupted result and the
// model decides (spec §B sub-turn resume).

import type { UtilityPurpose } from "./events";
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

/** One elided argument value the agent can list and read back (0.2.12). */
export type Artifact = {
  runSeq: number | null;
  callId: string;
  tool: string;
  /** The elided argument key, or null when the WHOLE object was collapsed. Not `""` — an empty
   * string is a legal JSON property name, so it cannot distinguish the two (codex P1). */
  field: string | null;
  bytes: number;
};

/** A page of an archived argument value. `retained: false` = the journal has since pruned the
 * body, which is stated plainly rather than returned as an empty string. */
export type ArtifactPage = {
  text: string;
  offset: number;
  total: number;
  more: boolean;
  retained: boolean;
};

/** The agent's per-thread working plan (W3 recitation). */
export type TodoStatus = "pending" | "doing" | "done" | "dropped";
export type TodoItem = { text: string; status: TodoStatus };

export type ToolCtx = {
  /** Workspace root for file tools; absolute path. */
  workspace: string;
  /** Engine scratch root (DELTA_SCRATCH_DIR); equals workspace unless the operator moved it.
   * Spill/research/scratchpad live here, and file tools accept it as a second confined root so
   * the model can read what the engine tells it to read_file. */
  scratchDir?: string;
  /** This run's tool-result cap. A tool that returns bounded pages sizes them from this, so its
   * output can never itself trip `capAndSpill` and write a spill file (0.2.12). */
  resultCap?: number;
  /** Pull more tools into this run's active set (search_tools uses this). */
  activate: (names: string[]) => void;
  /** Search THIS thread's message history — including rows compacted out of the active
   * window — for text the agent saw earlier (the `recall` tool). Session is bound
   * internally so a caller can never search another session. Absent in bare/oneshot
   * contexts (a `:memory:` sub-agent has no shared history). */
  history?: {
    search: (query: string, limit: number) => RecallHit[];
    /** The manifest of argument values elided out of this thread's window (0.2.12). */
    artifacts: (limit: number) => Artifact[];
    /** Page one of them back from the journal archive. Null = no such artifact in this thread. */
    read: (
      ref: { runSeq: number; callId: string; field: string | null },
      offset: number,
      maxChars: number,
    ) => ArtifactPage | null;
  };
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
  /** S3: report a utility-lane model call for telemetry. A callback rather than `events` + `spine`
   *  on this type, because the closure already carries both and this keeps the reporting seam one
   *  optional field wide instead of threading two types through every tool context. Purely
   *  observational — it never charges usage, so it cannot double-bill. */
  onUtilityCall?: (purpose: UtilityPurpose, r: ModelResult) => void;
  /** Per-run bearer for act-as-user MCP calls (act-as-token passthrough, §E). */
  authToken?: string;
  /** The run's owning principal (the seam-asserted user_id), or null for an unowned/dev run. Lets a
   *  tool that calls back out to the gateway assert WHICH user it is acting for — e.g. schedule_self
   *  POSTs this so the gateway binds the schedule to the right conversation even when several users'
   *  turns run concurrently (the async replacement for a single in-flight origin). */
  owner?: string | null;
  /** Whether the daemon's model reads images — shapes image-marker phrasing so a
   * non-vision model is told plainly it can't see the pixels. */
  vision?: boolean;
  /** Charge nested model work to this run's durable usage total. */
  chargeUsage?: (usage: Usage) => void;
  /** Fresh-token and dollar budget still available to nested work. */
  remainingBudget?: () => { maxTokens: number; maxCostUsd: number };
  /** Claim a share of what is left for ONE piece of nested work, and hold it until released
   * (0.2.12). `remainingBudget` is derived from the run's usage, which only moves when a child
   * EXITS, so concurrent children each read the FULL remaining budget and a run can spend a
   * multiple of its ceiling. A live reservation is what makes the ceiling actually hold. */
  reserveBudget?: (share: number) => {
    maxTokens: number;
    maxCostUsd: number;
    release: () => void;
  };
  /** Persist the agent's own DELTA.md self-file (the `remember` tool): atomic replace,
   * prior version snapshotted, oversized rejected. Absent in bare/oneshot contexts. */
  writeSelf?: (content: string) => { ok: boolean; error?: string; bytes?: number };
};

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  idempotent: boolean;
  /** True iff this tool cannot mutate workspace / self-file / knowledge-base / external
   * state — a positive, fail-closed capability marker (distinct from `idempotent`, which
   * is retry-safety). Read-only tools are the ONLY tools a restricted context (a research
   * subagent) may call; anything unmarked defaults to mutating and is excluded. Adding a
   * new tool without this flag is safe by construction — it simply won't reach children. */
  readonly?: boolean;
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
/** The DETERMINISTIC spill location for a tool result. One definition, used both to WRITE the
 *  spill and to recognise one later — compaction derives this path from the row's own run id and
 *  tool_call_id instead of trusting a path parsed out of model-visible content, so a hostile tool
 *  result cannot point a pointer-stub at an arbitrary file (codex P1).
 *  callId comes from the PROVIDER — sanitize both ids so a hostile `../`-laden id can never escape
 *  the spill dir and overwrite an arbitrary path (codex #4). */
export function spillPathFor(workspace: string, runId: string, callId: string): string {
  const safe = (s: string) => s.replace(/[^\w-]/g, "_").slice(0, 80);
  return `${workspace}/.delta/spill/${safe(runId)}.${safe(callId)}.txt`;
}

/** The sanitized `<runId>.` filename prefix spill files carry — one definition beside
 *  spillPathFor, so the exhaustion handoff (run.ts) enumerates exactly what capAndSpill
 *  wrote for this run and nothing else. */
export function spillRunPrefix(runId: string): string {
  return `${runId.replace(/[^\w-]/g, "_").slice(0, 80)}.`;
}

export async function capAndSpill(
  text: string,
  workspace: string,
  runId: string,
  callId: string,
  max = 20_000,
): Promise<string> {
  if (text.length <= max) return text;
  const path = spillPathFor(workspace, runId, callId);
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

/** The engine-authored marker replacing an over-budget argument value. */
export const ELIDED_KEY = "_delta_elided";

/** Bound what the MODEL writes. `capAndSpill` bounds a tool RESULT on arrival and `demoteSpilled`
 * bounds it again at compaction; both ignore anything that isn't `role:"tool"`, so a tool call's
 * ARGUMENTS — which live on the assistant message and are replayed on every later turn — have never
 * had a rail. A sweep that writes its findings out page by page therefore carries every page's
 * payload in the window forever, which is what makes its retained tail irreducible.
 *
 * Elides by STRUCTURE, not by call: the object and its keys survive, and only the largest values are
 * replaced, largest-first, until the whole serialized object fits `cap`. `send_email` keeps `to` and
 * `subject` and loses only `body`, so the model can still see WHAT it did — the thing that prevents
 * duplicate side effects and repeated work. The full arguments stay in `journal.args` (written before
 * execution, never overwritten), which is how `recall` reads them back.
 *
 * One cap, applied as both the per-value threshold and the total ceiling, so the invariant is simply
 * "a stored tool call's arguments never exceed `cap` bytes". A per-value rule alone would still admit
 * an arbitrarily large object made of sub-threshold values (codex P1).
 *
 * Returns the replacement JSON string, or null to leave the row byte-identical. Pure and synchronous
 * so it can run inside the commit transaction. Idempotent by SHAPE: an already-elided object is
 * under `cap`, so a second pass measures it and declines — `demoteSpilled` learned that a sentinel
 * alone is forgeable, and size is not. */
export function elideArgs(args: Record<string, unknown>, cap: number): string | null {
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const bytes = (s: string) => Buffer.byteLength(s, "utf8"); // UTF-8: `.length` is UTF-16 (0.2.11)
  const ser = (o: unknown): string | null => {
    try {
      return JSON.stringify(o) ?? null;
    } catch {
      return null; // circular/unserializable → no-op rather than a throw on the commit path
    }
  };
  const size = (v: unknown): number => (typeof v === "string" ? bytes(v) : bytes(ser(v) ?? "null"));

  const first = ser(args);
  if (first === null || bytes(first) <= cap) return null;

  // Largest values first, so the fewest fields are lost to reach the bound. Track the serialized
  // size INCREMENTALLY rather than re-serializing the whole object per field: re-serializing is
  // O(n²) and codex measured 7.2s synchronously on a 20,000-field object, on the commit path.
  const order = Object.entries(args)
    .map(([k, v]) => [k, size(v)] as const)
    .sort((a, b) => b[1] - a[1]);
  const next: Record<string, unknown> = { ...args };
  let total = bytes(first);
  for (const [k, n] of order) {
    const before = bytes(ser(next[k]) ?? "null");
    // Kept deliberately TINY. The cap is both the per-value threshold and the total ceiling, so
    // every byte of marker is a byte of real field that cannot survive: a 135-byte explanatory
    // marker collapsed a 30-field object to a single root marker where a 33-byte one preserved 17
    // real fields (codex). The model-facing warning lives in `elidedArgsRejection`, which fires
    // exactly when it is needed and costs nothing the rest of the time.
    next[k] = { [ELIDED_KEY]: { bytes: n } };
    total += bytes(ser(next[k]) ?? "null") - before;
    if (total <= cap) {
      const out = ser(next);
      // The incremental figure is an estimate of the same quantity; confirm before returning it.
      if (out !== null && bytes(out) <= cap) return out;
    }
  }
  // Every value elided and still over — a pathological key count. Collapse to ONE root marker.
  // `fields` keeps the manifest honest about how much was lost. This is the only shape that can
  // exceed `cap`, and only when `cap` is smaller than the marker itself.
  return ser({ [ELIDED_KEY]: { bytes: size(args), fields: order.length } });
}

/** Reject a tool call carrying an engine elision marker (0.2.12).
 *
 * The failure: the engine replaces an over-budget argument value with a marker, the model sees that
 * marker in its own history where a value goes, and copies it into a LATER call. The tool then
 * persists the placeholder. A live 10-turn session filed 4 of 10 pages as the marker while the run
 * merely looked cheaper.
 *
 * MATCHES BY SHAPE, and deliberately so. An earlier version authenticated against the set of markers
 * this daemon had actually emitted, which sounds stronger and is weaker: the set is in-memory, so a
 * restart left every persisted marker unauthenticated; eviction did the same to a still-live marker;
 * a reordered key defeated the comparison; and a daemon-wide set let one tenant authenticate
 * another's (codex). Every one of those fails OPEN, and the two directions are not equal:
 *
 *   • a missed echo is SILENT data loss and unrecoverable;
 *   • a wrongly rejected call is one loud retry, with the model told exactly what to send instead.
 *
 * So this is stateless and fails closed. The residual false positive — a value that is EXACTLY our
 * marker and nothing else — is an agent writing about this feature or saving a fixture, which is
 * rare and self-correcting.
 *
 * Recognises the marker at the root, on any value, inside arrays and nested objects, and inside a
 * JSON string (a `content` parameter takes text, so the model echoes SERIALIZED json — the live
 * rerun proved an object-only check sails straight past that). */
export function elidedArgsRejection(args: Record<string, unknown>): string | null {
  /** Our EXACT emitted shape: `{_delta_elided:{bytes:number[,fields:number]}}`, one key, nothing
   * else. Key PRESENCE alone would refuse a legitimate document that merely mentions it. */
  const isMarker = (v: unknown): boolean => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length !== 1) return false;
    const m = o[ELIDED_KEY];
    if (!m || typeof m !== "object" || Array.isArray(m)) return false;
    const mm = m as Record<string, unknown>;
    if (typeof mm.bytes !== "number") return false;
    // `fields` is the only other key we ever emit (the root collapse), and it is a number.
    return Object.keys(mm).every(
      (k) => k === "bytes" || (k === "fields" && typeof mm.fields === "number"),
    );
  };
  const holds = (v: unknown, depth = 0): boolean => {
    if (depth > 6) return false; // bounded; the producer only ever emits at depth 0 or 1
    if (typeof v === "string") {
      if (!v.includes(ELIDED_KEY)) return false; // cheap prefilter, then parse — never substring
      const t = v.trimStart();
      if (!t.startsWith("{") && !t.startsWith("[")) return false;
      try {
        return holds(JSON.parse(v), depth + 1);
      } catch {
        return false;
      }
    }
    if (isMarker(v)) return true;
    if (Array.isArray(v)) return v.some((x) => holds(x, depth + 1));
    if (!v || typeof v !== "object") return false;
    return Object.values(v as Record<string, unknown>).some((x) => holds(x, depth + 1));
  };
  // The ROOT-collapse shape is a marker at `args` itself, which checking only the values misses
  // entirely — a whole-object echo then executed as real input (codex).
  const bad = isMarker(args)
    ? ["(whole argument object)"]
    : Object.entries(args)
        .filter(([, v]) => holds(v))
        .map(([k]) => k);
  if (!bad.length) return null;
  return (
    `[tool error] ${bad.join(", ")} contains an engine placeholder (${ELIDED_KEY}) instead of a real value. ` +
    "That marker only ever appears in your history to show that a value you ALREADY sent was dropped from context; " +
    "it is not something to send. Reissue this call with the actual content."
  );
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
