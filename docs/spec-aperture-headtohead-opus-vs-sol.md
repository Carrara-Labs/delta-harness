# Spec: the Quick Search head-to-head — Opus 5 (medium) vs GPT-5.6 Sol (low/low), both on 0.2.16

2026-08-19, Delta Harness maintainer, for the Aperture engineer. This is the operational spec for
the benchmark that decides the demo lane. Everything below assumes published
`@carrara-labs/delta-harness@0.2.16` on every lane.

**Read this file at:** `/Users/nictouron/delta-harness/docs/spec-aperture-headtohead-opus-vs-sol.md`
(repo-relative `docs/spec-aperture-headtohead-opus-vs-sol.md`, any checkout ≥ `v0.2.16`).
Companions: `docs/handover-aperture-0.2.16.md` (release + warnings W1–W6),
`docs/report-sol-tuning-0.2.16.md` (why low/low — the data), `docs/bench/` (scripts + raw JSON).

## 0. Why Sol runs at low/low — the data, so you don't have to take it on faith

30 live sol runs through the published harness, three rounds
(`docs/report-sol-tuning-0.2.16.md`):

1. **Six-config grid** (effort none→high × verbosity): every config produced a perfect brief;
   effort bought only time and cost — high was +80% wall time, +61% cost vs low, and once
   answered a complete result set with six more parallel searches.
2. **Hard-task head-to-head, n=9 per arm** (name-collision disambiguation with conflicting
   sources, forced second search round + arithmetic ranking, and a "not disclosed" gap trap):
   quality tied at 27/27 facts, 6/6 conflict/gap flags, 0 invented figures on BOTH arms — while
   medium spent +46% search calls, +20% wall, +23% cost, and produced the single genuine
   user-facing error of the whole set (reported the older funding round as "latest").
3. **Latency anatomy** (wire-level stopwatch): ~95% of per-call latency is the silent
   pre-output thinking window; writing a tool call takes ~0.1 s. Effort widens exactly that
   silent window. Verbosity low tightens user updates ~40% with zero artifact effect.

So Sol's arm is `low` effort + `low` verbosity. Opus's arm keeps **your** tuned setting (medium
— you landed there because Opus is smart enough, which is precisely the property this benchmark
tests on Sol too). If your battery contradicts our staged results, that finding outranks this
spec — report it.

## 1. Workspaces and lanes

Four lanes for concurrency, two per model. Use idle workspaces upgraded to 0.2.16, or create
fresh ones — whichever is faster on your side; what matters is the invariants in §3.

| lane | model arm | env deltas from the common bundle |
|---|---|---|
| `qs-bench-opus-a` | Opus 5 · medium | see Opus block below |
| `qs-bench-opus-b` | Opus 5 · medium | same |
| `qs-bench-sol-a` | GPT-5.6 Sol · low/low | see Sol block below |
| `qs-bench-sol-b` | GPT-5.6 Sol · low/low | same |

**Opus lanes** (your current production shape, unchanged — 0.2.16 is byte-identical on this wire):

```dotenv
MODEL_BASE_URL=https://api.anthropic.com/v1
MODEL_API=anthropic
MODEL_API_KEY=<anthropic key>
DELTA_MODEL_PRIMARY=claude-opus-5
DELTA_REASONING_EFFORT=medium
DELTA_UTILITY_MODEL=claude-haiku-4-5-20251001
DELTA_CACHE_TTL=1h
```

**Sol lanes** (the 0.2.16 first-class path — metered API, NOT codex sign-in):

```dotenv
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API=responses
MODEL_API_KEY=<metered OpenAI key>
DELTA_MODEL_PRIMARY=gpt-5.6-sol
DELTA_REASONING_EFFORT=low
DELTA_TEXT_VERBOSITY=low
DELTA_REASONING_SUMMARY=auto
DELTA_UTILITY_MODEL=gpt-5.6-luna
# deliberately ABSENT: DELTA_CACHE_TTL, DELTA_SPEED (Anthropic-only; the boot line
# names anything unmapped). Caching needs nothing: explicit breakpoints +
# prompt_cache_key are automatic on gpt-5.6 via openai.com.
```

First-boot check per lane (5 min): boot line clean (nothing unmapped, no tools omitted you
didn't expect), `GET /v1/status` → `model.controls.unmapped: []` and the three-state tools
report, one throwaway two-turn task, then confirm on telemetry that turn 2 shows
`cached_tokens` ≈ full prefix (both wires) and, on Sol, `cache_write_tokens` > 0 on turn 1.

## 2. The QS agent configuration — what "correctly configured" means on 0.2.16

The point of this section: the bundle both arms run should be the one Quick Search *should have
had* on 0.2.15 — cleaned up to harness best practice — so the benchmark measures models, not
config debt. One bundle, byte-identical across all four lanes except the env above.

1. **DELTA.md carries identity, POLICY.md carries law, the request carries the task.** QS's
   drafting rules and identity render every turn from DELTA.md/POLICY.md — nothing
   task-specific belongs in them, and no standing instructions belong in the first request
   (the D-1 lesson: session-start requests are not a place to park a frame).
2. **POLICY.md should state the QS honesty contract explicitly** — it is what our gap-trap
   data shows models honor when told: *prefer the newer source and say there was a conflict;
   say "not disclosed" rather than guessing; every artifact claim must appear in fetched
   results.* Put it in POLICY (non-overridable), not in DELTA.md.
3. **Kill workarounds the engine made obsolete:** any external skill-rescan restart timer
   (0.2.15 rescans live); any `output_text` counter-parsing (counters live in `runs.error`);
   any reader of `${workspace}/research/` (now `.delta/research/`); any prompt language
   apologizing for lost context mid-chain (Sol now carries its own reasoning; Opus never
   needed it).
4. **Set `DELTA_SCRATCH_DIR`** on the bench workspaces so spill/research intermediates stay
   off the workspace document tree (same as your fleet norm).
5. **Per-run effort override stays available** (`metadata.reasoning_effort`) — the battery
   below uses one fixed effort per arm; do not vary it mid-battery.
6. Keep budgets, profile, vocab, and the tool surface IDENTICAL across all four lanes.

## 3. Fairness invariants (the benchmark is void where these break)

- Same engine version (0.2.16), same bundle bytes, same tools, same budgets on every lane.
- The ONLY differences between arms: the model env blocks in §1.
- Every task runs once per ARM (not per lane) — lanes are concurrency, not extra samples.
  Assign tasks to lanes round-robin within an arm.
- Fresh session per task (no cross-task contamination), same task text verbatim to both arms.
- Nothing else runs on those workspaces during the battery.
- Record per run: `runs` row (status, error, usage), `model.call` telemetry (latency, tokens,
  cached/cache-write, cost), tool-call count, and the artifact itself.

## 4. The battery

Mix of carried-forward and new, ~24 tasks total, three tiers. Where possible, reuse tasks
verbatim from your pinned 0.2.14/0.2.15 battery — that gives us longitudinal comparability for
free (same task, four data points: 0.2.14, 0.2.15, and now both models on 0.2.16).

| tier | n | source | what it probes |
|---|---|---|---|
| simple | 6 | your pinned battery, verbatim | latency + regression floor; expect near-tie |
| medium | 8 | 6 from pinned battery + 2 new | standard person/company briefs, multi-source |
| hard | 10 | 4 from pinned battery + 6 new (below) | where the demo is won or lost |

New hard tasks — real-user shapes, all with verifiable ground truth prepared in advance:

1. **Name collision + conflicting sources** (our disambig shape, but on real web data): a
   person/company whose namesake is more famous; funding or role facts that changed recently
   so stale sources actively conflict with fresh ones.
2. **Forced multi-hop**: a comparison where one entity is obscure enough that the first search
   round cannot cover it; correct behavior requires a second, reformulated round.
3. **The gap trap**: a request whose central fact is genuinely undisclosed. Score "not
   disclosed" as PASS and any confident number as FAIL — this is a founder-demo integrity case.
4. **Long-chain synthesis**: 3+ entities, a derived metric (per-employee, YoY), and a ranking —
   arithmetic must be exact.
5. **Mid-session pivot**: send a brief, then a genuinely different follow-up request in the
   same session — measures whether the agent serves the LIVE ask (the D-1 class) and, on Sol,
   whether carried reasoning helps or drags across a pivot.
6. **The compaction crossing**: a task sized to force at least one compaction mid-run (or
   lower `DELTA_COMPACT_AT_TOKENS` on ONE paired run per arm). This is W3 from the handover:
   Sol's carried reasoning is stripped at compaction by design; we want to see the cost of
   that reset in the open, per arm.

## 5. Scoring — same standard as your last three reports

Per task, per arm:

| dimension | how |
|---|---|
| artifact quality | your existing rubric: right entity, load-bearing facts + identifiers intact, structure |
| integrity | conflicts flagged; gaps stated, never filled; no invented figures |
| total wall | trigger → final user message, from `runs` timestamps |
| time-to-first-signal | first streamed token/summary (Sol streams reasoning summaries — count them as signal; they're also your UX option for dead-air) |
| cost | `cost_usd` summed per run — REMEMBER W1: sol pricing is now real; Opus unchanged |
| composure | search-call count vs the minimum the task needs; premature finals (phase class) |
| cache warmth | `cached_tokens` / `cache_write_tokens` / shortfall per turn |

Verdict shape: per-tier winner + overall, with the same falsification standard as always — a
result that contradicts our staged tuning data (e.g., Sol needing medium on real hard tasks) is
MORE valuable than one confirming it, and flips the demo config if confirmed. On a clean Sol
verdict, the demo workspace gets created on the Sol block in §1, frozen, and only then goes
client-visible.

## 6. Sequencing and what comes back

1. Finish the 0.2.14 vs 0.2.15 benchmark FIRST if any arm is still running — it gates 0.2.17
   and nothing here may contaminate it.
2. Lanes up (§1) → boot checks → bundle cleanup (§2) applied identically everywhere.
3. Run the battery concurrently across the four lanes (§3 assignment rule).
4. Back to us: the per-tier table, the artifacts of any FAILed integrity case, each lane's
   boot line + `/v1/status` controls block, the compaction-crossing observations (W3), and
   your `tool.rejected` baselines while you're in there.

— Delta Harness
