// SPDX-License-Identifier: Apache-2.0
// The judge lane (spec docs/spec-judge-lane.md, slice 1): fast typed judgments a System One model
// (TypeSafe Jev, `POST /v1/systemone`) makes on tool results, declared by the OPERATOR in the
// bundle's `judge.json` and configured like the utility lane: a key, a model, off by default.
//
// Slice 1 is SHADOW ONLY. The engine judges rows of a tool result and records per-row scores; the
// result the model sees is the same string, byte for byte (it is never re-serialized). That is
// what makes the lane safe to run on a live lane while its thresholds are chosen from real data.
//
// Invariants the rest of the engine leans on:
//  · The judge never generates: it answers Noul questions (probability a statement is true) over
//    a state the engine assembles from an explicit allowlist of row fields plus the user's ask,
//    which the operator locates in the run input with a marker (never the whole dispatch card).
//    Nothing it returns is ever inserted anywhere the model reads.
//  · It never throws into a turn, runs only AFTER the tool outcome is durable, never outlives its
//    deadline or the run's cancellation, and never loses a row: a failed, malformed, timed-out or
//    unsent request abstains for its rows.
//  · The agent cannot call it and cannot edit its policies (judge.json is a FIXED operator file).
//  · What leaves the box is the projected rows and the ask, scrubbed leaf by leaf, and only when
//    the operator authorized egress (DELTA_JUDGE_EGRESS=1) on top of supplying a key. The key is
//    registered as a secret value at boot, so an echoing endpoint cannot land it in an event.

import { type ProviderErrorClass, providerErrorClass } from "./provider";
import { scrubText } from "./scrub";

export type JudgeQuestion = {
  instructions: string;
  criteria?: { true?: string; false?: string };
};

/** What `ask` is: the text of the run's input after a marker (up to an optional end marker), or a
 * literal. A marker, not a regex: linear, and it forces the operator to name the part of the input
 * that is the user's ask rather than ship the whole dispatch card. */
export type JudgeAsk = { from: "run.input"; after: string; until?: string } | { literal: string };

export type JudgePolicy = {
  name: string;
  on: "tool.result";
  /** Exact tool name. One policy per tool. */
  tool: string;
  /** Dot path (with `[i]` indices) into the parsed JSON result to an array of objects. */
  rows: string;
  /** Row keys (dot paths) copied into the judge state. Explicit: nothing else leaves the box. */
  row_fields: string[];
  ask: JudgeAsk;
  questions: Record<string, JudgeQuestion>;
  /** Slice 1 accepts only `shadow`; the key exists so the file shape is stable for later modes. */
  mode: "shadow";
  /** Per question, in (0,1). In shadow it only counts `rows_would_filter`. Never empty. */
  threshold?: Record<string, number>;
  /** Rows per request (1..20). Small batches limit cross-row contamination by a hostile row. */
  batch: number;
  max_rows: number;
};

export type JudgeFile = { version: 1; policies: JudgePolicy[] };

export const JUDGE_DEFAULTS = { batch: 5, max_rows: 200 } as const;
/** Caps on what one request carries: the state is what leaves the box. */
export const ASK_CHARS = 2_000;
export const ROW_CHARS = 4_000;
const LEAF_CHARS = 1_000;
const ITEM_CHARS = 300;
const ARRAY_ITEMS = 12;
const BATCH_MAX = 20;
const ROWS_MAX = 500;
const FILE_MAX_BYTES = 100_000;
const MARKER_MAX_CHARS = 200;
/** Requests in flight across the whole process, whatever the number of parallel tool calls. */
const CONCURRENCY = 4;
/** Wall-clock the lane may add to one tool result; rows not judged by then abstain. */
export const RESULT_DEADLINE_MS = 8_000;
/** Consecutive failed requests that pause the lane, and for how long. */
const COOLDOWN_AFTER = 3;
const COOLDOWN_MS = 60_000;
const TOKENS_MAX = 10_000_000;
const POLICY_KEYS: ReadonlySet<string> = new Set([
  "on",
  "tool",
  "rows",
  "row_fields",
  "ask",
  "questions",
  "mode",
  "threshold",
  "batch",
  "max_rows",
]);
const RESERVED_ON: ReadonlySet<string> = new Set(["before_turn", "run.start", "loop"]);

/** Parse + validate `judge.json`. Strict on purpose and shared by boot and `delta bundle apply`:
 * a bad file is a named failure, never a silently inert lane. `undefined`/empty → no policies. */
export function parseJudgeFile(raw: string | undefined): JudgeFile {
  if (!raw || !raw.trim()) return { version: 1, policies: [] };
  if (Buffer.byteLength(raw) > FILE_MAX_BYTES) throw new Error("judge.json: over the 100KB cap");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("judge.json: not valid JSON");
  }
  if (!isObj(parsed)) throw new Error("judge.json: must be a JSON object");
  if (parsed.version !== 1) throw new Error("judge.json: version must be 1");
  if (!isObj(parsed.policies))
    throw new Error("judge.json: policies must be an object keyed by policy name");
  const policies: JudgePolicy[] = [];
  const tools = new Set<string>();
  for (const [name, v] of Object.entries(parsed.policies)) {
    if (!/^[\w.-]{1,64}$/.test(name))
      throw new Error(`judge.json: policy name "${name}" must match [A-Za-z0-9_.-]{1,64}`);
    const p = parsePolicy(name, v);
    if (tools.has(p.tool))
      throw new Error(`judge.json: policies.${name}: tool "${p.tool}" already has a policy`);
    tools.add(p.tool);
    policies.push(p);
  }
  return { version: 1, policies };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isPath = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[A-Za-z_][\w-]*(\[\d+\])*(\.[A-Za-z_][\w-]*(\[\d+\])*)*$/.test(s) &&
  !/(^|\.)(__proto__|constructor|prototype)(\.|\[|$)/.test(s);
const isIdent = (s: string) =>
  /^[A-Za-z_]\w{0,63}$/.test(s) && !/^(__proto__|constructor|prototype)$/.test(s);

function parsePolicy(name: string, v: unknown): JudgePolicy {
  const at = (msg: string) => new Error(`judge.json: policies.${name}: ${msg}`);
  if (!isObj(v)) throw at("must be an object");
  for (const k of Object.keys(v)) if (!POLICY_KEYS.has(k)) throw at(`unknown key "${k}"`);
  if (v.on !== "tool.result")
    throw at(
      RESERVED_ON.has(String(v.on))
        ? `on="${v.on}" is reserved for a later slice`
        : `on must be "tool.result"`,
    );
  if (typeof v.tool !== "string" || !/^[\w.:-]{1,128}$/.test(v.tool))
    throw at("tool must be an exact tool name");
  if (!isPath(v.rows)) throw at("rows must be a dot path like output.data");
  if (!Array.isArray(v.row_fields) || !v.row_fields.length || !v.row_fields.every(isPath))
    throw at("row_fields must be a non-empty array of dot paths");
  const ask = parseAsk(v.ask, at);
  if (!isObj(v.questions) || !Object.keys(v.questions).length)
    throw at("questions must be a non-empty object");
  const questions: Record<string, JudgeQuestion> = {};
  for (const [qn, q] of Object.entries(v.questions)) {
    if (!isIdent(qn)) throw at(`question "${qn}" must be an identifier`);
    if (!isObj(q)) throw at(`question "${qn}" must be an object`);
    if (q.type !== undefined && q.type !== "noul")
      throw at(`question "${qn}": only type noul in this slice`);
    if (
      typeof q.instructions !== "string" ||
      !q.instructions.trim() ||
      q.instructions.length > 2_000
    )
      throw at(`question "${qn}": instructions must be a string of at most 2000 chars`);
    if (q.criteria !== undefined) {
      if (!isObj(q.criteria)) throw at(`question "${qn}": criteria must be {true, false}`);
      for (const [ck, cv] of Object.entries(q.criteria))
        if ((ck !== "true" && ck !== "false") || typeof cv !== "string" || cv.length > 500)
          throw at(
            `question "${qn}": criteria keys are true/false with string values under 500 chars`,
          );
    }
    questions[qn] = {
      instructions: q.instructions,
      ...(q.criteria ? { criteria: q.criteria as JudgeQuestion["criteria"] } : {}),
    };
  }
  if (v.mode !== undefined && v.mode !== "shadow") throw at("mode must be shadow in this slice");
  let threshold: Record<string, number> | undefined;
  if (v.threshold !== undefined) {
    if (!isObj(v.threshold)) throw at("threshold must be an object");
    threshold = {};
    for (const [k, t] of Object.entries(v.threshold)) {
      if (!(k in questions)) throw at(`threshold names unknown question "${k}"`);
      if (typeof t !== "number" || !(t > 0 && t < 1))
        throw at(`threshold.${k} must be a number in (0,1)`);
      threshold[k] = t;
    }
    if (!Object.keys(threshold).length) threshold = undefined; // {} means "none", never "all"
  }
  const batch = v.batch ?? JUDGE_DEFAULTS.batch;
  if (!Number.isInteger(batch) || (batch as number) < 1 || (batch as number) > BATCH_MAX)
    throw at(`batch must be an integer 1..${BATCH_MAX}`);
  const maxRows = v.max_rows ?? JUDGE_DEFAULTS.max_rows;
  if (!Number.isInteger(maxRows) || (maxRows as number) < 1 || (maxRows as number) > ROWS_MAX)
    throw at(`max_rows must be an integer 1..${ROWS_MAX}`);
  return {
    name,
    on: "tool.result",
    tool: v.tool,
    rows: v.rows,
    row_fields: v.row_fields as string[],
    ask,
    questions,
    mode: "shadow",
    ...(threshold ? { threshold } : {}),
    batch: batch as number,
    max_rows: maxRows as number,
  };
}

function parseAsk(v: unknown, at: (m: string) => Error): JudgeAsk {
  if (!isObj(v))
    throw at('ask must be {"from":"run.input","after":"<marker>"} or {"literal":"..."}');
  if (typeof v.literal === "string") {
    if (!v.literal.trim() || v.literal.length > ASK_CHARS)
      throw at(`ask.literal must be 1..${ASK_CHARS} chars`);
    return { literal: v.literal };
  }
  if (v.from !== "run.input") throw at('ask.from must be "run.input"');
  if (typeof v.after !== "string" || !v.after.trim() || v.after.length > MARKER_MAX_CHARS)
    throw at(
      `ask.after is required: the marker the user's ask follows in the run input (1..${MARKER_MAX_CHARS} chars)`,
    );
  if (
    v.until !== undefined &&
    (typeof v.until !== "string" || !v.until || v.until.length > MARKER_MAX_CHARS)
  )
    throw at(`ask.until must be a marker of 1..${MARKER_MAX_CHARS} chars`);
  return {
    from: "run.input",
    after: v.after,
    ...(typeof v.until === "string" ? { until: v.until } : {}),
  };
}

/** The policy for a tool, if any (exact names only in this slice). */
export function policyFor(policies: readonly JudgePolicy[], tool: string): JudgePolicy | undefined {
  return policies.find((p) => p.tool === tool);
}

/** Resolve the ask for a run. `undefined` = nothing to send (marker absent, or an empty input): the
 * policy abstains rather than ship the whole input. Linear string search, bounded slice. */
export function resolveAsk(ask: JudgeAsk, runInput: string | undefined): string | undefined {
  if ("literal" in ask) return ask.literal;
  if (!runInput) return undefined;
  const at = runInput.indexOf(ask.after);
  if (at < 0) return undefined;
  // The end marker is located on the ORIGINAL text (a scrub could consume the delimiter and
  // let what follows it through), then the bounded segment is scrubbed BEFORE the clip (a
  // secret cut by the clip would leave an unrecognizable prefix).
  let text = runInput.slice(at + ask.after.length);
  if (ask.until) {
    const stop = text.indexOf(ask.until);
    if (stop >= 0) text = text.slice(0, stop);
  }
  text = scrubText(text).trim().slice(0, ASK_CHARS);
  return text ? text : undefined;
}

// --- the wire ---

export type JudgeResult =
  | {
      ok: true;
      answers: Record<string, unknown>;
      inputTokens: number;
      model: string;
      /** The response named the configured model. False = an alias moved or an echo. */
      modelMatched: boolean;
      latencyMs: number;
    }
  | {
      ok: false;
      error: string;
      class: ProviderErrorClass | "timeout";
      status?: number;
      latencyMs: number;
    };

export type JudgeClient = (
  state: unknown,
  questions: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<JudgeResult>;

export type JudgeClientConfig = {
  url: string;
  key: string;
  model: string;
  timeoutMs: number;
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch;
};

/** One HTTP client, no SDK: the request is three fields. The key rides ONLY the Authorization
 * header of this request; it is never on the state, an event, or a file. Provider-authored text
 * (an error body) is scrubbed, the model id must be a plain identifier, usage must be a finite
 * bounded count: an echoing or hostile endpoint can neither leak nor poison anything. */
export function makeJudgeClient(cfg: JudgeClientConfig): JudgeClient {
  const f = cfg.fetch ?? fetch;
  return async (state, questions, signal) => {
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    const onAbort = () => ac.abort();
    if (signal?.aborted) ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const took = () => Math.round(performance.now() - t0);
    const fail = (
      error: string,
      cls: ProviderErrorClass | "timeout",
      status?: number,
    ): JudgeResult => ({
      ok: false,
      error: scrubText(error).slice(0, 200),
      class: cls,
      ...(status ? { status } : {}),
      latencyMs: took(),
    });
    try {
      const res = await f(cfg.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: cfg.model, questions }),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) return fail(text, providerErrorClass(res.status, text), res.status);
      let body: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
      try {
        body = JSON.parse(text);
      } catch {
        return fail("judge returned non-JSON", "request", res.status);
      }
      if (!isObj(body) || !isObj(body.answers))
        return fail("judge returned no answers", "request", res.status);
      const raw = body.usage?.input_tokens;
      const inputTokens =
        typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= TOKENS_MAX ? raw : 0;
      return {
        ok: true,
        answers: body.answers,
        inputTokens,
        // Provider-authored text is never exported as metadata, even identifier-shaped: an
        // echoing endpoint could put the key there. The configured id is the record; whether
        // the answering id matched it is a boolean.
        model: cfg.model,
        modelMatched: body.model === cfg.model,
        latencyMs: took(),
      };
    } catch (e) {
      const aborted = ac.signal.aborted;
      return fail(
        aborted ? `aborted after ${took()}ms` : String(e),
        aborted ? "timeout" : "transient",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

// --- state assembly ---

/** Resolve `a.b[2].c` on parsed JSON. Own properties only; never prototype segments (isPath). */
export function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const seg of path.split(".")) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg);
    if (!m) return undefined;
    if (m[1]) {
      if (!isObj(cur) || !Object.hasOwn(cur, m[1])) return undefined;
      cur = cur[m[1]];
    }
    for (const idx of (m[2] ?? "").matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx[1])];
    }
  }
  return cur;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);
/** Every string that leaves the box goes through here: scrub FIRST (a secret split by a clip
 * would survive a whole-state scrub), then bound. */
const leaf = (s: string, n: number) => clip(scrubText(s), n);
const WALK_DEPTH = 6;
const WALK_NODES = 400;
/** Scrub every string leaf of a decoded value, bounded in depth and size, and serialize. JSON
 * escaping puts a word character before a secret that follows a newline, so a scrub over the
 * serialized text misses it; the leaves are scrubbed decoded, then the text is scrubbed again. */
function scrubDeep(v: unknown, budget: { nodes: number }, depth = 0): unknown {
  if (--budget.nodes < 0 || depth > WALK_DEPTH) return "[omitted]";
  if (typeof v === "string") return scrubText(v);
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v.slice(0, ARRAY_ITEMS)) {
      if (budget.nodes <= 0) {
        out.push("[omitted]");
        break;
      }
      out.push(scrubDeep(x, budget, depth + 1));
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const k in v) {
    if (!Object.hasOwn(v, k)) continue;
    // Stop ENUMERATING when the budget is spent: a 3,000-key object must not be walked,
    // scrubbed and serialized whole (the walk is synchronous and blocks every lane).
    if (budget.nodes <= 0) {
      out["[omitted]"] = true;
      break;
    }
    out[scrubText(k)] = scrubDeep((v as Record<string, unknown>)[k], budget, depth + 1);
  }
  return out;
}
const nested = (v: unknown, n: number) =>
  leaf(JSON.stringify(scrubDeep(v, { nodes: WALK_NODES })) ?? "", n);

/** Bound one field's value: scalars as-is (strings scrubbed + clipped), arrays to a few clipped
 * items, objects to a clipped JSON string. Nothing nested rides unbounded or unscrubbed. */
function boundValue(v: unknown): unknown {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return leaf(v, LEAF_CHARS);
  if (Array.isArray(v))
    return v
      .slice(0, ARRAY_ITEMS)
      .map((x) =>
        typeof x === "string"
          ? leaf(x, ITEM_CHARS)
          : typeof x === "number" || typeof x === "boolean" || x === null
            ? x
            : nested(x, ITEM_CHARS),
      );
  if (typeof v === "object") return nested(v, LEAF_CHARS);
  return undefined;
}

/** The projected row the judge sees: the allowlisted fields, each bounded, the whole under ROW_CHARS. */
export function projectRow(
  row: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let size = 2;
  for (const f of fields) {
    const v = boundValue(getPath(row, f));
    if (v === undefined) continue;
    const s = JSON.stringify(v).length + f.length + 4;
    if (size + s > ROW_CHARS) {
      out._truncated = true;
      break;
    }
    out[f] = v;
    size += s;
  }
  return out;
}

/** The question id the engine generates per row: `<question>__<row index in batch>`. */
export const qid = (name: string, j: number) => `${name}__${j}`;

/** Build one request's state + questions for a batch of rows. `row` in an instruction becomes
 * `rows[j]`. Every leaf was scrubbed in projection; the ask is scrubbed here. */
export function buildRequest(
  policy: JudgePolicy,
  ask: string,
  rows: Record<string, unknown>[],
): { state: unknown; questions: Record<string, unknown> } {
  const state = { ask: scrubText(ask), rows: rows.map((r) => projectRow(r, policy.row_fields)) };
  const questions: Record<string, unknown> = {};
  for (let j = 0; j < rows.length; j++)
    for (const [qn, q] of Object.entries(policy.questions))
      questions[qid(qn, j)] = {
        type: "noul",
        instructions: q.instructions.replace(/`row`/g, `\`rows[${j}]\``),
        ...(q.criteria ? { criteria: q.criteria } : {}),
      };
  return { state, questions };
}

/** A valid Noul answer for an id: `{type:"noul", noul: finite in [0,1]}`; anything else abstains. */
export function noulOf(answers: Record<string, unknown>, id: string): number | undefined {
  const a = answers[id];
  if (!isObj(a) || a.type !== "noul" || typeof a.noul !== "number" || !Number.isFinite(a.noul))
    return undefined;
  return a.noul >= 0 && a.noul <= 1 ? a.noul : undefined;
}

// --- the lane ---

export type JudgeLaneConfig = {
  policies: JudgePolicy[];
  client: JudgeClient;
  /** Finite and non-negative; the config loader guarantees it, the lane clamps anyway. */
  pricePerMtok: number;
  model: string;
  now?: () => number;
};

export type Decision = {
  policy: string;
  mode: "shadow";
  tool: string;
  call_id: string;
  rows_in: number;
  rows_judged: number;
  rows_abstained: number;
  /** Rows past `max_rows`, never sent. rows_in = judged + abstained + capped. */
  rows_capped: number;
  /** Rows that a `filter` mode would have moved out (below EVERY threshold). */
  rows_would_filter: number;
  /** Why rows were left alone: not JSON / path not an array of objects, no ask, cooldown, the cap,
   * the deadline (or the run's cancellation). */
  skipped?: "shape" | "no_ask" | "cooldown" | "max_rows" | "deadline";
  /** Per-row scores for the first thresholded (else first) question: `[row index, noul]`. */
  scores: [number, number][];
  p10?: number;
  p50?: number;
  calls: number;
  cost_usd: number;
  input_tokens: number;
  latency_ms: number;
  model: string;
};

export type CallAttrs = Record<string, unknown>;

type Waiter = { resolve: () => void; cancel: () => void };

/** Process-wide state: the in-flight bound and the failure cooldown, shared by every run. */
export class JudgeLane {
  readonly policies: JudgePolicy[];
  private inFlight = 0;
  private waiters: Waiter[] = [];
  private failures = 0;
  private cooldownUntil = 0;
  private readonly cfg: JudgeLaneConfig;
  constructor(cfg: JudgeLaneConfig) {
    this.cfg =
      Number.isFinite(cfg.pricePerMtok) && cfg.pricePerMtok >= 0
        ? cfg
        : { ...cfg, pricePerMtok: 0 };
    this.policies = cfg.policies;
  }

  policyFor(tool: string): JudgePolicy | undefined {
    return policyFor(this.policies, tool);
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  /** Take a slot, or give up when the deadline or the cancellation arrives first. A released slot
   * is handed straight to the next waiter (never decremented and re-taken), so the bound cannot
   * be barged. */
  private acquire(deadline: number, signal: AbortSignal): Promise<boolean> {
    if (this.inFlight < CONCURRENCY) {
      this.inFlight++;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { resolve: () => resolve(true), cancel: () => resolve(false) };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", giveUp);
      };
      function giveUp() {
        cleanup();
        const i = self.waiters.indexOf(waiter);
        if (i < 0) return;
        self.waiters.splice(i, 1);
        waiter.cancel();
      }
      const self = this;
      timer = setTimeout(giveUp, Math.max(0, deadline - this.now()));
      signal.addEventListener("abort", giveUp, { once: true });
      const granted = waiter.resolve;
      waiter.resolve = () => {
        cleanup();
        granted();
      };
      this.waiters.push(waiter);
    });
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next)
      next.resolve(); // the slot passes hands; inFlight is unchanged
    else this.inFlight--;
  }

  /** Judge one tool result in shadow. Never throws; never changes the result. */
  async judge(
    policy: JudgePolicy,
    input: {
      result: string;
      runInput: string | undefined;
      callId: string;
      deadlineMs?: number;
      /** The run's cancellation; an aborted run stops judging at the next request. */
      signal?: AbortSignal;
    },
    onCall: (attrs: CallAttrs) => void,
  ): Promise<Decision> {
    // A telemetry callback that throws must not lose a row's accounting: it is isolated here,
    // and the caller's failure is its own problem.
    const emit = (attrs: CallAttrs) => {
      try {
        onCall(attrs);
      } catch {
        /* observational only */
      }
    };
    const d: Decision = {
      policy: policy.name,
      mode: "shadow",
      tool: policy.tool,
      call_id: input.callId,
      rows_in: 0,
      rows_judged: 0,
      rows_abstained: 0,
      rows_capped: 0,
      rows_would_filter: 0,
      scores: [],
      calls: 0,
      cost_usd: 0,
      input_tokens: 0,
      latency_ms: 0,
      model: this.cfg.model,
    };
    if (this.now() < this.cooldownUntil) return { ...d, skipped: "cooldown" };
    const ask = resolveAsk(policy.ask, input.runInput);
    if (ask === undefined) return { ...d, skipped: "no_ask" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.result);
    } catch {
      return { ...d, skipped: "shape" };
    }
    const arr = getPath(parsed, policy.rows);
    if (!Array.isArray(arr) || !arr.length || !arr.every(isObj)) return { ...d, skipped: "shape" };
    const rows = arr as Record<string, unknown>[];
    d.rows_in = rows.length;
    if (rows.length > policy.max_rows) {
      d.skipped = "max_rows";
      d.rows_capped = rows.length - policy.max_rows;
    }
    const judged = rows.slice(0, policy.max_rows);
    const key = policy.threshold
      ? Object.keys(policy.threshold)[0]
      : Object.keys(policy.questions)[0];
    const deadline = this.now() + (input.deadlineMs ?? RESULT_DEADLINE_MS);
    const starts: number[] = [];
    for (let i = 0; i < judged.length; i += policy.batch) starts.push(i);
    let next = 0;
    const t0 = performance.now();
    // One cancellation for the whole result: the deadline and the run's own signal both trip it,
    // and it reaches every in-flight request AND every slot wait.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (input.signal?.aborted) ac.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(onAbort, Math.max(0, deadline - this.now()));
    const halted = (): Decision["skipped"] | undefined =>
      ac.signal.aborted || this.now() >= deadline
        ? "deadline"
        : this.now() < this.cooldownUntil
          ? "cooldown"
          : undefined;
    const abstain = (n: number, why: Decision["skipped"]) => {
      d.rows_abstained += n;
      d.skipped = d.skipped ?? why;
    };
    const worker = async () => {
      while (next < starts.length) {
        const start = starts[next++] ?? 0;
        const slice = judged.slice(start, start + policy.batch);
        // Checked before waiting for a slot AND after getting one: a slot that arrives past the
        // deadline, or once the lane cooled down, is not a licence to send.
        const before = halted();
        if (before) {
          abstain(slice.length, before);
          continue;
        }
        if (!(await this.acquire(deadline, ac.signal))) {
          abstain(slice.length, "deadline");
          continue;
        }
        let r: JudgeResult | undefined;
        try {
          const after = halted();
          if (after) abstain(slice.length, after);
          else {
            // Projection or the client can throw on a pathological row (a stringify past the
            // stack, a broken fetch implementation); that batch abstains, the loop goes on.
            const req = buildRequest(policy, ask, slice);
            r = await this.cfg.client(req.state, req.questions, ac.signal);
          }
        } catch {
          abstain(slice.length, "shape");
        } finally {
          this.release();
        }
        if (!r) continue;
        d.calls++;
        if (!r.ok) {
          d.rows_abstained += slice.length;
          // Our own cancellation (deadline or the run's signal) is not an endpoint failure and
          // must not cool the lane down for every other run.
          const ours = r.class === "timeout" && ac.signal.aborted;
          if (ours) d.skipped = d.skipped ?? "deadline";
          else if (++this.failures >= COOLDOWN_AFTER) this.cooldownUntil = this.now() + COOLDOWN_MS;
          emit({
            policy: policy.name,
            mode: "shadow",
            rows: slice.length,
            latency_ms: r.latencyMs,
            status: "error",
            "error.class": r.class,
            ...(r.status ? { http_status: r.status } : {}),
            "error.message": r.error,
          });
          continue;
        }
        this.failures = 0;
        const cost = (r.inputTokens * this.cfg.pricePerMtok) / 1e6;
        d.cost_usd += cost;
        d.input_tokens += r.inputTokens;
        d.model = r.model;
        emit({
          policy: policy.name,
          mode: "shadow",
          rows: slice.length,
          latency_ms: r.latencyMs,
          status: "ok",
          input_tokens: r.inputTokens,
          cost_usd: cost,
          model: r.model,
          model_matched: r.modelMatched,
        });
        for (let j = 0; j < slice.length; j++) {
          const scores: Record<string, number> = {};
          let complete = true;
          for (const qn of Object.keys(policy.questions)) {
            const p = noulOf(r.answers, qid(qn, j));
            if (p === undefined) {
              complete = false;
              break;
            }
            scores[qn] = p;
          }
          if (!complete) {
            d.rows_abstained++;
            continue;
          }
          d.rows_judged++;
          d.scores.push([start + j, round3(scores[key ?? ""] ?? 0)]);
          const th = policy.threshold;
          if (th && Object.keys(th).every((k) => (scores[k] ?? 1) < (th[k] ?? 0)))
            d.rows_would_filter++;
        }
      }
    };
    try {
      // allSettled: a worker can no longer throw, but nothing may ever return before every
      // sibling has settled (a request that outlives the run would bill after finalization).
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(CONCURRENCY, starts.length) }, worker),
      );
      // A worker cannot throw by construction; if one ever does, the rows it never reached
      // are still accounted for rather than vanishing from the counts.
      if (settled.some((w) => w.status === "rejected")) {
        const seen = d.rows_judged + d.rows_abstained;
        if (seen < judged.length) abstain(judged.length - seen, "shape");
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
    if (ac.signal.aborted && d.rows_abstained > 0) d.skipped = d.skipped ?? "deadline";
    d.latency_ms = Math.round(performance.now() - t0);
    if (d.scores.length) {
      const s = d.scores.map((x) => x[1]).sort((a, b) => a - b);
      d.p10 = s[Math.floor(s.length * 0.1)];
      d.p50 = s[Math.floor(s.length * 0.5)];
    }
    return d;
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
