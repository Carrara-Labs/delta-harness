# Delta Harness

The open source harness for knowledge work — build long-running agents with MCP tools, managed
context, subagents, and self-improvement, in one lean TypeScript-on-Bun binary.

[![npm](https://img.shields.io/npm/v/@carrara-labs/delta-harness?color=%230b7)](https://www.npmjs.com/package/@carrara-labs/delta-harness)
[![license](https://img.shields.io/npm/l/@carrara-labs/delta-harness?color=%23555)](./LICENSE)
[![built with Bun](https://img.shields.io/badge/built%20with-Bun-fbf0df)](https://bun.sh)

**[deltaharness.dev](https://deltaharness.dev)** · **[Docs](https://deltaharness.dev/docs/)** · **[GitHub](https://github.com/Carrara-Labs/delta-harness)**

A single-binary daemon: a **<2k-token prompt spine** and a durable tool-call loop that combine
built-in workspace capabilities with external systems over MCP. Zero runtime deps · SQLite WAL
state · **~30MB RSS, <50ms cold start** (measured).

## Install

```sh
# install the binary (macOS / Linux)
curl -fsSL https://deltaharness.dev/install.sh | sh

# or run it via Bun
bunx @carrara-labs/delta-harness --help

# or run the daemon as a container
docker run -p 8080:8080 --env-file .env ghcr.io/carrara-labs/delta-harness
```

Requires **Bun ≥ 1.3** to run from source or via `bunx`; the prebuilt binary and container are self-contained.

## Quickstart

```sh
delta init ./my-agent    # scaffold a bundle — five plain files
delta dev  ./my-agent    # boot it in the local Cockpit at /dev
```

`init` never overwrites your files; `dev` runs the real daemon on loopback and opens the Cockpit,
so you can watch the loop, tools, memory, and cost live.

## What's in the runtime

| | |
|---|---|
| **Durable run + queue** | Serial per session, concurrent across; checkpoint-per-turn, survives crash/redeploy, resumes in-flight runs from the SQLite journal. |
| **Provider** | Zero-dep OpenAI-compatible streaming, model failover, usage + cost capture, error-as-value, Anthropic prompt-cache breakpoints. |
| **Loop + hands** | Usage guards (steps / tokens / cost); builtins (`web_search`, `web_fetch`, workspace files, `code`→codex CLI, `spawn_subagent`); run profiles with per-profile tool sets. |
| **MCP client** | Streamable HTTP + stdio, boot-time discovery, progressive tool disclosure via `search_tools`. |
| **Context** | Usage-aware compaction (Goal / Progress / Next / Artifacts); bounded context on long runs. |
| **Memory + learning** | Scoped local memory, optional shared knowledge over MCP, and a review→reflect loop that turns feedback into scoped memory. |
| **Observability** | Durable main-loop events over SQLite, SSE, and an NDJSON exporter. |

## The bundle — `agent = engine + bundle + state`

The engine names no product. A **bundle** is five plain files you version like code:

| File | What | Editable by |
|---|---|---|
| `delta.env` | backends, keys, budgets | operator |
| `vocab.json` | the write rail (your product's nouns/verbs) | operator |
| `POLICY.md` | fixed, highest-priority prompt guidance | operator |
| `DELTA.md` | identity **+ what the agent has learned** | human **and** agent |
| `PROMPT_CONTEXT.md` | optional dynamic vars (`{{model}}`, `{{now.date}}`, `{{request.*}}`) | operator |

`DELTA.md` is the **self-learning** surface: the agent rewrites it with the `remember` tool, so
the next uninterrupted run uses the change. Writes are atomic, size-capped, and reversible.

## Surface (the seam)

| Route | What |
|---|---|
| `POST /v1/responses` | OpenAI-Responses-compatible sync turn |
| `POST /v1/tasks` | Async long-run: `202 {id}` → SSE progress → completion; cancellable |
| `GET /v1/tasks/:id` · `/events` · `DELETE` | Status · SSE tail · cancel |
| `GET /v1/queue` | Queued and running rows |
| `GET /healthz` | Liveness (autosuspend wake + reconciler) |

## From source

```sh
git clone https://github.com/Carrara-Labs/delta-harness
cd delta-harness && bun install
bun test        # 480+ tests (unit + child-process crash/resume)
bun run build   # dist/delta
```

Full guide (models, MCP tools, memory, subagents, deploy, recovery): **[deltaharness.dev/docs](https://deltaharness.dev/docs/)**.
Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

> **Status:** `0.1.x` — early release. The API surface and bundle format may still shift before `1.0`.

## License

[Apache 2.0](./LICENSE) — see [`NOTICE`](./NOTICE) and [`TRADEMARKS.md`](./TRADEMARKS.md).
Created by **Nicolas Touron** at **Carrara Labs**.
