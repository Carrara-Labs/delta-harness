// biome-ignore-all lint/security/noDangerouslySetInnerHtml: The only raw HTML is JSON-LD serialized from a static local object.
import { Fragment, type ReactNode, useEffect } from "react";

import { SiteFooter, SiteHeader } from "~/components/landing";
import "~/styles/landing.css";
import "~/styles/enhancements.css";
import "~/styles/changelog.css";

const canonicalUrl = "https://deltaharness.dev/changelog";
const pageTitle = "Changelog. Every Delta release, in the open.";
const description =
  "The complete release history of the Delta agent harness, from the first public npm package to today. Every version, every change, aligned to the source CHANGELOG.";
const socialImageUrl = "https://deltaharness.dev/delta-og-image.png";
const socialImageAlt = "Delta triangular logo and wordmark on a warm off-white background";
const repoUrl = "https://github.com/Carrara-Labs/delta-harness";
const releasesUrl = "https://github.com/Carrara-Labs/delta-harness/releases";
const changelogSourceUrl = "https://github.com/Carrara-Labs/delta-harness/blob/main/CHANGELOG.md";
const npmUrl = "https://www.npmjs.com/package/@carrara-labs/delta-harness";

// A CollectionPage (the release history) about the software entity, plus a BreadcrumbList
// so answer engines place it in the site hierarchy.
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      "@id": `${canonicalUrl}#page`,
      name: pageTitle,
      description,
      url: canonicalUrl,
      inLanguage: "en",
      isPartOf: { "@id": "https://deltaharness.dev/#website" },
      about: { "@id": "https://deltaharness.dev/#software" },
      publisher: {
        "@type": "Organization",
        name: "Carrara Labs",
        logo: {
          "@type": "ImageObject",
          url: "https://deltaharness.dev/delta-logo-light-background.svg",
        },
      },
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Delta", item: "https://deltaharness.dev/" },
        { "@type": "ListItem", position: 2, name: "Changelog", item: canonicalUrl },
      ],
    },
  ],
};

export function meta() {
  return [
    { title: pageTitle },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: canonicalUrl },
    { name: "robots", content: "index, follow, max-image-preview:large" },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "Delta" },
    { property: "og:title", content: "Delta changelog." },
    { property: "og:description", content: description },
    { property: "og:url", content: canonicalUrl },
    { property: "og:image", content: socialImageUrl },
    { property: "og:image:alt", content: socialImageAlt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: "Delta changelog." },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: socialImageUrl },
  ];
}

type Kind = "added" | "changed" | "fixed" | "removed";

type ChangeGroup = { kind: Kind; items: string[] };

type Release = {
  version: string;
  date: string;
  iso: string;
  tagline: string;
  latest?: boolean;
  note?: string;
  groups: ChangeGroup[];
};

const kindLabel: Record<Kind, string> = {
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
  removed: "Removed",
};

// Mirrors the canonical source history at CHANGELOG.md (Keep a Changelog / SemVer).
// Newest first. Prose is written for a reader; the categories and facts track the source
// exactly. Update this alongside the root CHANGELOG.md when a release ships.
const releases: Release[] = [
  {
    version: "0.2.14",
    date: "August 10, 2026",
    iso: "2026-08-10",
    tagline: "The second breakpoint.",
    latest: true,
    note: "A turn that calls many tools in parallel no longer loses the prompt cache. Anthropic's cache lookback is twenty blocks per breakpoint and finds only positions earlier requests already wrote; we place two rolling breakpoints precisely to survive a wide tool turn, and they were landing one block apart, sharing a single window instead of starting two. A turn calling about ten tools in parallel outran both and re-billed the entire prefix. Measured live, with the two arms differing only in placement: at a burst of twelve, a turn's cache read went from 2,523 to 10,207 tokens and its cache write from 8,745 to 1,061, which is 4.8x cheaper on an affected turn. If your agent calls fewer than ten tools at once, this changes nothing for you: at bursts of four and nine the two arms are identical to the token, and the threshold sits at exactly ten. 0.2.14 adds no migration, so from 0.2.13 it is reversible; from 0.2.11 it is not, because it carries the one-way step 0.2.13 introduced.",
    groups: [
      {
        kind: "fixed",
        items: [
          "**Rolling cache breakpoint windows are chained contiguously**, on both the native Anthropic and OpenAI-compatible wires. A breakpoint covers twenty blocks including itself, so the next window has to begin exactly twenty back rather than merely far away. Counted in blocks rather than messages, because one message is not one block: an assistant turn carrying N tool calls arrives as N blocks, which is exactly what made a parallel tool burst outrun the marks.",
          "**The debug capture table is bounded.** `calls` grew without limit; on one lane it reached 45% of the database from a flag left on after an investigation. Now bounded by age and by a byte budget (`DELTA_RETENTION_MAX_CALL_BYTES`, default 32MB), in bytes rather than rows because a captured call is ~95KB on one lane and ~700KB on another. The newest call is always kept, so the bound can never discard the turn being debugged.",
          "**`cache_shortfall_tokens` is bounded by the current turn's input as well as the previous turn's.** A request cannot re-read more than it contains, so a turn that shrank — which is what compaction produces — previously reported a large shortfall for a turn that had cached everything available to it.",
          "**`list_schedules` and `cancel_schedule` carry the control server's reason.** A bare `409` was read by an agent as \"my schedules are unreadable\" and filed as a blocker, when the server had actually said \"no active agent turn\".",
          "**An empty provider error body carries its HTTP status**, and a 404 with no body names the usual cause: a `MODEL_BASE_URL` missing its `/v1` path segment.",
        ],
      },
      {
        kind: "changed",
        items: [
          "**Sub-agent capability prose is locked to the enforced filter by test.** Research children have been read-only since 0.2.4 while five places went on describing them as having the parent's full rights, including the child's own role prompt, which instructed it to write files the engine refuses. A wrong tool description costs a plan; a wrong role prompt makes a running agent attempt something that always fails.",
        ],
      },
    ],
  },
  {
    version: "0.2.13",
    date: "August 9, 2026",
    iso: "2026-08-09",
    tagline: "Say what changed.",
    note: "The engine now reports which part of the prompt moved between turns, so a cache miss names its own cause. Compaction gets under its own ceiling reliably, and the arguments the model itself writes are bounded for the first time. This release also carries the work prepared as 0.2.12, which was never published, so upgrading from 0.2.11 is a single step rather than two. That step is one-way: two migrations, and a lane rolled back to 0.2.11 afterwards will not boot. Snapshot the workspace before upgrading, and verify the archive actually contains DELTA.md, because the self-file lives in the workspace rather than the database and the workspace path is not the same on every deployment.",
    groups: [
      {
        kind: "added",
        items: [
          "**Prefix identity on `model.call`.** `spine_hash` and `tools_hash`, salted per daemon process, alongside `spine_bytes`, `tools_bytes`, `tools_n`, `self_bytes`, `history_bytes` and `ephemeral_bytes`. A miss with a moved hash names the segment that changed; a miss with both stable proves the prefix was intact. The salt is per process, so compare bytes across a restart and hashes only within one.",
          "**`cache_shortfall_tokens`**, the previous request's gross input minus this call's cache reads. Prefer it to `cache_hit_pct`, which is a ratio whose denominator grows as history is appended and so moves even when caching is perfect. Measured in production across eleven turns: the ratio spanned 59% to 97% while the shortfall held flat and the prefix never moved. The shortfall's floor equals `ephemeral_bytes` and is structural.",
          "**A context ceiling derived from the model.** `pricing.ts` gains an optional `window`; `DELTA_COMPACT_AT_TOKENS` becomes an override, clamped with a boot warning when it exceeds what the smallest model in the cascade supports. An unknown model keeps the 120,000 default.",
          "**`tool.breaker`** when a failing tool is quarantined, with the schema bytes withdrawn.",
          "**`last_event_ms_ago` on `/v1/busy`** while a run is in flight: how long the daemon has been silent, which is the signal a stall detector needs. Daemon-wide, so use `/v1/tasks/:id/events` for a per-run decision.",
          "**`capture_enabled` on `/v1/dev/runs/:id/calls`**, plus an explanation when the result is empty. Request capture requires `DELTA_CAPTURE_CALLS`, which is dev-only and distinct from `DELTA_CAPTURE_PAYLOADS`.",
          "`self: {bytes, cap}` on `/v1/status`, and the canonical profile name.",
          "`recall` with an empty query lists the thread's spilled and evicted artifacts.",
        ],
      },
      {
        kind: "changed",
        items: [
          "**Compaction targets a flat budget instead of one derived from its own trigger.** A high ceiling used to produce a retained tail nearly as large as the ceiling, so compaction landed just under budget and re-fired next turn. It now compacts to a fixed target, fires less often, and reliably gets under the limit. A lane measured at a 60,000-token ceiling went from eight compactions, five context-irreducible errors and an 18% ceiling overrun to four compactions, no errors and a peak under the ceiling. **No effect on lanes with a ceiling below roughly 33,000 tokens**, where the previous calculation was already the smaller of the two.",
          "**`compaction` events count attempts, not rewrites.** An attempt that ran the summarizer and produced nothing usable was billed and reported nothing. It now emits with `shrank: false` and a reason. **Filter `shrank = true` to reproduce previous counts.**",
          "**`model.call` covers the utility model.** Compaction summaries, research fan-out, reflection and `eval_n` judging previously charged the run without emitting anything. **Filter `tier = 'main'` anywhere you count turns.**",
        ],
      },
      {
        kind: "fixed",
        items: [
          "**A compaction interrupted by a crash no longer resumes with a stale context estimate.** The provider-anchored estimate is reset inside the same transaction that rewrites history, on both the proactive and overflow-recovery paths.",
          "**A succeeded call's arguments are bounded.** Tool results were capped on arrival and demoted at compaction; the arguments the model wrote were bounded by neither. They are now elided to a pointer once the call has succeeded, at a seam where a resume no longer needs them, so it costs no prefix-cache churn.",
          "**A crash mid-batch no longer strands uncommitted parallel tool calls.**",
          "**Concurrent `spawn_subagent` cannot overspend the run budget.** Each child read the full remaining budget at spawn, before any sibling had charged a token. Replaced with a live reservation reconciled on exit.",
          "**The self-write breaker no longer quarantines an agent that is converging.** An attempt closing a material share of the remaining gap resets the streak, bounded by a hard attempt ceiling.",
        ],
      },
    ],
  },
  {
    version: "0.2.11",
    date: "August 3, 2026",
    iso: "2026-08-03",
    tagline: "Context economics.",
    note: "Prompt caching and compaction were each defeating themselves. Both are fixed, and the pair compounds, because a prompt that stays small needs compacting far less often. No configuration change is required and nothing is opt-in. One caveat: Anthropic's cache lookup scans a bounded number of blocks back from each breakpoint, and demotion reduces the size of a tool result but not the number of blocks, so a turn with many parallel tool calls can still miss the previous cached tail.",
    groups: [
      {
        kind: "fixed",
        items: [
          "**Rolling cache breakpoints land on persisted transcript.** They were marking the derived per-turn blocks the engine appends after the history — context, retrieval, plan, budget — one of which carries a clock. A cached prefix ending on a block that changes every turn can never be matched again, so every turn wrote a cache that could not be read back and only the system prefix was ever served from cache. Both wire serializers now share one eligibility rule.",
          "**Compaction shrinks the prompt it was called to shrink.** Nothing re-bounded the recent tail it keeps: a tool result is capped once, when it is produced, and the capped copy then rode the active context for the rest of the session. Spilled results in the retained tail are demoted to a bounded head plus their spill pointer; the full output stays on disk and the original row stays archived for `recall`. When demotion alone is enough, the summarizer is skipped entirely.",
          "**Compaction's tail floor is a wire group, not a row count.** Two rows of any size could survive a zeroed budget, and the loop that repaired split tool groups was unbounded. Whole groups are selected instead, so a group is never split and there is nothing to repair.",
          "**Compaction reports progress honestly.** Success compared the summary against the prefix alone, in UTF-16 code units. It now compares the whole active set, before and after, in UTF-8 bytes, and requires a material reduction — except on overflow recovery, where any reduction beats failing the turn.",
          "**`prompt_cache_key` on the OpenAI-compatible wire.** It was sent on the Responses wire only, but it is a Chat Completions field and OpenAI documents it as required for reliable matching on GPT-5.6 and later. Sent only to hosts documented to accept it, with a per-provider override for a verified proxy.",
          "**`max_completion_tokens` on OpenAI's own endpoint.** `max_tokens` is deprecated on Chat Completions and o-series reasoning models reject it, so a direct `api.openai.com` base URL with a reasoning model failed on a parameter the engine controls. Other endpoints keep `max_tokens`, which OpenRouter normalizes for every upstream.",
        ],
      },
    ],
  },
  {
    version: "0.2.10",
    date: "August 1, 2026",
    iso: "2026-08-01",
    tagline: "The secret vault.",
    note: "An agent's third-party credentials can live encrypted in the daemon instead of the deployment environment, under one rule: a secret value never enters model-readable state. Fully opt-in; with no vault key set, a deployment runs exactly as 0.2.9.",
    groups: [
      {
        kind: "added",
        items: [
          "**The vault.** `DELTA_VAULT_KEY_FILE` (or `DELTA_VAULT_KEY`) enables an AES-256-GCM store in the daemon database — outside the model-writable workspace, so the workspace-confined file tools cannot reach the ciphertext. With neither set there is no vault: the routes `503`, the tool is not registered, and a reference fails closed. Safe mode never carries one.",
          "**A write-only seam.** `PUT /v1/secrets/:name` stores a credential; `GET /v1/secrets` lists names, purposes, and timestamps. No route returns a value. `PUT` is create-only (`409` on an existing name), so a gateway flow cannot silently replace an established credential; rotation and deletion are operator acts on `/v1/dev/secrets/:name` behind the inspect token.",
          "**`{{vault:NAME}}` references** in MCP HTTP headers and stdio `env`, resolved in engine code at egress — per call for headers, at spawn for a child. Configuration holds the name, never a value. A backend that could not connect at boot for want of its credential reconnects when it arrives.",
          "**`list_secrets`**, the model's entire view of the vault: names and purposes. There is deliberately no tool that returns a value.",
          "**Runtime credentials for built-ins.** `web_search` falls back to a vaulted `EXA_API_KEY`, resolved per call, so handing an agent a search key enables the tool without a redeploy.",
          "**Exact-value redaction.** A value is registered when resolved for egress, in raw, percent-encoded, and JSON-escaped form. A later reflection of it is replaced with `[vault:NAME]` before reaching the model, the transcript, a spill file, a research artifact, or telemetry.",
          "**`/v1/status` reports the vault** live: `enabled`, `count`, and `declared` — the names the running configuration wires a destination for, so an edge can refuse a request for a credential nothing is configured to use.",
        ],
      },
      {
        kind: "changed",
        items: [
          "**stdio MCP servers no longer inherit the daemon environment.** A configured server child now receives process plumbing (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`) plus its own `env` object. Previously every stdio server received the daemon's full environment, including broker, control, telemetry, and provider credentials. A server that relied on an inherited variable must now declare it in its `env`.",
        ],
      },
    ],
  },
  {
    version: "0.2.9",
    date: "August 1, 2026",
    iso: "2026-08-01",
    tagline: "Affordances for correct long chat turns.",
    note: "Two additive, opt-in affordances that let a fire-and-forget gateway (Delta Connect) run long chat turns correctly under loss and concurrency. With nothing new set, a deployment runs exactly as 0.2.8.",
    groups: [
      {
        kind: "added",
        items: [
          "**Opt-in exactly-once tasks.** A request may set `idempotency_terminal: true` (on a durable run) so its `idempotency_key` also dedupes against its own terminal run, not only a live one. A fire-and-forget caller that loses the `202` for a durably-accepted run can re-POST the same key and re-attach to that run instead of starting a second — no duplicate billing, no stranded result. Owner-scoped; the free-the-key default is unchanged.",
          "**Run identity on self-scheduling.** `schedule_self` / `list_schedules` / `cancel_schedule` assert the run's owner to the control plane via `x-delta-user`, so a gateway can bind a schedule to the right conversation even when several users' turns run concurrently. An unowned run sends no assertion and the gateway falls back as before.",
        ],
      },
    ],
  },
  {
    version: "0.2.8",
    date: "August 1, 2026",
    iso: "2026-08-01",
    tagline: "A legible command surface.",
    note: "A legible command surface. A deployed agent can describe its own provider and effort in plain terms, safe mode is observable and self-aware, and the provider cascade is queryable. All additive read-surface plus one honesty fix; with nothing new set, a deployment runs exactly as 0.2.7.",
    groups: [
      {
        kind: "added",
        items: [
          "**`/v1/status` names the provider.** A friendly wire label (`anthropic-native`, `openai-native`, `openrouter`, `codex-sign-in`) on the model view, plus `provider_chain` for the full failover cascade.",
          "**Reasoning effort always resolves.** The status `reasoning_effort` field is never omitted; an unset effort reports `default` (the provider's own) instead of a blank line.",
          "**`safe_mode` on `/v1/status`.** An operator can confirm safe mode from an edge client instead of reading the boot log.",
        ],
      },
      {
        kind: "changed",
        items: [
          "**Safe mode is self-aware.** The system spine drops the configured agent name in a safe-mode boot (so the agent no longer presents as its configured persona) and states that persona, policy, and the learned self-file are not loaded this run. The agent is honest about its footing instead of inferring an identity from conversation history.",
        ],
      },
    ],
  },
  {
    version: "0.2.7",
    date: "July 31, 2026",
    iso: "2026-07-31",
    tagline: "Agents that know their limits and can't wedge.",
    latest: false,
    note: "Agents that know their limits and can't wedge. The two run tiers are renamed to name what they are, the tool set becomes an operator knob, and a poisoned config is always recoverable. Default behavior is unchanged: with the new env vars unset, a deployment runs exactly as 0.2.6.",
    groups: [
      {
        kind: "added",
        items: [
          "**Custom tool envelope.** `DELTA_ALLOWED_TOOLS` / `DELTA_PINNED_TOOLS` define an exact tool surface. They narrow within the tier and cannot escalate it (a `safe` daemon stays safe); build a broad envelope from `trusted` plus a list.",
          "**Budget self-awareness.** A one-time qualitative wrap-up nudge to the model once any budget axis passes ~85%. Not a raw counter.",
          "**Resilience.** An output-capped tool call is reissued smaller instead of executed truncated; one deterministic tool-argument repair pass; unified provider error classification (moderation terminal, quota fails over, transient retries).",
          "**Safe mode.** `DELTA_SAFE_MODE=1` boots a neutral, safe-floor, no-MCP agent so a poisoned self-file or broken config can never wedge the daemon. Self-file revert via the existing Cockpit endpoints.",
          "**Local skills.** `DELTA_SKILLS=local` reads `skills/<name>/SKILL.md` folders (use-only, progressive disclosure - only name and description enter the prompt). `off` hides skills entirely; `mcp` (default) is unchanged.",
          "**`GET /v1/status`** - a secret-free model, effort, tier, and budget read for edge tooling.",
        ],
      },
      {
        kind: "changed",
        items: [
          "**The two run tiers are renamed** `chat` to `safe` and `work` to `trusted`, naming the capability axis rather than an activity. The old names remain aliases, so existing `DELTA_PROFILE=work` deployments resolve unchanged; the canonical name in telemetry and `/v1/status` is the new one.",
          "**A committed self-file (`remember`) write on a budget-failed turn is surfaced** in the failure result instead of silently swallowed.",
        ],
      },
    ],
  },
  {
    version: "0.2.6",
    date: "July 30, 2026",
    iso: "2026-07-30",
    tagline: "A default deployment that describes itself.",
    note: "A default deployment that describes itself. Two telemetry blind spots are closed, so a default deployment is fully self-describing: cost, fallbacks, and error classes are queryable without turning on payload capture. The Anthropic fast-mode wire ships inert by default, so enabling it is a single env flip the day an org's allocation lands. No behavior changes when nothing is set; upgrading is a version bump.",
    groups: [
      {
        kind: "added",
        items: [
          "**Safe telemetry without payload consent.** `model.call`, `tool.call`, and `tool.result` now export a closed allowlist of operational attributes (model, provider, tokens, cost, latency, effort, fallback, `error.class`, tool names). Prompts, tool arguments, results, `error.message`, and `tool_calls` still require `DELTA_CAPTURE_PAYLOADS=1`.",
          "**`model.fallback` event** when a call is served by a model other than the configured primary, plus `fallback: true` on that `model.call` and a stderr marker.",
          "**`error.class` on failed `tool.result`** - a low-cardinality class (`self_cap`, `self_conflict`, `timeout`, `transient`, `categorical`, and more). A 200-char `error.message` snippet rides alongside it, local-only unless payload capture is on.",
          "**`gen_ai.request.effort` on `model.call`** - the reasoning effort each call ran at, bounded to the known tiers on export.",
          "**`self.pressure` event + stderr warning** when `DELTA.md` is elided from the prompt (over cap) or over 90% full. Seed `DELTA.md` at no more than half its cap.",
          "**Anthropic fast mode** (`DELTA_SPEED=fast`, off by default, byte-identical when unset). Opus 5 and Opus 4.8 only; the served speed lands on `model.call` telemetry. 2x token pricing, so pair it with a `DELTA_MODEL_PRICES` override.",
        ],
      },
      {
        kind: "changed",
        items: [
          "**The categorical-failure breaker now latches self-write storm classes.** Repeated `remember` refusals whose messages vary per call (byte counts, file text) are now quarantined at 3 instead of grinding. Conflict, transient, and timeout never latch.",
        ],
      },
    ],
  },
  {
    version: "0.2.5",
    date: "July 30, 2026",
    iso: "2026-07-30",
    tagline: "Fast, reliable first turns after idle.",
    note: "The first turn after an idle or suspended machine wakes is now fast and reliable, and a misbehaving provider is visible instead of silent. A rare turn-1 stall traced to the first model call reusing a pooled connection stranded by a suspend/resume, where it hung with no logs and no events; this release heals that automatically, bounds any future stall to seconds, and surfaces every retry. No wire changes, so upgrading is a one-line version bump and every new setting is safe by default.",
    groups: [
      {
        kind: "added",
        items: [
          "**First-byte deadline.** `DELTA_FIRST_BYTE_MS` (default 30s) bounds the connect-and-first-header phase the per-chunk idle watchdog cannot see. A call that cannot reach the provider now fails fast and retries in about 30s instead of hanging on a dead connection up to the 600s cap. On by default and independent of `DELTA_STREAM_IDLE_MS`; set `0` to opt out.",
          "**Self-healing wire after idle or resume.** The first call after a suspend/resume, or after five minutes of silence, automatically opens a fresh connection instead of reusing a stale pooled one, so a woken lane's opening turn just works. A best-effort preconnect at boot and on resume also pays DNS and TLS off the first turn's path. Fully automatic; the only cost is one extra TLS handshake on that first call.",
          "**Retry visibility, end to end.** Every retry, re-auth, model switch, and provider failover now emits a persisted `model.retry` event and one log line, so a host can show real 'retrying' state instead of dead air. `model.call` also carries `wall_ms` and `retries` beside `latency_ms`, so a slow turn's pre-call gap is one query away (`wall_ms` minus `latency_ms`). Nothing to enable.",
          "**`DELTA_CACHE_TTL=1h`** (opt-in, off by default). For a lane serving several turns an hour, keeps the stable prefix (system spine plus tools) cached for an hour instead of five minutes, for a faster and cheaper turn 1. Byte-identical when unset; 1h cache writes bill double, so turn it on only for busy lanes.",
        ],
      },
      {
        kind: "fixed",
        items: [
          "**No more silent retry storms.** Failed model attempts now log one line each, so a retry storm is never silent. Previously only successful calls printed a line.",
        ],
      },
    ],
  },
  {
    version: "0.2.4",
    date: "July 28, 2026",
    iso: "2026-07-28",
    tagline: "Harden what shipped; close the gaps.",
    note: "Security, observability, and performance hardening. No wire changes, so upgrading is a one-line version bump — every change is provider-agnostic and lands with tests.",
    groups: [
      {
        kind: "added",
        items: [
          "**Tunable concurrency.** `DELTA_MAX_CONCURRENCY` sets how many sessions run at once — default **8** (up from 4), clamped 1–256. Sessions stay serial and the queue is tested correct to **128** concurrent runs; the practical ceiling is your provider's rate limit, so keep it low on a subscription key and 25+ on a high-limit API key. Budget roughly **4–15 MB per active run**.",
          "**Live progress without a stream.** `GET /v1/tasks/:id/events?since=<id>` returns a cursor-paged JSON page for hosts that can't hold an SSE connection, and `model.call` events now carry `cache_hit_pct` so you can watch per-turn prompt-cache warmth live instead of reconstructing it after the fact.",
          "**One-step operator-config updates.** The new `delta bundle apply` command (also run on every boot) re-seeds the fixed operator files, validating each first and never touching the agent's learned `DELTA.md`.",
        ],
      },
      {
        kind: "changed",
        items: [
          "**Faster cold starts on scale-to-zero.** A host can now flip `stop` → `suspend` and cut cold start from **~4.7s to ~1.1s**. The write-lease reclaims itself across a suspend instead of exiting and stalling on the platform's restart cap.",
          "**Per-tenant task access.** `GET`/`DELETE /v1/tasks/:id` and `…/events` now enforce that the caller owns the run — a cross-tenant or unknown id both return `404`. Ownership comes from the gateway `x-delta-user` header, never a request body. Set `DELTA_STRICT_TENANT` to require an owner on every run.",
          "**Memory-widening can't be self-asserted.** The metadata that widens a private memory to a broader audience is stripped from every request body by default, so a caller can't self-authorize it. `DELTA_TRUST_REVIEW_METADATA=1` opts a single-tenant daemon back in.",
          "**Read-only research subagents.** A research child is admitted only read-only tools; anything unmarked defaults to mutating, so it can never write, `remember`, or run code mid-run.",
          "**Earlier, cheaper compaction.** The pre-send size gate now projects off the provider's real last-call input, so a long run compacts before it wastes a frontier call on an over-budget request.",
          "**Deterministic memory recall.** An identical query returns the same set every time (ranking no longer drifts on a self-mutating counter). `DELTA_ISOLATE_AGENT_MEMORY` keeps agents on a shared database from reading each other's rows.",
        ],
      },
      {
        kind: "fixed",
        items: [
          "**Concurrent self-writes no longer clobber each other.** Two runs calling `remember` at once used to overwrite each other's `DELTA.md`, silently dropping one lesson. A compare-and-swap now lets both survive.",
          "**No more silently dropped lessons.** A malformed learning could throw and be lost entirely (latent since 0.1.0); it now degrades to a best-effort learning instead of none.",
        ],
      },
    ],
  },
  {
    version: "0.2.3",
    date: "July 28, 2026",
    iso: "2026-07-28",
    tagline: "Failure-visibility, from the field.",
    note: "Driven by Aperture's production field report — two prod agents, the harness's heaviest real consumer. Every item ships with a test.",
    groups: [
      {
        kind: "added",
        items: [
          "A first-class `error` field on `GET /v1/tasks/:id`. It carries the run's last error — the provider or fatal error that ended it — so a plain HTTP poller learns *why* a run failed before its first token instead of seeing a merely-dead run. Both incidents that motivated it were provider errors that failed the run before its first token (Opus 5 rejecting `thinking.type=enabled`; an untranslated fallback id). Per-tool errors stay in the message stream.",
          "Run lifecycle timestamps on `GET /v1/tasks/:id`: `created_at` (accepted), `started_at` (dequeued and began executing), and `finished_at` (terminal), so a host can measure queue wait separately from execution time instead of one faith-based spinner.",
          'Native Anthropic adaptive thinking. `DELTA_REASONING_EFFORT` now maps to `thinking:{type:"adaptive"}` + `output_config.effort` on Claude 4.6+ and every Claude 5 model, which reject the legacy `thinking:{type:"enabled"}`; the budget wire is kept for Claude ≤4.5. On the adaptive path `none`/`minimal` map to `low`, and Delta raises `max_tokens` by an effort-based headroom. Effort control now works on frontier models.',
          "Baked `claude-opus-5` pricing, so the native and subscription paths meter real dollars without a `DELTA_MODEL_PRICES` override.",
          "The four hosting lifecycle contracts are now documented guarantees in `docs/hosting.md` — idempotency keys freed on terminal runs, `recover()` resumes mid-flight runs on boot, `/v1/busy` reports the durable queued-or-running truth, and seeding never touches an existing `DELTA.md` — each pinned by a named guard test so it can't silently regress.",
        ],
      },
      {
        kind: "changed",
        items: [
          "Categorical-failure breaker. A tool that returns the same categorical `[tool error]` on three consecutive turns (a missing CLI, a persistent schema reject) is quarantined for the rest of the run and the model is told to try another approach — a success, transient, or different error resets the count. This caps the field report's worst case (a missing `code` CLI that burned ~$3.50 of a $5.17 run by looping ~17 turns): a live replay spent pennies on the dead end and still filed its output.",
          "The `code` tool self-disables when its CLI isn't an executable file — probed once at boot via `Bun.which` (bare name) or `accessSync(X_OK)` (explicit path), so a capability the daemon can't back is never offered. A CLI that passes the probe but fails at runtime is caught by the breaker instead; the two layers are complementary.",
          "All native-wire model ids are normalized (prefix stripped, dotted versions → dashes) for the primary *and* every fallback, not just the utility model. An untranslated fallback id was one of the two silent zero-token failures the release targets.",
        ],
      },
    ],
  },
  {
    version: "0.2.2",
    date: "July 27, 2026",
    iso: "2026-07-27",
    tagline: "Self-write, budgets, and a channel edge.",
    groups: [
      {
        kind: "added",
        items: [
          "`DELTA_ALLOW_SELF_WRITE` — trusted-gateway self-write. Off by default. When set, the `remember` self-write tool is granted (and pinned) even on the restricted `chat` profile, for a daemon fronted by a trusted, authenticated gateway. This is what lets a chat agent learn safely.",
          "`DELTA_STEP_MAX_TOKENS` — cap the tokens a single tool call may emit, with an honest truncation error for oversized tool calls instead of silent corruption.",
          "Companion package [`@carrara-labs/delta-connect`](https://www.npmjs.com/package/@carrara-labs/delta-connect) — a thin, always-on edge that plugs a Delta agent into a chat channel (Telegram first). The agent scales to zero between messages; the edge holds the conversation. See [/connect](https://deltaharness.dev/connect).",
        ],
      },
      {
        kind: "changed",
        items: [
          "`DELTA_MAX_TOKENS` / `DELTA_MAX_COST_USD` now override the profile budget instead of only narrowing it, so an operator can raise as well as lower a profile's budget explicitly.",
        ],
      },
    ],
  },
  {
    version: "0.2.1",
    date: "July 22, 2026",
    iso: "2026-07-22",
    tagline: "Scale-to-zero, made safe.",
    groups: [
      {
        kind: "added",
        items: [
          "`GET /v1/busy` — the scale-to-zero lifecycle signal. A host managing suspend and resume can ask the daemon “is it safe to suspend?” and get `{ busy, running, queued }`, read from the durable run table so a machine is never suspended with work still owed — including a queued run that hasn't started. It sits behind the `/v1/` control-token gate, deliberately not folded into the open, data-free `/healthz`.",
          "`docs/hosting.md` — the hosting lifecycle contract: control-plane-owned suspend and resume, the three host hooks (wake before dispatch, busy-check before suspend, suspend after terminal), and the WAL suspend-safety guarantee that makes aggressive suspend safe.",
        ],
      },
      {
        kind: "changed",
        items: [
          "`DELTA_MCP_SERVERS` parsing fails loud, never silent. A malformed value used to boot the agent tool-less and burn a full model run before anyone noticed. Malformed JSON, a non-array, and each unusable entry are now dropped with a specific boot-log warning — and a missing `transport` is inferred from the entry shape (`url` → `http`, `command` → `stdio`) so a common omission just works.",
        ],
      },
      {
        kind: "fixed",
        items: [
          "A bad `stdio` MCP server no longer crashes boot. A command that spawns and throws synchronously is now caught inside the registry boundary and logged, and the daemon boots with the remaining backends — honoring the “one bad server is never fatal” contract.",
        ],
      },
    ],
  },
  {
    version: "0.2.0",
    date: "July 22, 2026",
    iso: "2026-07-22",
    tagline: "Sub-agents grow up.",
    groups: [
      {
        kind: "changed",
        items: [
          "Sub-agents (`research`) now hold the same rights as the parent, not a read-only subset. A child's callable tools are the parent's full registry minus a small withheld set (the delegation tools `research`/`spawn_subagent`/`eval_n`, plus the run-scheduling tools), so nesting stays exactly one level deep. A child can read, write, run code, `remember`, and call MCP reads and writes — whatever the parent can — and it's built from the same system spine, so it inherits the parent's rules along with its rights.",
        ],
      },
      {
        kind: "removed",
        items: [
          "`DELTA_RESEARCH_TOOLS`. The operator allowlist that gated which MCP reads a `research` child could use is gone — children inherit the parent's tools directly. The variable is now ignored; remove it from any config.",
        ],
      },
    ],
  },
  {
    version: "0.1.2",
    date: "July 22, 2026",
    iso: "2026-07-22",
    tagline: "Safe-to-retry dispatch.",
    groups: [
      {
        kind: "added",
        items: [
          "Dispatch idempotency for `POST /v1/tasks`. A run request may carry an `idempotency_key`; a retry dedupes onto the live run instead of starting a duplicate, so fire-and-forget async dispatch is safe to retry. Race-safe with no schema migration, and it composes with `store: false`.",
        ],
      },
    ],
  },
  {
    version: "0.1.1",
    date: "July 16, 2026",
    iso: "2026-07-16",
    tagline: "Container image, cleaner clone.",
    groups: [
      {
        kind: "added",
        items: [
          "Published `docker run` image at `ghcr.io/carrara-labs/delta-harness`, documented on the Deploy guide.",
          "Hardened release and secret-scan workflows: checksum-verified gitleaks, a tag-gated scan, and ghcr publish.",
        ],
      },
      {
        kind: "changed",
        items: [
          "Clearer, more technical README and npm package description.",
          "Removed stale monorepo doc-sync tooling so `bun run check` works on a clean clone.",
        ],
      },
      {
        kind: "fixed",
        items: [
          "Sub-agents inherit the parent's model: `childEnv` forwards `DELTA_MODEL_PRIMARY`, not just the legacy `DELTA_MODEL` alias.",
        ],
      },
    ],
  },
  {
    version: "0.1.0",
    date: "July 16, 2026",
    iso: "2026-07-16",
    tagline: "Delta, in the open.",
    note: "Initial public release.",
    groups: [
      {
        kind: "added",
        items: [
          "Product-neutral engine: a durable Run and queue (crash- and redeploy-resumable), a zero-dependency OpenAI-compatible provider with model failover and prompt-cache breakpoints, the tool-call loop with builtins and profiles, an MCP client with progressive tool disclosure, usage-aware compaction, a governed memory rail, and NDJSON observability.",
          "The bundle model (`agent = engine + bundle + state`): `delta init` scaffolds a bundle and `delta dev` boots the local Cockpit.",
          "The HTTP seam: `POST /v1/responses`, `GET /healthz`, and the async `POST /v1/tasks` surface.",
          "Apache 2.0 license, single-binary builds, and the container image.",
        ],
      },
    ],
  },
];

function renderInline(text: string) {
  // Lightweight inline Markdown so change entries can be authored naturally: backticks for
  // identifiers (`/v1/busy`), `**bold**` for the lead phrase, `*italic*` for emphasis. Flat
  // tokenizer (no nesting) — code is matched first so backticks are never re-parsed. Keyed by
  // the part's character offset in the source string — stable and unique, never the array index.
  let offset = 0;
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part) => {
    const key = `${offset}:${part}`;
    offset += part.length;
    if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

// A small line icon per change category, drawn in the category's own colour (inherits
// currentColor from the label). Added/Fixed read as positive (sage +/check); Changed/Removed
// read as mutating (clay swap/minus) — two accents, on-system with the rest of the page.
function KindIcon({ kind }: { kind: Kind }) {
  const paths: Record<Kind, ReactNode> = {
    added: <path d="M8 3.4v9.2M3.4 8h9.2" />,
    fixed: <path d="M3.6 8.4l2.9 2.9 5.9-6" />,
    changed: (
      <>
        <path d="M3 6h9M10 4l2 2-2 2" />
        <path d="M13 10H4M6 8l-2 2 2 2" />
      </>
    ),
    removed: <path d="M3.4 8h9.2" />,
  };
  return (
    <svg
      className="chg-ico"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[kind]}
    </svg>
  );
}

export default function Changelog() {
  useEffect(() => {
    document.body.classList.add("v2", "v3");
  }, []);

  const latest = releases.find((release) => release.latest) ?? releases[0];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="chg" tabIndex={-1}>
        {/* ===== HERO ===== */}
        <section className="chg-hero" id="top">
          <div className="page">
            <div className="chg-hero-inner">
              <span className="chg-eyebrow">
                <span className="chg-dot" /> Changelog
              </span>
              <h1 className="chg-title">Every release, in the open.</h1>
              <p className="chg-subline">
                The complete history of the Delta harness, from the first public package to today.
                Each version tracks the source <code>CHANGELOG.md</code> exactly — nothing shipped
                quietly.
              </p>
              <div className="chg-hero-actions">
                <span className="chg-current">
                  <span className="chg-current-label">Latest</span>
                  <span className="chg-current-ver">v{latest.version}</span>
                </span>
                <a className="chg-link" href={npmUrl} target="_blank" rel="noreferrer">
                  npm package
                </a>
                <a className="chg-link" href={releasesUrl} target="_blank" rel="noreferrer">
                  GitHub releases
                </a>
                <a className="chg-link" href={changelogSourceUrl} target="_blank" rel="noreferrer">
                  Source CHANGELOG
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ===== TIMELINE ===== */}
        <section className="chg-body-section">
          <div className="page">
            <div className="chg-timeline">
              {releases.map((release) => (
                <article
                  key={release.version}
                  className="chg-release"
                  aria-labelledby={`v-${release.version}`}
                >
                  <header className="chg-meta">
                    <h2 className="chg-version" id={`v-${release.version}`}>
                      v{release.version}
                    </h2>
                    {release.latest ? <span className="chg-latest">Latest</span> : null}
                    <time className="chg-date" dateTime={release.iso}>
                      {release.date}
                    </time>
                  </header>

                  <div className="chg-content">
                    <p className="chg-tagline">{release.tagline}</p>
                    {release.note ? <p className="chg-note">{release.note}</p> : null}

                    {release.groups.map((group) => (
                      <div className="chg-group" data-kind={group.kind} key={group.kind}>
                        <span className="chg-group-label">
                          <KindIcon kind={group.kind} />
                          {kindLabel[group.kind]}
                        </span>
                        <ul className="chg-items">
                          {group.items.map((item) => (
                            <li key={item.slice(0, 48)}>{renderInline(item)}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ===== FOOTNOTE ===== */}
        <section className="chg-foot">
          <div className="page">
            <div className="chg-foot-inner">
              <p>
                Delta follows{" "}
                <a href="https://semver.org" target="_blank" rel="noreferrer">
                  Semantic Versioning
                </a>
                . A daemon reports its running version at <code>/healthz</code>, and upgrades only
                ever move a deployed agent's database forward.
              </p>
              <p>
                Watch the{" "}
                <a href={repoUrl} target="_blank" rel="noreferrer">
                  repository
                </a>{" "}
                for what's next.
              </p>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
