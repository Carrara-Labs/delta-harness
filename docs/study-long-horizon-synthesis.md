# Long-horizon work: Pi, Hermes, OpenClaw vs Delta, and what to do about it

2026-09-02. Synthesis of four source-level studies taken at today's head of each repo, plus a
read-only pass over Aperture's production telemetry. Every claim in the per-harness sections is
cited in the companion documents; this file ranks and decides.

| Companion | Repo head | Lines |
|---|---|---|
| `docs/study-long-horizon-pi.md` | earendil-works/pi `23842b1` (272 commits since 08-07) | 361 |
| `docs/study-long-horizon-hermes.md` | nousresearch/hermes-agent `55d8c05` (6,051 commits) | 677 |
| `docs/study-long-horizon-openclaw.md` | openclaw/openclaw `5e6117d` (9,611 commits) | 526 |
| `docs/study-long-horizon-delta.md` | this repo, `main` at 0.2.16 | 843 |

Production ground truth used below: Aperture `agent_events`, Quick Search lanes, last 14 days
(2026-08-19 to 09-02): 817 runs, 12,090 turns, 335 compactions, 60 runs past 30 turns, longest 100
turns. All figures read-only from `PROD_DATABASE_MIGRATION_URL`.

---

## 1. The one-paragraph verdict

Delta already has the strongest **safety and recoverability** story of the four: real budgets, a
pre-send compaction gate, archive-safe compaction with `recall`, spill-to-disk, a recited plan, an
identifier audit with a machine-built appendix, crash-replay that never re-fires a non-idempotent
tool, and the only cache metric that is not a denominator artifact. Where the others have moved
ahead in the last month is **compaction economics and compaction fidelity**: Hermes measured its
summaries on recall and rebuilt them around a mechanical anchor index plus an advertised recovery
tool; OpenClaw routes pressure to truncation before it ever summarizes and prunes only when the
provider cache is cold anyway; Pi compacts between turns inside a run and carries structured facts
outside the summary. None of the three recites a plan, none has a task object inside the loop,
and none has a long-horizon eval that actually runs. Our biggest exposures are self-inflicted and
already known: the post-compaction re-cache is ~30% of spend on the QS lane with no attribute
naming it, the history digest that would settle the shape-1 cache defect is unbuilt, argument
elision is measured at -36% cost and off by default (the bench-opus lanes have it on; client lanes
unverified as of 2026-09-02), and the long-horizon affordances we built are used in 6% (todo) and
3% (recall) of production runs.

---

## 2. Comparison matrix

Legend: **bold** = best of the four on that row. "None" means not present at head.

| Dimension | Pi | Hermes | OpenClaw | Delta |
|---|---|---|---|---|
| Loop bound | none (300 s HTTP idle only) | unbounded iterations; 600 s no-progress watchdog, 1800 s inactivity, 8-error outer cap | 48 h elapsed, 5-strike idle breaker, no step cap | **steps + fresh tokens + cost per profile, 600 s call, 60 s idle, 30 s first byte, 120 s tool** |
| Overflow handling | one compact-and-retry; overflow excluded from retry; 3-way detector (regex, silent `input+cacheRead>window`, zero-output at 99%) | rebuilt request rechecked after overflow (09-01) | in-attempt compact-and-retry x3, then route `compact_only / truncate_only / compact_then_truncate` | one forced compaction + one retry; `context_irreducible` is a warning and the request is sent anyway |
| Compaction trigger | `window - 16k`, previous gross usage + chars/4 delta; **now also between turns inside a run (08-28)** | 50% of window (75% floor <512K), gross of cache, reasoning excluded, **checked before every provider call with usage anchor (08-28)** | gross `window - reserve(16-20K)`, not cache-aware | **pre-send byte estimate maxed with provider-anchored projection**, ceiling derived from smallest model window |
| What survives verbatim | ~20k tail, never cuts a tool result, split-turn prefix prompt | 2.5% of window (10-25K) tail, old tail tool results demoted to stubs with a search pointer, every user message verbatim (24K) | `keepRecentTokens` 20K | flat 24k tail in whole wire units, spilled results demoted to head+path, args elided (opt-in) |
| Summary contract | PRESERVE/ADD/UPDATE merge, fixed skeleton, `<read-files>/<modified-files>` extracted deterministically, length-stop rejected | one aux call: summary + **regex anchor index (PRs, SHAs, paths, errors)** + `## Context Recovery` footer, static fallback on failure | two contracts coexist; safeguard mode **re-distills** ("prune stale") with 5 headings, pinned in-flight ask, up to 12 identifiers must survive, audit refuses to persist otherwise | Goal/Progress/Next/Artifacts, iterative merge (PRESERVE), audit of paths + numbers, one retry, ≤25% accept, appendix of the rest |
| Fidelity measurement | none | **recall eval harness, real transcripts, closed-book vs +recovery arms: lean 68.3% vs old 45.8%** | qa-lab graded drift, soak lane environment-blocked | audit counts on the `compaction` event; no recall eval |
| Recoverability of compacted content | session tree keeps it, no search | **in-place, rows `active=0, compacted=1`, FTS via `session_search`, advertised in the summary** | none (truncation is lossy, "rerun with narrower args") | `recall` builtin: bounded LIKE over an id window, not advertised in the summary text |
| Cache economics of compaction | summary call `cacheRetention: none`; cache-friendly compaction landed and reverted | compaction is the one accepted cold write; cache-preserving injection points are a house rule | **TTL-gated pruning: prune only after the provider cache lapsed, never last 3 turns**; cache-miss attribution with named causes | rolling marks, `cache_shortfall_tokens`, 0.2.14 killed the post-compaction collapse; re-cache after compaction unnamed (~30% of QS spend) |
| Tool output hygiene | truncate 2000 lines / 50 KB, bash spills to temp file, nothing pruned | spill at 100K chars with `<persisted-output>` "do NOT re-request", 75/25 head/tail, identical-result stubs | window-derived caps (16/32/64K chars), aggregate cap, no spill | **capAndSpill at 20k, spill re-readable, demoted at compaction, no TTL on spill** |
| Plan / todo | extension only | `todo_list` in-memory, deferred behind tool_search, injected once per compaction | none inside the loop | **`todo` re-injected every turn, survives compaction, lives outside messages** |
| Memory before compaction | none | memory prefetch into user message copy | **silent memory flush turn at `threshold - 4000`, once per cycle, to `memory/YYYY-MM-DD.md`** | DELTA.md self-file (agent-written, capped, wall silently stops learning) |
| Post-compaction guards | one overflow flag | repetition guard | **loop guard: same tool+args+result hash 3x in a 3-call window after compaction aborts** | none |
| Crash recovery | reload JSONL, in-flight call lost | **assistant tool-call row persisted before execution; turn lease 300 s; synthetic resume turn** | admission in one SQLite txn, 3 retries then tombstone | journal replay, non-idempotent tools never re-fired, stranded siblings resumed |
| Subagents | subprocess, 4 concurrent, 50 KB output cap, scout format | background by default, depth 1, up to 10, live list/steer/stop, "self-reports not facts" warning, 50% headroom cap | push-based, depth 1, 5 children, 24K steering queue | in-process read-only `research` children, N≤3, utility model, no persistence, no crash recovery; `spawn_subagent` is a weaker second harness |
| Multi-session / handoff | **session tree + `/fork` + handoff prompt as alternative to compaction** | kanban + cron with 16KB notepad, `context_from: self`, monitor-mode hash gate | lanes, cron with fresh transcript + 16 KB state | durable per-session FIFO, `/v1/tasks` async, `schedule_self`; no engine handoff, no standing goal |
| Long-run telemetry | cache-miss notices | occupancy vs threshold, `compression_count` | qa-lab design, not collected | **`agent_events` with `cache_shortfall_tokens`, segment hashes, compaction attrs** |

Bottom line by theme:

- **Loop and recovery**: Delta leads. Take Hermes's persist-before-execute discipline as a check
  (we replay from the journal; verify the tool-call row lands before the tool runs) and OpenClaw's
  idle breaker as a second line behind our budgets.
- **Compaction fidelity**: Hermes leads, because they measured. Our audit measures numbers and
  paths only and never tracks proper names, which on a recruiting workload is the payload.
- **Compaction economics**: OpenClaw leads on the mechanism (TTL-gated prune, route-before-compact),
  Delta leads on the metric. Nobody has both.
- **Multi-task**: everyone is weak. Delta's plan recitation and durable queue are the best shape;
  our subagents are the least durable of the four.

---

## 3. Where Delta is ahead: keep, do not regress

1. Budgets the agent can reason about (steps, fresh tokens, cost), re-checked after every
   compaction. Pi has none, OpenClaw only elapsed time, Hermes only idleness.
2. The pre-send gate with the provider-anchored projection. Hermes reached the same design on
   08-28; Pi on 08-28 as well. We shipped it in 0.2.11.
3. Archive-safe compaction: message rows are never mutated, so `recall` can always find what a
   summary dropped. Hermes is the only other harness with this property.
4. The recited plan (`todo`) outside `messages`. None of the three recites a plan per turn.
5. `cache_shortfall_tokens` as prevInput-minus-cached. Pi reached the same formula; OpenClaw only
   alarms on warm-state drops.
6. Crash-replay idempotency and stranded-sibling resume. Hermes is comparable; the other two lose
   in-flight work.
7. Identifier audit with a deterministic appendix (0.2.15). OpenClaw's safeguard audit refuses to
   persist; ours appends what is missing. Ours is the better default for a summary that must
   always land.

---

## 4. Where Delta is behind, with evidence

### 4.1 Compaction economics

- Post-compaction re-cache is a large, unnamed cost. `docs/shipping-list.md:318-327` measured
  30.6% of spend on the QS lane; nothing on `model.call` says "this is the first turn after a
  compaction". Production today: the compaction turn's shortfall is p50 45 tokens but p90 4,258
  and max 38,123 on the non-bench lanes, and the turn after it has its shortfall suppressed, so
  the reload is invisible in the very place it is paid.
- We have one pressure valve, and it is the expensive one. OpenClaw routes to truncation of old
  tool results first (`preemptive-compaction.ts:421-466`) and summarizes only when that cannot
  cover the overflow with margin. Our `demoteSpilled` and `elideRowArgs` run only inside a
  compaction, not as a standalone cheaper step at a lower watermark.
- Pruning is not tied to the cache. OpenClaw prunes tool results only after the provider cache TTL
  lapsed, when the next request rewrites the prefix anyway (`tool-result-truncation.ts:150-225`).
  On QS, every resumed conversation after 5 minutes is such a moment, and we do nothing with it.
- `DELTA_TOOL_ARG_MAX_BYTES` is off by default (`config.ts:299-301`). Measured on the Aperture
  shape: -36.5% cost, 5 compactions to 0. Correction 2026-09-02: the four bench-opus lanes DO run
  it at 4096 (Fly env read by the Aperture engineer); client lanes were not read, so adoption
  outside the bench is unverified, not zero.
- The summary call itself is uncached on the utility lane (Aperture R8: 82 summary calls, 0 cached).
  Small in dollars, but every compaction also pays a full cold read of a 60,000-char transcript.

### 4.2 Compaction fidelity

- Production: 4.4 of 25.7 audited identifiers still go missing per compaction on average (17%),
  worst case 30 of 30, across 335 compactions. Better than the 35% Aperture reported on 0.2.14,
  and the appendix covers the audited set, but the audit only harvests years, numbers and spill
  paths (`compaction.ts:118-133`). Proper names, slugs, emails, URLs and company names are never
  audited. On a recruiting workload those are the payload.
- The merge contract accumulates. `SUMMARIZE_UPDATE` says "never DROP a prior fact". OpenClaw's
  safeguard contract re-distills ("prune stale, duplicate, or superseded") and Pi rejects
  length-stopped summaries. Under a 350-word cap, "never drop" plus "add everything new" is a
  contradiction the summarizer resolves silently, and the audit cannot see what it chose.
- Recovery is not advertised. Hermes ends every summary with a `## Context Recovery` footer naming
  the exact search call; demoted stubs carry the pointer. Our `recall` exists, but the summary
  text never tells the model it does. Production usage: `recall` in 27 of 818 runs.
- We have no fidelity measurement beyond the audit count. Hermes's ~450-line recall eval (questions
  generated from the region about to be summarized, closed-book vs +recovery arms) found their own
  default scoring 26-33% on three of four transcripts, which nobody had noticed. We are in the
  same position: no one has measured what a QS summary actually loses.

### 4.3 Loop hygiene after a compaction

- No post-compaction loop guard. OpenClaw aborts when the same `tool+args+result` hash repeats 3x
  in a 3-call window after a compaction (`post-compaction-loop-guard.ts:142`). This is the exact
  failure where a summary erased "already tried". We only see it as a `tool.breaker` event, of
  which there were 5 in 14 days, cause unknown.
- `context_irreducible` sends the oversized request anyway (`run.ts:986-992`).
- W3-shaped degradation on the OpenAI lane (reasoning stripped at compaction) is unmeasured.

### 4.4 The affordances exist but are not used

| Builtin | Runs using it (of 818) | Calls |
|---|---|---|
| `todo` | 47 | 137 |
| `recall` | 27 | 56 |
| `write_file` | 152 | 413 |
| `read_file` | 388 | 802 |
| `remember` | 236 | 652 |

Agents run 30 to 60 turns on `fiber_call` and `qs_step` with no recited plan. Aperture's own
`qs_step` may be doing the plan's job at the product layer, which is worth confirming on the VM,
but the engine's compaction summary is then the only carrier of "what is left", exactly the
pattern the other three suffer from. Meanwhile three Aperture lanes independently built the same
hot-file plus cold-notes memory design in userspace (R3d), which says the engine's memory shape is
not what a long run wants.

### 4.5 Subagents

- `research` children are in-process, not persisted, not resumable, run on the utility model by
  default, and reach MCP tools only when the server sets `readOnlyHint` (`mcp.ts:327`). Aperture
  banned delegation in production after children fabricated locations and roles (A25). The
  parallelism inside 10-30 minute runs is their largest unquantified latency lever and it is
  currently off.
- Hermes ships a prompt-level guard we do not: "child summaries are SELF-REPORTS, not verified
  facts, require a verifiable handle". Pi caps child output at 50 KB in a fixed format.

### 4.6 Instrumentation gaps

- The history digest (`history_hash`, `history_prefix_hash`, `history_n`) is not built; the cost
  objection at `run.ts:1010-1011` was measured false. Production confirms: 0 of 1,979 QS model
  calls in the last 7 days carry `history_prefix_hash`.
- Anthropic cache diagnosis (`cache_miss_reason`) is present on 0 of those calls, and the reason
  is simple: the R6 triage said "SHIP 0.2.15" but nothing named `CACHE_DIAGNOSIS` exists in
  `src/` today. It was never built. The shape-1 misses (p90 2,240 tokens, max 149,855 on
  non-bench lanes) remain unlabeled.
- `turns_since_compaction` is proposed and unbuilt.

---

## 5. Hypotheses, ranked by value over effort

Each hypothesis names the mechanism, the measurement that confirms or kills it, and the risk.
The shipping-list lesson from 0.2.15 applies throughout: measure before fixing, because the two
cache mechanisms proposed before that were both killed by the one segment nobody instrumented.

### H1. A quarter to a third of long-run spend is the reload after compaction, and it can be cut in half without touching summary quality

- **Claim**: on 30+ turn QS runs, the first 1-3 turns after each compaction re-write most of a
  170k-token prefix. Compaction fires at 200k with a 24k tail, so each cycle re-caches ~150k.
- **Mechanism**: (a) name it: `turns_since_compaction` on `model.call` and stop suppressing
  `cache_shortfall_tokens` on the turn after; (b) add a cheaper valve below the ceiling:
  demotion of spilled results and argument elision as a standalone pass at ~70% of the ceiling,
  routed OpenClaw-style (truncate-only when it covers the projected overflow, summarize only when
  it cannot); (c) run the demotion pass at cache-cold moments for free: first call of a resumed
  session after the TTL, and immediately after any compaction.
- **Measure**: cost per compaction cycle (sum of `cost_usd` from the compaction turn through the
  turn `cached_tokens` recovers) on the bench lanes, 0.2.16 vs candidate, same pinned battery.
- **Risk**: low for (a), medium for (b) and (c) because they change what the model sees mid-run.
- **Effort**: (a) one day; (b) and (c) one slice each.

### H2. Flipping `DELTA_TOOL_ARG_MAX_BYTES=4096` on by default is the cheapest long-horizon win we own

- **Claim**: 41% of stored arguments on the QS lane are reclaimable at 4 KB; measured -36.5% cost
  and 5 compactions to 0 on the Aperture shape. Every default deployment carries unbounded
  assistant rows in the retained tail, which is the `context_irreducible` shape.
- **Mechanism**: default on, with the existing elided-argument archive so `recall` still reaches
  the original.
- **Measure**: compactions per run and cost per run on carrara QS (the canary lane) across the
  next five heavy runs (tails over 59 KB), compared to the fortnight before.
- **Risk**: low; the archive path is built and tested. The unknown is whether any lane's tools
  legitimately need a 4 KB+ argument echoed back (staged bodies go through `qs_stage_body`, so
  probably not).
- **Effort**: a config default plus a changelog line.

### H3. Summary loss is concentrated in proper names, and an anchor index plus an advertised recovery footer recovers most of it at zero model cost

- **Claim**: our audit sees 17% loss on numbers and paths; the loss on names, slugs, URLs and
  companies is unmeasured and likely higher, because a 350-word summary of 118 compacted turns
  cannot hold a 50-person roster. Hermes's regex anchor index alone moved one transcript from
  23 to 60 recall points.
- **Mechanism**: (a) extend `extractIdentifiers` to a Hermes-style anchor set (URLs, emails,
  slugs, `Capitalized Multi Word` runs, quoted strings) with a bounded appendix; (b) append a
  `## Context Recovery` footer naming the exact `recall` call and the spill paths; (c) switch
  `SUMMARIZE_UPDATE` from "never drop" to OpenClaw's re-distill contract, because the appendix
  now owns identifier survival and the prose should own state.
- **Measure**: build the recall eval first (H4). Without it this is a guess.
- **Risk**: low for (a) and (b), medium for (c).
- **Effort**: (a)+(b) one slice; (c) one slice gated on H4.

### H4. We cannot improve compaction fidelity until we can score it, and the score can be built from Aperture's transcripts in a day

- **Claim**: Hermes's recall eval is the reason their lean compaction shipped with a number
  attached. We have 335 production compactions and no score.
- **Mechanism**: `DELTA_CAPTURE_CALLS=1` on one bench lane for one pinned battery, then an
  offline script: take each compaction's prefix, generate 20 questions from the region that was
  summarized, answer closed-book from summary + tail, then with `recall` allowed, score both.
  Standalone, no engine change.
- **Measure**: the score itself, on 0.2.16, as the baseline every H3 variant must beat.
- **Risk**: none to production.
- **Effort**: one to two days including the capture session.

### H5. The stationary-prefix miss is a placement defect, and two instruments settle it in one battery

- **Claim**: the same 7,172-token miss at discrete offsets across independent runs is a mark that
  went ineligible, not a TTL. The digest and the Anthropic diagnosis header label every miss.
- **Mechanism**: build the history digest as designed (`history_hash`, `history_prefix_hash`,
  `history_n`, delete the false cost objection), build the `DELTA_CACHE_DIAGNOSIS` opt-in that
  the R6 triage approved and nobody shipped, and set it on the two bench lanes.
- **Measure**: for every miss over 100 tokens on the battery: `history_prefix_hash` equal to the
  previous turn's `history_hash` (placement) or not (we mutated history), cross-checked against
  `cache_miss_reason`.
- **Risk**: none; additive telemetry.
- **Effort**: one day. This is the 0.2.15 diagnosis release that never got built.

### H6. A post-compaction loop guard prevents the worst-case wasted runs

- **Claim**: some of the 5 `tool.breaker` events and some of the $20+ runs are the model
  re-trying a path the summary forgot.
- **Mechanism**: OpenClaw's guard: after a compaction, hash `tool+args+result` for a 3-call
  window; on 3 identical, inject a one-line notice and, on a second strike, stop the run with the
  0.2.15 handoff.
- **Measure**: needs `DELTA_CAPTURE_CALLS` data to count identical post-compaction calls today.
  Cheap to compute on the H4 capture.
- **Risk**: low; notice first, abort second.
- **Effort**: one slice.

### H7. Delegation is banned in production because of one host-side annotation, and un-banning it is the largest latency lever on 10-30 minute runs

- **Claim**: children get web-only tools because Aperture's MCP tools do not set `readOnlyHint`,
  so they guess. With the annotation, children reach `fiber_read` and `fiber_docs` through the
  parent's live connection and stop fabricating.
- **Mechanism**: host-side annotation (already in the R7 triage); engine-side, add Hermes's
  "self-reports, not verified facts, return a verifiable handle" contract to the research child
  prompt and Pi's fixed compressed return format with a hard output cap.
- **Measure**: wall time and identifier accuracy on the hard tier of the pinned battery with
  delegation allowed vs the current ban.
- **Risk**: medium; fabrication was real. The contract text and the read-only allowlist are the
  guards.
- **Effort**: host: hours. Engine prompt: hours. Persisted, resumable children: a later release.

### H8. The plan should be bidirectional with the summary, and it should be seeded by the engine

- **Claim**: `todo` is used in 6% of runs, so on the other 94% the summary's `Next` section is the
  only carrier of intent across a cut, which is the failure mode all three competitors live with.
- **Mechanism**: when a compaction lands and the thread has no plan, seed `thread_state` from the
  summary's `Next` section; when a plan exists, hand it to the summarizer as the authoritative
  `Next`, so the prose never contradicts the recited plan. Also verify on the VM whether
  Aperture's `qs_step` already carries the plan, in which case expose a host hook rather than
  changing the default.
- **Measure**: on 30+ turn runs, the count of "what was I doing" re-reads (`qs_read_artifact`,
  `qs_context` calls after a compaction) before and after.
- **Risk**: medium; changes the recited text.
- **Effort**: one slice after H4 gives a fidelity score.

### H9. Handoff at a phase boundary beats compaction for multi-hour knowledge work

- **Claim**: 60 runs in 14 days passed 30 turns and 4 passed 60. Pi's `handoff` (a self-contained
  prompt for a new session, parent link kept) and Hermes's cron notepad both say the same thing:
  at a phase boundary, a fresh session with a written brief loses less than a fifth summary
  generation.
- **Mechanism**: a `handoff` builtin that writes a brief (goal, state, artifacts, next) to the
  workspace and opens a new session linked to the parent; the standing-goal design deferred in
  0.2.16 is the same feature from the other end.
- **Measure**: only after H4 exists; compare fidelity of "fifth summary" vs "handoff brief".
- **Risk**: medium.
- **Effort**: a release. Park behind H1-H5.

Not proposed, deliberately: Hermes's micro-compaction (they ship it off, it breaks the prefix
every turn), OpenClaw's gross-only trigger and dual summarizer contracts, Pi's unbounded loop,
and any "compact on top of the live cached prefix" trick until Pi says why they reverted theirs.

---

## 6. Proposed shape of the next release

Diagnosis first, then the two cheap wins, then fidelity, in that order, because every fix that
skipped measurement in this project's history was later found to solve a problem no lane had.

| Slice | Hypothesis | Type | Fleet risk |
|---|---|---|---|
| `turns_since_compaction` + unsuppressed post-compaction shortfall | H1a | telemetry | none |
| History digest + verify `DELTA_CACHE_DIAGNOSIS` | H5 | telemetry | none |
| Recall eval script on captured transcripts | H4 | offline tool | none |
| `DELTA_TOOL_ARG_MAX_BYTES` default 4096 | H2 | default flip | low |
| Anchor index + recovery footer | H3a, H3b | compaction | low |
| Post-compaction loop guard (notice, then stop) | H6 | loop | low |
| Standalone demotion pass at 70% + cache-cold pass | H1b, H1c | compaction | medium |
| Re-distill merge contract | H3c | compaction | medium, gated on H4 score |
| Research child contract + return format | H7 | prompt | low |

---

## 7. What to do with the Aperture engineer

Their fleet is the only place these hypotheses can be tested on real work. The collaboration has
three parts; the brief in `docs/brief-aperture-long-horizon-study.md` is the version to send.

**Part A, data we can pull today (read-only, `agent_events`)**

1. Cost per compaction cycle on every 30+ turn run since 08-19, by lane: spend from the compaction
   turn until `cached_tokens` recovers to its pre-compaction level. This sizes H1.
2. The distribution of `identifiers_missing` by lane and by summary generation (`merged` true vs
   false), to see whether loss grows with generation. This sizes H3.
3. Tool-call sequences after each compaction on the 20 most expensive runs: any tool called with
   the same name three times in the next five calls. A proxy for H6 until we have arguments.
4. Resume gaps per session (end of run to start of next run, same session) to size the free
   cache-cold pruning moments for H1c. Their runbook already has the right query shape.

**Part B, what to inspect on a VM (one client lane and one bench lane)**

1. `DELTA.md` and any `notes/` files: what the agents taught themselves about compaction, memory,
   and delegation. Carrara's `notes/delta-dropped.md` and the hot-file plus cold-notes design are
   the userspace spec for what the engine should do.
2. `thread_state`: how many threads ever held a plan, and what the plans look like when they
   exist. Whether `qs_step` is the real plan carrier.
3. `.delta/spill` size and age, and how often demoted spill paths were re-read (`read_file` on a
   `.delta/spill` path).
4. `messages` for one 40+ turn run: the actual summary chain, generation by generation, to read
   what a fifth-generation summary looks like. This is the qualitative check that H3 and H8 are
   aimed at the right thing.

**Part C, the experiment**

1. Set `DELTA_CAPTURE_CALLS=1` and `DELTA_CACHE_DIAGNOSIS=1` on `speed-lab` for one pinned
   battery on 0.2.16. This is the baseline capture for H4 and H5 and costs nothing in production.
2. Annotate their read-only MCP tools with `readOnlyHint: true` on the bench lanes only, and rerun
   the hard tier with delegation allowed. This is H7 and needs no engine release.
3. Flip `DELTA_TOOL_ARG_MAX_BYTES=4096` on `google-deepmind` as a second canary alongside carrara,
   so a heavy run lands on it sooner. This is H2.
4. When the diagnosis slices ship, upgrade the two bench lanes, rerun the same battery, and hand
   back the labeled miss table. That decides the order of everything in section 6 below the line.

Questions for them, in their own terms:

- Does `qs_step` carry the plan, and would they want the engine's `todo` seeded from it, or the
  reverse?
- Which lane has the most 30+ turn runs on real client work, so H1 is sized on the run shape that
  matters rather than on bench lanes (which dominate the compaction counts today: the top eight
  runs by compaction count are all bench lanes)?
- Have they seen anything W3-shaped on the OpenAI bench lane since 0.2.16? It gates the 0.2.17
  reasoning-context candidate and none of the above touches it.

---

## 8. Codex review of the plan (2026-09-02) and the revised order

An adversarial pass over sections 5 and 6 by codex (gpt-5.6-sol), against the source. What it
changed, in the order it matters:

1. **One behavior change per battery.** Section 6 bundled telemetry, a default flip, summary
   semantics, a loop guard, pruning and delegation into one release; a green battery could not
   have attributed the result. The build now runs as: battery 0 = slice 1 (telemetry only, also
   the A/A twin noise floor), then exactly one behavior slice per battery.
2. **H1's measurement was wrong as written.** "Spend until `cached_tokens` recovers" never
   terminates cleanly and counts normal work. The reload is simply the shortfall on the call with
   `turns_since_compaction = 0` (min(prev, cur) minus cache read), which slice 1 now emits.
3. **H1c is dropped.** Pruning at a cache-cold moment is not free: it still rewrites active
   history, pays a fresh cache write, changes what the model sees, and can trigger the
   documented redo behavior next to `elideRowArgs`.
4. **H2 stays a canary, not a default flip after five runs.** The four bench-opus lanes already
   run `DELTA_TOOL_ARG_MAX_BYTES=4096` (verified on their Fly env on 2026-09-02); client lanes
   were not read, so "off everywhere" in section 4.1 was stale. Guardrails before any flip:
   completion rate, duplicate side-effect calls, and an elided-argument echo count.
5. **H4 moves first and gets stricter.** An LLM generating and judging its own questions is
   self-confirming. The eval needs verbatim source spans from the summarized region, a tripwire
   that discards anything answerable from the retained tail, an abstention option, a string-match
   judge, and scoring per summary generation (1st, 2nd, 3rd cut in a session), not per cut alone.
6. **H3 after H4, with per-class budgets and defanging.** Broader anchor classes (names, URLs,
   quoted strings) break the appendix's current "no defang needed" assumption and can stuff it
   with stale names across generations.
7. **H6 ships shadow-only first.** A `would-have-fired` event, replayed against captured runs,
   before any notice; never an abort, because a status or poll tool can legitimately return the
   same result three times right after a compaction.
8. **H8 loses the summary-to-plan seeding.** Promoting a summarizer's `Next` into recited text
   amplifies a hallucinated or injected plan across every later turn. Keep only plan-to-summary
   consistency (hand the todo to the summarizer as the authoritative `Next`).
9. **H9 is out of this cycle.** It is a session-ownership feature, not a builtin.
10. **H5 anchors are process-local.** A daemon restart mid-run resets the comparison; the
    attributes say so by absence, and resume tests are owed before results are read.

Five gaps codex found that the competitor teardowns support and the plan missed:

- No end-to-end 40-turn, four-compaction soak scored on completion, drift, cost and recovery.
- No rejection of length-truncated or structurally invalid summaries, and no static fallback
  (Pi rejects length stops, Hermes falls back, OpenClaw cancels before persisting).
- The advertised recovery footer needs a backend worthy of it: `searchHistory` is a bounded LIKE
  with a 25-hit cap and an id window, so "use recall" can point at data it cannot retrieve.
- No effectiveness check against the NEXT real provider usage after a compaction, and
  `context_irreducible` still sends the oversized request.
- No bounded pre-compaction durable-facts checkpoint (OpenClaw's once-per-cycle memory flush),
  which is the other half of the self-file wall.

Slice 1 itself passed codex's diff review after two P2 fixes: the diagnostics anchor now survives
an id-less fallback call, and `cache_miss_reason` is re-allowlisted at the export boundary.

---

## 9. Results log (running)

### 9.1 Recall eval baseline, 2026-09-02 (control lane bench-opus-c, 0.2.16 summaries)

`docs/bench/compaction-recall.ts` on the lane's own `delta.db`: 7 real compactions, 83 grounded
questions (verbatim-span grounded, tail tripwire), reader claude-sonnet-5, string-match judge.

| generation | cuts | questions | closed-book correct | abstain | wrong | +recall (phrase LIKE) correct | recall hit rate |
|---|---|---|---|---|---|---|---|
| 1 | 5 | 59 | 22% | 54% | 24% | 32% | 7% |
| 2 | 2 | 24 | 4% | 67% | 29% | 4% | 0% |

Reading: a first-generation summary carries about one grounded fact in five; the first merge
carries almost none. The phrase-LIKE `recall` found the answer in 7% of searches. Wrong answers
(24 to 29%) are the reader confabulating from a summary that names an entity without its facts.
This is the number every summary change must beat, on the same cached questions.

### 9.2 Battery 0, control arm (bench-opus-c, 0.2.16, production config), 2026-09-02

23 of 23 runs succeeded. Per tier: simple p50 $0.80 / 1.9 min / 11 turns; medium p50 $1.26 /
3.9 min / 17 turns; hard p50 $2.98 / 8.9 min / 23 turns. Zero recall or todo calls in the whole
battery. Only TWO compactions fired across all 23 runs (H4 once, M6 once at 37 turns), and the M6
compaction dropped 25 of 30 audited identifiers.

The finding is about the instrument: at the production ceiling (200k) with `DELTA_TOOL_ARG_MAX_BYTES`
on, this corpus almost never compacts, so a twin battery at production config cannot measure
compaction fidelity or the reload. Battery 1 therefore runs BOTH twins at `DELTA_COMPACT_AT_TOKENS=60000`
(the same lever the 0.2.14 canary used), which turns every hard run into a three-to-five compaction
run, the exact shape carrara's 30+ turn client runs have at the production ceiling. Env stays
identical across the twins; only the image differs.

### 9.3 Battery 0, twin-vs-twin (A/A noise floor), 2026-09-02

Both arms same model-visible behavior (control 0.2.16, candidate lh-rc1 = slice 1 telemetry only).
45 of 45 runs succeeded. Neither lane called `recall` or `todo` once.

| tier | control cost p50 / wall p50 / turns | candidate cost p50 / wall p50 / turns |
|---|---|---|
| simple (10) | $0.80 / 1.9 min / 11.1 | $0.63 / 1.9 min / 11.1 |
| medium (8) | $1.69 / 3.9 min / 17.5 | $1.91 / 3.8 min / 18.9 |
| hard (5) | $3.17 / 8.9 min / 25.4 | $2.58 / 10.4 min / 23.2 |

That spread (up to about 25% per tier at n=5 to 10) is the noise floor every later comparison
must beat.

Instrument results on the candidate, 23 runs, 376 main-lane calls:
- **The reload is now a number.** The call after each of the two compactions re-read 29,571 and
  20,177 tokens (`turns_since_compaction = 0`, `cache_shortfall_tokens`). At $15/M input that is
  roughly $0.45 and $0.30 per compaction on Opus, on top of the summary call.
- **History is append-only in practice.** `history_prefix_hash` matched the previous turn's
  `history_hash` on all 353 comparable turns. "We mutate history" is falsified for this workload.
- **The provider agrees.** `cache_miss_reason` was `none` on 376 turns; the only two
  `messages_changed` verdicts were the two compaction reloads, where the prefix really was rewritten.
  No stationary-prefix miss over 100 tokens on the candidate. The shape-1 defect did not reproduce
  here; it remains a Ferni and client-lane observation to chase with the same instruments.
- Identifier audit on the two compactions (numbers and paths only, pre-slice-3): 30 of 30 and 29 of
  30 missing.
- Both lanes grew `DELTA.md` from 4.5 KB to 15.9 KB in one battery and each wrote its own
  pending-lessons note (`notes/pending-delta-lessons.md`, `notes/lessons-inbox.md`): the self-file
  wall workaround, reinvented on a fresh seed within a single battery.
