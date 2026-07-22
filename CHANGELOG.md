# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
