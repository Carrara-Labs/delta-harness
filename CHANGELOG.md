# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
