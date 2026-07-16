# Delta Harness

A lean, **product-neutral operator harness** — the in-VM agent loop that runs one working
agent per process or VM.

A TypeScript-on-Bun single-binary daemon: a small prompt spine and a durable tool-call loop
that combine built-in workspace capabilities with external systems over MCP.

- **Memory** → scoped local memory, with optional shared knowledge over MCP
- **Skills** → versioned procedures over MCP with progressive disclosure
- **Code** → delegated to `codex` / `claude-code` CLIs
- **Review & learning** → policy, vocabulary, reflection, and a configurable write rail

Zero runtime deps · SQLite WAL state · **~30MB RSS, <50ms cold start** (measured).

> **Status:** `0.1.0` — early release. The API surface and bundle format may still shift
> before `1.0`. Feedback and issues welcome.

## Install

```sh
# as a CLI (requires Bun ≥ 1.3)
bunx @carrara-labs/delta-harness --help

# or grab a prebuilt binary from Releases
curl -fsSL https://deltaharness.dev/install.sh | sh

# or run the container
docker run -p 8080:8080 --env-file .env ghcr.io/carrara-labs/delta-harness
```

## Quickstart (from source)

```sh
bun install
bun test                                  # 480+ tests (unit + child-process crash/resume)
bun run build                             # dist/delta — the product-free engine
./dist/delta init ./my-agent              # scaffold a bundle
./dist/delta dev  ./my-agent              # boot it in the Cockpit at /dev
```

The engine is **product-agnostic** — it names no product. A product is a *bundle*
(a directory of plain files).

**A bundle is these files, split by who may edit them:**

| File | What | Editable by |
|---|---|---|
| `delta.env` | backends, keys, budgets | operator |
| `vocab.json` | the write rail (product nouns/verbs) | operator |
| `POLICY.md` | fixed highest-priority prompt guidance | operator |
| `DELTA.md` | identity **+ what the agent has learned** | human **and** agent |
| `PROMPT_CONTEXT.md` | optional dynamic vars (`{{model}}`, `{{now.date}}`, `{{request.*}}`) | operator |

`DELTA.md` is the **self-learning** surface: the agent can rewrite the whole file with the
`remember` tool so the next uninterrupted run can use the change. Writes are atomic,
size-capped, and up to 20 prior versions are retained for Cockpit reverts.

To run the raw seam directly instead of the dev launcher:

```sh
set -a; source .env; set +a               # export .env (bare KEY=value lines)
bun run start                             # serve on :8080
bash scripts/smoke.sh                     # live check against the running server
```

`.env` needs `OPENROUTER_API_KEY` (or `MODEL_API_KEY`) and, for `web_search`, `EXA_API_KEY`.

## Surface (the seam)

| Route | What |
|---|---|
| `POST /v1/responses` | OpenAI-Responses-compatible sync turn |
| `GET /healthz` | Liveness (autosuspend wake + reconciler) |
| `POST /v1/tasks` | Async long-run: `202 {id}` → SSE progress → completion; cancellable |
| `GET /v1/tasks/:id` · `/events` · `DELETE` | Status · SSE tail · cancel |
| `GET /v1/queue` | Queued and running rows |

## What's built

- **Durable Run + queue** — serial per session, concurrent across; survives crash/redeploy;
  resumes in-flight runs from the SQLite journal. An interrupted non-idempotent call is
  not silently re-fired; its external outcome must be verified before retrying.
- **Provider** — zero-dep OpenAI-compatible streaming, retries + model failover, usage +
  cost capture, error-as-value, and Anthropic prompt-cache breakpoints.
- **Loop + hands** — recorded model-usage guards (steps/tokens/cost); builtins
  (`web_search`/`web_fetch`/workspace files, `code`→codex CLI, `spawn_subagent`); run
  profiles (`work`/`chat`); a tool directory (index + `search_tools`, schema on demand).
- **MCP client** — Streamable HTTP + stdio, boot-time discovery, and progressive tool
  disclosure through `search_tools`.
- **Compaction** — usage-aware Goal/Progress/Next/Artifacts summary; bounded context on
  long runs.
- **Observability** — durable main-loop events feed SQLite, SSE, and an NDJSON exporter.

## Ship

`Dockerfile` (two-stage, compiled binary in `debian-slim`) + `fly.toml.sample` (one Machine
per agent; externally controlled suspend/resume). `bun run build` emits `dist/delta`.

## Docs

Full guide, architecture, and operating reference: **[deltaharness.dev](https://deltaharness.dev)**.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). By contributing you agree
to the [DCO](https://developercertificate.org/) (`Signed-off-by` on each commit).

## License

[Apache 2.0](./LICENSE) — see [`NOTICE`](./NOTICE) and [`TRADEMARKS.md`](./TRADEMARKS.md).
Created by **Nicolas Touron** at **Carrara Labs**.
