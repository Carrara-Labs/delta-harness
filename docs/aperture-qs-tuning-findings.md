# Aperture Quick Search: measured tuning findings

Status: **findings + config candidates, 2026-08-19.** Written from the lane's own database ahead of
a high-stakes Quick Search demo. Nothing here is an engine change; §5 is what the findings imply for
the engine backlog, and those are spec candidates rather than decisions.

Visual summary: [`aperture-qs-quick-wins.html`](./aperture-qs-quick-wins.html)
([published](https://claude.ai/code/artifact/afeb98b9-713e-409c-a1a4-4b02de2b1ab2)).

## 0. Provenance, and the caveat that governs everything below

**Source:** `aperture-qs-69598a208017` from the 2026-08-10 pre-0.2.14 fleet snapshot
(`~/delta-lane-snapshots/2026-08-10-pre-0214/`), queried offline, aggregates only. 140 runs, 2,718
`model.call` events, 4,899 `journal` rows, $669.02 metered.

**The caveat: this is 0.2.11 data and the lane has run 0.2.14 since 2026-08-10.** 0.2.13/S5
decoupled the retained tail from the compaction trigger (a flat 24k low-water mark), which
directly attacks the §2 finding. **Every magnitude below is an upper bound on the current build.**
The live lane was suspended and deliberately not woken to re-measure; that is the first task in §6.

Fleet config for this lane, from its pre-bump Machines config:

```
DELTA_PROFILE=work · DELTA_MODEL_PRIMARY=claude-opus-5 · DELTA_REASONING_EFFORT=medium
DELTA_COMPACT_AT_TOKENS=200000 · DELTA_STEP_MAX_TOKENS=16384
DELTA_MAX_TOKENS=4000000 · DELTA_MAX_COST_USD=35 · DELTA_SELF_MAX_TOKENS=2400
DELTA_CAPTURE_PAYLOADS=1        (correct — telemetry enrichment, not the request capture)
unset: DELTA_TOOL_ARG_MAX_BYTES · DELTA_CACHE_TTL · DELTA_TOOL_RESULT_MAX_BYTES
```

## 1. Baseline

| measure | value |
|---|---:|
| median run wall-clock | 8 min |
| p90 run wall-clock | 25 min |
| model calls per run | 19.4 |
| model call latency p50 / p90 / p99 | 17.3 s / 63.4 s / 130.1 s |
| cost per run | $4.78 |
| runs that compacted | 31 of 140 |
| failed runs (all budget exhaustion) | 5 |

**Tools are not the bottleneck.** Summed `duration_ms` across every `tool.result` on the lane is
~6,094 s (101 min). Model time is 2,718 calls × 27.9 s ≈ 75,800 s (21 h). **A ratio of 12.4 : 1.**
Optimising tool execution is invisible; optimising prompt size is not.

```sql
-- tool wall-clock by tool
SELECT json_extract(data,'$."gen_ai.tool.name"') tool, count(*) n,
       round(avg(CAST(json_extract(data,'$.duration_ms') AS INT))) avg_ms,
       round(sum(CAST(json_extract(data,'$.duration_ms') AS INT))/1000.0) total_s
  FROM events WHERE type='tool.result' GROUP BY tool ORDER BY total_s DESC;
```

## 2. The cost is concentrated in the post-compaction reload

| call position | n | cache hit | avg input | avg latency | spend |
|---|---:|---:|---:|---:|---:|
| before any compaction | 2,256 | 87% | 97,401 | 24.4 s | $359.90 |
| **first call after a compaction** | **192** | **32%** | 226,897 | 35.0 s | **$205.05** |
| later in a compacted run | 270 | 88% | 231,163 | 52.2 s | $104.08 |

**192 calls — 7.1% of traffic — are 30.6% of spend.** $1.07 per call against $0.16 for an ordinary
one, a 6.7× multiple.

This is **structural, not a defect**: rewriting the prefix invalidates the cache from the first
changed block, so a compaction costs one full re-cache by construction. The lever is to compact less
often, not to change compaction. Note also row three — after compacting, input is still averaging
231k, i.e. on 0.2.11 compaction was firing without winning back much room. **That specific behaviour
is what 0.2.13/S5 addressed**, so expect row three to have improved on 0.2.14 and row two to persist.

```sql
WITH ev AS (SELECT run_id, ts, type,
     CAST(json_extract(data,'$.cache_hit_pct') AS INT) hit,
     CAST(json_extract(data,'$.latency_ms') AS INT) ms,
     CAST(json_extract(data,'$."gen_ai.usage.input_tokens"') AS INT) inp,
     CAST(json_extract(data,'$."gen_ai.usage.cost_usd"') AS REAL) cost
   FROM events WHERE type IN ('model.call','compaction')),
 mc AS (SELECT *, (SELECT max(ts) FROM ev p
          WHERE p.run_id=ev.run_id AND p.type='compaction' AND p.ts<ev.ts) lastc
        FROM ev WHERE type='model.call')
SELECT CASE WHEN lastc IS NULL THEN 'pre-compaction'
            WHEN (ts-lastc)<90000 THEN 'FIRST after compaction'
            ELSE 'later post-compaction' END bucket,
  count(*) n, round(avg(hit)) hit, round(avg(inp)) avg_in,
  round(avg(ms)) avg_ms, round(sum(cost),2) cost
FROM mc GROUP BY bucket;
```

Cache warmth by inter-call gap, same lane:

| gap since previous model call | n | cache hit | avg latency | spend |
|---|---:|---:|---:|---:|
| < 1 min | 2,105 | 91% | 19.0 s | $309.14 |
| 1–5 min | 473 | 66% | **71.8 s** | $299.48 |
| first call of a run | 140 | **21%** | 13.0 s | $60.41 |

No call on this lane ever followed a gap greater than 5 minutes *within* a run, so the default
5-minute TTL never lapses mid-run. The cold band is **between** runs.

## 3. What feeds the compaction: unbounded tool-call arguments

Assistant tool-call **arguments** are the one large thing entering context with no bounding rail —
`demoteSpilled` opens with `if (m.role !== "tool") return`, so nothing has ever shrunk them. They are
replayed on every turn until compaction sheds the prefix.

Measured on this lane's `journal` (4,899 calls, 4.83 MB of stored arguments):

| tool | calls | avg bytes | max bytes | total | reclaimable at 4 KB |
|---|---:|---:|---:|---:|---:|
| `aperture__qs_stage_body` | 206 | 11,831 | 47,709 | 2.44 MB | **1.61 MB** |
| `remember` | 80 | 7,621 | 9,141 | 610 KB | 282 KB |
| `aperture__qs_save_artifact` | 82 | 2,752 | 14,106 | 226 KB | 77 KB |
| `research` | 3 | 6,411 | 14,462 | 19 KB | 10 KB |
| **all tools** | **4,899** | 987 | 47,709 | **4.83 MB** | **1.99 MB (41.2%)** |

**81% of the reclaim is one tool.** `qs_stage_body` is the model staging long report bodies as
arguments — precisely the case cited in `config.ts:218` when the rail was built ("Aperture handed
over a 143,905-char artifact in ~12.4KB chunks").

```sql
SELECT tool, count(*) n, round(avg(length(args))) avg_b, max(length(args)) max_b,
       sum(length(args)) total_b,
       sum(CASE WHEN length(args)>4096 THEN length(args)-4096 ELSE 0 END) reclaimable_b
  FROM journal GROUP BY tool ORDER BY reclaimable_b DESC;
```

*(A `messages`-level count of the same thing returns ~39 MB. Do not use it: one assistant row can
carry several calls and compaction leaves deactivated rows in place, so it double-counts. The
`journal` figure is one row per call and is the one to quote.)*

## 4. The three config candidates

All three already exist in 0.2.14, which the lane runs. Each is one environment variable and a
restart, and each reverts by removing it. **No code, not in the 0.2.15 diff, cannot regress a
deployed build.**

### 4.1 `DELTA_TOOL_ARG_MAX_BYTES=4096`

Default is **0 = off** (`config.ts:230`). Shipped opt-in for one cycle in 0.2.12 because its
marker-echo guard was new; that cycle has passed and no lane ever turned it on.

- **Worth here:** 1.99 MB of 4.83 MB stored argument bytes (41.2%), 81% of it from one tool.
- **Reference measurement** (same work, both arms): compactions 5 → 0, input tokens −29.9%, peak
  call −26.2%, cost −36.5%.
- **Known cost:** the echo guard adds roughly 8 extra model calls on a long filing session.
- **Revert signal:** compactions per run going **up**, or the agent redoing work it already did.

### 4.2 `DELTA_CACHE_TTL=1h`

Ferni has run this since the 2026-08-03 cache investigation with a written rationale; no Aperture
lane has it. Targets the 21%-hit first-call-of-run band and the 66%-hit 1–5 min band. Cache writes
bill at 1.25× input, repaid on every read; this lane is overwhelmingly read-dominated (2,105 of
2,718 calls at 91% hit), so the premium is covered.

### 4.3 `DELTA_SELF_MAX_TOKENS` 2400 → 4000

125 self-write refusals on this lane = **42% of its 294 tool errors**, plus 23 write collisions
between concurrent runs. Every refusal is a paid turn that produced nothing, and a full self-file
means the lane has stopped learning. Fleet drift: 4000 on intake lanes, 2400 here, 1600 on two
others — three values, none chosen for a workload. Check live fullness on `/v1/status` (`self`)
before picking a number.

### 4.4 Deliberately NOT recommended

- **Do not lower `DELTA_REASONING_EFFORT` to `low`.** The −56% p50 / half-cost measurement is
  **chat-shaped**; Quick Search is research-shaped, the profile most likely to degrade. Test it
  after the demo, on their bench rig, not before it.
- **Do not raise `DELTA_COMPACT_AT_TOKENS`.** Usable ceiling for `claude-opus-5` is window 249,000 −
  `OUTPUT_RESERVE` 40,000 = **209,000**, against 200,000 today. ~9k of headroom buys nothing and
  overshooting trades a cache miss for a hard overflow.

## 5. What this implies for the engine — spec candidates

1. **Flip `DELTA_TOOL_ARG_MAX_BYTES` to default 4096.** The strongest finding in this document is not
   the byte count, it is that **the opt-in cycle worked exactly as designed and produced zero
   adoption**: the rail was built for Aperture, measured at −36.5% cost, shipped off, and never
   switched on by anyone — including us, on the lane it was built for. An opt-in default for a
   measured win is a default of "nobody gets it". Candidate for 0.2.16 with a canary, or for 0.2.15
   if the config canary in §6 lands clean.
2. **The post-compaction reload has no telemetry that names it.** It is 30.6% of spend on this lane
   and is only visible by joining `model.call` against `compaction` by timestamp, which nobody does.
   A `turns_since_compaction` scalar on `model.call` would make it a one-column group-by. Sibling of
   the history-digest work in the shipping list.
3. **Effective tuning config is invisible.** Three self caps across one fleet, and no lane sets the
   arg cap or the cache TTL — none of which any surface reports. Extends D-3
   (`spec-tool-usability.md`): `/v1/status` should report the *effective* tuning values, not only
   tools.
4. **Self-file write collisions → retry rather than a returned error** (48 fleet-wide, 23 here).
   Already on the 0.2.16 list; this is a second lane confirming it.

## 6. Open, in order

1. **Re-measure §2 against the live 0.2.14 lane.** Everything here is an upper bound. The lane
   autosuspends; waking it is a production action and should be someone's deliberate call.
2. **Canary the three variables on one pinned job**, comparing four numbers only: compactions per
   run, post-compaction `input_tokens`, cost per run, wall clock.
3. **Then 0.2.15**, which carries three fixes measured on this same lane: D-1 (27 runs answered a
   stale question, 0 harmless), D-9 (5 runs, $84.05, 98 min returned as counters), D-3.

## 7. Hypotheses tested and falsified — do not re-argue these

- **Self-file writes churn the prefix cache.** *False.* Calls within 2 minutes of a `remember` show
  **higher** cache hit (93% vs 82%) and lower cost ($0.18 vs $0.25). The self-file is small against a
  130k-token prompt and sits in the stable segment.
- **Tool latency is a meaningful share of run time.** *False.* 12.4 : 1 against it.
- **The 5-minute cache TTL lapses mid-run.** *False.* Zero calls on the lane followed an intra-run
  gap over 5 minutes. The cold band is between runs, which is still worth the 1h TTL, but for a
  different reason than assumed.

## 8. Not the harness — Aperture-side error rates

| tool | calls | errors | rate |
|---|---:|---:|---:|
| `aperture__qs_save_artifact` | 148 | 26 | **17.6%** |
| `aperture__qs_start` | 153 | 15 | 9.8% |

Roughly one in six artifact saves failed. The agent recovers, which is why it went unnoticed, but
each failure costs a visible turn. Worth passing to Aperture regardless of the demo.
