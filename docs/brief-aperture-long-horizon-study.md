# To the Aperture engineer: the long-horizon study, and what I need from your fleet

2026-09-02, from the Delta Harness maintainer. Companion to
`docs/study-long-horizon-synthesis.md` (the decisions) and the four teardowns behind it
(`docs/study-long-horizon-{pi,hermes,openclaw,delta}.md`, all cited to file:line at today's head).

## Why now

Nic asked for the harness to get better at long-horizon work: 30 to 60 turn runs, several
compactions, an hour of wall time. Your Quick Search lanes are the only place that work happens
at volume: 817 runs, 12,090 turns and 335 compactions in the last 14 days, 60 runs past 30 turns.
So the study is grounded on your telemetry, and the experiments have to run on your lanes.

I pulled Pi, Hermes and OpenClaw to today's head (272 / 6,051 / 9,611 commits since our August
snapshot) and had each torn down on four themes: the long-running loop, compaction, context
management, and multiple tasks. Then the same for our own engine, bluntly.

## What the study says, in five lines

1. Delta leads on safety and recoverability: budgets, pre-send gate, archive-safe compaction with
   `recall`, spill, recited plan, identifier appendix, crash replay. Keep all of it.
2. Hermes leads on compaction fidelity, because they measured it: a recall eval on real transcripts
   showed their own default scoring 26-33%, and a regex anchor index plus an advertised recovery
   tool fixed most of it at zero model cost. We have no such score.
3. OpenClaw leads on compaction economics: it truncates old tool results before it ever
   summarizes, and it prunes only when the provider cache has lapsed anyway.
4. Nobody recites a plan or has a durable subagent. Our `todo` is ahead; our `research` children
   are the least durable of the four.
5. Our biggest exposures are self-inflicted and known: the reload after a compaction is ~30% of
   spend on your lane with nothing naming it, the history digest and the cache-diagnosis opt-in
   from the 0.2.15 triage were never built, `DELTA_TOOL_ARG_MAX_BYTES` is measured at -36% cost
   and off by default (on for your bench-opus lanes, client lanes unverified), and `todo` / `recall` appear in 6% / 3% of your runs.

## Three things I saw in your data that I want you to confirm or correct

- **Identifier loss is 17% now, not 35%.** 4.4 of 25.7 audited identifiers per compaction,
  worst case still 30 of 30. The appendix covers the audited set, but the audit tracks numbers
  and paths only, never names, slugs, companies. Is name loss what your users actually notice?
- **The long-horizon tools are barely used.** `todo` in 47 of 818 runs, `recall` in 27. Is
  `qs_step` doing the plan's job at your layer? If so the engine should seed from it or expose a
  hook, not compete with it.
- **The compaction-heavy runs are all bench lanes.** The top eight runs by compaction count are
  `bench-*`. Which client lane has the most 30+ turn runs on real work, so I size the reload cost
  on the shape that matters?

## What I need from you

**A. Nothing to build, just say yes:** I will keep pulling read-only from `agent_events` for:
cost per compaction cycle on every 30+ turn run since 08-19 by lane; `identifiers_missing` by
summary generation; tool-name repeats in the five calls after each compaction; resume gaps per
session. Same URL and same restraint as before.

**B. One VM session each on a client lane and a bench lane.** I want to read, not change:
`DELTA.md` and `notes/`, `thread_state` (how many threads ever held a plan, what they look like),
`.delta/spill` size and age plus how often demoted spill paths were re-read, and the full summary
chain of one 40+ turn run in `messages`, generation by generation. Carrara's `notes/delta-dropped.md`
and the hot-file plus cold-notes design your lanes converged on are the userspace spec I intend to
build against.

**C. Three experiments on the bench lanes, in this order, none needs an engine release:**

1. `DELTA_CAPTURE_CALLS=1` on `speed-lab` for one run of the pinned battery on 0.2.16. This is the
   baseline for the recall eval I am building (Hermes-style: questions generated from the region a
   compaction summarized, scored closed-book and with `recall`). It does not export; I will read
   the `calls` table on the machine.
2. `readOnlyHint: true` on your read-only MCP tools (`fiber_read`, `fiber_docs`, the `qs_read_*`
   family), bench lanes only, then the hard tier with delegation allowed. This is the R7 host-side
   half from the August triage and it un-bans parallelism inside your 10-30 minute runs. I am
   adding Hermes's "child summaries are self-reports, not facts, return a verifiable handle"
   contract to the child prompt on my side.
3. `DELTA_TOOL_ARG_MAX_BYTES=4096` on `google-deepmind` alongside the carrara canary. Only a heavy
   run (tail over 59 KB) exercises it, and carrara has not had one since the flag went on.

**D. When the diagnosis slices ship** (`turns_since_compaction`, the unsuppressed post-compaction
shortfall, the history digest, `DELTA_CACHE_DIAGNOSIS`): upgrade the two bench lanes, rerun the
same battery, send back the labeled miss table. That decides the order of the fidelity and
economics work.

## What comes back to you

- The recall score of 0.2.16 compaction on your own transcripts, before anything changes.
- A labeled cause for every cache miss over 100 tokens on the battery: placement, our mutation, or
  provider.
- The cost of a compaction cycle in dollars per lane, so "compact less often" stops being a
  feeling.
- The hard-tier wall time with delegation on vs off.

Still open from August and untouched by this study: anything W3-shaped on the OpenAI bench lane
since 0.2.16. It gates the 0.2.17 reasoning-context candidate. If you have seen it, that goes
first.

- Delta Harness
