# Harness 0.2.13 plan - "say what changed"

Batch scoped 2026-08-07 from `docs/ask-context-ceiling-and-compaction.md` (Aperture, after a 12-hour
600-profile client engagement on 0.2.11), across three rounds recorded in
`docs/reply-aperture-context-ceiling{,-2,-3}.md`. Visual explainer:
`docs/harness-0.2.13-explainer.html`, published at
https://claude.ai/code/artifact/06f9afe2-7ecf-4a93-9b66-8fe0e04a68e0

**Read this before touching the batch.** Two plausible mechanisms were proposed for the same defect
and both were killed by data. The batch is instrumentation-first on purpose, and the ordering below
is a dependency argument rather than a priority list.

## The finding this batch exists for

Aperture measured that **a turn whose assembled context comes out shorter than the previous turn's
misses the prompt cache**: 27/27 over a 39-turn window, against 21/25 hits when it grew. A miss
floors at 8-9% and costs 5.7x a cached turn. Over that window, misses took 87% of spend: $36.62
where $10.32 was the floor, so 72% was nominally recoverable, on roughly one sixth of one engagement.

The correlation has survived every check. **Every proposed cause has not.**

| round | mechanism | how it died |
|---|---|---|
| R1 | Compaction fires nearly every turn and each tail rewrite kills the prefix | Arithmetic first: compaction may only alter history on a >=5% shrink (`MATERIAL`, `compaction.ts:29`), and four of five observed steps were under 2.3%. Then data: **68% of misses had no compaction event at all**, and a compacting turn was more often a hit than a miss. 161 compactions cannot produce 119 misses. |
| R2 | The A4 breaker withdraws a failing tool's schema, and schemas sit ahead of history | Killed by a control: only **10 `tool.result` errors in 30 hours**, across four tools that all kept being called. The breaker never latched. **Vacuous, not negative** - ruled out as the dominant cause, untested as a cause. |
| R3 | (the instrument both sides agreed to build) Assembled-prefix byte size per turn | Caught before building. It measures size; the cache keys on identity. |

Also settled and worth not re-deriving:

- **Tools called per turn is orthogonal.** That block is appended at the end of history, behind
  everything cached, so it cannot invalidate a prefix. Aperture's second probe (tool-set shrink:
  21% of misses vs 29% of hits) was measuring the suffix and discriminates nothing.
- **`cache_hit_pct` already ships** (`run.ts:1054`, on `SAFE_ATTRS`) and was reaching their table on
  2,629 of 2,629 rows. The "emit the signal" ask was wrong twice over.
- **The pre-send gate under-counts**, materially. The byte estimator has a per-token bias that a
  large MCP surface worsens, and `run.ts:897-898` zeroes both `lastInputTokens` and `lastEstimate`
  after a shrinking compaction, discarding the provider-anchored half of the projection. Aperture
  measured 206k-218k real input against a nominal 200k ceiling with compaction never attempting.

## Why the mechanism is still unnamed, and what that says about the instrument

Because every instrument either side proposed measured **size**, and the prompt cache keys on
**identity**. A prefix that mutates without changing length breaks the cache exactly as hard as one
that shrinks, and is invisible to a byte counter.

That is not hypothetical here. The spine is rebuilt every turn (`run.ts:762`) and embeds
`searchable: allowedMap.size - active.size`, a counter that decrements on every activation, alongside
the agent-writable self-file. `138` to `139` is cache-fatal and zero bytes.

Assembly order is the whole contract (`run.ts:922`):

```
messages = [ system, ...history, ...ephemeral ]
wire     = [ spine ][ tool schemas ][ ......... history ......... ][ fresh ]
             ^ a change here invalidates everything to its right      ^ free to churn
```

> **Correction, 2026-08-10, from the first production reading (`results-0.2.13-live.md`).** Half of
> the sentence above is wrong. `buildSpine` is inside the turn loop, but `self` is read **once per
> run**, before it, so a mid-run `remember` cannot change the prompt of the run it happens in.
> Measured on Ferni: a self-write on turn 10 left turn 11's `spine_hash` untouched, and the next run
> moved it by exactly the self-file delta (+659 bytes, `tools_hash` unchanged). The `searchable`
> counter *is* recomputed every turn and survives as the suspect. The net effect is to **narrow**
> the hypothesis onto tool activation, which fits Aperture's large-MCP-surface shape more tightly
> than the two-cause version did.

| part | rebuilt per turn | can change | can shrink | verdict |
|---|---|---|---|---|
| spine | yes | yes, at constant length | yes | **standing suspect**, narrowed 2026-08-10 to the `searchable` counter alone; the self-file is fixed for the run |
| tool schemas | yes | grows on activation, shrinks only via breaker | breaker only | ruled out on current data, not in general |
| history | no (read from disk) | compaction only | compaction only | compaction ruled out |
| ephemeral | yes | constantly, by design | yes | exonerated: sits last, and 0.2.11's `ephemeralCount` keeps breakpoints off it |

## The batch

### Tier 1 - ships first, because every remaining decision is currently a guess

**S1. Segmented prefix identity on `model.call`.** Six fields, no new event, no new consent tier, no
payload capture:

| field | answers | why |
|---|---|---|
| `spine_bytes`, `spine_hash` | did the identity block change, and by how much | carries a live counter and the self-file; both mutate at constant length |
| `tools_bytes`, `tools_hash` | did the callable surface change | grows on activation, shrinks only via quarantine |
| `history_bytes` | did the transcript get rewritten | no hash needed: append-only unless compaction touches it, and compaction emits its own event |
| `ephemeral_bytes` | how much is re-read every turn regardless | cannot break the prefix; tracked because it is uncached by construction |

**Hash, not diff, and the reason is the general pattern.** A diff answers the question completely and
costs far too much: it needs the previous request retained, it moves model-visible text into
telemetry, and it only works where someone turned capture on *before* the interesting turn. A short
hash per segment is a handful of bytes, carries nothing readable, is safe without payload consent,
and localises with certainty. It cannot answer *which byte* - which is exactly what a targeted
capture on a known-guilty segment then answers cheaply. **Ship the cheap always-on signal that
localises; keep the expensive one for confirming.** This thread had neither.

**S2. Emit the non-shrinking compaction attempt.** `compaction.ts:538` returns before the event is
emitted, so an attempt that summarises ~60k of transcript on the utility model and produces a
non-material result emits nothing while still being billed. Silent cost and silent latency in front
of a turn on any saturated lane.

**S3. Emit `model.call` for utility-tier calls.** `model.call` fires in exactly one place
(`run.ts:1044`), the main-loop call. Every `chatUtility` path bypasses it (`run.ts:484`, `:876`,
`:983`) while charging through `addUsage`. No consumer can see or price the utility tier, and it
means every compaction count in this investigation was a floor on attempts rather than a count.

**S4. Emit the A4 breaker latch** as its own event, with the tool name and the schema bytes
withdrawn. R2 could not be tested directly because the thing it accused leaves no trace.

### Tier 2 - rides along, provable from source, waits for nobody

**S5. Decouple the tail budget from the ceiling.** `run.ts:872` computes
`recentBudget = compactAtTokens - fixed - SUMMARY_RESERVE`, so the budget compaction compacts *to* is
derived from the ceiling that *triggers* it. On a 200k ceiling with a ~16k fixed floor that is a 180k
tail: compaction lands at ~99% of budget and the next turn pushes it straight back over. That is
`spec-compaction-tail`'s 94-of-94 in one line. Compact to a low-water mark independent of the
trigger. Real, and a smaller win than R1 assumed.

**S6. A `window` column on the `pricing.ts` model table.** Ceiling derived as
`window - max_output - reserve`; `DELTA_COMPACT_AT_TOKENS` demoted from the only input to an
override; clamp-with-warning when the override exceeds the known window, so the inverse error
degrades loudly instead of turning compaction into overflow. The table, the env-override pattern and
the exact/leaf/prefix resolver already exist, so this is **a column, not a catalogue**.

Seed `claude-opus-5` conservatively from Aperture's field floor: **249,127 input accepted, zero
overflow, zero forced-compaction retries, no beta header sent** (`provider.ts:1261` sends
`anthropic-beta` only for `FAST_MODE_BETA`). That is an observation, not a published number, which is
why the clamp matters.

**S7. `last_event_ms_ago` on `/v1/busy`.** `queue.activity()` already reads the `runs` table; this is
one SQL expression. "How long has it been silent" beats turn age, because that is the question a
reconciler is actually asking. Aperture's treated 2 minutes of silence as a stall and carded a
healthy 12-hour run with a Resume that would have duplicated it; every consumer is guessing this
constant independently.

**S8. What survives a suspend, in `hosting.md`.** A machines-API wake timeout cold-booted a daemon
mid-engagement and lost in-memory state. Hosting agents that sleep is a documented contract or a
surprise.

### Tier 3 - gated, because shipping it now would be a third guess

**S9. Keep the schema resident when the A4 breaker latches.** Short-circuit the call to a synthetic
refusal instead of dropping the tool from `effectiveTools()` (`run.ts:397`). Identical protection,
one branch, prefix intact. Withdrawing a schema breaks the prefix for no benefit that refusing the
call does not also give.

**Ships labelled "not the fix for your bill" in the release brief.** The data that motivated it also
ruled it out as the dominant cause, and a consumer who scores it against their spend will conclude
the release did nothing.

**The mechanism fix is deliberately unwritten.** It waits for S1's first reading on a real lane.

## The prediction, written before the data

> **On miss turns, `spine_hash` moves.**

- **If it holds:** the fix is to move volatile counters out of the cached prefix. Small and obvious -
  a per-turn counter has no business at position zero of a cached block.
- **If it does not:** both prefix hashes stable across a miss means the shrink is inside history,
  which is append-only outside compaction, and compaction is already ruled out. That is a defect not
  currently nameable from source, and knowing it with certainty beats a third theory.

Committing to this in advance is what makes the first reading a test. Reading the numbers and then
explaining them makes it a survey, and a survey agrees with anything.

## What it is worth, priced by confidence

A single headline number would repeat the exact error this batch exists to correct.

| tier | return | confidence |
|---|---|---|
| Diagnostic | 3 rounds + a 12-hour forensic session + one retracted cost claim, collapsed to a two-column join on a lane already doing paid work | **certain** - not a forecast |
| Correctness | S5 removes a summary call and its latency from in front of most turns on a saturated lane; S3 makes a whole tier of spend priceable for the first time; S6 prevents a class of silent misconfiguration whose only symptom is a bill | high |
| Mechanism | **50-60% off affected lanes** if the prediction lands. 72% is the ceiling and nobody should promise it, because some misses are legitimately cold | **contingent, unproven** |

If the reading comes back and the spine is stable, the mechanism tier does not shrink - it moves. The
money is still there, the cause is elsewhere, and we know that in one turn instead of three rounds.

## Scoring - the part it is easiest to get wrong

- **Score S1 on whether it localises a miss on the first attempt**, not on any cost number. It is an
  instrument; it saves money only through what it enables.
- **Score S5 on compaction count and post-compaction `input_tokens`**, never on steady-state cache
  hit, which is 92-100% and will not move. This is the same trap 0.2.12 documented.
- **Never score S9 against spend.** See above.
- **The quality gate is reported before any cost number.** A run that gets cheap by delivering less
  is a regression, and 0.2.12 produced exactly that failure before its guard landed.

## Verification

Per the release gate: `bun test` + `scripts/smoke.sh` against a running server, codex on every slice,
then deploy from source to a real agent and finish the human-in-the-loop test before publishing.

S1 through S4 are telemetry and unit-testable, but S1 needs one live check that a byte-identical
re-send produces an identical `spine_hash` and that a single activation changes it - a hash that is
stable when it should move is worse than no hash. S5 and S6 need a live run that actually crosses the
threshold. S7 and S8 touch disjoint paths.

Aperture will send the join from their next ordinary engagement rather than a reproduction run, and
their canary offer stands between jobs. **Nothing in this batch is blocked on them.**

## Honesty ledger

- **The spine may be stable on miss turns.** The headline prediction fails, the instrument still pays
  for itself, and the mechanism tier does not land in this release.
- **Misses may be partly unavoidable.** Cold starts after suspend and genuine first turns push the
  recoverable band toward the bottom of 50-72% or below.
- **The window floor is an observation, not a published number.** Hence conservative seeding plus the
  clamp.
- **S9 is probably not the fix.** Shipping because it is correct, labelled so nobody scores it wrong.
- **Nothing here is built.** Scoped and committed; gated behind cutting 0.2.12 first.

## Not in this batch

Carried from `shipping-list.md` and unchanged: echo-rate reduction, spill retention, effort
inheritance for subagents, the opt-in MCP mount for children, cold-cache restructuring, and
`cacheRetention: "none"` on the summary call (codex established it is not the one-liner the 0.2.12
plan claimed - the serializers add breakpoints automatically, so it needs its own cache patch).

Also still open and promised: **the `#8` docs convention** - operator reference material is pointed
at, not resident - so the next consumer does not invent a fifth bundle file and ship a pointer to
nothing.
