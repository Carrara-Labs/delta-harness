# Release brief - Harness 0.2.18 "Astra"

Status: **RELEASE CANDIDATE, 2026-09-17, HOLD until two live probes land.** Branch
`feat/gpt6-astra`. The battery ran rc3 (bb8af91); the tip adds the codex pre-publish fixes
below (pricing arithmetic and wording only, no wire change). 1046 tests green, typecheck and
lint clean. Codex pre-publish review round 1: HOLD with 2 P1 + 2 P2, all four fixed on the
branch; round 2 pending. Release on Nic's explicit go. Spec and the whole story:
`docs/spec-gpt6-astra-0.2.18.md`.

## Codex pre-publish round 1 (2026-09-17) and what changed

| finding | fix |
| --- | --- |
| P1: Astra calls above 272k gross input metered half their cost (a 300k-token call: $3.05 for $6.075); `DELTA_COMPACT_AT_TOKENS=600000` is an accepted config | `longContext` tier on the price entry: above 272k the whole request bills 2× input, cached reads and writes, 1.5× output; tests at 272,000 / 272,001 with reads and writes; merge-safe under `DELTA_MODEL_PRICES`. Sol keeps its previous untiered arithmetic this release. |
| P1: the tool-output block-array rendering reaches every GPT-5.6+ lane on `api.openai.com` (Sol, Terra, Luna) with no live probe on Sol | live probe requested on the bench (Sol, five tool turns, a parallel batch, cache gate) before any tag; see the probes below |
| P2: the effort boot warning claimed every call fails, but a run's own `reasoning_effort` override applies | wording: calls inheriting the daemon default fail |
| P2: changelog said the wire is unchanged without the Codex-backend qualifier, and did not name the Sol rendering change or the unmodeled tier | rewritten |

Codex's containment checks, for the record: request bodies and headers byte-identical to
`main` in ten off-gate cases (Anthropic native Opus 5, OpenRouter, Codex Astra and Sol, a custom
Responses proxy, older OpenAI models); stored tool rows stay strings, the array is built at
serialization, so no persistence migration; `SAFE_ATTRS` addition consent-correct; version
still 0.2.17 in both places.

## Live probes before a tag

1. Astra on `api.openai.com` (bench-sol-a, rc3 image): a fresh smoke twelve days after the
   battery, cache gate line, engine anomalies. Requested from the engineer.
2. Sol on `api.openai.com` with the new rendering: one user prompt, five or more tool turns, one
   parallel tool batch; no 400s, rolling cache growth, cost reconciling with cache writes.
   Requested from the engineer.
3. Controls on the final candidate: Codex Astra and Sol, Anthropic-native Opus 5 tool round-trips
   (local daemons, the 09-05 runner), off-gate rendering byte-identical.

## What it is

GPT-6 Astra (`gpt-6-astra`) as a first-class model on both OpenAI surfaces the harness speaks,
plus one cache defect found on the way that affects every GPT-5.6+ lane on `api.openai.com`.
No schema migration, no wire change for any lane that does not run a GPT-5.6+ model on
`api.openai.com`.

| change | who sees it |
| --- | --- |
| `gpt-6-astra` priced ($10 / $50 / $1 cached read per 1M; writes 1.25x) and recognised as a vision model | any lane on Astra: dollar caps trip, images reach the model |
| `gpt-5.6-sol` price refreshed to $4 / $20 / $0.40 (pricing page 2026-09-05) | Sol lanes: metered cost drops ~20%, nothing on the wire |
| boot warning when a cascade member on GPT-6 carries effort `none` or `minimal` (a terminal 400 on every call, never fails over) | operators, at boot, by name |
| `gen_ai.usage.cache_write_tokens` exported on `model.call` (main and utility; exporter allowlisted) | any metered turn can be reconciled to the cent |
| explicit prompt-cache marks for Astra on `api.openai.com` (`modelHasExplicitCache` takes `gpt-6`); the host gate keeps the ChatGPT/Codex backend off (it 400s the field) | Astra lanes on `api.openai.com` |
| **rolling cache marks ride tool outputs** on the Responses wire under the explicit-cache gate: every `function_call_output` renders as an `input_text` block array and carries the marks | every GPT-5.6+ lane on `api.openai.com`, Sol included: the two rolling marks had no carrier since 0.2.16 on the fleet's real shape (one user message, then tool calls) |

## What it is worth, measured (Aperture Quick Search bench, 25 tasks, twin lanes, 2026-09-06)

| | Opus 5 medium | Astra low | Astra medium | Sol low (old placement) |
| --- | --- | --- | --- | --- |
| runs ok / total | 25/25 | 25/25 engine-clean (23 delivered as asked) | 24/25 (one budget stop) | 25/25 |
| model $ p50 per run | 1.48 | 1.11 | 1.32 | 1.26 |
| all-in $ per run | 2.77 | 1.97 | 2.90 | 2.00 |
| wall p50 | 166 s | 68 s | 73 s | 90 s |
| first message p50 (serial) | 154 s | 34 s | 26 s | 68 s |
| cache hit p50 after turn 1 | 93% | 94% | 96% | 49% |
| cache shortfall p50 / p95 | 45 / 7,672 | 41 / 41 | 41 / 14,203 | 12,157 / 61,451 |
| retries / fallbacks | 0 | 0 | 0 | 0 |
| compactions, identifiers lost net | 8, 0 | 11, 0 | 29, 0 | 1, 0 |

- **The cache fix is the release.** rc1 (no explicit marks) ran Astra at 3x Sol's cost with the
  hit rate decaying 34% to 18%; rc2 (model gate only) pinned cached tokens at the first message;
  rc3 reads `cached(N+1) = input(N) - 41` on every turn, the 41 being the ephemeral clock line.
  Smoke cost $0.47 against $0.72 on rc1 and rc2.
- **Quality, blind judge (Opus 5, random A/B):** Astra low beats Sol 13 / 8 / 1, Astra medium
  beats Sol 16 / 4 / 2 (every hard artifact task); both lose to Opus (1 / 20 / 1 and 3 / 19 / 1).
  Astra is a stronger artifact worker than Sol and a weaker narrator than Opus. Effort does not
  change the four pause-or-incomplete outcomes (H1, M2, M10, HN6): Astra asks where Opus and Sol
  assume.
- **Where to run it:** keep Opus 5 medium as the default for artifact work read later; Astra low
  where a person waits on the answer, replacing Sol at Sol's cost and 25% faster. Ledger:
  `ai-recruiter/docs/research/model-bench-ledger.md`; verdict and tables in
  `ai-recruiter/docs/research/qs-astra-bench-2026-09-05/`.

## Live results across providers (2026-09-05 to 06)

| lane | where | result |
| --- | --- | --- |
| Opus 5, Anthropic native | local daemon | image read, threaded recall, cost metered; nothing moved |
| gpt-6-astra, Codex subscription, low | local daemon via Delos broker | image delivered, web search, recall, $0.075 over 6 calls; no boot warning |
| gpt-5.6-sol twin, Codex subscription | local daemon | same task at the refreshed price |
| gpt-6-astra, effort none | local daemon | boot warning; every call 400 as error-as-value; no failover |
| gpt-6-astra, api.openai.com | bench-sol-a/b, rc1 to rc3 | cost reconciles to the cent with cache writes; rc3 passes the cache gate on both lanes |
| Sol on api.openai.com | not rerun on rc3 | expected to gain hit rate from the carrier fix; the August numbers are on the old placement |

## Upgrade day

No migration. Fly lanes: image-only swap as in `docs/upgrade-0.2.17.md`; npm globals: `npm i -g
@carrara-labs/delta-harness@0.2.18`. Model settings need no change. A Sol lane on
`api.openai.com` will see its cache hit rate rise and its cache-write tokens appear in
telemetry; a Sol lane on the Codex backend sees only the price refresh. `healthz` now carries
`build` when the image was built with `DELTA_BUILD`.

## Before moving any lane to Astra (not a release blocker)

Audit `POLICY.md`, `DELTA.md` and skills for tool-scope or "ask first" lines and make instruction
precedence explicit: on the Quick Search bundle Astra read "act ONLY through the aperture MCP
tools" as a hard boundary and refused `read_file` four times out of four, where Sol and Opus read
the playbook. Expect refusals and clarifying questions as an outcome class.

## Still open, honestly

- The 0.2.17 changelog promised an engine-side guard for the volume-restore telemetry trap
  (row counter rewound below the collector's high-water). Not in this release: the daemon cannot
  know the collector's maximum from a restored database; the guard needs a collector answer.
  The runbook step (advance `sqlite_sequence`) stands.
- A Sol arm rerun on rc3 would give a like-for-like against Astra on the new mark placement.
  Optional, Nic's call.
- The `>272k input` 2x/1.5x billing tier is unmodeled (as for 5.6); no `window` is baked, the
  120k compaction default applies.
