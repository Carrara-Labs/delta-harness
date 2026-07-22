// SPDX-License-Identifier: Apache-2.0
// All placement variance is config (architecture "Placements"): provider = any
// OpenAI-compatible baseURL + bearer. No Fly/cloud assumption anywhere.

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { BrokerCredential } from "./broker";
import type { McpServerConfig } from "./mcp";
import {
  KNOWN_EFFORTS,
  normalizeEffort,
  type ProviderConfig,
  type ReasoningEffort,
} from "./provider";
import { HARNESS_VERSION } from "./version";
import { parseVocab, type Vocab } from "./vocab";

export type Config = {
  port: number;
  dbPath: string;
  leaseTtlMs: number;
  /** Stable single-writer identity for the run-lease (F0.5). Machine-scoped, NOT
   *  per-process: it matches the act-as-token principal the lease protects (one writer
   *  per machine/token — the cross-machine hazard), and lets a crashed daemon's fast
   *  restart on the SAME machine reclaim its own lease instantly instead of waiting out
   *  the TTL. Same-machine double-start is already blocked by the port bind. */
  leaseHolder: string;
  agentId?: string;
  /** The primary provider (kept for callers that inspect it directly). */
  provider: ProviderConfig;
  /** The ordered failover cascade (§C / G1c): primary first, then any
   * DELTA_PROVIDERS fallbacks. `chatVia` walks this on a failover-worthy error. */
  providers: ProviderConfig[];
  workspace: string;
  exaKey?: string;
  fetchAllowPrivate: boolean;
  codeCli: string[];
  subagentDepth: number;
  /** Placement profile ceiling — requests may narrow it, never escalate. */
  profile: string;
  telemetryUrl?: string;
  /** Bearer the exporter presents to the (authed) collector. */
  telemetryToken?: string;
  capturePayloads: boolean;
  mcpServers: McpServerConfig[];
  /** THE context-window knob (`DELTA_COMPACT_AT_TOKENS`). The pre-send gate compacts older turns
   * once the ESTIMATED assembled request would exceed this many tokens, so the active window is
   * bounded here. One dial, operator's choice:
   *   • tight (~60–90k)  — cheaper + lower latency per call; compacts more often.
   *   • balanced (120k)  — the default; safe on any ≥200k-window model.
   *   • large (160k+)    — fewer compactions, more continuity/performance; set this HIGHER only
   *     when the model's real window supports it — keep it below `model_window − max_output` or
   *     you'll overflow instead of compact. Safe to run large because W1 made compaction
   *     restorable: whatever scrolls out is on disk and `recall`-able, so a big window loses
   *     nothing, and sub-agents/spill keep the signal-to-token ratio high. */
  compactAtTokens: number;
  hydrateTools: string[];
  /** Knowledge-base search tool for task-keyed relevance hydration (§E / G3a). */
  hydrateSearchTool?: string;
  /** DELTA.md (the writable self-file) size budget: the verbatim cap for the spine AND
   * the write-time reject ceiling for the agent's own self-writes (bytes ≈ tokens*4). */
  selfMaxTokens: number;
  /** POLICY.md (the fixed contract) size budget: boot FAILS if a policy exceeds it — a
   * fixed rule is never elided (that would drop its middle). */
  policyMaxTokens: number;
  /** The primary model reads images (Sprint 8) — gates image-marker expansion. */
  vision: boolean;
  reflect: boolean;
  /** Product vocabulary for the review loop (portability seam). a knowledge base by default;
   * DELTA_VOCAB overrides fields for another product. */
  vocab: Vocab;
  memoryNamespace: string;
  promoteMinRuns: number;
  promoteClaimTtlMs: number;
  capabilitySearchK: number;
  /** Reasoning effort for the main model when it supports extended thinking
   * (DELTA_REASONING_EFFORT — passes straight through; the supported set is MODEL-dependent, e.g.
   * OpenAI/Codex: none|minimal|low|medium|high|xhigh, and gpt-5.6-sol 4xxs on `minimal`. "auto" is
   * NOT an effort. Any value reaches the model; unsupported → clean 4xx). Unset → provider default. */
  reasoningEffort?: ReasoningEffort;
  /** Robustness ceilings (budgets, not timers — these are safety caps for a HUNG provider/tool,
   * never the loop's control mechanism). */
  modelTimeoutMs: number;
  streamIdleMs: number;
  toolTimeoutMs: number;
  toolResultCap: number;
  /** Cheap model for auxiliary calls (compaction/reflection/judging). Empty string disables
   * the lane (everything rides the main cascade). */
  utilityModel: string;
  /** Control-plane base URL for self-scheduling (Sprint 4). Absent → the schedule tools
   * aren't registered (a non-CP-wired dev binary boots fine without them). */
  controlUrl?: string;
  /** Bearer for the CP schedule endpoints — this VM's own gateway token (hash-matched). */
  controlToken?: string;
  /** Local diagnostic-state retention (events + journal). The Exporter bounds `events` only
   * when telemetry is wired, and nothing bounds `journal` — so a telemetry-less daemon would
   * grow both without limit. A periodic sweep caps them by age AND row-count. See retention.ts. */
  retentionMs: number;
  retentionMaxEvents: number;
  retentionMaxJournal: number;
  /** Sweep interval; 0 disables the periodic sweep (a one-shot still runs at boot). */
  retentionSweepMs: number;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  warnLegacyBundleEnv(env);
  // Product vocab: DELTA_VOCAB env wins; else a vocab.json in the bundle (the clean
  // file form the Cockpit shows/edits); else the neutral default. Reading the bundle
  // file here keeps a product's nouns out of a giant env string.
  const workspaceDir = resolve(env.DELTA_WORKSPACE ?? "workspace");
  const vocab = parseVocab(env.DELTA_VOCAB ?? readIfExists(resolve(workspaceDir, "vocab.json")));
  const models = [
    // T2: the control plane emits DELTA_MODEL_PRIMARY; DELTA_MODEL is the legacy harness name.
    aliased(env, "DELTA_MODEL_PRIMARY", "DELTA_MODEL") ?? "anthropic/claude-sonnet-5",
    ...(env.DELTA_MODEL_FALLBACKS?.split(",").map((m) => m.trim()) ?? []),
  ].filter(Boolean);
  // T1: static per-request headers a bundle supplies (e.g. Codex `originator`). Fails loudly on
  // malformed/reserved input — an operator-owned, security-relevant field, not a fail-open one.
  const modelHeaders = parseModelHeaders(env.MODEL_HEADERS, "MODEL_HEADERS");
  // Reasoning effort passes through to the model (the supported set is model-dependent); warn — but
  // don't drop — an unrecognized value so a typo is visible while a valid future tier still works.
  const reasoningEffort = normalizeEffort(env.DELTA_REASONING_EFFORT);
  if (reasoningEffort && !(KNOWN_EFFORTS as readonly string[]).includes(reasoningEffort)) {
    console.error(
      `delta: DELTA_REASONING_EFFORT='${reasoningEffort}' is not a recognized level (${KNOWN_EFFORTS.join(", ")}) — sending it as-is; the model 4xxs if it doesn't support it.`,
    );
  }
  // Vision (Sprint 8): does the PRIMARY model read images? Gates image-marker
  // expansion — a non-vision model keeps markers as text (their own placeholder).
  // Family heuristic with an env override for the fleets' long tail of slugs.
  const visionRe = env.DELTA_VISION_MODELS
    ? new RegExp(env.DELTA_VISION_MODELS, "i")
    : /claude|gpt-4o|gpt-4\.1|gpt-5|gemini|qwen[\w.-]*vl|pixtral|vision|glm[\w.-]*v|grok/i;
  const vision =
    env.DELTA_VISION === "1" || (env.DELTA_VISION !== "0" && visionRe.test(models[0] ?? ""));
  // Robustness ceilings. Absolute model cap is generous (idle watchdog is the fast stall detector);
  // tool default is below any long-runner, which opts out with timeoutMs:0.
  const modelTimeoutMs = Number(env.DELTA_MODEL_TIMEOUT_MS ?? 600_000); // 10 min absolute backstop
  const streamIdleMs = Number(env.DELTA_STREAM_IDLE_MS ?? 60_000); // per-chunk stall; 0 disables
  const toolTimeoutMs = Number(env.DELTA_TOOL_TIMEOUT_MS ?? 120_000); // per-tool default; 0 unbounded
  // Inline cap before spill — 20k matches the old per-builtin elide, so the token budget is
  // unchanged; what's new is the full output now survives in a re-readable spill file.
  const toolResultCap = Number(env.DELTA_TOOL_RESULT_MAX_BYTES ?? 20_000);
  const leaseTtl = Number(env.DELTA_LEASE_TTL_MS ?? 30_000);
  const provider: ProviderConfig = {
    baseUrl: env.MODEL_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: env.MODEL_API_KEY ?? env.OPENROUTER_API_KEY ?? "",
    models,
    label: "primary",
    // Wire format (§C): "anthropic" = native Messages API; "responses" = the
    // OpenAI Responses/ChatGPT-Codex subscription backend; else /chat/completions.
    ...(env.MODEL_API === "anthropic" || env.MODEL_API === "responses"
      ? { api: env.MODEL_API as "anthropic" | "responses" }
      : {}),
    ...(modelHeaders ? { headers: modelHeaders } : {}),
    // Subscription path: mint the bearer from the control plane's broker endpoint
    // instead of a static key (§C). DELTA_BROKER_MINT_URL points at GET
    // /api/broker/openai-token; DELTA_BROKER_AUTH is this machine's gateway token.
    // A broker (ChatGPT/Codex) token must NEVER go to OpenRouter — that leaks the
    // subscription token to a metered host — so it requires an explicit
    // non-OpenRouter MODEL_BASE_URL; otherwise the credential is ignored and the
    // static key path stands.
    ...brokerCredential(env),
    timeoutMs: modelTimeoutMs,
    streamIdleMs,
  };
  // Every provider in the cascade inherits the same wall-clock ceilings.
  const providers = [provider, ...parseFallbackProviders(env, models)].map((p) => ({
    ...p,
    timeoutMs: p.timeoutMs ?? modelTimeoutMs,
    streamIdleMs: p.streamIdleMs ?? streamIdleMs,
  }));
  // T5: a subscription (broker) provider with NO usable non-subscription fallback has no safety
  // net when the broker 409s / 401s / cools down after a 429. A real fallback = a non-broker
  // provider that actually has a credential (a static apiKey or its own Credential) — a keyless
  // OpenRouter entry would 401 too, so it doesn't count (codex P2). Warn loudly, don't fail.
  const hasBroker = providers.some((p) => p.credential instanceof BrokerCredential);
  const hasUsableFallback = providers.some(
    (p) => !(p.credential instanceof BrokerCredential) && (p.apiKey !== "" || p.credential),
  );
  if (hasBroker && !hasUsableFallback) {
    console.error(
      "delta: a subscription (broker) provider is configured but there is NO usable non-subscription fallback provider — a broker 409/401/429 will have no safety net. Add a keyed provider (e.g. OpenRouter) to DELTA_PROVIDERS.",
    );
  }
  return {
    port: Number(env.PORT ?? 8080),
    dbPath: env.DELTA_DB ?? "data/delta.db",
    leaseTtlMs: Number.isFinite(leaseTtl) ? Math.max(5_000, leaseTtl) : 30_000,
    // Machine-scoped, stable across restarts: Fly's per-machine id in prod, hostname
    // otherwise; DELTA_LEASE_HOLDER overrides (tests, or to simulate a second machine).
    leaseHolder: env.DELTA_LEASE_HOLDER || env.FLY_MACHINE_ID || hostname() || "delta",
    ...(env.DELTA_AGENT_ID ? { agentId: env.DELTA_AGENT_ID } : {}),
    provider,
    providers,
    workspace: workspaceDir,
    ...(env.EXA_API_KEY ? { exaKey: env.EXA_API_KEY } : {}),
    fetchAllowPrivate: env.DELTA_FETCH_ALLOW_PRIVATE === "1",
    codeCli: (
      env.DELTA_CODE_CLI ?? "codex exec --sandbox workspace-write --skip-git-repo-check"
    ).split(" "),
    subagentDepth: Number(env.DELTA_SUBAGENT_DEPTH ?? 0),
    profile: env.DELTA_PROFILE ?? "work",
    ...(env.TELEMETRY_URL ? { telemetryUrl: env.TELEMETRY_URL } : {}),
    ...(env.TELEMETRY_TOKEN ? { telemetryToken: env.TELEMETRY_TOKEN } : {}),
    capturePayloads: env.DELTA_CAPTURE_PAYLOADS === "1",
    mcpServers: parseMcpServers(env.DELTA_MCP_SERVERS),
    // The context-window dial (see the Config field doc). Default 120k = balanced + safe on any
    // ≥200k model; raise for performance up to `model_window − max_output`, lower for cost.
    // Validated to a finite positive integer — NaN/Inf would silently DISABLE the gate (every
    // comparison false), a negative would force pathological compaction (codex).
    compactAtTokens: (() => {
      const n = Number(env.DELTA_COMPACT_AT_TOKENS);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120_000;
    })(),
    // Task-start hydration (§E) — read tools called at task start. NEUTRAL by default
    // (a product names its own reads); empty = the agent hydrates nothing.
    hydrateTools: (env.DELTA_HYDRATE_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Task-keyed relevance search (§E / G3a). Unset by default; a product points it at
    // its own search tool.
    hydrateSearchTool: env.DELTA_HYDRATE_SEARCH_TOOL || undefined,
    // The two bundle markdown files are FIXED filenames (DELTA.md self-file + POLICY.md
    // contract) — no path knobs (codex #23). Identity comes from DELTA.md alone; the
    // live remote-charter override is gone (codex #21) so a self-edit actually wins.
    // Budgets guard the <2k spine (self is elided as recovery; policy fails boot).
    selfMaxTokens: positiveInt(env.DELTA_SELF_MAX_TOKENS, 800),
    policyMaxTokens: positiveInt(env.DELTA_POLICY_MAX_TOKENS, 800),
    vision,
    reflect: env.DELTA_REFLECT === "1",
    // Review-loop vocabulary: neutral by default, one JSON env to serve another product.
    vocab,
    memoryNamespace:
      env.DELTA_MEMORY_NAMESPACE ||
      vocab.writeNoun
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") ||
      "default",
    promoteMinRuns: positiveInt(env.DELTA_PROMOTE_MIN_RUNS, 2),
    promoteClaimTtlMs: positiveInt(env.DELTA_PROMOTE_CLAIM_TTL_MS, 60_000),
    capabilitySearchK: positiveInt(env.DELTA_CAPABILITY_SEARCH_K, 5),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    modelTimeoutMs,
    streamIdleMs,
    toolTimeoutMs,
    toolResultCap,
    // Auxiliary-call model (Sprint 2): compaction summaries, reflection, eval_n judging are
    // summarize/pick tasks — haiku does them at 1/2–1/5 the price. DELTA_UTILITY_MODEL=""
    // disables the lane. Falls back to the main cascade per-call on any failure.
    utilityModel: env.DELTA_UTILITY_MODEL ?? "anthropic/claude-haiku-4.5",
    // Self-scheduling (Sprint 4): the control plane owns the clock (this VM autosuspends).
    ...(env.DELTA_CONTROL_URL ? { controlUrl: env.DELTA_CONTROL_URL } : {}),
    ...(env.DELTA_CONTROL_TOKEN ? { controlToken: env.DELTA_CONTROL_TOKEN } : {}),
    // Local diagnostic-state retention (retention.ts): bound events + journal by age + count
    // regardless of telemetry. 7-day age, 50k-row cap, hourly sweep — all overridable.
    retentionMs: positiveInt(env.DELTA_RETENTION_MS, 7 * 24 * 3_600_000),
    retentionMaxEvents: positiveInt(env.DELTA_RETENTION_MAX_EVENTS, 50_000),
    retentionMaxJournal: positiveInt(env.DELTA_RETENTION_MAX_JOURNAL, 50_000),
    // 0 disables the periodic sweep (a boot sweep still runs); NaN/Infinity/blank → default,
    // so a malformed value never reaches setInterval as a busy-loop or an invalid delay.
    retentionSweepMs: nonNegativeMs(env.DELTA_RETENTION_SWEEP_MS, 3_600_000),
  };
}

/** The Cockpit's `/v1/dev/config` body (spec §4.6). Built from an EXPLICIT allowlist
 *  of safe resolved fields — never iterate `process.env` or the config object, and
 *  never emit a credential VALUE. Anything credential-shaped is a presence boolean;
 *  MCP servers are projected to name+transport (URLs/headers/auth stripped). Pure and
 *  side-effect-free so it can be unit-tested for leaks. */
export function devConfigView(
  cfg: Config,
  toolNames: string[],
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const present = (...vals: (string | undefined)[]) => vals.some((v) => Boolean(v?.length));
  return {
    version: HARNESS_VERSION,
    ...(env.DELTA_BUILD ? { build: env.DELTA_BUILD } : {}),
    ...(cfg.agentId ? { agent_id: cfg.agentId } : {}),
    port: cfg.port,
    profile: cfg.profile,
    namespace: cfg.memoryNamespace,
    model: {
      model: cfg.provider.models[0] ?? null,
      models: cfg.provider.models,
      utility: cfg.utilityModel || null,
      // Origin only — MODEL_BASE_URL can carry credentials in userinfo/query/path
      // (e.g. https://user:key@host/…?sig=…); emit just protocol+host (codex P1).
      base_url: safeOrigin(cfg.provider.baseUrl),
      api: cfg.provider.api ?? "chat",
      ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
    },
    // Presence only — never the value (not even a first4/last4 slice).
    secrets_present: {
      MODEL_API_KEY: present(env.MODEL_API_KEY, env.OPENROUTER_API_KEY),
      EXA_API_KEY: present(env.EXA_API_KEY),
      DELTA_INSPECT_TOKEN: present(env.DELTA_INSPECT_TOKEN),
      DELTA_CONTROL_TOKEN: present(env.DELTA_CONTROL_TOKEN),
      TELEMETRY_TOKEN: present(env.TELEMETRY_TOKEN),
      DELTA_BROKER_AUTH: present(env.DELTA_BROKER_AUTH),
      DELTA_MCP_REFRESH: present(env.DELTA_MCP_REFRESH_TOKEN, env.DELTA_MCP_REFRESH_FILE),
    },
    tools: {
      mcp: toolNames.filter((n) => n.includes("__")).sort(),
      builtin: toolNames.filter((n) => !n.includes("__")).sort(),
    },
    mcp_servers: cfg.mcpServers.map((s) => ({ name: s.name, transport: s.transport })),
    // The bundle files the Cockpit shows — the two markdown layers + vocab, whichever
    // EXIST on disk (so a dev never sees a phantom ★ that 404s). DELTA.md is the writable
    // self-file; POLICY.md + vocab.json are operator-owned (read-only to the agent).
    operator_files: ["DELTA.md", "POLICY.md", "vocab.json", "PROMPT_CONTEXT.md"].filter((f) =>
      existsSync(resolve(cfg.workspace, f)),
    ),
    vocab: cfg.vocab,
  };
}

/** The bundle collapsed to two markdown files (DELTA.md + POLICY.md); the old
 * charter/playbook/steering knobs are gone (codex #20). Warn LOUDLY when a legacy env
 * is still set so its content isn't silently dropped — the operator must move it into
 * DELTA.md or POLICY.md by hand (there is no safe automatic mapping for freeform
 * steering, and a multi-file charter list can't collapse to one file cleanly). */
function warnLegacyBundleEnv(env: Record<string, string | undefined>): void {
  const legacy: Array<[string, string]> = [
    ["DELTA_PLAYBOOK_FILE", "POLICY.md (rename the file to POLICY.md; the path is now fixed)"],
    ["DELTA_STEERING_FILE", "DELTA.md or POLICY.md (AGENTS.md is gone — move its content by hand)"],
    ["DELTA_CHARTER_FILES", "DELTA.md (the self-file; the path is now fixed)"],
    [
      "DELTA_CHARTER_TOOL",
      "DELTA.md (live remote-charter override removed — identity is the file)",
    ],
    ["DELTA_PLAYBOOK_MAX_TOKENS", "DELTA_POLICY_MAX_TOKENS"],
    ["DELTA_STEERING_MAX_TOKENS", "DELTA_SELF_MAX_TOKENS"],
  ];
  for (const [name, to] of legacy)
    if (env[name] !== undefined)
      console.error(
        `delta: ${name} is no longer used (the bundle is now DELTA.md + POLICY.md) — its value is IGNORED. Migrate it to ${to}.`,
      );
}

/** Read a file if it exists, else undefined — a runaway/unreadable file never crashes
 * boot (config style: fail-open). Used for the bundle's optional vocab.json. */
function readIfExists(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Reduce a base URL to `protocol//host` (host includes port), dropping userinfo,
 *  path, query, and fragment — anywhere a credential could hide. Unparseable → "". */
function safeOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback;
}

/** Like positiveInt but allows 0 (a disable sentinel). Blank/NaN/Infinity → fallback, so a
 *  malformed value can never reach setInterval as a busy-loop (NaN→0) or invalid delay. */
function nonNegativeMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Hosts allowed to receive a subscription (broker-minted) bearer. Default: the ChatGPT
 * Codex backend. This is an ALLOWLIST, not a denylist (codex H3) — a typo'd or hostile
 * MODEL_BASE_URL must never receive the subscription token. Extend via
 * DELTA_BROKER_ALLOWED_HOSTS (comma list) for a different Codex-compatible host. */
function trustedSubscriptionHosts(env: Record<string, string | undefined>): string[] {
  return (env.DELTA_BROKER_ALLOWED_HOSTS ?? "chatgpt.com")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
/** Is `base` an HTTPS URL whose host EXACTLY matches an allowlisted host (codex P1)? Exact match,
 * not subdomain-suffix — `evil.chatgpt.com` must not inherit `chatgpt.com`'s trust; a real
 * subdomain backend is listed explicitly. Plaintext http is rejected: a subscription bearer must
 * never cross the wire unencrypted. */
function subscriptionBaseAllowed(base: string, env: Record<string, string | undefined>): boolean {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return trustedSubscriptionHosts(env).includes(u.hostname.toLowerCase());
}
/** The mint URL carries the machine gateway token, so it must be HTTPS — except a loopback host,
 * which is how local dev / tests / a same-VM broker sidecar run (codex P1). Invalid → false. */
function mintUrlOk(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || LOCAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Read a canonical env var, falling back to a deprecated legacy name (codex T2). Warns when
 * both are set and disagree, so a stale legacy value can't silently win. Canonical wins. */
function aliased(
  env: Record<string, string | undefined>,
  canonical: string,
  legacy: string,
): string | undefined {
  const c = env[canonical];
  const l = env[legacy];
  if (c !== undefined && l !== undefined && c !== l) {
    console.error(
      `delta: both ${canonical} and ${legacy} are set and differ — using ${canonical} (${legacy} is deprecated).`,
    );
  }
  return c ?? l;
}

const RESERVED_HEADERS = new Set([
  // Auth / account — a static header must never clobber the credential's own.
  "authorization",
  "x-api-key",
  "chatgpt-account-id",
  "anthropic-version",
  "anthropic-beta",
  // Protocol / framing — the engine owns these.
  "content-type",
  "content-length",
  "host",
  // Hop-by-hop / sensitive (codex P2) — never operator-settable static headers.
  "proxy-authorization",
  "proxy-authenticate",
  "cookie",
  "connection",
  "transfer-encoding",
  "trailer",
  "te",
  "upgrade",
  "keep-alive",
  "proxy-connection",
]);
/** Parse static provider headers (T1): a JSON object of extra request headers a bundle supplies
 * (e.g. `originator` for the Codex backend). Names are lowercased so header precedence is
 * deterministic (engine auth/protocol headers always win); reserved auth/protocol/account names
 * are REJECTED; malformed input FAILS LOUDLY (throws at boot) rather than silently running without
 * a header the operator set — codex H1/T1. Empty/absent → undefined. */
function parseModelHeaders(
  raw: string | undefined,
  source: string,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`${source} must be a JSON object of header name→value`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.trim().toLowerCase();
    if (!key) continue;
    if (RESERVED_HEADERS.has(key))
      throw new Error(`${source} may not set the reserved header '${key}'`);
    if (typeof v !== "string") throw new Error(`${source}['${k}'] must be a string`);
    // Reject syntactically invalid header names/values (illegal token chars, CRLF injection)
    // by round-tripping through the platform Headers parser (codex P2).
    try {
      new Headers([[key, v]]);
    } catch {
      throw new Error(`${source}['${k}'] is not a valid HTTP header name/value`);
    }
    out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Parse the DELTA_PROVIDERS cascade (§C / G1c): a JSON array of fallback
 * providers, tried in order after the primary on a failover-worthy error. Each
 * entry: { baseUrl, models?, api?, label?, apiKey?, apiKeyEnv?, brokerMintUrl?,
 * brokerAuthEnv? }. `models` defaults to the primary's; a broker entry mints its
 * bearer, a keyed entry reads apiKey / apiKeyEnv. Malformed → ignored, never fatal
 * (a Delta must boot on its primary alone). */
function parseFallbackProviders(
  env: Record<string, string | undefined>,
  primaryModels: string[],
): ProviderConfig[] {
  if (!env.DELTA_PROVIDERS) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(env.DELTA_PROVIDERS);
  } catch {
    console.error("delta: DELTA_PROVIDERS is not valid JSON — ignoring the failover cascade.");
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ProviderConfig[] = [];
  for (const [i, e] of raw.entries()) {
    const p = e as Record<string, unknown>;
    if (typeof p.baseUrl !== "string" || !p.baseUrl) continue;
    const models = Array.isArray(p.models)
      ? (p.models as string[])
      : typeof p.models === "string"
        ? [p.models]
        : primaryModels;
    const apiKeyEnv = typeof p.apiKeyEnv === "string" ? env[p.apiKeyEnv] : undefined;
    const cfg: ProviderConfig = {
      baseUrl: p.baseUrl,
      apiKey: (typeof p.apiKey === "string" ? p.apiKey : apiKeyEnv) ?? "",
      models,
      label: typeof p.label === "string" ? p.label : `fallback-${i + 1}`,
      ...(p.api === "anthropic" || p.api === "responses"
        ? { api: p.api as "anthropic" | "responses" }
        : {}),
    };
    if (typeof p.brokerMintUrl === "string") {
      // Same allowlist guard as the primary (codex H3): a subscription token may only go to a
      // host on the allowlist — never a metered/typo'd/hostile base. Otherwise drop the credential.
      if (!subscriptionBaseAllowed(cfg.baseUrl, env)) {
        console.error(
          `delta: fallback provider '${cfg.label}' has a broker mint URL but its base '${cfg.baseUrl}' is not on the subscription-token allowlist — refusing to leak a subscription token. Ignoring its broker credential.`,
        );
      } else if (!mintUrlOk(p.brokerMintUrl)) {
        console.error(
          `delta: fallback provider '${cfg.label}' has an invalid or non-HTTPS broker mint URL — ignoring its broker credential.`,
        );
      } else {
        const auth = typeof p.brokerAuthEnv === "string" ? env[p.brokerAuthEnv] : undefined;
        cfg.credential = new BrokerCredential(p.brokerMintUrl, auth);
      }
    }
    out.push(cfg);
  }
  return out;
}

/** Build a broker credential only when it's safe: a valid mint URL AND a model endpoint whose
 * host is on the subscription allowlist (codex H3). Sending a ChatGPT/Codex subscription token
 * to any other host — an OpenRouter base, a typo, a hostile URL — would leak it, so we refuse
 * and log. The mint URL (which carries the machine gateway token) must also be a valid URL. */
function brokerCredential(env: Record<string, string | undefined>): {
  credential?: BrokerCredential;
} {
  // T2: the control plane emits DELTA_BROKER_TOKEN_URL; DELTA_BROKER_MINT_URL is the legacy name.
  const mintUrl = aliased(env, "DELTA_BROKER_TOKEN_URL", "DELTA_BROKER_MINT_URL");
  if (!mintUrl) return {};
  if (!mintUrlOk(mintUrl)) {
    console.error(
      "delta: the broker mint URL is not a valid HTTPS (or loopback) URL — refusing to send the machine gateway token over it. Ignoring the broker credential.",
    );
    return {};
  }
  const base = env.MODEL_BASE_URL ?? "";
  if (!subscriptionBaseAllowed(base, env)) {
    console.error(
      `delta: a broker mint URL is set but MODEL_BASE_URL '${base || "(unset)"}' is not on the subscription-token allowlist (${trustedSubscriptionHosts(env).join(", ")}) — refusing to send a subscription token to an untrusted host. Point MODEL_BASE_URL at the Codex backend or extend DELTA_BROKER_ALLOWED_HOSTS. Using the static key instead.`,
    );
    return {};
  }
  return { credential: new BrokerCredential(mintUrl, env.DELTA_BROKER_AUTH) };
}

/** MCP servers from a JSON env var (hot-reloadable via /admin later). Malformed
 * config is ignored, never fatal — a Delta must still boot without its MCP. */
function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
  } catch {
    return [];
  }
}
