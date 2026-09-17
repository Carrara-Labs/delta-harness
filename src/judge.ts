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
//    a state the engine assembles from an explicit allowlist of row fields plus an ask the operator
//    extracts from the run's input. Nothing it returns is ever inserted anywhere the model reads.
//  · It never throws into a turn, never delays one past its deadline, and never loses a row: a
//    failed, malformed or timed-out request abstains for its rows.
//  · The agent cannot call it and cannot edit its policies (judge.json is a FIXED operator file).
//  · What leaves the box is the projected rows and the extracted ask, scrubbed, and only when the
//    operator authorized egress (DELTA_JUDGE_EGRESS=1) on top of supplying a key.

import { type ProviderErrorClass, providerErrorClass } from "./provider";
import { scrubText } from "./scrub";

export type JudgeQuestion = {
  instructions: string;
  criteria?: { true?: string; false?: string };
};

export type JudgeAsk = { from: "run.input"; match?: string } | { literal: string };

export type JudgePolicy = {
  name: string;
  on: "tool.result";
  /** Exact tool name. One policy per tool. */
  tool: string;
  /** Dot path (with `[i]` indices) into the parsed JSON result to an array of objects. */
  rows: string;
  /** Row keys (dot paths) copied into the judge state. Explicit: nothing else leaves the box. */
  row_fields: string[];
  /** What `ask` is: the run's input (optionally the first capture group of `match`) or a literal. */
  ask: JudgeAsk;
  questions: Record<string, JudgeQuestion>;
  /** Slice 1 accepts only `shadow`; the key exists so the file shape is stable for later modes. */
  mode: "shadow";
  /** Per question, in (0,1). In shadow it only counts `rows_would_filter`. */
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
const MATCH_MAX_CHARS = 200;
/** Requests in flight across the whole process, whatever the number of parallel tool calls. */
const CONCURRENCY = 4;
/** Wall-clock the lane may add to one tool result; rows not judged by then abstain. */
export const RESULT_DEADLINE_MS = 8_000;
/** Consecutive failed requests that pause the lane, and for how long. */
const COOLDOWN_AFTER = 3;
const COOLDOWN_MS = 60_000;
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
    if (!/^[A-Za-z_]\w{0,63}$/.test(qn)) throw at(`question "${qn}" must be an identifier`);
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
    throw at('ask must be {"from":"run.input","match":"<regex>"} or {"literal":"..."}');
  if (typeof v.literal === "string") {
    if (!v.literal.trim() || v.literal.length > ASK_CHARS)
      throw at(`ask.literal must be 1..${ASK_CHARS} chars`);
    return { literal: v.literal };
  }
  if (v.from !== "run.input") throw at('ask.from must be "run.input"');
  if (v.match === undefined) return { from: "run.input" };
  if (typeof v.match !== "string" || !v.match || v.match.length > MATCH_MAX_CHARS)
    throw at(`ask.match must be a regex source of at most ${MATCH_MAX_CHARS} chars`);
  let re: RegExp;
  try {
    re = new RegExp(v.match);
  } catch {
    throw at("ask.match is not a valid regex");
  }
  if (new RegExp(`${re.source}|`).exec("")!.length !== 2)
    throw at("ask.match must have exactly one capture group");
  return { from: "run.input", match: v.match };
}

/** The policy for a tool, if any (exact names only in this slice). */
export function policyFor(policies: readonly JudgePolicy[], tool: string): JudgePolicy | undefined {
  return policies.find((p) => p.tool === tool);
}

/** Resolve the ask for a run. `undefined` = nothing to send (a `match` that did not match, or an
 * empty input): the policy abstains rather than ship the whole input. */
export function resolveAsk(ask: JudgeAsk, runInput: string | undefined): string | undefined {
  if ("literal" in ask) return ask.literal;
  if (!runInput) return undefined;
  let text = runInput;
  if (ask.match) {
    const m = new RegExp(ask.match).exec(runInput);
    if (!m || !m[1]?.trim()) return undefined;
    text = m[1];
  }
  return text.trim().slice(0, ASK_CHARS);
}

// --- the wire ---

export type JudgeResult =
  | {
      ok: true;
      answers: Record<string, unknown>;
      inputTokens: number;
      model: string;
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
 * header of this request; it is never on the state, an event, or a file. */
export function makeJudgeClient(cfg: JudgeClientConfig): JudgeClient {
  const f = cfg.fetch ?? fetch;
  return async (state, questions) => {
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    const took = () => Math.round(performance.now() - t0);
    try {
      const res = await f(cfg.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: cfg.model, questions }),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok)
        return {
          ok: false,
          error: text.slice(0, 200),
          class: providerErrorClass(res.status, text),
          status: res.status,
          latencyMs: took(),
        };
      let body: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
      try {
        body = JSON.parse(text);
      } catch {
        return {
          ok: false,
          error: "judge returned non-JSON",
          class: "request",
          status: res.status,
          latencyMs: took(),
        };
      }
      if (!isObj(body) || !isObj(body.answers))
        return {
          ok: false,
          error: "judge returned no answers",
          class: "request",
          status: res.status,
          latencyMs: took(),
        };
      const inputTokens =
        typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : 0;
      return {
        ok: true,
        answers: body.answers,
        inputTokens,
        model: typeof body.model === "string" ? body.model : cfg.model,
        latencyMs: took(),
      };
    } catch (e) {
      const aborted = ac.signal.aborted;
      return {
        ok: false,
        error: aborted ? `timeout after ${cfg.timeoutMs}ms` : String(e).slice(0, 200),
        class: aborted ? "timeout" : "transient",
        latencyMs: took(),
      };
    } finally {
      clearTimeout(timer);
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

/** Bound one field's value: scalars as-is (strings clipped), arrays to a few clipped items,
 * objects to a clipped JSON string. Nothing nested rides unbounded. */
function boundValue(v: unknown): unknown {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return clip(v, LEAF_CHARS);
  if (Array.isArray(v))
    return v
      .slice(0, ARRAY_ITEMS)
      .map((x) =>
        typeof x === "string"
          ? clip(x, ITEM_CHARS)
          : typeof x === "number" || typeof x === "boolean" || x === null
            ? x
            : clip(JSON.stringify(x), ITEM_CHARS),
      );
  if (typeof v === "object") return clip(JSON.stringify(v), LEAF_CHARS);
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
 * `rows[j]`. The serialized state is scrubbed (registered secrets + secret-shaped text) before it
 * leaves; a state that no longer parses after scrubbing is not sent. */
export function buildRequest(
  policy: JudgePolicy,
  ask: string,
  rows: Record<string, unknown>[],
): { state: unknown; questions: Record<string, unknown> } | undefined {
  const raw = JSON.stringify({ ask, rows: rows.map((r) => projectRow(r, policy.row_fields)) });
  let state: unknown;
  try {
    state = JSON.parse(scrubText(raw));
  } catch {
    return undefined;
  }
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
  /** Rows that a `filter` mode would have moved out (below EVERY threshold). */
  rows_would_filter: number;
  /** Why rows were left alone: not JSON / path not an array of objects, no ask, cooldown, the cap. */
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

/** Process-wide state: the in-flight bound and the failure cooldown, shared by every run. */
export class JudgeLane {
  readonly policies: JudgePolicy[];
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  private failures = 0;
  private cooldownUntil = 0;
  constructor(private cfg: JudgeLaneConfig) {
    this.policies = cfg.policies;
  }

  policyFor(tool: string): JudgePolicy | undefined {
    return policyFor(this.policies, tool);
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < CONCURRENCY) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
  }
  private release(): void {
    this.inFlight--;
    this.waiters.shift()?.();
  }

  /** Judge one tool result in shadow. Never throws; never changes the result. */
  async judge(
    policy: JudgePolicy,
    input: { result: string; runInput: string | undefined; callId: string; deadlineMs?: number },
    onCall: (attrs: CallAttrs) => void,
  ): Promise<Decision> {
    const d: Decision = {
      policy: policy.name,
      mode: "shadow",
      tool: policy.tool,
      call_id: input.callId,
      rows_in: 0,
      rows_judged: 0,
      rows_abstained: 0,
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
    if (rows.length > policy.max_rows) d.skipped = "max_rows";
    const judged = rows.slice(0, policy.max_rows);
    const key = policy.threshold
      ? Object.keys(policy.threshold)[0]
      : Object.keys(policy.questions)[0];
    const deadline = this.now() + (input.deadlineMs ?? RESULT_DEADLINE_MS);
    const starts: number[] = [];
    for (let i = 0; i < judged.length; i += policy.batch) starts.push(i);
    let next = 0;
    const t0 = performance.now();
    const worker = async () => {
      while (next < starts.length) {
        const start = starts[next++] ?? 0;
        const slice = judged.slice(start, start + policy.batch);
        if (this.now() >= deadline) {
          d.rows_abstained += slice.length;
          d.skipped = d.skipped ?? "deadline";
          continue;
        }
        const req = buildRequest(policy, ask, slice);
        if (!req) {
          d.rows_abstained += slice.length;
          continue;
        }
        await this.acquire();
        let r: JudgeResult;
        try {
          r = await this.cfg.client(req.state, req.questions);
        } finally {
          this.release();
        }
        d.calls++;
        d.latency_ms += r.latencyMs;
        if (!r.ok) {
          d.rows_abstained += slice.length;
          if (++this.failures >= COOLDOWN_AFTER) this.cooldownUntil = this.now() + COOLDOWN_MS;
          onCall({
            policy: policy.name,
            mode: "shadow",
            rows: slice.length,
            latency_ms: r.latencyMs,
            status: "error",
            "error.class": r.class,
            ...(r.status ? { http_status: r.status } : {}),
            "error.message": r.error.slice(0, 200),
          });
          continue;
        }
        this.failures = 0;
        const cost = (r.inputTokens * this.cfg.pricePerMtok) / 1e6;
        d.cost_usd += cost;
        d.input_tokens += r.inputTokens;
        d.model = r.model;
        onCall({
          policy: policy.name,
          mode: "shadow",
          rows: slice.length,
          latency_ms: r.latencyMs,
          status: "ok",
          input_tokens: r.inputTokens,
          cost_usd: cost,
          model: r.model,
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
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, starts.length) }, worker));
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
