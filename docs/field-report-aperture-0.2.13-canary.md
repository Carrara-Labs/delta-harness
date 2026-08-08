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

Our raw request/response payloads for these turns are captured on the lane
(`DELTA_CAPTURE_PAYLOADS=1`) at `/data/delta.db` on machine `8747430b6d7118`, and the lane is
still up. **Ask and we will pull the exact serialized bodies for those three turns** - that is the
one artifact that could distinguish "inside history" from "on the wire", and we did not want to
ship transcript content to you unasked.

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
