# Field report: 0.2.13 canary on Aperture

From Aperture, 2026-08-08. Answering `ask-aperture-0.2.13-canary.md`.

**Build:** `feat/0.2.13-say-what-changed` @ `d705692`, built to
`registry.fly.io/aperture-qs-3498560efa0d:0213-canary-d705692`.
**Lane:** Speed Lab quick-search (`aperture-qs-3498560efa0d`), opus-5, ceiling 200k.
**Workload:** two ordinary Quick Search engagements, roster path, the same code the UI drives.
42 main turns, 3.71M input tokens, $5.34. Zero errors, zero retries, zero fallbacks.

Only the image changed. Env, secrets and volume were left identical so the reading is attributable.

---

## 1. The prediction fails. Row 3.

**Across all 42 turns, in both runs, `spine_hash` and `tools_hash` never moved once.**
`tools_n` held at 28. `self_bytes` held constant within each run. And `cache_hit_pct` over the
same turns ranged **65% to 100%**.

The prefix was byte-identical and the cache still "broke". That is your third bucket, the one you
said you would most want to know early.

Before concluding "history or the wire", we eliminated what we could:

| candidate | verdict |
|---|---|
| prefix mutation | **eliminated** - `spine_hash` identical on every turn |
| tool activation / breaker withdrawal | **eliminated** - `tools_hash` identical, `tools_n` = 28 throughout, zero `tool.breaker` events |
| ephemeral drift | **eliminated** - `ephemeral_bytes` a flat 108 on every turn of both runs |
| 5-minute TTL expiry | **eliminated** - largest inter-turn gap was 45s |
| compaction | **eliminated** - zero compaction events; the lane never approached its ceiling |

## 2. The more useful finding: the metric is mostly an artifact

The instrument answers a question you did not ask, and it is the more valuable answer.

If the prefix cache were healthy, `cached_tokens` on turn N should equal `input_tokens` on turn
N-1 - everything sent last turn is now a cacheable prefix. We computed that shortfall per turn:

```
run 1, turn 8:  input 87,975  cached 63,334  prevInput 63,379  shortfall 45   pct 72%
run 1, turn 9:  input 108,253 cached 87,930  prevInput 87,975  shortfall 45   pct 81%
run 2, turn 16: input 125,199 cached 106,420 prevInput 106,465 shortfall 45   pct 85%
```

**The shortfall is a constant 45 tokens on 37 of 40 comparable turns.** The cache is serving
literally everything it could serve. `cache_hit_pct` swings 35 points because its *denominator*
grows when history is appended, not because anything was lost. A turn that appends 62k of tool
output reads as a "72% cache hit" while caching perfectly.

That reframes our own context-ceiling report to you. A meaningful part of the "cache decay" we
reported was us reading a ratio whose denominator moves. **`cache_hit_pct` is not a health metric.**
The shortfall against previous-turn input is; consider emitting it directly, since you already have
both numbers at the call site.

The constant 45 is itself unexplained and probably worth a glance - it is stable enough to be
structural (a breakpoint sitting just short of the tail) rather than noise.

## 3. The residual - three real misses in 42 turns

| run | turn | tokens lost | preceding history growth |
|---|---|---|---|
| 1 | 3 | **7,172** | 13,408 B |
| 2 | 7 | 466 | 14,686 B |
| 2 | 17 | **4,993** | 48,803 B |

12,631 tokens across 3.71M input. Real, but nothing like the effect we implied. Each occurred with
the spine provably intact and every candidate above eliminated, so this is genuinely your row 3:
inside history or on the wire. It does not correlate cleanly with growth size, which argues against
a simple breakpoint-placement story.

## 4. Your prediction was untestable as scoped, and your source already knew

Worth correcting for the next batch. The ask says the two spine movers are tool activation and the
agent rewriting its self-file. But `run.ts:988` states `self` is a per-run snapshot - a mid-run
`remember` lands next run, so it is "constant for every turn of a run by construction", and credits
codex for catching that the spec claimed within-run resolution it does not have.

So within one `task_id` the spine's only live input is the tool index, and that moves `tools_hash`
and `tools_n` *together*. **Row 2 of your table is unreachable within a task**, except for a
same-turn withdraw-plus-activate. The code comment is right; the ask doc did not get the update.

We therefore also ran the query *across* runs - and there, row 2 appears exactly as predicted:

```
task ef0cdc80 | self_bytes 6251 | tools_n 28
task 8a92adc3 | self_bytes 3682 | tools_n 28 | spineMoved=TRUE
```

The self-file moved (the agent hit its 6,400-byte cap, got the `self.ts:119` "compact your notes"
error, and rewrote itself smaller), the spine moved with it, and `tools_n` did not. **But this only
ever happens at a run boundary, where the cache is cold anyway** - run 2 turn 1 was a 0% hit
regardless. So the self-file axis is real and now visible, and it still cannot explain a
mid-conversation miss.

## 5. Did anything get slower? No.

Speed Lab QS main turns, same lane:

| arm | turns | wall p50 | wall p90 |
|---|---|---|---|
| 0.2.11 baseline | 2,949 | 19,771ms | 51,460ms |
| 0.2.13 canary | 42 | 16,204ms | 39,620ms |

S1's per-turn hashing does not show up. We are **not** claiming it is faster - n=42 against a
different workload mix - only that there is no detectable regression.

## 6. What we could NOT test for you: S5

**No compaction fired, so the headline change is unexercised.** This is a lane-selection problem
worth knowing about:

| lane | compaction events | tasks | max input |
|---|---|---|---|
| carrara QS | 169 | 30 | 282,684 |
| alpha-school QS | 62 | 13 | 249,622 |
| **speed-lab QS** | **5** | **1** | 233,388 |
| google-deepmind QS | **0** | 0 | 212,447 |

Your "161 compactions" came from **carrara** - a production client lane. The lab lanes you named
are where a canary is *safe*, not where the ceiling behaviour *lives*. To evidence S5 we would need
to canary a client lane or synthesise a ceiling-pressure workload. Say which you would prefer.

Also note carrara's 282,684 max input exceeds the opus-5 window of 249,000 outright.

## 7. Confirmed in passing

- **S3 works.** One utility-tier call surfaced that 0.2.11 emitted nothing for. On this workload
  utility volume was trivial (1 call, $0.02) - nothing like your 4-events-to-6-calls case, because
  that ratio is a property of compaction, which never fired here.
- **S6 left us alone, as you predicted.** Our explicit `DELTA_COMPACT_AT_TOKENS=200000` sits under
  the 209,000 clamp; no clamp warning at boot.
- **S2** emitted no rows to check the `shrank` semantics against.
- **S4** emitted no `tool.breaker` events.
- Quality held. Both engagements produced real, sourced, caveated shortlists.

## 8. Two practical notes back

- **`src/version.ts` still reads `0.2.12` on the branch.** `/healthz` cannot distinguish the canary
  from released 0.2.12. We only identified ours via `--build-arg DELTA_BUILD`. Worth bumping before
  anyone else canaries this.
- The `MODEL_BASE_URL` `/v1` trap did not bite us - this lane runs openrouter-primary.

**The lane is still on the canary image** so we can keep gathering. Rollback is one command:
`fly machine update 8747430b6d7118 --image ghcr.io/carrara-labs/delta-harness:0.2.11 -a aperture-qs-3498560efa0d --yes`

---

## 9. Where the data is

**Every number above is reproducible from one file - you do not need access to our database.**

### The raw per-turn export

`docs/data/aperture-0.2.13-canary-turns.csv` - 42 rows, one per main turn, both runs.
Columns: `task_id, turn, event_time_ms, cache_hit_pct, spine_hash, spine_bytes, tools_hash,
tools_n, self_bytes, history_bytes, ephemeral_bytes, wall_ms, latency_ms, input_tokens,
cached_tokens, output_tokens, cost_usd, model, provider`.

The digests are in there verbatim, so **you can verify the central claim yourself**: sort by
`task_id, event_time_ms` and confirm `spine_hash` and `tools_hash` never change within a task.

Collapsing the export to its distinct tuples gives exactly **one row per task** - 19 and 23 turns
each reduce to a single unchanging prefix identity:

```
$ awk -F, 'NR>1 {print $1", spine="$5", tools="$7", tools_n="$8", self="$9}' \
    docs/data/aperture-0.2.13-canary-turns.csv | sort -u

ef0cdc80…, spine=8b5264f3114d, tools=badfd8b78c89, tools_n=28, self=6251   (19 turns)
8a92adc3…, spine=c90b9d50d840, tools=badfd8b78c89, tools_n=28, self=3682   (23 turns)
```

Note `tools_hash` is identical **across** both runs while `spine_hash` differs - that is the
self-file rewrite in §4, isolated exactly as your disambiguators intend. The instrument works.

### Identifiers, if you want to go deeper

| | |
|---|---|
| task 1 | `ef0cdc80-6f5c-467d-8e5c-a9daf4171cf1` (19 main turns) |
| task 2 | `8a92adc3-f1a4-4c1a-a906-3c52d1b429a3` (23 main turns) |
| workspace_slug | `speed-lab`, agent_type `quick-search` |
| lane | Fly app `aperture-qs-3498560efa0d`, machine `8747430b6d7118`, volume `vol_vgn1n1g8zww1epj4` |
| image | `registry.fly.io/aperture-qs-3498560efa0d:0213-canary-d705692` |
| commit | `d7056921b9e68c550dc34ffbe9700d976851c081` (`DELTA_BUILD` on `/healthz`) |
| ran at | 2026-08-08 10:53–11:30 UTC |

### The three real misses, for a targeted look

| task | turn | tokens lost |
|---|---|---|
| `ef0cdc80` | 3 | 7,172 |
| `8a92adc3` | 7 | 466 |
| `8a92adc3` | 17 | 4,993 |

**CORRECTION (2026-08-08, after the first version of this report).** We said these turns' raw
request bodies were captured on the lane. **They were not, and they do not exist.** We conflated
two flags:

- `DELTA_CAPTURE_PAYLOADS=1` - what this lane sets. Only adds `data` to payload-class telemetry
  events (`exporter.ts:173`). Not the assembled request.
- `DELTA_CAPTURE_CALLS=1` - the one that snapshots the exact assembled request and response into
  the `calls` table (`db.ts:247`, `run.ts:208`). Explicitly DEV-ONLY, "prod never pays the
  storage". **This lane has never set it.**

So `calls` is empty for all three turns. Two further things we checked before saying so: `calls`
is not in `PEEK_TABLES`, so it is not readable over `/v1/dev/*` even in principle, and this lane
sets no `DELTA_INSPECT_TOKEN`, so that whole surface 404s anyway.

**The bodies are therefore only obtainable by reproduction.** Plan in §10.

### Re-running the analysis

The reader lives in the Aperture repo at `app/scripts/canary-turns.ts`:

```
bun scripts/canary-turns.ts speed-lab --csv out.csv
```

It computes `prevInput - cached` per turn, flags spine/tools movement, and prints the cross-run
block. It is deliberately generic - point it at any workspace slug on a 0.2.13+ build.

### Our own telemetry, for reference

`agent_events` (Neon, Aperture), `event_name = 'model.call'`, filtered
`attributes ? 'spine_hash'` and `attributes->>'tier' = 'main'`. One trap worth passing on: that
table is RLS-guarded, and a pooled read **returns zero rows with exit 0** rather than erroring.
A "no data" result there means check your connection before you conclude the instrument is silent.

---

## 10. Follow-up plan (agreed 2026-08-08)

Two experiments, deliberately NOT combined. Compaction rewrites history, so a lane configured to
compact cannot also serve as clean evidence about a miss on an unchanged prefix.

### Experiment 1 - S5, the release blocker

Synthetic ceiling pressure on a lab lane, per your instruction not to canary a paying client.
`DELTA_COMPACT_AT_TOKENS=60000` (above the ~33k no-op floor), identical Quick Search workload run
on both arms:

| arm | image | ceiling |
|---|---|---|
| A | `ghcr.io/carrara-labs/delta-harness:0.2.11` | 60,000 |
| B | `0213-canary-d705692` | 60,000 |

Our ordinary QS engagements reach 115k-160k input, so a 60k ceiling forces repeated compaction
without contriving the workload. Scoring, per your own guidance: **compaction attempts (and
`shrank=true` separately), post-compaction `input_tokens`, `context_irreducible`, turns
delivered.** Not steady-state cache hit. We will also report `cache_shortfall_tokens` once we are
on a build that emits it.

The agent is not deterministic, so we will run each arm more than once if the first pair is close.
If it is not close, we will say so and not manufacture precision we do not have.

### Experiment 2 - the three misses

Requires `DELTA_CAPTURE_CALLS=1` and the ORIGINAL conditions (ceiling 200,000, no compaction), then
ordinary work until a miss reproduces. Misses ran ~3 in 40 turns, so this is a couple of runs, not
a guaranteed single shot.

What we will send when one lands: the assembled request for the miss turn and its predecessor, so
you can diff the two byte strings directly. That is the artifact that separates "inside history"
from "on the wire".

Two caveats we would rather state now than discover later. `calls` stores the full assembled
request per turn, so at a 200k ceiling this is real volume against a 1GB lane volume - we will
watch it and pull promptly. And it is dev-only for a reason; we will turn it back off afterwards.

---

## 11. Experiment 1 result: S5 works, and the failure it removes is not subtle

Speed Lab, `DELTA_COMPACT_AT_TOKENS=60000`, identical question both arms, fresh room each time.
Arm A is **0.2.12** (`6b3a05d`) per your correction, not 0.2.11, so the delta is exactly the
13-commit 0.2.13 batch - we verified `feat/0.2.12-bound-writes` is a direct ancestor of the
0.2.13 branch before building.

| metric | arm A (0.2.12) | arm B (0.2.13) |
|---|---|---|
| main turns | 23 | 21 |
| compaction | **8** (rewrites) | **4** attempts, **4 shrank** |
| **`context_irreducible`** | **5** | **0** |
| errors | 5 | 0 |
| max input | **70,969** (over the 60k ceiling) | **56,521** (under it) |
| avg input | 53,170 | 46,930 |
| wall p50 | 12,370ms | 12,043ms |
| cost | $3.31 | $2.19 |
| utility calls (S3) | 0 emitted | 7, $0.124 |

**The headline is not the compaction count, it is the five `context_irreducible` errors.** Every
one of them is the same event: "assembled request still exceeds the context budget after
compaction". On 0.2.12 the lane compacted eight times, still could not get under budget five
times, and overran its own ceiling by 18%. On 0.2.13 it compacted four times, every one of them
actually shrank, it never exceeded the ceiling, and there were no errors at all.

That is S5 doing exactly what it was designed to do, at a scale your 40k local test could not show.

### Delivery quality: no regression, and one number you should discount

| | arm A | arm B |
|---|---|---|
| artifact | 6,800 chars | 10,313 chars |
| rows carrying a LinkedIn URL | 6 | **14** |
| named people missing an identifier | 0 | 0 |
| repeated provider calls | 0 | 0 |
| closing message in the room | **none** | **none** |

**Do not read 6 to 14 as a quality win.** Two confounds, both ours:

1. The arms ran sequentially on the same workspace, and Fiber observations persist. Arm B's
   named people (Basu, Mou, Chursin, Shuvalov, Ingram) are the same people earlier runs on this
   lane had already researched, so arm B started warm. Rows delivered is not a valid A/B metric
   under that design. The mechanism metrics above are unaffected - they are about context
   assembly, not workspace state.
2. Arm B reached them through `kitchen-sink/bulk/profile` rather than per-person calls. Our first
   pass scored that as "0 people researched" because the metric matched only `/person`, which
   read as a grounding regression and was purely our regex. Corrected.

What IS clean: **zero repeated provider calls on both arms.** That was the direct "did the agent
forget what it just did" test for a shorter verbatim tail, and it came back negative. Combined
with zero unidentified people and no errors, we see **no delivery regression from S5** on this
workload.

**The one delivery defect is ours, not yours.** Both arms finished with an empty
`outputs.message`, so the room rendered "Finished without a report". It reproduces identically on
0.2.12 and 0.2.13 and did not occur on the no-compaction canary runs, so it is an Aperture bug
correlated with compaction, not an S5 regression. Filed on our side.

## 12. The remaining lead just got much sharper

`cache_shortfall_tokens` paid for itself immediately.

**The same miss, to the token, in two independent runs:**

| run | ceiling | image | turn | shortfall |
|---|---|---|---|---|
| `ef0cdc80` | 200,000 | 0.2.13 canary | **3** | **7,172** |
| `3a81c9d6` | 60,000 | 0.2.13 arm B | **3** | **7,172** |

Different ceiling, different image build, different conversation, same turn, identical magnitude.
That is not noise and it is not history-dependent - history differed completely between those two
runs.

**Hypothesis: it is the tool-schema block being re-read, not a prefix mutation.** `tools_bytes` is
**24,116 in every run we have measured**, and 24,116 / 7,172 = **3.36 bytes per token**, which is
what dense JSON tool schemas tokenize at. A constant-size block, a constant miss, and a
`tools_hash` that provably never moved - so the block did not CHANGE, it simply stopped being
served from cache on that turn.

If that holds, this is a cache-breakpoint placement question, not a mutation question, and it is
the same class of defect as the 0.2.11 ephemeral-block fix rather than anything new.

Two caveats we will not paper over. The other two misses we saw were 466 and 4,993 tokens, which
do not match this size, so either more than one block can drop or there is more than one
mechanism. And run 2 (`8a92adc3`) had no turn-3 miss at all, so whatever triggers it is not
simply "turn 3".

**The decisive test is still Experiment 2** - the captured request bodies for the miss turn and
its predecessor. If the tools block is present in both and the miss is 7,172, this is settled.

---

## 13. Experiment 2: the captured bodies, and what the 45 actually is

Reproduced the miss on the third try: 25 turns, exactly one miss, **turn 3, 7,172 tokens** - the
same magnitude for the third time, now at a 60k ceiling on a completely different conversation.
`cache_shortfall_tokens` made this a single indexed query instead of a long watch, so the
reproduction cost one run rather than the several we budgeted.

Captured with `DELTA_CAPTURE_CALLS=1`, pulled the lane's `delta.db`, and diffed turn 2 against
turn 3 locally. We are sending segment sizes, hashes and structure only, not transcript content.

### What the bodies prove

| segment | turn 2 | turn 3 | verdict |
|---|---|---|---|
| system spine | 26,908 B, `7c3758cef7c8` | 26,908 B, `7c3758cef7c8` | **byte-identical** |
| tool schemas | 24,116 B, 28 tools, `8a5b88404ae7` | 24,116 B, 28 tools, `8a5b88404ae7` | **byte-identical** |
| `cache_key` | `sess_0bfd5cf7…` | same | constant across all 26 turns |
| messages | 61,328 B, 7 msgs | 66,422 B, 11 msgs | grew |

So every segment the engine controls is provably stable, confirming the digests independently
from the wire side.

### The finding: `messages` is NOT append-only, and that is the constant 45

The last element of `messages` is the ephemeral context block, and it is **123 bytes carrying a
`now:` UTC timestamp**:

```
{"role":"user","content":"# Context\nCurrent model: claude-opus-5 · now: 2026-08-09T06:54:51.982Z (UTC)","ephemeral":true}
```

It sits at the END of the array on every single turn:

```
turn 1:  3 messages, ephemeral at index  2 (last), 123 B
turn 2:  7 messages, ephemeral at index  6 (last), 123 B
turn 3: 11 messages, ephemeral at index 10 (last), 123 B
turn 4: 14 messages, ephemeral at index 13 (last), 123 B
```

Every turn therefore ends with 123 bytes that are unique to that turn. The reusable prefix can
never extend past where the *previous* turn's ephemeral sat, so a fixed slice is re-read every
single turn, forever.

**That is the constant 45-token shortfall.** Your guess in §2 - "structural, a breakpoint sitting
just short of the tail" - was right, and this is the object.

**Why this matters more than 45 tokens.** This is the same root object as the 0.2.11 ephemeral
bug. That fix moved the rolling cache *marks* off the ephemeral blocks; it did not move the
ephemeral block itself, which is still the last element of `messages` and still carries a clock.
The expensive half of the bug is gone. A cheap, permanent, per-turn floor remains, and it is only
cheap because the block is small. Anything that grows that block re-opens the original bug.

Worth noting the clock is the only volatile part. A `# Context` block without `now:` would be
byte-stable across turns and the floor would go to zero.

### What the capture could NOT settle

`calls.request` is the engine-assembled body - top-level keys `messages, tools, reasoning_effort,
cache_key` - and it contains **zero `cache_control` markers**. Breakpoint placement is added later
in provider serialization, exactly as your caveat 2 said. So we cannot see breakpoints from this
artifact, and the 7,172 remains unexplained by anything engine-side.

**The tools-block hypothesis survives but is not proven.** 24,116 B / 7,172 tok = **3.36 bytes per
token**, right in the JSON-schema range, and the block is now provably byte-identical across the
miss. If you want it settled, the capture would need to happen one layer lower, after provider
serialization. That is a change only you can make.

Against the hypothesis, still: the other two misses were 466 and 4,993 tokens, and one run had no
turn-3 miss at all.
