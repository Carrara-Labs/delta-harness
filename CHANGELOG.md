# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
