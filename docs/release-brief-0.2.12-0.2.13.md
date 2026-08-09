# Release brief: 0.2.12 + 0.2.13

For operators upgrading a Delta fleet. Read the first section before touching any lane.

## Upgrade path: go straight to 0.2.13

0.2.12 and 0.2.13 have **identical schemas** (30 migrations each), so upgrading between them is
reversible. Reaching either from 0.2.11 is not.

| transition | reversible? |
|---|---|
| 0.2.11 → 0.2.12 | **NO** — schema 28 → 30 |
| 0.2.11 → 0.2.13 | **NO** — same one-way step, taken once |
| 0.2.12 → 0.2.13 | yes |

**So deploy 0.2.13 directly.** Both are published for provenance, but routing the fleet through
0.2.12 first buys nothing and doubles the disruption on client lanes.

## Before any lane you care about

A lane rolled back after upgrading **crash-loops to its restart cap**, and the obvious recovery —
destroying the volume — also destroys the agent's learned `DELTA.md`, a workspace file that is not
in the database. That loss is permanent.

```sh
fly machine start <machine-id> -a <app>
fly ssh console -a <app> -C "tar cf - -C /data workspace" > <app>-workspace-$(date +%Y%m%d).tar
tar tf <app>-workspace-*.tar | head    # NOT optional
```

The workspace is `/data/workspace`, not `/data`, and lanes autosuspend so the machine must be woken
first. **Both failure modes write a file that exists and looks fine**, which is why the verify step
is where the safety actually lives. Roll forward, never back.

## Who sees nothing

- Any agent not near a context ceiling: new telemetry fields, no behaviour change.
- Any lane with `DELTA_COMPACT_AT_TOKENS` below ~33,000: the compaction fix is a deliberate no-op
  there, because the ceiling-derived budget already wins.
- Any lane whose tool calls are small: 0.2.12's argument eviction does nothing for you.

## Three things that will break a dashboard

1. **`model.call` now includes utility-tier calls** (compaction summaries, research fan-out,
   reflection, `eval_n` judging). Filter `tier = 'main'` anywhere you count turns.
2. **`compaction` now counts attempts, not rewrites.** Filter `shrank = true` for the old meaning.
   Historic counts were rewrites and are not comparable.
3. **`tool.breaker` is a new event type.** Strict event enums will reject it.

## Stop scoring on `cache_hit_pct`

It is a ratio whose denominator grows when history is appended, so a byte-identical prefix reads
anywhere from 65% to 100%. On real fleet data a turn reading 68% was perfectly cached while one
reading 92% had re-read 4,993 tokens.

Use **`cache_shortfall_tokens`** instead: the previous request's gross input minus this call's cache
reads. Its floor equals `ephemeral_bytes` and that floor is structural, not waste.

## What 0.2.13 is worth, measured

On a consumer lane at a 60k ceiling, same work both arms:

| | 0.2.12 | 0.2.13 |
|---|---|---|
| `context_irreducible` | 5 | **0** |
| peak input | 70,969 (18% over the ceiling) | 56,521 (under) |
| compaction | 8 rewrites | 4 attempts, all shrinking |

Delivery showed no regression: zero repeated provider calls on either arm. A favourable rows-delivered
difference was discounted by the reporting team because their arms shared a warm workspace.

## Known limits, stated

- One cache miss per ~25 turns remains unexplained. Diagnosing it needs request capture below the
  provider serializer, which does not exist yet.
- The `calls` capture table has **no retention**. If you enable `DELTA_CAPTURE_CALLS` on a real
  workload, pull the data and disable it promptly — a captured request runs 0.5-0.7MB at scale.
