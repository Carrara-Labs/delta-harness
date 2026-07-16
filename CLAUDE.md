# Delta Harness — contributor guide

A lean, product-neutral operator harness — the in-VM agent loop that runs one working agent
per process or VM. This file orients humans and AI coding agents working in this repo.

## Coding principles

1. Simple, straightforward, elegant code that is efficient, lean, and **just works**.
2. The least amount of code the better.
3. Ground the work in real testing to validate; research third-party docs when they exist.
4. Wicked smart and evolving by default — lean over sprawling.

## What Delta is (and isn't)

- A **working agent** ("intelligence at work") — not a coding agent, not a personal companion.
- **<2k-token system spine.** The daemon owns almost nothing: memory, skills, code, and review
  live behind adapters (local tables + MCP + delegated CLIs). Delta is the thin, fast,
  cache-friendly loop that composes them.
- **Budgets, not timers.** A typical task is minutes; the plumbing has no wall-clock ceiling
  (checkpoint-per-turn SQLite WAL, renewable busy-lease, compaction, sub-agent offload).
- **Error-as-value**: a provider/tool failure returns a clean turn; the daemon never crashes.
- NOT building: channels, devices, an MCP server, a plugin catalog, a coding toolset, or a
  local vector store.

## The seam

- `POST /v1/responses` — OpenAI-Responses-compatible sync turn.
- `GET /healthz` — liveness (autosuspend wake + reconciler).
- `POST /v1/tasks` — async surface for long runs: start → progress events → completion; cancellable.

## Stack

Bun (single-file `bun build --compile` binary, <10ms cold start) · TypeScript strict · **zero
runtime deps** until one earns its place (exact pins, committed lockfile) · SQLite WAL for local
state · Biome · providers subscription-first with OpenRouter backup.

## Reality checks

`bun test` + `bash scripts/smoke.sh` against a running server before calling anything done.

## The bundle (how you configure an agent)

`agent = engine + bundle + state`. A bundle is five plain files in the workspace:
`delta.env` (backends/keys/budgets) · `vocab.json` (the write rail) · `DELTA.md` (the **living
self-file**: identity + `## Learned`, human- AND agent-editable via the `remember` tool) ·
`POLICY.md` (the **fixed** operating contract, rendered last, non-overridable) ·
`PROMPT_CONTEXT.md` (optional dynamic vars). `delta init` scaffolds them.

## Repo layout

- `src/` — the engine (published to npm as `@carrara-labs/delta-harness`).
- `test/` — `bun test` suite (unit + child-process crash/resume).
- `site/` — the docs/marketing site behind [deltaharness.dev](https://deltaharness.dev).
- `scripts/` — smoke/demo scripts and the container entrypoint.
