# Study: a System One judge (TypeSafe Jev) in the Delta harness

Date 2026-09-17. Question from Nic: can a fast, non-generative decision model make the harness
faster, cheaper and more real-time without any loss of quality, and where. Evidence: 14 days of
production Quick Search telemetry (agent_events, prod lanes only, bench lanes excluded).

## What Jev is (docs.typesafe.ai, read 2026-09-17)

- `POST /v1/systemone`: one `state` (string or JSON, text only) + a map of typed questions.
  Three primitives: Choice (one of a set, full distribution + confidence), Score (ordered
  rubric, probability-weighted), Noul (probability a statement is true).
- Every question is answered in parallel and in isolation over the same state; adding
  questions barely changes latency. About 100 to 150 ms per request.
- Price $0.042 per million input tokens, output free. Rate limits 250k tokens/s,
  1,200 requests/min (dynamic). Context: 64k tokens for state + all questions, 32k for
  state + the longest question.
- Model `jev-1.13.0` (alias `jev-latest`). JS SDK `@typesafe-ai/sdk` 0.6.0, Python
  `typesafe-sdk`. Claude Code plugin `typesafe@typesafe-ai` installed on this machine.
- It does NOT generate text, code, queries or explanations. Jagged edges (their own page):
  literal reading, no arithmetic or counting, no date comparison, weak under indirection,
  accuracy falls with irrelevant state, adversarial state can move it. Their rule: code owns
  control flow and arithmetic, the model owns the semantic judgment.

## What the telemetry says (prod QS, 176 runs, 2026-09-03 to 09-16)

| measure | p50 | p90 | total |
| --- | --- | --- | --- |
| Opus turns per run | 20 | 35 | 3,831 |
| tool calls per run | 35 | 74 | 7,953 |
| cost per run | $3.45 | $6.80 | $695 |
| wall per run | 14 min | 42 min | |
| share of wall inside Opus calls | 94% | | 81% mean |
| tool time per run | 22 s | 88 s | |

- Latency is output-bound: 82 output tokens/s at medium effort, 2,763 output tokens per
  call on average, so every turn costs about 34 s and about $0.18 whatever it decides.
- Cost split of the main lane: uncached input $177, cached input $200, output $266.
  The utility lane (Haiku: summaries, reflection, research) is $7.82 in total. Replacing
  Haiku with anything saves nothing.
- Turn classes (by the tool calls the turn made):

| class | turns | share | avg out tokens | avg latency | cost |
| --- | --- | --- | --- | --- | --- |
| fetch only | 1,872 | 49% | 2,177 | 28 s | $311 |
| write (stage/save artifact) | 901 | 24% | 3,757 | 44 s | $167 |
| chat only (say/step/finish/remember) | 730 | 19% | 3,028 | 36 s | $151 |
| mixed | 156 | 4% | 5,147 | 57 s | $38 |
| no tool call | 172 | 4% | 1,039 | 16 s | $20 |

- Fetch chains: 231 runs of consecutive fetch-only turns, p50 length 7, p90 13, max 30.
  The follow-on turns inside those chains (turn 2..n of a chain) are 1,454 turns, 38% of
  all Opus turns, $221 (32% of spend), 12.9 hours of model latency, 4.4 min per run.
  941 of them are pure `fiber_call` or pure `fiber_read` turns ($155). This is the
  "keep fetching until we have enough" loop, run by the frontier model one page at a time.
- Wasted lone-tool turns: 246 turns whose only call was `remember` (144 of 254 remember
  calls fail with `self_cap`, the self-file wall), about $50 and 2 hours; 140 turns whose
  only call was `qs_step` (the policy forbids it), about $30. Neither is a Jev problem;
  both are policy/engine fixes.
- Time to first word (qs_say): p50 29 s, p90 81 s. The first turn is a full Opus turn.
- Compaction reload: 86 post-cut calls at 30k tokens each, $12. Not a target.
- Follow-up dispatch: 160 follow-up runs across 186 rooms, p50 gap 13.8 min, 10 of 160
  within 5 min. First-call cached share p50 = 0 (116 of 174 runs cold). The Anthropic
  cache is already gone when a follow-up lands, so a per-run model switch loses nothing.
  A mid-run switch would lose the whole prefix (caches are per model): ~110k tokens at
  $5/M, about $0.55 plus the cache write, per switch. Route at run boundaries only.

## Where a System One judge fits (ranked by evidence)

1. **Semantic screens in the seam (Aperture-side, zero harness change).** `fiber_call`
   already evaluates deterministic `screen` predicates (tenure, dates, title substrings)
   on every row before the preview cap. Add a `judge` block: the brief plus 1 to 6 Noul
   or Choice questions per row (matches the ask, is current, is an IC not a manager, is
   the company in scope, likely duplicate of a listed person). Jev answers a 10-row page
   in one call, about 4k tokens, $0.0002, 150 ms. Rows return tagged with verdicts and
   probabilities. Effect: fewer pages read by Opus, less context, fewer compactions.
   Measurable on the 24-task corpus with the bench3 rig.
2. **A sweep worker for roster asks (fetch until done).** Code paginates
   people-search or nlp-search, Jev judges every row against the brief, code counts,
   dedupes and stops (target reached, or a page yields under k relevant rows, or a credit
   cap). Opus receives ONE tool result holding the accepted set. This targets the 7 to 13
   turn fetch chains directly: a 13-turn sweep at 34 s and $0.18 a turn becomes one tool
   call of a few seconds plus the same Fiber credits. First as a seam tool
   (`fiber_sweep`), then as a generic engine affordance: a bounded loop tool whose stop
   rule is a judge question declared in the bundle, with the judge as a new utility-lane
   provider (`DELTA_JUDGE_URL` / `DELTA_JUDGE_KEY`), the way `research` children are
   bounded today.
3. **Dispatch-time classification (app-side, cache-safe).** One Jev call per dispatch on
   the user's message plus the room's artifact titles: register (chat / report / list /
   clarify first), roster vs shortlist, revision of an existing artifact vs new question
   (closes the "agent is the router, revision known only at save time" gap), and a
   difficulty or risk estimate. Its output is one line appended to the dispatch card
   (ephemeral suffix, never the cached prefix) and a per-run model or effort choice:
   trivial follow-ups to Sonnet 5 or low effort, since the cache is cold anyway.
4. **Verification on the utility lane (harness-side, quality not cost).** `recall`
   rerank over the FTS5 candidates (the rerank cookbook takes top-1 from 5% to 18% on
   BM25 shortlists), `eval_n` judging, pre-finish checks (does the closing message name
   every skip, does every list entry carry evidence), tool-call sanity (arguments match
   the request) and `loop.repeat` style detection with probabilities in telemetry.
   Low volume today (recall 90 calls in 14 days), so this is a quality lever.
5. **Not worth it.** Compaction summaries and reflection need generation. The utility
   lane is $7.82 in two weeks. Artifact writing (24% of turns) is generation.

## Constraints to design around

- Text only, 32k state: send rows, never payload dumps. Screens keep dates and counts in
  code, Jev gets the semantic rules. Keep questions literal, criteria explicit.
- LinkedIn headlines are user-authored text: a profile that argues for its own relevance
  can move a judgment. Thresholds per rule, uncertain rows go to Opus, never dropped.
- Quality gate: twin-lane battery on the 24-task corpus (blind judge, identifiers,
  turns, cost, wall), the same rig that gated 0.2.17. No Jev rule ships on a client
  lane without it. A TypeSafe API key is needed for any experiment; none is on this
  machine.
- Pin `jev-1.13.0`, not the alias, once thresholds are tuned; log the answering model.

## Sources

docs.typesafe.ai (introduction, quickstart, concepts/system-one, state,
how-to-build-with-system-one, use-case-map, primitives, confidence, api, models,
sdk/javascript, agent-skill, model-jaggedness/jev-1.13, cookbooks skill_suggestion,
rerank_typesafe, classifying_rag_passages, function_calling, sde_cascade).
Telemetry scripts: session scratchpad `ts-shape.ts`, `ts-turns.ts`, `ts-turns2.ts`,
`ts-rooms.ts` (read-only against `PROD_DATABASE_MIGRATION_URL`).
