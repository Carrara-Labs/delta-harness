# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.10] — 2026-08-01

The secret vault. An agent's third-party credentials can live encrypted in the daemon instead of
the deployment environment, under one rule: a secret value never enters model-readable state. Fully
opt-in; with no vault key set, a deployment runs exactly as 0.2.9.

### Added
- **The vault.** `DELTA_VAULT_KEY_FILE` (or `DELTA_VAULT_KEY`) enables an AES-256-GCM store in the
  daemon database — outside the model-writable workspace, so the workspace-confined file tools
  cannot reach the ciphertext. With neither set there is no vault: the routes `503`, the tool is
  not registered, and a reference fails closed. Safe mode never carries one.
- **Write-only seam.** `PUT /v1/secrets/:name` stores a credential and `GET /v1/secrets` lists
  names, purposes, and timestamps. No route returns a value. `PUT` is create-only (`409` on an
  existing name), so a gateway flow cannot silently replace an established credential; rotation and
  deletion are operator acts on `/v1/dev/secrets/:name` behind the inspect token.
- **`{{vault:NAME}}` references** in MCP HTTP headers and stdio `env`, resolved in engine code at
  egress — per call for headers, at spawn for a child. Configuration holds the name, never a value.
  A backend that could not connect at boot for want of its credential reconnects when it arrives.
- **`list_secrets`**, the model's entire view of the vault: names and purposes. There is
  deliberately no tool that returns a value.
- **Runtime credentials for built-ins.** `web_search` falls back to a vaulted `EXA_API_KEY`,
  resolved per call, so handing an agent a search key enables the tool without a redeploy.
- **Exact-value redaction.** A value is registered when resolved for egress, in raw,
  percent-encoded, and JSON-escaped form. A later reflection of it is replaced with `[vault:NAME]`
  before reaching the model, the transcript, a spill file, a research artifact, or telemetry.
- **`/v1/status` reports the vault** live: `enabled`, `count`, and `declared` — the names the
  running configuration wires a destination for, so an edge can refuse a request for a credential
  nothing is configured to use.

### Changed
- **stdio MCP servers no longer inherit the daemon environment.** A configured server child now
  receives process plumbing (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`) plus its own
  `env` object. Previously every stdio server received the daemon's full environment, including
  broker, control, telemetry, and provider credentials. A server that relied on an inherited
  variable must now declare it in its `env`.

## [0.2.9] — 2026-08-01

Two additive affordances that let a fire-and-forget gateway (Delta Connect) run long chat turns
correctly. Both are opt-in; with nothing new set, a deployment runs exactly as 0.2.8.

### Added
- **Opt-in exactly-once tasks.** A request may set `idempotency_terminal: true` (on a durable run)
  so its `idempotency_key` also dedupes against its own *terminal* run, not only a live one. A
  fire-and-forget caller that loses the `202` for a run the daemon durably accepted can re-POST the
  same key and re-attach to that run instead of starting a second — no duplicate billing, no
  stranded result. The dedupe stays scoped to the run's owner. The default (a terminal run frees
  its key, so a stable key reused later runs fresh) is unchanged.
- **Run identity on self-scheduling.** `schedule_self` / `list_schedules` / `cancel_schedule` now
  assert the run's owner to the control plane via `x-delta-user`, so a gateway can bind a schedule
  to the right conversation even when several users' turns run concurrently. An unowned/dev run
  sends no assertion and the gateway falls back as before.

## [0.2.8] — 2026-08-01

A legible command surface. A deployed agent can describe its own provider and effort in plain
terms, safe mode is observable and self-aware, and the provider cascade is queryable. All
additive read-surface plus one honesty fix; with nothing new set, a deployment runs exactly as
0.2.7.

### Added
- `/v1/status` names the provider: a friendly wire label (`anthropic-native`, `openai-native`,
  `openrouter`, `codex-sign-in`) on the model view, plus `provider_chain` for the full failover
  cascade.
- Reasoning effort always resolves: the status `reasoning_effort` field is never omitted. An
  unset effort reports `default` (the provider's own) instead of leaving the field blank.
- `safe_mode` on `/v1/status`: an operator can confirm safe mode from an edge client instead of
  reading the boot log.

### Changed
- Safe mode is now self-aware. The system spine drops the configured agent name in a safe-mode
  boot (so the agent no longer presents as its configured persona) and states that persona,
  policy, and the learned self-file are not loaded this run. The agent is honest about its
  footing instead of inferring an identity from conversation history.

## [0.2.7] — 2026-07-31

Agents that know their limits and can't wedge. The two run tiers are renamed to name what
they are, the tool set becomes an operator knob, and a poisoned config is always recoverable.
Default behavior is unchanged: with the new env vars unset, a deployment runs exactly as 0.2.6.

### Added
- Envelope knob: `DELTA_ALLOWED_TOOLS` / `DELTA_PINNED_TOOLS` define a custom capability
  envelope. They narrow within the tier and cannot escalate it (a `safe` daemon stays safe);
  build a custom powerful envelope from `trusted` plus a list.
- Budget self-awareness: a one-time qualitative wrap-up nudge to the model once any budget
  axis passes ~85%. Not a raw counter.
- Resilience: an output-capped tool call is reissued smaller instead of executed truncated;
  one deterministic tool-argument repair pass for slightly-malformed calls; unified provider
  error classification (moderation terminal, quota fails over, transient retries).
- Safe mode: `DELTA_SAFE_MODE=1` boots a neutral, safe-floor, no-MCP agent so a poisoned
  self-file or broken config can never wedge the daemon. Self-file revert via the existing
  Cockpit revision endpoints.
- Local skills: `DELTA_SKILLS=local` reads a `skills/<name>/SKILL.md` folder (use-only,
  progressive disclosure — only name and description enter the prompt). `off` hides skills
  entirely; `mcp` (default) is unchanged.
- `GET /v1/status`: a secret-free model / effort / profile / budget read for edge tooling.

### Changed
- The two run tiers are renamed `chat` → `safe` and `work` → `trusted` to name the capability
  axis, not an activity. The old names remain as aliases, so existing `DELTA_PROFILE=work`
  deployments resolve unchanged; the canonical name in telemetry and `/v1/status` is the new one.
- A committed self-file (`remember`) write on a budget-failed turn is now surfaced in the
  failure result instead of silently swallowed (error-as-value).

## [0.2.6] — 2026-07-30

A default deployment that describes itself. Two telemetry blind spots are closed, so a
default deployment is fully self-describing: cost, fallbacks, and error classes are
queryable without turning on payload capture. The Anthropic fast-mode wire ships inert by
default, so enabling it is a single env flip the day an org's allocation lands. No
behavior changes when nothing is set; upgrading is a version bump.

### Added

- **Safe telemetry without payload consent.** `model.call`, `tool.call`, and `tool.result`
  now export a closed allowlist of operational attributes (model, provider, tokens, cost,
  latency, effort, fallback, `error.class`, tool names). Prompts, tool arguments, results,
  `error.message`, and `tool_calls` still require `DELTA_CAPTURE_PAYLOADS=1`.
- **`model.fallback` event** when a call is served by a model other than the configured
  primary, plus `fallback: true` on that `model.call` and a stderr marker.
- **`error.class` on failed `tool.result`** - a low-cardinality class (`self_cap`,
  `self_conflict`, `self_spine_echo`, `self_empty`, `self_unavailable`, `self_protected`,
  `timeout`, `transient`, `categorical`). A 200-char `error.message` snippet rides
  alongside it, local-only unless payload capture is on.
- **`gen_ai.request.effort` on `model.call`** - the reasoning effort each call ran at,
  bounded to the known tiers on export.
- **`self.pressure` event + stderr warning** when `DELTA.md` is elided from the prompt
  (over cap) or over 90% full. Seed `DELTA.md` at no more than half its cap.
- **Anthropic fast mode** (`DELTA_SPEED=fast`, off by default, byte-identical when unset).
  Opus 5 and Opus 4.8 only; the served speed lands on `model.call` telemetry. 2x token
  pricing, so pair it with a `DELTA_MODEL_PRICES` override.

### Changed

- **The categorical-failure breaker now latches self-write storm classes.** Repeated
  `remember` refusals whose messages vary per call (byte counts, file text) are now
  quarantined at 3 instead of grinding. Conflict, transient, and timeout never latch.

## [0.2.5] — 2026-07-30

The first turn after an idle or suspended machine wakes is now fast and reliable, and a
misbehaving provider is visible instead of silent. Field data (Aperture, 2026-07-29) traced a rare
turn-1 stall to the first model call reusing a pooled connection left stranded by a suspend/resume,
where it hung with no logs and no events. This release heals that automatically, bounds any future
stall to seconds, and surfaces every retry, plus an opt-in cache knob for lanes that run several
turns an hour. No wire changes, so upgrading is a one-line version bump and every new setting is
safe by default.

### Added

- **First-byte deadline** (`DELTA_FIRST_BYTE_MS`, default 30s; per-provider `firstByteMs`). Bounds
  the connect-and-first-header phase that the per-chunk idle watchdog cannot see. A call that cannot
  reach the provider now fails fast and retries in ~30s instead of hanging on a dead connection up
  to the 600s cap. On by default and independent of `DELTA_STREAM_IDLE_MS`; set `0` to opt out.
- **Self-healing provider wire after idle or resume.** The first call after a suspend/resume, or
  after five minutes of silence, automatically opens a fresh connection instead of reusing a stale
  pooled one, so a woken lane's opening turn just works. A best-effort preconnect at boot and on
  resume also pays DNS and TLS off the first turn's path. Fully automatic; the only cost is one
  extra TLS handshake on that first call.
- **Retry visibility, end to end.** Every retry, re-auth, model switch, and provider failover now
  emits a persisted `model.retry` event (with a stable `error.type`) and one log line, so a host
  can show real "retrying" state instead of dead air. `model.call` also carries `wall_ms` and
  `retries` beside `latency_ms`, so a slow turn's pre-call gap is one query away (`wall_ms` minus
  `latency_ms`). Nothing to enable.
- **`DELTA_CACHE_TTL=1h`** (opt-in, off by default, byte-identical when unset). For a lane serving
  several turns an hour, keeps the stable prefix (system spine plus tools, ~13k tokens) cached for
  an hour instead of five minutes, for a faster and cheaper turn 1. 1h cache writes bill double, so
  turn it on only for busy lanes; the per-run tail keeps the default TTL.

### Fixed

- Failed model attempts now log one line each, so a retry storm is never silent (previously only
  successful calls printed a line).

## [0.2.4] — 2026-07-28

Harden what shipped + close the remaining Aperture field-report gaps. Five code audits of the 0.2.3
binary plus a three-way competitor teardown (openclaw / hermes / pi) found that the two roadmap "big
blocks" — context management and scoped memory — were already shipped, so this release is targeted
correctness, security, and observability, each with tests. The two security surfaces (task tenancy,
memory widening) were codex-gated to a GO. Every change is provider-agnostic (no wire changes);
validated end-to-end on a real compiled binary against OpenRouter (Sonnet 5) and native Anthropic
(Opus 5).

### Security

- **Task-route tenancy + identity boundary.** `GET`/`DELETE /v1/tasks/:id` and `…/events` checked
  only that a run *existed*, so any control-token holder could read, poll, or cancel any run. They
  now enforce that the caller owns the run: the tenancy principal is the gateway-asserted
  `x-delta-user` header (never a request-body field), a cross-tenant hit and a miss return the same
  `404` (no existence disclosure), and the header is canonicalized into the stored run at ingress so
  memory recall, reflection, and event identity all key on the same owner — a body `user_id` can no
  longer point them at another tenant. The idempotency dedupe is scoped to the run's owner (a shared
  key can't return another tenant's live run or its streamed result), and the `previous_response_id`
  continuation check no longer leaks existence via a `400`-vs-`403` split. New `DELTA_STRICT_TENANT`
  requires every run to be owned (creation without a principal is `401`, unowned runs are
  inaccessible, `/v1/queue` is principal-scoped with tenant-local positions) for a daemon that serves
  multiple users behind one control token. `/v1/busy` stays global by design — it is the host's
  whole-machine suspend gate, control-token-gated and host-only.
- **Memory-widening authorization can't be self-asserted.** Reflection widens a `user`-scoped memory
  to a broader audience only on `review_kind = submission_disposition` + `widen_authorized`, both
  read from run metadata — which a caller controls. A shared control token authenticates the gateway,
  not that a body field came from a human reviewer, so those fields are now stripped from **every**
  request body by default (an untrusted body could otherwise widen its memory into a cross-user
  audience). `DELTA_TRUST_REVIEW_METADATA=1` is the single-tenant opt-in; a durable trusted
  challenge path is planned separately.

### Added

- **Pollable per-task event feed + per-turn cache-hit%** (Aperture A1). `GET /v1/tasks/:id/events`
  now also serves a bounded, cursor-paged JSON poll when given `?since=<id>` (with a `cursor` and a
  `done` flag), for hosts that can't hold an SSE connection; the live SSE tail takes an opt-in
  `?coarse=1` that drops the per-token deltas, leaving the structural heartbeat. `model.call` events
  carry a pre-computed `cache_hit_pct`, so a host sees live per-turn cache warmth (the 0–99%
  oscillation that previously could only be diagnosed forensically) instead of deriving it. Both
  surfaces inherit the task-tenancy gate above.
- **`delta bundle apply`** (Aperture A12). A first-class command (also run on every container boot)
  that re-seeds the FIXED operator files — `POLICY.md`, `vocab.json`, `PROMPT_CONTEXT.md` — from
  their base64 env vars and **never** touches the agent's learned `DELTA.md`. It validates every
  payload first (a `vocab.json` that isn't a JSON object, or a `POLICY.md` over the byte or token
  budget, is refused and *nothing* is written), so updating operator config on a live machine is one
  safe step instead of the old five-step `fly machine update` dance. The FIXED/self file split now
  lives in one manifest (`src/bundle.ts`) that the write-guard and cockpit allowlist also derive
  from, so it can't drift.
- **New config flags:** `DELTA_STRICT_TENANT`, `DELTA_TRUST_REVIEW_METADATA`, and
  `DELTA_ISOLATE_AGENT_MEMORY` (below). All default off (current single-tenant behavior).
- **Configurable run concurrency** (`DELTA_MAX_CONCURRENCY`, clamped 1–256). The number of
  concurrent cross-session runs was a hardcoded 4; it is now a config knob whose **default is 8**.
  Each run is IO-bound async work on one event loop (not a thread), and sessions stay serial, so the
  practical ceiling is the provider's concurrent-request tolerance (keep it low on a subscription
  key; a high-limit API key can run 25+), then per-run context memory (~4–15 MB/run). The queue
  mechanism is tested correct to 128 concurrent runs.

### Changed

- **Suspend-safe resume** (Aperture A2). The write-lease heartbeat exited the daemon when renewal
  failed — which, after a Fly suspend/resume across a wall-clock jump, meant the daemon exited
  *without releasing* and Fly's restart cap turned that into a minutes-long stall. It now
  `renew-or-reacquire`s: it reclaims its own machine-scoped lease and stays up, exiting only when a
  *different* live holder genuinely owns it. Both lease functions now sample the clock inside the
  write transaction. This is recovery, not fencing (the lease is unfenced and machine-scoped, as
  documented); it lets a scale-to-zero host flip `stop` → `suspend` and cut cold-start ~4.7s → ~1.1s.
- **Research subagents are genuinely read-only.** A research sub-agent inherited the parent's full
  rights, so it could `write_file` / `remember` / mutate via a mis-named MCP tool mid-run. Tools now
  carry a positive, fail-closed `readonly` marker and a research child is admitted **only** read-only
  tools; MCP tools are classed read-only from the authoritative `readOnlyHint` annotation, never a
  name heuristic. Anything unmarked defaults to mutating, so a new or forgotten tool can never leak a
  write into a child.
- **Pre-send context estimate is provider-anchored.** The pre-send compaction gate estimated the
  request with a byte rule that could sit just under budget while the provider's real input was over,
  wasting a frontier call before the post-provider overflow retry corrected it. It now also projects
  off the last call's *real* gross input plus the estimated growth since, taking the max with the
  byte estimate — so a long run compacts a call earlier without a tokenizer dependency, and never
  estimates below the existing floor.
- **Deterministic memory recall + agent isolation.** Recall ranked partly on a `hits` counter that
  the recall itself mutates, so an identical repeated query drifted its order; `hits` is dropped from
  ranking (usefulness now survives via TTL, not rank) and the sort gets a stable `id` tiebreak, so
  the same query returns the same set. New `DELTA_ISOLATE_AGENT_MEMORY=1` excludes the anonymous
  (`agent_id=''`) memory bucket from recall on a shared multi-agent DB, so one agent can't read
  another's unbound rows.

### Fixed

- **Concurrent self-writes no longer clobber each other.** Two runs on one daemon both calling
  `remember` wrote `DELTA.md` last-write-wins, silently dropping one run's lesson. `writeSelf` now
  uses optimistic concurrency: a write carries the base revision it read, a diverged base is refused
  (returning the current content), and the run re-reads, re-merges, and retries — so both concurrent
  lessons survive. An idempotent re-fire (the content already on disk) still no-ops. This is the one
  documented file-level compare-and-swap layer; other file writes remain last-write-wins.
- **A distilled learning could be silently dropped.** When the utility model returned a non-string
  field in a distilled artifact (a numeric `name`, an object `body`), reflection threw while
  persisting and the whole learning was lost — latent since 0.1.0. The artifact's `content`, `name`,
  and `body` are now type-guarded with safe fallbacks before use, so a malformed distiller response
  degrades to a best-effort learning instead of none.

## [0.2.3] — 2026-07-28

Failure-visibility + native-wire batch, driven by Aperture's production field report (two prod
agents, the harness's heaviest real consumer). Every item ships with a test.

### Added

- **Run error on the task surface.** `GET /v1/tasks/:id` now returns a first-class `error` field
  carrying the run's last error — the provider or fatal error that ended it (length-capped) — so a
  plain HTTP poller learns *why* a run failed before its first token instead of seeing a merely-dead
  run. Both motivating incidents were provider errors that failed the run before its first token
  (Opus 5 rejecting `thinking.type=enabled`; an untranslated fallback id). Per-tool errors stay in
  the message stream, as before.
- **Run lifecycle timestamps on the task surface.** `GET /v1/tasks/:id` now returns `created_at`
  (accepted/enqueued), `started_at` (dequeued and began executing), and `finished_at` (terminal),
  so a host can measure queue wait (created → started) separately from execution time (started →
  finished) instead of showing one faith-based spinner over the whole thing.
- **Native Anthropic adaptive thinking.** `DELTA_REASONING_EFFORT` now maps to the correct wire
  per model: `thinking:{type:"adaptive"}` + `output_config.effort` on Claude 4.6+ and all Claude 5
  models (Opus 5, Sonnet 5, Fable 5…), which **reject** the legacy `thinking:{type:"enabled"}`;
  the legacy budget wire is kept for Claude ≤4.5. Effort control now works on frontier models.
  Two specifics worth knowing: on the adaptive path the OpenAI-only `none` and `minimal` efforts
  map to `low` (always-on reasoning models reject a disabled thinking type), and Delta
  automatically raises the request's `max_tokens` by an effort-based headroom so adaptive thinking
  (which has no fixed budget) has room to breathe — size `DELTA_STEP_MAX_TOKENS` generously at high
  effort regardless.
- **Opus 5 pricing** baked into the cost table (`claude-opus-5`), so the native/subscription paths
  meter real dollars without a `DELTA_MODEL_PRICES` override.

### Changed

- **Categorical-failure breaker.** A tool that returns the *same* categorical `[tool error]` on
  three consecutive turns (a missing CLI, a persistent schema reject) is quarantined for the
  remainder of the run and the model is told to try another approach — a success, a transient
  error, or a different error resets the count, and multiple failures in one turn count once. This
  caps the field report's worst case (a missing `code` CLI that burned ~$3.50 of a $5.17 run by
  looping ~17 turns): a live replay spent pennies on the dead end and still filed its output.
- **`code` tool self-disables when its CLI isn't an executable file.** Probed once at boot: a bare
  name via `Bun.which` (PATH), an explicit path via `accessSync(X_OK)` — a real executable check, so
  a path *this process* can't exec (e.g. a root-owned `0700` file) is rejected rather than passing a
  mode-bit glance and then `EACCES`-ing on spawn. This stops the model being handed a tool whose CLI
  is simply absent. A CLI that passes the probe but fails at *runtime* (the bc8e877e case — the CLI
  was present, its runtime dependency was not) is caught by the breaker above, not here; the two
  layers are complementary.
- **All native-wire model ids are normalized** (provider prefix stripped, dotted versions →
  dashes), for the primary *and* every fallback — not just the utility model. An untranslated
  fallback id was one of the report's two silent zero-token failures (a run that looked merely
  dead to a polling host); `claude-opus-4.8` and `claude-opus-4-8` both reach the wire correctly now.

### Documented

- **The four hosting lifecycle contracts are now documented guarantees** (`docs/hosting.md`):
  idempotency keys are freed on terminal runs, `recover()` resumes mid-flight runs on boot,
  `/v1/busy` reports the durable queued-or-running truth, and seeding never touches an existing
  `DELTA.md`. Each is pinned by a named guard test (`test/contracts.test.ts`) so it can't silently
  regress. Hosts (Aperture) already build their reconcilers on these; they now change semantics
  only with a major-version note.

## [0.2.2] — 2026-07-27

### Added

- **`DELTA_ALLOW_SELF_WRITE` — trusted-gateway self-write.** Off by default. When set, the
  `remember` self-write tool is granted (and pinned) even on the restricted `chat` profile — for a
  daemon fronted by a trusted, authenticated gateway. This is what lets a chat agent learn safely.
- **`DELTA_STEP_MAX_TOKENS`** — cap the tokens a single tool call may emit, with an honest
  truncation error for oversized tool calls instead of silent corruption.

### Changed

- **`DELTA_MAX_TOKENS` / `DELTA_MAX_COST_USD` now override the profile budget** instead of only
  narrowing it, so an operator can raise as well as lower a profile's budget explicitly.

### Companion

- **[`@carrara-labs/delta-connect`](https://www.npmjs.com/package/@carrara-labs/delta-connect)** —
  a new companion package: a thin, always-on edge that plugs a Delta agent into a chat channel
  (Telegram first). The agent scales to zero between messages; the edge holds the conversation.
  See [/connect](https://deltaharness.dev/connect).

## [0.2.1] — 2026-07-22

### Added
- **`GET /v1/busy` — the scale-to-zero lifecycle signal.** A host managing suspend/resume can
  now ask the daemon "is it safe to suspend?" and get `{ busy, running, queued }`. `busy` is the
  durable queued-**or**-running truth read from the run table, so a host never suspends a Machine
  with work still owed (a queued-but-not-yet-dispatched run keeps `busy` true). Behind the `/v1/`
  control-token gate, deliberately not folded into the open, data-free `/healthz`. Turns the
  scale-to-zero pattern from "read the provisioner source" into a ten-line host integration.
- **`docs/hosting.md` — the hosting lifecycle contract.** Documents control-plane-owned
  suspend/resume (why not `fly-proxy` autostop), the three host hooks (wake before dispatch, busy
  check before suspend, suspend after terminal), and the WAL suspend-safety guarantee that makes
  aggressive suspend safe.

### Changed
- **`DELTA_MCP_SERVERS` parsing fails loud, never silent.** A malformed value used to return no
  backends with zero trace — the agent booted tool-less and burned a full model run before anyone
  noticed. Malformed JSON, a non-array, and each unusable entry (no `name`, an `http` entry with no
  `url`, a `stdio` entry with no `command`) are now dropped with a specific boot-log warning. A
  **missing `transport` is inferred** from the entry shape (`url` → `http`, `command` → `stdio`)
  and stamped on the entry, so a common omission just works instead of crashing the stdio path on
  `Bun.spawn(undefined)`.

### Fixed
- **A bad `stdio` MCP server no longer crashes boot.** A `stdio` entry whose command spawns and
  throws synchronously (a non-existent binary, an empty argv element) used to escape the startup
  loop and take the daemon down, despite the "one bad server is never fatal" contract. The
  connection is now constructed inside the registry's catch boundary, so any spawn failure is
  logged (`mcp: <name> failed — …`) and the daemon boots with the remaining backends. Non-string
  or empty `command` elements are also rejected at config time with a clear skip.

## [0.2.0] — 2026-07-22

### Changed
- **Sub-agents (`research`) now have the same rights as the parent, not a read-only subset.** A
  `research` child's callable tools are the parent's full registry minus a small *withheld* set
  (the delegation tools `research`/`spawn_subagent`/`eval_n`, plus the run-scheduling tools), so
  nesting stays exactly one level deep. A child can now read, write, run code, use `remember`, and
  call MCP reads **and** writes — whatever the parent can. Children are built from the **same
  system spine** as the parent (identity + safety norms + `DELTA.md` + `POLICY.md`), so they inherit
  the parent's operating rules along with its rights — not powerful-but-unconstrained. Each child
  starts resident on the parent's pinned tool set and can `search_tools` for the rest, so a large
  MCP surface never blows the child's own token budget. Children run concurrently in one shared
  workspace; the child prompt cautions against clobbering a sibling's writes (full worktree
  isolation is a future option, not yet built).

### Removed
- **`DELTA_RESEARCH_TOOLS`.** The operator allowlist that gated which MCP read tools a `research`
  child could use is gone — children inherit the parent's tools directly. The env var is now
  ignored; remove it from any config.

## [0.1.2] — 2026-07-22

### Added
- **Dispatch idempotency for `POST /v1/tasks`.** A run request may now carry an `idempotency_key`;
  `enqueue` returns any existing non-terminal run with the same key instead of starting a duplicate.
  This makes fire-and-forget async dispatch safe to retry — a client retry, or a controller
  re-driving a slow-but-alive task, dedupes onto the live run rather than spawning a second one. A
  terminal run frees the key. Race-safe (single-writer, synchronous check-before-insert) with no
  schema migration, and composes with `store: false` (the ephemeral transcript is still purged at
  terminal).

## [0.1.1] — 2026-07-16

### Fixed
- Subagents inherit the parent's model: `childEnv` forwards `DELTA_MODEL_PRIMARY`, not just the
  legacy `DELTA_MODEL` alias.

### Changed
- Clearer, technical README and npm package description.
- Removed stale monorepo doc-sync tooling so `bun run check` works on a clean clone.

### Added
- `docker run` published to `ghcr.io/carrara-labs/delta-harness` (on the Deploy docs).
- Hardened release/secret-scan workflows (checksum-verified gitleaks, tag-gated scan, ghcr publish).

## [0.1.0] — 2026-07-16

Initial public release.

### Added
- Product-neutral engine: durable Run + queue (crash/redeploy resume), zero-dep
  OpenAI-compatible provider with model failover and prompt-cache breakpoints, the tool-call
  loop with builtins and profiles, an MCP client with progressive tool disclosure,
  usage-aware compaction, a governed memory rail, and NDJSON observability.
- The bundle model (`agent = engine + bundle + state`): `delta init` scaffolds a bundle;
  `delta dev` boots the local Cockpit.
- `POST /v1/responses`, `GET /healthz`, and the async `POST /v1/tasks` surface.
- Apache 2.0 license, single-binary builds, and the container image.

[Unreleased]: https://github.com/Carrara-Labs/delta-harness/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Carrara-Labs/delta-harness/releases/tag/v0.1.0
