# 0.2.13 live results (local, real model)

2026-08-07. Branch `feat/0.2.13-say-what-changed` vs base `feat/0.2.12-bound-writes`, native
Anthropic wire, `claude-sonnet-5`, utility `claude-haiku-4-5-20251001`. Key borrowed from the
ai-recruiter app env with Nic's authorisation; nothing was written into this repo.

**Scope.** Three repetitions per arm of an identical workload. Synthetic, self-designed, at 40k on
sonnet - an order of magnitude below Aperture's 200k+ opus shape, and the workload was invented by
the same person judging the result, which  names as a failure mode in its own right.
The lane canary is still the real number.

## Quality gate, before any cost figure

| | turns requested | delivered | errors |
|---|---|---|---|
| Arm A (0.2.12) | 9 | **9** | 0 |
| Arm B (0.2.13) | 9 | **9** | 0 |

Both arms answered every turn correctly. A DB snapshot of arm A shows 8 because it was copied while
the daemon still held the last commit in the WAL - **a capture artifact, not lost work**. Do not
report this as a quality difference.

## The A/B: identical 9-turn growing conversation, ceiling 40,000, **n=3 per arm**

An earlier single run per arm is superseded by this. Ranges are [min–max] across three repetitions
of the identical workload.

| metric | arm A (0.2.12) | arm B (0.2.13) | verdict |
|---|---|---|---|
| **compaction events** | **5.00** [5–5] | **3.00** [3–3] | **separated, zero variance - established** |
| mean input tokens | 26,880 [26845–26921] | 24,682 [24676–24686] | **-8.2%, separated - established** |
| peak input tokens | 32,170 [32110–32286] | 32,093 [32075–32109] | flat |
| mean cache hit | 61.3% [51.7–71.0] | 68.3% [46.6–79.1] | **ranges overlap - NOT established** |
|  | 0, 0, 0 | 0, 0, 0 | no regression |
| turns delivered | 9, 9, 9 | 9, 9, 9 | no quality loss |

### What n=3 retired

A single run per arm had shown **cache 52% → 79%**, and that number does not survive repetition.
Across three runs the arms are 61.3% vs 68.3% with ranges that overlap almost completely
(46.6–79.1 against 51.7–71.0). **The cache-hit improvement is not established** - the first
observation was noise, and cache hit is a poor metric on short runs because it is sensitive to the
5-minute TTL against variable wall-clock timing.

That is the same error class as the retracted -29.9% in 0.2.12, caught this time by running the
repetitions before reporting rather than after.

### What survives

**Compaction count and input volume are effectively deterministic**, not statistical: both arms
returned identical counts on every repetition, with no overlap between arms. That is expected -
compaction firing is decided by token arithmetic on identical inputs - and it means 5 → 3 is a
property of the change rather than a sample.

**The cost figure is still not quoted.** Arm A's utility calls emit nothing (the bug S3 fixes), so
its cost sums main calls only while arm B's sums main plus its summary calls. The two numbers do not
measure the same set.

## S5 has a deliberate no-op zone, and a first run landed in it

An earlier arm at ceiling **12,000** showed no benefit, correctly. `retainedTailBudget` takes the
*smaller* of the ceiling-derived remainder and the flat 24k target, so below roughly a 33k ceiling
the derived value already wins and the change does nothing. That is the preserved safety property,
and it is why the A/B had to be run at 40k. **Consumers running tight ceilings will see nothing** -
that belongs in the release brief.

## S1 verified against a real wire

The check the spec demanded, run on the Anthropic path with `DELTA_CAPTURE_CALLS=1`:

- **`spine_bytes` = 3,861 and the captured system string = 3,861 bytes.** Exact. The spine digest is
  computed over the string the provider actually received.
- **`tools_n` = 15 = the captured tool count.**
- `tools_bytes` differs from the captured array by ~170 bytes, which is **read-time redaction** on
  `/v1/dev/runs/:id/calls`, not engine drift. The no-drift property is structural: `specs` is the
  same array object handed to `deps.chat`, and the digest is computed from it.
- Digest values cannot be recomputed externally by design - the salt is per-process and never
  exported. That is the privacy property working as intended, and it means external verification is
  by *byte equality and stability*, not by recomputation.

**On a two-turn thread:** turn 1 cold at 0%, turn 2 at 99%, with `spine_hash` and `tools_hash`
identical across both. Stable prefix, cache hit. The instrument reads correctly.

## A first look at the standing prediction

On the 40k A/B, across all 9 turns of arm B, **`spine_hash` and `tools_hash` never moved once** -
while cache hit dropped from 82% to 47% at the compaction turns.

That is the third row of the prediction table: **prefix intact, cache still lost**. On *this*
workload the drop is fully explained by compaction rewriting history, which is expected and is not
the Aperture mystery. It is not evidence against the prediction, because this workload has no
self-writes and no tool activations - the two things that make the spine move.

It does establish something useful: **the instrument can distinguish the two cases**, which is the
whole point of building it. Aperture's lanes have both self-writes and activations, so their reading
is the one that decides.

## One defect found, not in this batch

`MODEL_BASE_URL` must include `/v1` for the native Anthropic path (`provider.ts` appends
`/messages`). Setting it without produced a 404 whose body was empty, which the engine reported as
**`(empty error body)`** with no status code - an unhelpful diagnostic that cost a detour, and it
reproduces identically on the 0.2.12 base, so it is **pre-existing, not introduced here**. Worth a
backlog line: include the HTTP status when the body is empty.

## What this does not cover

- No sub-agent, research or `eval_n` path was exercised, so S3's other three purposes are
  unit-tested only.
- No suspend/resume, so S8's claims are documentation.
- No tool failures, so S4's breaker event never fired live.
- Sonnet, not Opus, and 40k rather than 200k+ - an order of magnitude below Aperture's shape.


---

# Aperture canary round 2 (2026-08-08): S5 answered

Their run, not ours. Speed Lab, ceiling 60,000, arm A on **0.2.12** (verified a direct ancestor of
the 0.2.13 branch, so the delta is exactly this batch), identical question both arms.

| metric | 0.2.12 | 0.2.13 |
|---|---|---|
| compaction | 8 rewrites | 4 attempts, 4 shrank |
| **`context_irreducible`** | **5** | **0** |
| max input | **70,969 - over its own 60k ceiling** | 56,521, under |
| cost | $3.31 | $2.19 |

**The headline is not the compaction count, it is the five errors.** 0.2.12 compacted eight times,
still failed to get under budget five times, and overran its own ceiling by 18%. 0.2.13 never did.
That reframes S5 from a cost optimisation to a **correctness fix**: deriving the retained tail from
the trigger did not merely waste money, it left compaction unable to do its job.

**Delivery: no regression.** Zero repeated provider calls on both arms - the direct "did it forget
what it just did" test, and the question that actually gated this release. Zero unidentified people
either side. They explicitly **discounted** a favourable 6-vs-14 rows difference because the arms ran
sequentially on one workspace and Fiber observations persist, so arm B started warm. Rows delivered
is not a valid A/B metric under that design, and they retired their own good number rather than
report it.

## The 45-token floor is explained, and we are deliberately not fixing it

`messages` is not append-only: the ephemeral blocks sit **last** and are rebuilt every turn, so the
reusable prefix can never extend past where the previous turn's ephemerals began. Their floor traced
to a 123-byte `# Context` block carrying a `now:` UTC clock.

Same root object as the 0.2.11 bug - that fix moved the cache marks off the ephemerals, not the
ephemerals themselves. A `# Context` without `now:` would be byte-stable and the floor would go to
zero.

**Not worth doing.** 45 tokens a turn is 0.05% of their run, against an agent that can no longer tell
the time. The floor is structural and correct.

**But it makes `ephemeral_bytes` actionable**, which is the useful half: every byte of ephemeral is
re-read on every single turn. On a lane mounting retrieval or plan blocks the floor is proportionally
larger, and that is now measurable rather than folkloric.

## Still open: the 7,172

`calls.request` carries **zero `cache_control` markers** - breakpoint placement happens in provider
serialization, exactly as caveat 2 of the spec warned. So the capture cannot settle it and the
diagnosis needs a capture one layer lower. Tools-block arithmetic fits at 3.36 bytes/token, but 466
and 4,993 do not.

**This is the second time the engine-input-vs-wire gap has blocked a diagnosis.** Filed as the
argument for capturing the serialized body, which the spec rejected as too invasive. That call now
has a cost attached to it.

## Production risk found: the upgrade is one-way

0.2.12 adds two migrations. A lane rolled back to 0.2.11 **crash-loops to its restart cap**, and the
obvious recovery - destroying the volume - also destroys the agent's learned `DELTA.md`, which is a
workspace file and not in the database.

The refusal itself is correct and stays. What was missing was what the operator does next, so:

- the boot error now names the workspace files as salvageable and says to copy them off **before**
  recreating the volume;
- `hosting.md` gains "Upgrades are one-way. Snapshot before you roll", with the backup command.

This must be in the 0.2.12 release notes, not the 0.2.13 ones - the migrations are 0.2.12's.

---

# Post-release: Ferni on 0.2.13 (2026-08-09)

Published to npm, merged to `main`, tagged `v0.2.13`. Ferni upgraded from 0.2.11, which is the
one-way schema step. Snapshot taken and verified first: 143 entries, 5.6MB, `DELTA.md` present.

**The snapshot caught a second bug in my own procedure.** Ferni sets `DELTA_WORKSPACE=/data/bundle`,
not the `/data/workspace` image default, so the documented command would have written an empty tar
here. The same silent-success failure Aperture caught one layer up. The procedure now takes the whole
volume, prints `DELTA_WORKSPACE` first, and greps the archive for `DELTA.md` rather than only
checking it is non-empty.

**First four turns after the upgrade:**

| turn | cache_hit_pct | cache_shortfall_tokens | spine_hash | tools_n | ephemeral_bytes |
|---|---|---|---|---|---|
| 1 | 0% | (first call) | 72553e20341c | 18 | 751 |
| 2 | 70% | 257 | 72553e20341c | 18 | 751 |
| 3 | 59% | 258 | 72553e20341c | 18 | 751 |
| 4 | 91% | 258 | 72553e20341c | 18 | 751 |

**`cache_hit_pct` swings 32 points while the prefix never moves and the shortfall holds flat at
~258.** That is the entire argument of this release, reproduced in production on the first run
without anyone looking for it. Turn 3 reading 59% is a perfectly cached turn; under the old metric
it would have been logged as a problem worth investigating.

The floor tracks `ephemeral_bytes` (751 bytes) as predicted, and a `tier: utility` /
`purpose: reflection` call appeared on the same run, so S3 is live too.

**One observation from the agent worth following up:** Ferni reported `list_schedules` returning a
409 on first call, and that its own `skills/delta-self-check/facts.md` is pinned four releases stale
at 0.2.9. Neither is caused by this release; both are filed. Both are answered below.

---

# Ferni config pass + an 11-turn reading (2026-08-10)

Ferni was already on 0.2.13; nothing to upgrade. What it needed was to be configured *for* the
version, and to be given enough real work to say something.

## Three config changes

| knob | was | now | why |
|---|---|---|---|
| `DELTA_REASONING_EFFORT` | **unset** | `medium` | unset sends no effort at all, so the lane silently took the provider default and no telemetry row could say which effort served a turn. `medium` is the fleet standard from the 0.2.6 rollout. |
| `DELTA_CAPTURE_CALLS` | `1` | **off** | it was staged as TEMPORARY for the 2026-08-03 cache investigation, which 0.2.13 concluded. |
| `DELTA_CACHE_TTL` | `1h` (probe) | `1h` (permanent) | re-justified rather than removed: Ferni is human-paced, so consecutive messages are routinely hours apart and the 5-minute default would be cold on nearly every first turn. |

**The capture flag had a cost nobody had looked at.** 174 rows holding **16.5 MB** of full
request + response, at ~95 KB a call, on a **1 GB** volume. `retention.ts` sweeps `journal` and
`events`; **`calls` is swept by nothing** and is only cleared when a session is deleted. Pruned to
the newest 20 rows (16.5 MB to 2.46 MB), keeping the post-upgrade turns as byte-level reference.

Scaled to Aperture's shape, 2,629 model calls at that rate is roughly **250 MB on a 1 GB volume**
from a diagnostic flag. Engine-side retention for `calls` moves from a backlog line to a real one.

## The 11-turn reading, at `medium`, all tools already active

| turn | in | cacheRead | `cache_hit_pct` | `cache_shortfall_tokens` | `spine_hash` | `history_bytes` |
|---:|---:|---:|---:|---:|---|---:|
| 1 | 7,338 | 0 | 0% | (first call) | ef4197c9eb0f | 2,015 |
| 2 | 11,961 | 7,081 | 59% | 257 | ef4197c9eb0f | 13,648 |
| 3 | 14,405 | 11,703 | **81%** | 258 | ef4197c9eb0f | 18,570 |
| 4 | 21,779 | 14,147 | **65%** | 258 | ef4197c9eb0f | 39,186 |
| 5 | 29,628 | 21,521 | 73% | 258 | ef4197c9eb0f | 60,129 |
| 6 | 30,565 | 29,370 | 96% | 258 | ef4197c9eb0f | 61,954 |
| 7 | 35,629 | 30,307 | 85% | 258 | ef4197c9eb0f | 74,776 |
| 8 | 40,554 | 35,371 | 87% | 258 | ef4197c9eb0f | 87,799 |
| 9 | 46,773 | 40,296 | 86% | 258 | ef4197c9eb0f | 104,303 |
| 10 | 49,055 | 46,515 | 95% | 258 | ef4197c9eb0f | 110,535 |
| 11 | 50,051 | 48,797 | 97% | 258 | ef4197c9eb0f | 113,433 |

`cache_hit_pct` spans **59 to 97** while `cache_shortfall_tokens` never leaves 257-258 and the
prefix never moves. Turn 4 is the sharpest illustration: the ratio *falls* 16 points from turn 3 on
a flawlessly cached turn, purely because history grew underneath the denominator. Eleven turns, one
lane, no reproduction run needed.

`gen_ai.request.effort = medium` now appears on every row, so an effort arm is self-labelling for
the first time on this lane.

## S1 localised a real prefix change to the byte

`remember` fired on turn 10. Turn 11's spine did not move. A second run in the **same daemon
process** (so the per-process salt is constant and the digests are comparable):

| | run 1 | run 2 | |
|---|---|---|---|
| `spine_hash` | ef4197c9eb0f | **eaf72c2e2648** | moved |
| `spine_bytes` | 9,146 | **9,805** | +659 |
| `self_bytes` | 1,866 | **2,525** | +659 |
| `tools_hash` | b050dcb096a8 | b050dcb096a8 | unchanged |

The whole spine delta is the self-file delta, to the byte, and the tools digest correctly stayed
put. **This is the first production evidence that the instrument does what it was built for:** it
named the segment, quantified it, and exonerated the other one.

## A claim in the plan is falsified, and the suspect narrows rather than dies

The plan lists the spine as the standing suspect on two grounds: the `searchable` counter, and the
agent-writable self-file. The second does not survive.

`buildSpine` is called inside the turn loop (`run.ts:797`), but `self` is read **once per run**,
before it. So a mid-run `remember` cannot change the system prompt of the run it happens in. The
measurement says so (turn 10 wrote, turn 11 did not move) and the agent said so independently,
quoting its own tool description: *"Takes effect on your NEXT run."*

**What that leaves.** `searchable: allowedMap.size - active.size` *is* recomputed every turn, so
tool activation remains a live, near-zero-byte, cache-fatal spine mutation. Ferni cannot test it:
all 18 of its tools are pinned, so `searchable` is 0 and never changes. The remaining hypothesis
now fits Aperture's shape more tightly than before, not less: long runs, a large MCP surface, and
tools activating as the work proceeds.

**Correction to `reply-aperture-context-ceiling-3.md`, which told them the self-file was one of two
reasons the spine was suspect.** Within a run it is not. Send it.

## Operational caveat the consumer docs must carry

The digest salt is per **process**. Ferni's spine was byte-identical yesterday and today
(`spine_bytes` 9,146 both) and hashed to two different values, because the machine restarted in
between. **A hash comparison spanning a daemon restart is a false positive.** Compare `*_bytes`
across restarts and `*_hash` only within one process lifetime.

## The `list_schedules` 409, explained and fixed

Reproduced verbatim, `duration_ms: 10`, so it never left the machine. It is
`connect/src/control.ts:154`: the control server 409s `"no active agent turn"` when it cannot
resolve which conversation a schedule belongs to. Both of these runs were POSTed straight at the
daemon seam rather than arriving as Telegram messages, so there was no origin to resolve. **The
guard is correct** and a Telegram-originated call should not hit it.

The defect is what the agent was told. `builtins.ts` carried the control server's reason on
`schedule_self` and **dropped it on both read paths**, so the agent saw a bare `409`, concluded its
schedules were unauditable, and filed a blocker. Fixed: `list_schedules` and `cancel_schedule` now
carry the reason, with a mutation-verified test.

## What the agent found that we had not asked about

Worth recording because it is the dogfood loop paying for itself:

- **deltaharness.dev/changelog is two releases behind npm**, still heading at v0.2.11, while the
  page claims it "tracks the source CHANGELOG.md exactly". Ferni's own procedure named that page as
  the cheapest version recheck, so following its documented method would have had it report 0.2.11
  as current. It rewrote its ladder to read raw `CHANGELOG.md` first.
- **`research`'s tool description is still wrong**, four releases after 0.2.4 made children
  read-only: it promises children "the SAME tools you have (read, write...)" and that each writes
  full findings to a file.
- Its tool count is **18 of 19**, not 17 of 18: `list_secrets` arrived with the 0.2.10 vault. Only
  `code` is still absent, correctly, because no `codex` CLI exists on that machine.
- Nothing sweeps `.delta/spill/` either, which it raised unprompted after hearing about `calls`.
