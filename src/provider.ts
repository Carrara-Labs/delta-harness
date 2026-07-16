// SPDX-License-Identifier: Apache-2.0
// Model provider: any OpenAI-compatible /chat/completions endpoint (OpenRouter, the
// subscription broker, the knowledge base's LLM proxy) — pure config, no SDK, no runtime deps.
// Error-as-value at the type level: this module NEVER throws past its boundary; every
// failure (HTTP, network, mid-stream, abort) comes back as { ok: false }. Internal
// message format IS the OpenAI wire format — zero conversion layers.

import { BrokerMintError, type Credential, NoServableToken } from "./broker";
import { priceUsd } from "./pricing";
import { untrustedToolResult } from "./untrusted";

/** Multimodal user parts (Sprint 8) — OpenAI chat/completions native shape; the
 * Anthropic/Responses translators map it. Produced ONLY ephemerally at request
 * build (expandImageMarkers); persisted transcripts stay plain strings. */
export type UserPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type WireToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
};

export type Usage = {
  /** GROSS prompt tokens (fresh + cacheRead + cacheWrite) on every wire path. */
  input: number;
  output: number;
  cacheRead: number;
  /** Cache-CREATION tokens (Anthropic native reports them separately; bills at 1.25× in).
   * The rolling breakpoints write cache every turn, so this is nonzero on healthy runs. */
  cacheWrite: number;
  total: number;
  costUsd: number;
};

export type AssistantMsg = Extract<ChatMsg, { role: "assistant" }>;

export type ModelResult =
  | {
      ok: true;
      model: string;
      message: AssistantMsg;
      finishReason: string;
      usage: Usage;
      latencyMs: number;
      /** Which provider in the cascade served this turn (§C / G1c). */
      provider?: string;
    }
  | {
      ok: false;
      model: string;
      error: string;
      status?: number;
      /** Parsed Retry-After (ms) from a 429, when the backend sent one — feeds the
       * subscription credential's cooldown so a shared identity isn't re-hit while throttled. */
      retryAfter?: number;
      aborted?: boolean;
      provider?: string;
    };

export type ProviderConfig = {
  baseUrl: string;
  apiKey: string;
  /** Failover chain: try models[0], fall through on exhausted retries. */
  models: string[];
  maxRetries?: number;
  /** Bearer source. Omit → static `apiKey` (OpenRouter). Set → broker-minted
   * subscription token (may add a chatgpt-account-id header). */
  credential?: Credential;
  /** Wire format. "openai" (default) = /chat/completions (OpenRouter, most
   * OpenAI-compatible endpoints). "anthropic" = the native Anthropic Messages
   * API (/v1/messages). "responses" = the OpenAI Responses API (/responses) —
   * the ChatGPT/Codex subscription backend the broker token targets (§C). */
  api?: "openai" | "anthropic" | "responses";
  /** Static extra headers merged into every request to this provider, at LOWEST
   * precedence (content-type / authorization / the credential's own headers always
   * win). Product-neutral seam: the engine carries arbitrary headers; the bundle
   * supplies the values (e.g. a Codex bundle sets `originator: codex_cli_rs`). Keys
   * are pre-normalized to lowercase and reserved names rejected at config load. */
  headers?: Record<string, string>;
  /** Label recorded on the served turn's event when this provider is used (G1c). */
  label?: string;
  /** Absolute wall-clock cap on a single model call (ms). A generous backstop for a
   * hung provider — the idle watchdog below is the fast stall detector. Default 600s. */
  timeoutMs?: number;
  /** Per-network-chunk idle watchdog (ms): abort if the SSE stream delivers no bytes
   * for this long. Resets every chunk, so a healthy long stream is never cut; a stalled
   * socket dies in `streamIdleMs`, not `timeoutMs`. 0 disables. Default 60s. */
  streamIdleMs?: number;
};

/** Provider error strings that mean "the prompt overflowed the model's context window"
 * — a compact-and-retry signal, NOT a terminal failure. Trimmed to the three wire APIs
 * Delta actually speaks (Anthropic, OpenAI-Responses, OpenRouter); grounded in a
 * 24-pattern overflow catalog minus providers we never call. */
export const OVERFLOW =
  /prompt is too long|request_too_large|exceeds the context window|maximum context length of [\d,]+ tokens?|maximum context length is \d+ tokens|context[_ ]length[_ ]exceeded/i;

/** Should the cascade fall through to the next provider on this result? Per §C:
 * a NoServableToken (409), an auth failure (401/403), a rate limit (429), a 5xx
 * after in-provider retries, or a network error. A plain 4xx (our bad request) is
 * NOT failover-worthy — retrying it on the next provider just burns two of them. */
export function failoverWorthy(r: ModelResult): boolean {
  if (r.ok || r.aborted) return false;
  const s = r.status;
  return s === undefined || s === 409 || s === 401 || s === 403 || s === 429 || s >= 500;
}

/** Try each provider in order; fall through on a failover-worthy error, stamping
 * the serving provider's label onto the result. The first ok/aborted/non-failover
 * result wins. Each provider does its own in-provider model+retry loop (`chat`).
 *
 * Poisoned-stream guard (codex P1): once a provider has streamed any text delta to
 * the consumer, we CANNOT retry on another provider — a second attempt would
 * concatenate a second answer onto the same SSE response. So failover only applies
 * before the first byte is emitted (which covers auth 409/401, rate limits, and
 * connect errors — they fail before streaming). A mid-stream break returns the
 * error, exactly as a single provider already would. */
export async function chatVia(providers: ProviderConfig[], req: ChatRequest): Promise<ModelResult> {
  let last: ModelResult = { ok: false, model: "", error: "no providers configured" };
  for (const p of providers) {
    let streamed = false;
    const perAttempt: ChatRequest = req.onDelta
      ? {
          ...req,
          onDelta: (t) => {
            streamed = true;
            req.onDelta?.(t);
          },
        }
      : req;
    const res = await chat(p, perAttempt);
    last = p.label ? { ...res, provider: p.label } : res;
    if (last.ok || last.aborted || streamed || !failoverWorthy(last)) return last;
  }
  return last;
}

export type ChatRequest = {
  messages: ChatMsg[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Streaming text deltas (SSE progress later); assembly happens regardless. */
  onDelta?: (text: string) => void;
  /** Streaming extended-thinking / reasoning deltas, per wire (Anthropic `thinking_delta`,
   * OpenAI-compat `reasoning`/`reasoning_content`, Responses reasoning-summary). Purely
   * observational: it is NEVER coupled to the `emitted` failover guard, so a provider that
   * streams reasoning then fails pre-answer can still fail over — reasoning capture cannot
   * change execution. Live-only; not persisted. */
  onReasoningDelta?: (text: string) => void;
  /** Cache-affinity key (the session id). Anthropic paths get rolling cache_control
   * breakpoints; the OpenAI Responses backend caches by prefix + this routing key
   * (`prompt_cache_key`, clamped to 64 chars). */
  cacheKey?: string;
  /** Reasoning effort when the model supports extended thinking. Mapped per wire:
   * OpenAI-Responses (subscription) + OpenRouter → `reasoning.effort`; a direct
   * OpenAI-compatible endpoint → `reasoning_effort`; the Anthropic-native wire takes
   * a thinking token budget, so the effort is mapped to one. Absent → the provider's
   * own default (no reasoning field is sent). */
  reasoningEffort?: ReasoningEffort;
};

/** A reasoning/thinking effort. Deliberately a bare string, NOT a fixed enum: the OpenAI docs state
 * the supported set is "model-dependent" (per the Reasoning guide + the Codex backend's own 400:
 * none|minimal|low|medium|high|xhigh) and OpenAI can add tiers, so the harness must NOT gate — any
 * operator-set effort passes straight through as reasoning.effort and the MODEL is the authority. An
 * unsupported one is a clean 4xx (error-as-value), never a crash or a silent drop. Set via
 * DELTA_REASONING_EFFORT (or per-run metadata). Note "auto" is NOT an effort (it's reasoning.summary). */
export type ReasoningEffort = string;

/** The efforts we recognize today — for docs + the Anthropic thinking-budget map ONLY. This is NOT a
 * gate: an effort outside this list still reaches the model. Mirrors the canonical OpenAI set. */
export const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Effort → Anthropic thinking budget (tokens); the native wire has no effort enum. An effort not in
 * the map (a model-specific or future tier) falls back to the `high` budget; `none` → 0 = no thinking. */
const THINKING_BUDGET: Record<string, number> = {
  none: 0,
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
};
const DEFAULT_THINKING_BUDGET = 16384; // unknown effort → treat as "high" on the Anthropic wire

/** Normalize an effort from env/metadata: trim + lowercase, pass ANY non-empty value through (the
 * model validates it). Empty / non-string → undefined (send nothing, use the provider default). */
export function normalizeEffort(v: unknown): ReasoningEffort | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s || undefined;
}

const RETRIABLE =
  /overloaded|rate.?limit|timeout|timed out|fetch failed|socket|ECONN|network|stream ended|Unterminated/i;

function retriable(status: number | undefined, message: string): boolean {
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) return true;
  if (status !== undefined) return false; // other HTTP 4xx: our fault, don't retry
  return RETRIABLE.test(message);
}

/** Conservative cooldown for a subscription 429 that carried no usable Retry-After — long enough
 * to give a throttled shared identity a rest, short enough not to strand the sub for a whole turn. */
const DEFAULT_429_COOLDOWN_MS = 20_000;

/** Classify a MID-STREAM error (an SSE `error`/`response.failed` event) into an HTTP-ish status so
 * chat() can still repair/cool the credential after a streamed auth/rate failure (codex P1) — the
 * SSE event carries no status line. Keyword heuristic over the error text; unknown → undefined. */
function streamErrorStatus(text: string): number | undefined {
  const s = text.toLowerCase();
  if (/\b429\b|rate.?limit|too many requests|quota|overloaded/.test(s)) return 429;
  if (
    /\b401\b|unauthorized|invalid.?(api.?key|token|authentication)|expired.?token|token.?expired/.test(
      s,
    )
  )
    return 401;
  if (/\b403\b|forbidden|permission.?denied/.test(s)) return 403;
  return undefined;
}

/** Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into ms from now.
 * Missing/garbled → undefined. Clamped to a sane [0, 5min] so a hostile/huge value can't
 * pin the subscription off for hours. */
function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  let ms: number;
  if (Number.isFinite(secs)) ms = secs * 1000;
  else {
    const when = Date.parse(v);
    if (!Number.isFinite(when)) return undefined;
    ms = when - Date.now();
  }
  if (ms <= 0) return undefined;
  return Math.min(ms, 5 * 60_000);
}

const DEFAULT_TIMEOUT_MS = 600_000; // absolute cap: 10 min, matching common SDK defaults
const DEFAULT_IDLE_MS = 60_000; // per-chunk stall watchdog — the fast stall detector

/** Compose the caller's cancel signal with an absolute wall-clock cap and (optionally)
 * a per-chunk idle controller into ONE AbortSignal for fetch. One seam covers connect +
 * TTFB + total duration + mid-stream stall + caller cancel — leaner than carrying three
 * separate signals or five env-tuned timeouts. */
export function withTimeout(
  signal: AbortSignal | undefined,
  ms: number,
  idle?: AbortController,
): AbortSignal {
  // AbortSignal.timeout retains its native timer until it fires (~0.5KB for up to `ms`),
  // even after the call settles. At Delta's scale (concurrency 4, one live signal per
  // in-flight attempt) that's tens of KB worst-case — accepted for the leaner API.
  const parts: AbortSignal[] = [AbortSignal.timeout(ms)];
  if (signal) parts.push(signal);
  if (idle) parts.push(idle.signal);
  return parts.length === 1 ? (parts[0] as AbortSignal) : AbortSignal.any(parts);
}

/** Race a promise against an abort signal (with listener cleanup) — bounds work that
 * happens BEFORE fetch, like a broker credential mint, under the same deadline. */
function raceAbort<T>(p: Promise<T>, sig: AbortSignal): Promise<T> {
  if (sig.aborted) return Promise.reject(sig.reason ?? new DOMException("aborted", "AbortError"));
  return new Promise((res, rej) => {
    const onAbort = () => rej(sig.reason ?? new DOMException("aborted", "AbortError"));
    sig.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        sig.removeEventListener("abort", onAbort);
        res(v);
      },
      (e) => {
        sig.removeEventListener("abort", onAbort);
        rej(e);
      },
    );
  });
}

/** Classify a fetch/stream throw against OUR composed signal. Keys off the ORIGINAL caller
 * signal, so a timeout is never mistaken for a user cancel. `emitted` = we already streamed
 * text to the consumer, so a retry would double-render → terminal (non-retriable); a
 * pre-first-token timeout is safe to retry/failover (the "timed out" string hits RETRIABLE).
 * Returns null when the error isn't a timeout/abort we own — a genuine network error the
 * caller handles exactly as before. */
function classifyTimeout(
  model: string,
  e: unknown,
  req: ChatRequest,
  emitted: boolean,
  ms: number,
): ModelResult | null {
  if (req.signal?.aborted) return { ok: false, model, error: "aborted", aborted: true };
  const name = (e as { name?: string } | undefined)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return emitted
      ? { ok: false, model, error: "model stream stalled after first token" } // terminal: don't re-stream
      : { ok: false, model, error: `model call timed out after ${ms}ms before first token` };
  }
  return null;
}

/** Bound any provider error body into a readable one-liner (a minimized error normalizer).
 * Keeps error.type/code alongside the message — Anthropic carries `request_too_large` in
 * error.type (413), not the message, and OVERFLOW matching needs to see it (codex #9). */
function normalizeError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string; code?: string | number } | string;
      message?: string;
    };
    const e = parsed.error;
    const msg =
      (typeof e === "object" && e?.message) || (typeof e === "string" && e) || parsed.message;
    const code = typeof e === "object" ? (e?.type ?? e?.code) : undefined;
    if (typeof msg === "string" && msg) {
      const line = code && !msg.includes(String(code)) ? `${code}: ${msg}` : msg;
      return line.slice(0, 2000);
    }
    if (code) return String(code).slice(0, 2000);
  } catch {}
  return body.slice(0, 2000) || "(empty error body)";
}

export async function chat(cfg: ProviderConfig, req: ChatRequest): Promise<ModelResult> {
  const maxRetries = cfg.maxRetries ?? 2;
  let last: ModelResult = { ok: false, model: cfg.models[0] ?? "", error: "no models configured" };
  // Poisoned-stream guard INSIDE the provider too (codex #1): once any delta reached the
  // consumer, an in-provider retry or next-model fallthrough would concatenate a second
  // answer onto the same SSE response — exactly the bug chatVia guards across providers.
  let streamed = false;
  const perCall: ChatRequest = req.onDelta
    ? {
        ...req,
        onDelta: (t) => {
          streamed = true;
          req.onDelta?.(t);
        },
      }
    : req;
  const once =
    cfg.api === "anthropic"
      ? streamAnthropic
      : cfg.api === "responses"
        ? streamResponses
        : streamOnce;
  // A shared-identity subscription credential exposes penalize() — used to scope identity-wide
  // 429 handling to it (a metered/keyed provider keeps its normal per-model retry+failover).
  const shared = !!cfg.credential?.penalize;
  let reauthed = false; // H2: at most one credential re-mint retry per chat() call
  for (const model of cfg.models) {
    for (let attempt = 0; ; attempt++) {
      last = await once(cfg, model, perCall);
      if (last.ok || last.aborted) return last;
      const s = last.status;
      // Repair/cool the credential on a rejection FIRST — this must happen even if we already
      // streamed (we can't retry mid-turn, but the NEXT turn must not reuse a dead token or
      // re-hit a throttled identity). Invalidate on EVERY 401/403 (codex P1): the reauthed flag
      // below only gates the in-turn RETRY, not the cache-drop, so a persistent 401 keeps
      // re-minting across turns instead of pinning the rejected bearer until expiry.
      if (s === 401 || s === 403) cfg.credential?.invalidate?.();
      if (s === 429 && shared) {
        // Cool the shared identity down. Honor Retry-After when parseable; else a conservative
        // default. Jitter desynchronizes the fleet so VMs don't all reopen on the same boundary.
        const base = last.retryAfter ?? DEFAULT_429_COOLDOWN_MS;
        cfg.credential?.penalize?.(base + Math.floor(Math.random() * 5_000));
      }
      if (streamed) return last; // poisoned: deltas already rendered — no retry, no next model
      // H2: after invalidating a rejected bearer, re-mint + retry the SAME model once — covers a
      // token revoked/rotated before its claimed expiry (the broker may have a fresher one). This
      // re-auth is NOT a transient-error attempt, so don't spend a retry slot on it (codex P2): the
      // `attempt--` cancels the loop's `attempt++` so a later 5xx still gets its full retry budget.
      if ((s === 401 || s === 403) && cfg.credential?.invalidate && !reauthed) {
        reauthed = true;
        attempt--;
        continue;
      }
      // Credential-wide failures aren't model-specific — don't try this provider's other models,
      // fail over to the next provider. A 429 is identity-wide only for a SHARED subscription
      // credential; a metered/keyed provider falls through to its normal retry+next-model path.
      if (s === 401 || s === 403 || s === 409 || (s === 429 && shared)) return last;
      if (!retriable(s, last.error) || attempt >= maxRetries) break; // next model
      const delay = Math.min(500 * 2 ** attempt + Math.random() * 250, 10_000);
      await Bun.sleep(delay);
      if (req.signal?.aborted) return { ok: false, model, error: "aborted", aborted: true };
    }
  }
  return last;
}

type Chunk = {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      // Non-standard reasoning fields emitted by OpenAI-compatible gateways:
      // OpenRouter → `reasoning`; DeepSeek and others → `reasoning_content`.
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; code?: number | string };
};

// Prompt caching — the biggest token lever (architecture "Prompt caching").
// Anthropic caches everything up to a `cache_control` breakpoint. TWO breakpoints (of the
// 4 allowed):
//   1. The system message (spine + tool index) — the stable prefix. Tools precede system
//      in Anthropic's cache order, so their schemas ride the same breakpoint.
//   2. ROLLING: the last user/tool message. Each turn's request writes a cache entry ending
//      at its own tail; the NEXT call's prompt extends that exact prefix, so the growing
//      transcript is served at the cache-read rate instead of re-billed fresh every turn.
//      Without this the lean edge decays on long runs (measured 8.5× → 3.7×): only the spine
//      was cached while the tail — most of the tokens by turn 10 — was full-rate. (Sprint 2;
//      a documented provider-caching technique.)
// OpenAI-family models cache automatically; only cache metadata is Anthropic-specific.
// Tool-result framing applies on every wire path.
function withPromptCache(messages: ChatMsg[], model: string): unknown[] {
  const framed = messages.map((m) =>
    m.role === "tool" ? { ...m, content: untrustedToolResult(m.content) } : m,
  );
  if (!/anthropic|claude/i.test(model)) return framed;
  const cc = { cache_control: { type: "ephemeral" } };
  // Mark the LAST system message only (Anthropic hard-caps 4 explicit breakpoints; marking
  // every system could exceed it — codex #6) + the last TWO user/tool messages. Two rolling
  // marks (not one) because Anthropic's cache lookup only scans ~20 blocks back from a
  // breakpoint: a turn with many parallel tool calls can add >20 blocks, jumping past a
  // single previous mark and forcing a full cache rewrite (codex #7). Total: 3 of 4.
  let lastSystem = -1;
  const rolling: number[] = []; // last two PERSISTED user/tool indices
  for (let i = framed.length - 1; i >= 0; i--) {
    const m = framed[i];
    const r = m?.role;
    if (lastSystem < 0 && r === "system") lastSystem = i;
    // String-content only: the trailing parts-array user message (the ephemeral
    // image attachment, Sprint 8) is DERIVED and moves every turn — marking it
    // burns one of the two rolling breakpoints on a prefix that can never match
    // the next request (codex S8 #11). Mark stable transcript messages instead.
    if (rolling.length < 2 && (r === "user" || r === "tool") && typeof m?.content === "string")
      rolling.push(i);
    if (lastSystem >= 0 && rolling.length === 2) break;
  }
  return framed.map((m, i) => {
    if (m.role === "system" && i === lastSystem)
      return { role: "system", content: [{ type: "text", text: m.content, ...cc }] };
    if (rolling.includes(i) && typeof m.content === "string" && m.content) {
      if (m.role === "user")
        return { role: "user", content: [{ type: "text", text: m.content, ...cc }] };
      if (m.role === "tool")
        return {
          role: "tool",
          tool_call_id: m.tool_call_id,
          content: [{ type: "text", text: m.content, ...cc }],
        };
    }
    return m;
  });
}

async function streamOnce(
  cfg: ProviderConfig,
  model: string,
  req: ChatRequest,
): Promise<ModelResult> {
  const start = performance.now();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleMs = cfg.streamIdleMs ?? DEFAULT_IDLE_MS;
  const idle = idleMs > 0 ? new AbortController() : undefined;
  // One composed deadline for the WHOLE call — including the credential mint that happens
  // before fetch (a hung broker must not escape the timeout; codex #6).
  const sig = withTimeout(req.signal, timeoutMs, idle);
  let emitted = false; // streamed text to the consumer → a retry would double-render
  const openrouter = cfg.baseUrl.includes("openrouter.ai");
  const body: Record<string, unknown> = {
    model,
    messages: withPromptCache(req.messages, model),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (openrouter) body.usage = { include: true }; // adds cost to the final usage chunk
  if (req.tools?.length) body.tools = req.tools;
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  // Reasoning effort: OpenRouter takes a unified `reasoning: {effort}` (it normalizes
  // effort→budget per routed model); a direct OpenAI-compatible endpoint takes the flat
  // `reasoning_effort`. Either is ignored by a non-reasoning model on most gateways.
  if (req.reasoningEffort) {
    if (openrouter) body.reasoning = { effort: req.reasoningEffort };
    else body.reasoning_effort = req.reasoningEffort;
  }

  // Resolve the bearer before the request: static key, or a broker-minted
  // subscription token (cached until near expiry) that may carry a
  // chatgpt-account-id header. A 409 (no servable token) is surfaced with its
  // status so a caller can fall back to a metered provider (§C).
  let auth: { token: string; headers?: Record<string, string> };
  try {
    auth = cfg.credential ? await raceAbort(cfg.credential.get(), sig) : { token: cfg.apiKey };
  } catch (e) {
    const t = classifyTimeout(model, e, req, emitted, timeoutMs);
    if (t) return t;
    return {
      ok: false,
      model,
      error: String(e),
      ...(e instanceof NoServableToken ? { status: 409 } : {}),
      ...(e instanceof BrokerMintError ? { status: e.status } : {}),
    };
  }

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        ...cfg.headers,
        "content-type": "application/json",
        authorization: `Bearer ${auth.token}`,
        ...auth.headers,
      },
      body: JSON.stringify(body),
      signal: sig,
    });
  } catch (e) {
    const t = classifyTimeout(model, e, req, emitted, timeoutMs);
    if (t) return t;
    const aborted = req.signal?.aborted ?? false;
    return { ok: false, model, error: aborted ? "aborted" : String(e), aborted };
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    if (req.signal?.aborted) return { ok: false, model, error: "aborted", aborted: true };
    const retryAfter =
      res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
    return {
      ok: false,
      model,
      status: res.status,
      error: normalizeError(text),
      ...(retryAfter ? { retryAfter } : {}),
    };
  }

  // Assemble the streamed message. Tool-call deltas are keyed by index but may
  // only carry the id on the first fragment — reconcile via both (a two-map).
  let content = "";
  let finishReason = "stop";
  let terminal = false; // saw [DONE] or a finish_reason — else the stream was truncated
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 };
  const byIndex = new Map<number, WireToolCall>();
  const byId = new Map<string, WireToolCall>();
  const calls: WireToolCall[] = [];

  try {
    for await (const data of sseLines(res.body, idle ? { ctrl: idle, ms: idleMs } : undefined)) {
      if (data === "[DONE]") {
        terminal = true;
        break;
      }
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        continue; // tolerate keep-alive noise
      }
      if (chunk.error) {
        const msg = chunk.error.message ?? "mid-stream provider error";
        const status = streamErrorStatus(msg);
        return { ok: false, model, error: msg, ...(status ? { status } : {}) };
      }
      if (chunk.usage) {
        usage.input = chunk.usage.prompt_tokens ?? 0;
        usage.output = chunk.usage.completion_tokens ?? 0;
        usage.total = chunk.usage.total_tokens ?? usage.input + usage.output;
        usage.cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage.costUsd = chunk.usage.cost ?? 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        terminal = true;
      }
      const delta = choice.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        req.onDelta?.(delta.content);
        emitted = true;
      }
      // Reasoning is observational only — never sets `emitted` (see ChatRequest.onReasoningDelta).
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) req.onReasoningDelta?.(reasoning);
      for (const tc of delta.tool_calls ?? []) {
        let call = tc.index !== undefined ? byIndex.get(tc.index) : undefined;
        if (!call && tc.id) call = byId.get(tc.id);
        if (!call) {
          call = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } };
          calls.push(call);
          if (tc.index !== undefined) byIndex.set(tc.index, call);
        }
        if (tc.id) {
          call.id = tc.id;
          byId.set(tc.id, call);
        }
        if (tc.function?.name) call.function.name = tc.function.name;
        if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
      }
    }
  } catch (e) {
    const t = classifyTimeout(model, e, req, emitted, timeoutMs);
    if (t) return t;
    const aborted = req.signal?.aborted ?? false;
    return { ok: false, model, error: aborted ? "aborted" : `stream broke: ${String(e)}`, aborted };
  }

  // A clean EOF WITHOUT [DONE]/finish_reason is a TRUNCATED stream, not a success —
  // returning ok would silently persist a half-answer. "stream ended" hits RETRIABLE, so a
  // pre-emit truncation retries; a post-emit one is blocked by chat()'s poisoned guard.
  if (!terminal) return { ok: false, model, error: "stream ended before completion" };

  // OpenRouter reports a metered `cost` (kept above); fall back to the price table only if
  // it didn't, so this path is never silently $0 for a priced model.
  if (!usage.costUsd) usage.costUsd = priceUsd(model, usage);

  const message: AssistantMsg = { role: "assistant", content: content || null };
  if (calls.length) message.tool_calls = calls;
  return {
    ok: true,
    model,
    message,
    finishReason,
    usage,
    latencyMs: Math.round(performance.now() - start),
  };
}

/** Minimal SSE reader: yields the payload of each `data:` line. When `idle` is set, a
 * watchdog re-arms on every network chunk and aborts the (composed) fetch signal if no
 * bytes arrive within `idle.ms` — so a stalled socket fails fast without capping a healthy
 * long stream (a per-read reset most HTTP clients provide, done in-house). */
async function* sseLines(
  stream: ReadableStream<Uint8Array>,
  idle?: { ctrl: AbortController; ms: number },
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (!idle) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => idle.ctrl.abort(), idle.ms);
  };
  try {
    arm();
    for await (const bytes of stream) {
      arm();
      buf += decoder.decode(bytes, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Native Anthropic Messages API (§C P1) ─────────────────────────────────────
// Same ModelResult contract, error-as-value, and prompt caching — but the native
// wire format: system as a top-level param with a cache_control breakpoint, tools
// in Anthropic shape, content-block streaming, tool_use blocks. Translates our
// OpenAI-format ChatMsg[] in and Anthropic's stream back out, so the rest of the
// daemon is provider-agnostic.

type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      cache_control?: { type: "ephemeral" };
    };

function toAnthropic(messages: ChatMsg[]): {
  system: unknown;
  msgs: Array<{ role: "user" | "assistant"; content: AnthropicContentBlock[] }>;
} {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n\n");
  const system = systemText
    ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
    : undefined;
  const msgs: Array<{ role: "user" | "assistant"; content: AnthropicContentBlock[] }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      // Tool results are user messages carrying a tool_result block.
      msgs.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: untrustedToolResult(m.content),
          },
        ],
      });
    } else if (m.role === "assistant") {
      const content: AnthropicContentBlock[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {}; // a malformed/partial stored tool-call → empty input, never a throw
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      msgs.push({ role: "assistant", content });
    } else if (typeof m.content === "string") {
      msgs.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else {
      // Multimodal user parts (Sprint 8): data-URI image_url → Anthropic base64
      // image blocks (standard image-block translation).
      const blocks: AnthropicContentBlock[] = m.content.map((p) => {
        if (p.type === "text") return { type: "text", text: p.text };
        const m2 = p.image_url.url.match(/^data:([^;]+);base64,(.*)$/s);
        return m2
          ? ({
              type: "image",
              source: { type: "base64", media_type: m2[1], data: m2[2] },
            } as unknown as AnthropicContentBlock)
          : { type: "text", text: "[unattachable image part]" };
      });
      msgs.push({ role: "user", content: blocks });
    }
  }
  // ROLLING breakpoints (see withPromptCache): mark the last block of the final TWO
  // user-role messages (tool_results are user-role here, so the tool-loop tail is covered).
  // Two marks, not one — Anthropic's ~20-block cache lookback can miss a single previous
  // mark after a big parallel-tool turn (codex #7). Never on tool_use (assistant) blocks.
  let marked = 0;
  for (let i = msgs.length - 1; i >= 0 && marked < 2; i--) {
    const m = msgs[i];
    if (m?.role !== "user") continue;
    const block = m.content[m.content.length - 1];
    if (block && block.type !== "tool_use") {
      block.cache_control = { type: "ephemeral" };
      marked++;
    }
  }
  return { system, msgs };
}

async function streamAnthropic(
  cfg: ProviderConfig,
  model: string,
  req: ChatRequest,
): Promise<ModelResult> {
  const start = performance.now();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleMs = cfg.streamIdleMs ?? DEFAULT_IDLE_MS;
  const idle = idleMs > 0 ? new AbortController() : undefined;
  // One composed deadline for the WHOLE call — including the credential mint that happens
  // before fetch (a hung broker must not escape the timeout; codex #6).
  const sig = withTimeout(req.signal, timeoutMs, idle);
  let emitted = false;
  const { system, msgs } = toAnthropic(req.messages);
  const body: Record<string, unknown> = {
    model,
    messages: msgs,
    max_tokens: req.maxTokens ?? 4096,
    stream: true,
  };
  // The native wire has no effort enum — extended thinking takes a token budget. Map the
  // effort to one and guarantee max_tokens > budget (Anthropic's rule) with room left over
  // for the answer AFTER the thinking spend. Temperature is left at the default (thinking
  // forbids a custom one), so nothing else needs to change.
  if (req.reasoningEffort) {
    // Unknown effort (a model-specific/future tier) → the `high` budget; `none` → 0 = no thinking
    // (Anthropic rejects a 0 budget, so we simply don't enable it — the OpenAI "none" semantics).
    const budget = THINKING_BUDGET[req.reasoningEffort] ?? DEFAULT_THINKING_BUDGET;
    if (budget > 0) {
      body.thinking = { type: "enabled", budget_tokens: budget };
      body.max_tokens = Math.max(body.max_tokens as number, (req.maxTokens ?? 4096) + budget);
    }
  }
  if (system) body.system = system;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  let auth: { token: string; headers?: Record<string, string> };
  try {
    auth = cfg.credential ? await raceAbort(cfg.credential.get(), sig) : { token: cfg.apiKey };
  } catch (e) {
    const t = classifyTimeout(model, e, req, emitted, timeoutMs);
    if (t) return t;
    return {
      ok: false,
      model,
      error: String(e),
      ...(e instanceof NoServableToken ? { status: 409 } : {}),
      ...(e instanceof BrokerMintError ? { status: e.status } : {}),
    };
  }

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/messages`, {
      method: "POST",
      headers: {
        ...cfg.headers,
        "content-type": "application/json",
        "x-api-key": auth.token,
        "anthropic-version": "2023-06-01",
        ...auth.headers,
      },
      body: JSON.stringify(body),
      signal: sig,
    });
  } catch (e) {
    const t = classifyTimeout(model, e, req, emitted, timeoutMs);
    if (t) return t;
    const aborted = req.signal?.aborted ?? false;
    return { ok: false, model, error: aborted ? "aborted" : String(e), aborted };
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    if (req.signal?.aborted) return { ok: false, model, error: "aborted", aborted: true };
    const retryAfter =
      res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
    return {
      ok: false,
      model,
      status: res.status,
      error: normalizeError(text),
      ...(retryAfter ? { retryAfter } : {}),
    };
  }

  let content = "";
  let finishReason = "stop";
  let terminal = false; // saw message_stop / a stop_reason — else the stream was truncated
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 };
  const calls: WireToolCall[] = [];
  const partialInput = new Map<number, string>(); // tool_use block index → json accumulator

  try {
    for await (const data of sseLines(res.body, idle ? { ctrl: idle, ms: idleMs } : undefined)) {
      if (!data || data === "[DONE]") continue;
      let ev: AnthropicEvent;
      try {
        ev = JSON.parse(data) as AnthropicEvent;
      } catch {
        continue;
      }
      if (ev.type === "message_start" && ev.message?.usage) {
        // Anthropic's input_tokens EXCLUDES cache reads and creations — normalize to GROSS
        // (codex P1): with rolling breakpoints most prompt tokens are cache traffic, so raw
        // input_tokens ≈ 0 would understate cost, weaken budgets, and never trip compaction.
        const u = ev.message.usage;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        usage.input = (u.input_tokens ?? 0) + usage.cacheRead + usage.cacheWrite;
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        calls.push({
          id: ev.content_block.id ?? "",
          type: "function",
          function: { name: ev.content_block.name ?? "", arguments: "" },
        });
        partialInput.set(ev.index ?? calls.length - 1, "");
      } else if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          content += ev.delta.text;
          req.onDelta?.(ev.delta.text);
          emitted = true;
        } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
          // Extended thinking — observational only, never sets `emitted`. `signature_delta`
          // is protocol state (a cryptographic block signature), not readable reasoning: ignored.
          req.onReasoningDelta?.(ev.delta.thinking);
        } else if (ev.delta?.type === "input_json_delta" && ev.delta.partial_json !== undefined) {
          partialInput.set(
            ev.index ?? 0,
            (partialInput.get(ev.index ?? 0) ?? "") + ev.delta.partial_json,
          );
        }
      } else if (ev.type === "message_delta") {
        if (ev.delta?.stop_reason) {
          finishReason = ev.delta.stop_reason === "tool_use" ? "tool_calls" : ev.delta.stop_reason;
          terminal = true;
        }
        if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens;
      } else if (ev.type === "message_stop") {
        terminal = true;
      } else if (ev.type === "error") {
        const msg = ev.error?.message ?? "anthropic stream error";
        const status = streamErrorStatus(msg);
        return { ok: false, model, error: msg, ...(status ? { status } : {}) };
      }
    }
  } catch (e) {
    const t = classifyTimeout(model, e, req, emitted, timeoutMs);
    if (t) return t;
    const aborted = req.signal?.aborted ?? false;
    return { ok: false, model, error: aborted ? "aborted" : `stream broke: ${String(e)}`, aborted };
  }

  // Truncated-stream guard (same contract as the other two paths): a clean EOF without
  // message_stop / stop_reason must not persist a half-answer as success.
  if (!terminal) return { ok: false, model, error: "stream ended before completion" };

  // Finalize tool-use inputs (accumulated JSON) onto their calls, in order.
  let ti = 0;
  for (const [, json] of [...partialInput.entries()].sort((a, b) => a[0] - b[0])) {
    const call = calls[ti++];
    if (call) call.function.arguments = json || "{}";
  }
  usage.total = usage.input + usage.output;
  // Anthropic reports tokens but no dollars — compute cost_usd from the price table.
  usage.costUsd = priceUsd(model, usage);

  const message: AssistantMsg = { role: "assistant", content: content || null };
  if (calls.length) message.tool_calls = calls;
  return {
    ok: true,
    model,
    message,
    finishReason,
    usage,
    latencyMs: Math.round(performance.now() - start),
  };
}

type AnthropicEvent = {
  type: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string; // extended-thinking text on a `thinking_delta`
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { output_tokens?: number };
  error?: { message?: string };
};

// ── OpenAI Responses API (§C / G1a) ───────────────────────────────────────────
// The ChatGPT/Codex subscription backend the broker token targets speaks the
// Responses API (/responses), not /chat/completions: system → `instructions`,
// messages → typed `input` items, tool calls as `function_call` items, and a
// distinct SSE event vocabulary (response.output_text.delta, …). Same
// ModelResult contract + error-as-value + prompt caching (auto on this backend),
// so the rest of the daemon stays provider-agnostic.

type ResponsesInputItem =
  | {
      role: "user" | "assistant";
      content: Array<{ type: string; text?: string; image_url?: string }>;
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

function toResponses(messages: ChatMsg[]): { instructions: string; input: ResponsesInputItem[] } {
  const instructions = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n\n");
  const input: ResponsesInputItem[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: untrustedToolResult(m.content),
      });
    } else if (m.role === "assistant") {
      if (m.content)
        input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || "{}",
        });
      }
    } else if (typeof m.content === "string") {
      input.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
    } else {
      // Multimodal user parts (Sprint 8): Responses wire takes input_image items.
      input.push({
        role: "user",
        content: m.content.map((p) =>
          p.type === "text"
            ? { type: "input_text", text: p.text }
            : { type: "input_image", image_url: p.image_url.url },
        ),
      });
    }
  }
  return { instructions, input };
}

async function streamResponses(
  cfg: ProviderConfig,
  model: string,
  req: ChatRequest,
): Promise<ModelResult> {
  const start = performance.now();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleMs = cfg.streamIdleMs ?? DEFAULT_IDLE_MS;
  const idle = idleMs > 0 ? new AbortController() : undefined;
  // One composed deadline for the WHOLE call — including the credential mint that happens
  // before fetch (a hung broker must not escape the timeout; codex #6).
  const sig = withTimeout(req.signal, timeoutMs, idle);
  let emitted = false;
  const { instructions, input } = toResponses(req.messages);
  // store:false is REQUIRED by the ChatGPT/Codex subscription backend ("Store must be set to
  // false") and is correct for us regardless: Delta sends the full transcript each turn and never
  // relies on server-side response storage, so there is nothing to store.
  const body: Record<string, unknown> = { model, input, stream: true, store: false };
  if (instructions) body.instructions = instructions;
  // Cache-affinity routing: same key → same cache shard → prefix hits across turns.
  if (req.cacheKey) body.prompt_cache_key = req.cacheKey.slice(0, 64);
  if (req.maxTokens) body.max_output_tokens = req.maxTokens;
  // The Responses API (ChatGPT/Codex subscription backend) takes reasoning effort natively.
  if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
  if (req.tools?.length) {
    // Responses tools are flat (no nested `function` wrapper).
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }

  let auth: { token: string; headers?: Record<string, string> };
  try {
    auth = cfg.credential ? await raceAbort(cfg.credential.get(), sig) : { token: cfg.apiKey };
  } catch (e) {
    const t = classifyTimeout(model, e, req, emitted, timeoutMs);
    if (t) return t;
    return {
      ok: false,
      model,
      error: String(e),
      ...(e instanceof NoServableToken ? { status: 409 } : {}),
      ...(e instanceof BrokerMintError ? { status: e.status } : {}),
    };
  }

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/responses`, {
      method: "POST",
      headers: {
        ...cfg.headers,
        "content-type": "application/json",
        authorization: `Bearer ${auth.token}`,
        ...auth.headers,
      },
      body: JSON.stringify(body),
      signal: sig,
    });
  } catch (e) {
    const t = classifyTimeout(model, e, req, emitted, timeoutMs);
    if (t) return t;
    const aborted = req.signal?.aborted ?? false;
    return { ok: false, model, error: aborted ? "aborted" : String(e), aborted };
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    if (req.signal?.aborted) return { ok: false, model, error: "aborted", aborted: true };
    // Capture Retry-After on a 429 so chat() can cool the shared subscription identity down
    // (H4). The subscription path is the one that shares an identity across the fleet.
    const retryAfter =
      res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
    return {
      ok: false,
      model,
      status: res.status,
      error: normalizeError(text),
      ...(retryAfter ? { retryAfter } : {}),
    };
  }

  let content = "";
  let finishReason = "stop";
  let completed = false; // saw a terminal event — else the stream was truncated
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 };
  const calls: WireToolCall[] = [];
  const byItem = new Map<string, WireToolCall>(); // function_call item_id → call

  try {
    for await (const data of sseLines(res.body, idle ? { ctrl: idle, ms: idleMs } : undefined)) {
      if (!data || data === "[DONE]") continue;
      let ev: ResponsesEvent;
      try {
        ev = JSON.parse(data) as ResponsesEvent;
      } catch {
        continue;
      }
      switch (ev.type) {
        case "response.output_text.delta":
          if (ev.delta) {
            content += ev.delta;
            req.onDelta?.(ev.delta);
            emitted = true;
          }
          break;
        // Reasoning SUMMARY deltas (the Responses backend exposes a summary, not raw
        // chain-of-thought). Observational only — never sets `emitted`.
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (ev.delta) req.onReasoningDelta?.(ev.delta);
          break;
        case "response.output_item.added":
          if (ev.item?.type === "function_call") {
            const call: WireToolCall = {
              id: ev.item.call_id ?? ev.item.id ?? "",
              type: "function",
              function: { name: ev.item.name ?? "", arguments: "" },
            };
            calls.push(call);
            if (ev.item.id) byItem.set(ev.item.id, call);
            finishReason = "tool_calls";
          }
          break;
        case "response.function_call_arguments.delta":
          if (ev.item_id && ev.delta) {
            const call = byItem.get(ev.item_id);
            if (call) call.function.arguments += ev.delta;
          }
          break;
        case "response.completed":
        case "response.incomplete": {
          completed = true;
          const u = ev.response?.usage;
          if (u) {
            usage.input = u.input_tokens ?? 0;
            usage.output = u.output_tokens ?? 0;
            usage.cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
            usage.total = u.total_tokens ?? usage.input + usage.output;
          }
          break;
        }
        case "response.failed":
        case "error": {
          const msg = ev.response?.error?.message ?? ev.message ?? "responses stream error";
          const status = streamErrorStatus(msg);
          return { ok: false, model, error: msg, ...(status ? { status } : {}) };
        }
      }
    }
  } catch (e) {
    const t = classifyTimeout(model, e, req, emitted, timeoutMs);
    if (t) return t;
    const aborted = req.signal?.aborted ?? false;
    return { ok: false, model, error: aborted ? "aborted" : `stream broke: ${String(e)}`, aborted };
  }

  // A clean EOF WITHOUT a terminal event is a truncated stream, not a success —
  // returning ok here would silently persist a half-answer (codex P1).
  if (!completed) return { ok: false, model, error: "responses stream ended before completion" };

  // Empty tool-call arguments must serialize as valid JSON for the next turn.
  for (const c of calls) if (!c.function.arguments) c.function.arguments = "{}";
  if (!usage.total) usage.total = usage.input + usage.output;
  // The Responses (OpenAI/ChatGPT-Codex) backend reports tokens but no dollars — meter it.
  usage.costUsd = priceUsd(model, usage);

  const message: AssistantMsg = { role: "assistant", content: content || null };
  if (calls.length) message.tool_calls = calls;
  return {
    ok: true,
    model,
    message,
    finishReason,
    usage,
    latencyMs: Math.round(performance.now() - start),
  };
}

type ResponsesEvent = {
  type: string;
  delta?: string;
  item_id?: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string };
  message?: string;
  response?: {
    error?: { message?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
};
