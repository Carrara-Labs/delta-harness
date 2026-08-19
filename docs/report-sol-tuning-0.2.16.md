# Sol parameter tuning for Quick Search — pre-benchmark measurements (0.2.16)

2026-08-19, Delta Harness maintainer. A quick, bounded experiment to answer one question before
Aperture stands up the OpenAI bench lane: **what should `gpt-5.6-sol`'s effort and verbosity be
for the Quick Search demo?** The working guess going in was "high thinking + concise verbosity."
The data confirms the second half and contradicts the first.

## Where everything lives (full paths from the root of this machine)

| artifact | path |
|---|---|
| this report | `/Users/nictouron/delta-harness/docs/report-sol-tuning-0.2.16.md` |
| the Aperture 0.2.16 handover (config + warnings W1–W6) | `/Users/nictouron/delta-harness/docs/handover-aperture-0.2.16.md` |
| the 0.2.16 plan + both Codex review arbitrations | `/Users/nictouron/delta-harness/docs/harness-0.2.16-plan.md` |
| release notes | `/Users/nictouron/delta-harness/CHANGELOG.md` (§0.2.16) |
| Delos probe request (codex-backend gating) | `/Users/nictouron/delta-harness/docs/probe-request-delos-0.2.16.md` |
| tuning script (this experiment) | `/Users/nictouron/delta-harness/docs/bench/sol-tuning.ts` |
| raw results JSON | `/Users/nictouron/delta-harness/docs/bench/sol-tuning-results.json` |
| 5.6 model-matrix results (all 3 models × 7 configs) | `/Users/nictouron/delta-harness/docs/bench/matrix-results.json` |
| visual verification report | https://claude.ai/code/artifact/df9537fb-4c93-46cf-b2cf-17d49118cc94 |

All paths are on the maintainer's machine; the repo-relative forms (`docs/…`, `docs/bench/…`)
resolve from any checkout of `github.com/Carrara-Labs/delta-harness` at or after `v0.2.16`.

## Method

- **Engine**: published `@carrara-labs/delta-harness@0.2.16`, provider layer invoked directly, so
  reasoning carry, `phase`, explicit cache breakpoints, `prompt_cache_key`, and
  `reasoning.summary` were all active — the exact demo-lane surface.
- **Task shape**: the QS unit of work — (1) task → search call(s); (2) a realistic chunky result
  set (correct facts + two near-miss distractors: a same-named biathlete, a similarly-named
  lighting retailer) → structured artifact save; (3) user-facing update. Parallel searches and
  extra search rounds allowed and counted.
- **Grid**: effort ∈ {none, low, medium, high} × verbosity ∈ {low, provider default}, six cells,
  one run each, `gpt-5.6-sol`, metered `api.openai.com`.
- **Scored**: fact retention in the artifact (6 load-bearing tokens: name, funding, lead
  investor, background, ARR, headcount), distractor leakage, search-call count, model-call
  count, wall time per call, output tokens (includes reasoning spend), metered cost.

## Results

| config (effort-verbosity) | facts kept | distractor leak | search calls | model calls | total wall | output tokens | cost |
|---|---|---|---|---|---|---|---|
| none-low | 6/6 | none | 8 | 4 | 18.1 s | 766 | $0.051 |
| low-low | 6/6 | none | 9 | 4 | **17.6 s** | 950 | $0.059 |
| low-default | 6/6 | none | 8 | 4 | 25.6 s | 1,043 | $0.061 |
| medium-low | 6/6 | none | 13 | 5 | 23.1 s | 1,169 | $0.075 |
| medium-default | 6/6 | none | 9 | 4 | 22.8 s | 1,092 | $0.064 |
| high-low | 6/6 | none | **15** | 5 | **31.6 s** | 1,615 | $0.095 |

(The grader initially reported 4/6 everywhere — an exact-substring artifact: every artifact
carried all six facts, with "$48M" and "$9.4M" written as "US$48 million" / "US$9.4 million".
Retention is complete and **identical in every cell**.)

User-update length under verbosity low: 340–410 chars; under provider default: 570–620 chars.
Artifact length was unaffected by verbosity (1.3–1.9 KB in both arms, uncorrelated).

## Findings

1. **Effort bought zero quality on this op shape.** Fact retention, distractor rejection, and
   artifact structure were indistinguishable from `none` to `high`. Sol is smart enough that
   "make an API call, read the results, write the brief, tell the user" does not need deep
   deliberation — the same conclusion the Opus 5 tuning reached when it settled on medium.
2. **Effort bought waste, measurably.** high vs low: **+80% wall time** (31.6 s vs 17.6 s),
   **+61% cost**, +70% output tokens — and **over-searching**: 15 search calls vs 8–9, with an
   extra model round. An earlier high-effort run responded to a complete result set by issuing
   six more parallel searches instead of saving. For a live demo, over-searching is the worst
   failure mode available: it looks hesitant and burns wall-clock in front of the audience.
3. **Verbosity low is a clean win for the chat surface.** Updates tighten ~40% with no effect on
   artifact completeness or length. This half of the working guess is confirmed.
4. **Caching and reasoning sharing need no tuning** — they are on automatically on this lane and
   were active in every run above. Separately measured on all three 5.6 models: turn-1 writes
   the full prefix, turn-2 reads 100% of it back, ~7.7× warm-turn cost drop
   (`/Users/nictouron/delta-harness/docs/handover-aperture-0.2.16.md` §4).
5. This also aligns with OpenAI's own 5.6 guidance: medium as the balanced default, **low for
   latency-sensitive tool-use workloads** — and QS in front of an audience is exactly that.

## Recommendation for the demo lane

```dotenv
DELTA_REASONING_EFFORT=low        # medium is the HARD-tier ceiling if the battery shows gaps; high is contraindicated
DELTA_TEXT_VERBOSITY=low          # confirmed win for user-facing updates
DELTA_REASONING_SUMMARY=auto      # observability for the debrief, never blocks a turn
# caching: nothing to set — explicit breakpoints + prompt_cache_key are automatic on gpt-5.6/openai.com
```

## Honest caveats

- n=1 per cell, one synthetic task, mock search results, substring grading. This is a
  **pre-benchmark direction-setter**, not the benchmark. The medium-low over-search (13 calls)
  vs medium-default (9) spread shows the single-run noise floor.
- The distractors were easy; the real battery's hard tier (ambiguous people, conflicting
  sources) is where a genuine effort effect could still appear. If it does, raise the hard tier
  to medium — not the whole lane, and not to high without evidence.
- Aperture should re-run this exact grid inside the pinned three-tier battery before the demo
  config is frozen; per-tier effort (`metadata.reasoning_effort` per run) is supported if the
  tiers want different settings.

— Delta Harness
