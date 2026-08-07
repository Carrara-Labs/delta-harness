# 0.2.13 live results (local, real model)

2026-08-07. Branch `feat/0.2.13-say-what-changed` vs base `feat/0.2.12-bound-writes`, native
Anthropic wire, `claude-sonnet-5`, utility `claude-haiku-4-5-20251001`. Key borrowed from the
ai-recruiter app env with Nic's authorisation; nothing was written into this repo.

**Scope.** Three repetitions per arm of an identical workload. Synthetic, self-designed, at 40k on
sonnet — an order of magnitude below Aperture's 200k+ opus shape, and the workload was invented by
the same person judging the result, which  names as a failure mode in its own right.
The lane canary is still the real number.

## Quality gate, before any cost figure

| | turns requested | delivered | errors |
|---|---|---|---|
| Arm A (0.2.12) | 9 | **9** | 0 |
| Arm B (0.2.13) | 9 | **9** | 0 |

Both arms answered every turn correctly. A DB snapshot of arm A shows 8 because it was copied while
the daemon still held the last commit in the WAL — **a capture artifact, not lost work**. Do not
report this as a quality difference.

## The A/B: identical 9-turn growing conversation, ceiling 40,000, **n=3 per arm**

An earlier single run per arm is superseded by this. Ranges are [min–max] across three repetitions
of the identical workload.

| metric | arm A (0.2.12) | arm B (0.2.13) | verdict |
|---|---|---|---|
| **compaction events** | **5.00** [5–5] | **3.00** [3–3] | **separated, zero variance — established** |
| mean input tokens | 26,880 [26845–26921] | 24,682 [24676–24686] | **-8.2%, separated — established** |
| peak input tokens | 32,170 [32110–32286] | 32,093 [32075–32109] | flat |
| mean cache hit | 61.3% [51.7–71.0] | 68.3% [46.6–79.1] | **ranges overlap — NOT established** |
|  | 0, 0, 0 | 0, 0, 0 | no regression |
| turns delivered | 9, 9, 9 | 9, 9, 9 | no quality loss |

### What n=3 retired

A single run per arm had shown **cache 52% → 79%**, and that number does not survive repetition.
Across three runs the arms are 61.3% vs 68.3% with ranges that overlap almost completely
(46.6–79.1 against 51.7–71.0). **The cache-hit improvement is not established** — the first
observation was noise, and cache hit is a poor metric on short runs because it is sensitive to the
5-minute TTL against variable wall-clock timing.

That is the same error class as the retracted -29.9% in 0.2.12, caught this time by running the
repetitions before reporting rather than after.

### What survives

**Compaction count and input volume are effectively deterministic**, not statistical: both arms
returned identical counts on every repetition, with no overlap between arms. That is expected —
compaction firing is decided by token arithmetic on identical inputs — and it means 5 → 3 is a
property of the change rather than a sample.

**The cost figure is still not quoted.** Arm A's utility calls emit nothing (the bug S3 fixes), so
its cost sums main calls only while arm B's sums main plus its summary calls. The two numbers do not
measure the same set.

## S5 has a deliberate no-op zone, and a first run landed in it

An earlier arm at ceiling **12,000** showed no benefit, correctly. `retainedTailBudget` takes the
*smaller* of the ceiling-derived remainder and the flat 24k target, so below roughly a 33k ceiling
the derived value already wins and the change does nothing. That is the preserved safety property,
and it is why the A/B had to be run at 40k. **Consumers running tight ceilings will see nothing** —
that belongs in the release brief.

## S1 verified against a real wire

The check the spec demanded, run on the Anthropic path with `DELTA_CAPTURE_CALLS=1`:

- **`spine_bytes` = 3,861 and the captured system string = 3,861 bytes.** Exact. The spine digest is
  computed over the string the provider actually received.
- **`tools_n` = 15 = the captured tool count.**
- `tools_bytes` differs from the captured array by ~170 bytes, which is **read-time redaction** on
  `/v1/dev/runs/:id/calls`, not engine drift. The no-drift property is structural: `specs` is the
  same array object handed to `deps.chat`, and the digest is computed from it.
- Digest values cannot be recomputed externally by design — the salt is per-process and never
  exported. That is the privacy property working as intended, and it means external verification is
  by *byte equality and stability*, not by recomputation.

**On a two-turn thread:** turn 1 cold at 0%, turn 2 at 99%, with `spine_hash` and `tools_hash`
identical across both. Stable prefix, cache hit. The instrument reads correctly.

## A first look at the standing prediction

On the 40k A/B, across all 9 turns of arm B, **`spine_hash` and `tools_hash` never moved once** —
while cache hit dropped from 82% to 47% at the compaction turns.

That is the third row of the prediction table: **prefix intact, cache still lost**. On *this*
workload the drop is fully explained by compaction rewriting history, which is expected and is not
the Aperture mystery. It is not evidence against the prediction, because this workload has no
self-writes and no tool activations — the two things that make the spine move.

It does establish something useful: **the instrument can distinguish the two cases**, which is the
whole point of building it. Aperture's lanes have both self-writes and activations, so their reading
is the one that decides.

## One defect found, not in this batch

`MODEL_BASE_URL` must include `/v1` for the native Anthropic path (`provider.ts` appends
`/messages`). Setting it without produced a 404 whose body was empty, which the engine reported as
**`(empty error body)`** with no status code — an unhelpful diagnostic that cost a detour, and it
reproduces identically on the 0.2.12 base, so it is **pre-existing, not introduced here**. Worth a
backlog line: include the HTTP status when the body is empty.

## What this does not cover

- No sub-agent, research or `eval_n` path was exercised, so S3's other three purposes are
  unit-tested only.
- No suspend/resume, so S8's claims are documentation.
- No tool failures, so S4's breaker event never fired live.
- Sonnet, not Opus, and 40k rather than 200k+ — an order of magnitude below Aperture's shape.
