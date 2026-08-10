# Release brief — Harness 0.2.14 "the second breakpoint"

Status: **drafted, release not cut.** 2026-08-10.

## What it is

**We found the 1-in-25 prompt-cache miss, and it was our own breakpoint placement.**

Anthropic's cache lookback is 20 blocks per breakpoint, and it finds only positions earlier requests
already wrote. We place two rolling `cache_control` marks precisely to survive a wide parallel-tool
turn. They landed **one block apart on every tool burst**, so they shared a single lookback window
instead of starting two. A width-N burst is ~2N blocks, so roughly **10 parallel tool calls** outran
both marks and re-billed the whole prefix.

The fix holds the second mark a full window behind the first, counted in blocks.

## What it is worth

Measured live against `api.anthropic.com`, two turns, arms differing only in mark placement, with
distinct prefixes so neither arm could read the other's cache:

| burst width 12 | turn 2 `cacheRead` | turn 2 `cacheWrite` |
| --- | --- | --- |
| before | 2,522 | 8,745 |
| after | **10,206** | **1,061** |

Priced at Anthropic's rates (writes 1.25x, reads 0.1x), that is **4.8x cheaper on an affected turn**.
Aperture measured their affected turns at 5.7x a cached turn, on a much larger prefix.

## Who sees nothing

**Any lane whose turns call fewer than ~8 tools in parallel.** Not an estimate: at burst width 4 the
two arms are byte-identical, 9,510 read and 365 written on both. If your agent calls one or two tools
at a time, this release changes nothing about your cost, latency, or behaviour.

That is also why Ferni could never reproduce the defect while Aperture hit it 27/27. A bug gated on
parallel-tool width appears on exactly one of those two lanes.

## Also in the release

- **`calls` is bounded** by age and a byte budget (`DELTA_RETENTION_MAX_CALL_BYTES`, 32MB default).
  The debug capture table was unbounded; on one lane it reached 45% of the database from a flag left
  on. Bytes rather than rows, because a captured call is ~95KB on one lane and ~700KB on another.
- **`cache_shortfall_tokens` is bounded by the current turn too.** A turn that shrank (what
  compaction produces) previously reported a large false shortfall.
- **Sub-agent capability prose is locked to the enforced filter.** Children have been read-only since
  0.2.4 while five places said otherwise, including the child's own role prompt, which told it to
  write files the engine refuses.
- **Schedule read errors carry their reason**; an agent filed a blocker on a bare `409`.
- **Empty provider error bodies carry their status**, and a 404 names a `MODEL_BASE_URL` missing its
  `/v1`.

## Upgrading

**0.2.14 itself adds no migration.** From 0.2.13 it is reversible.

**From 0.2.11 or earlier it is not**, because it carries the one-way schema step 0.2.13 introduced
(v14 to v15). Before upgrading such a lane:

1. Snapshot the whole `/data` volume. `DELTA_WORKSPACE` is not `/data/workspace` everywhere.
2. Grep the archive for `DELTA.md`. A tar that exists is not a tar that worked.
3. **Restore it and boot the old version against it.** For a migration with no reverse, "a snapshot
   exists" is not the same claim as "the rollback path works".

Two consumer-visible semantics, still new to anyone below 0.2.13: `model.call` now includes
utility-tier calls (filter `tier = 'main'`), and `compaction` counts attempts rather than rewrites
(filter `shrank = true`). `cache_hit_pct` is retired as a health metric; score on
`cache_shortfall_tokens`.

**One configuration note that the version number does not carry:** S1 argument eviction is opt-in.
`DELTA_TOOL_ARG_MAX_BYTES` defaults to 0, so a lane that upgrades without a config change receives
none of that token reduction. Ship the config diff, not just the version.

## Deferred, deliberately

**Effort inheritance and opt-in MCP inheritance for children** were scoped into this release and are
moving to 0.2.15. The reason is that the release changed underneath them: it was a diagnostic that
needed justifying, and it is now a measured fix for the exact defect the waiting consumer escalated.
Bundling two features that each need their own brief (one changes cost and latency for every existing
child, the other widens act-as rights) would delay a 4.8x fix to add things nobody is currently
blocked on. They are next, not dropped.

A **third** rolling breakpoint would extend cache survival from a burst width of ~20 to ~40, is one
line, and costs nothing per the vendor docs. Not taken: it spends the last of Anthropic's 4 slots and
no lane has been measured emitting bursts wider than 20. It is there when a measurement asks for it.

## Honest limits

- The live measurement is two turns per arm, one run each. The effect is large and the control is
  clean, but it is not a distribution.
- The fixture is synthetic, ~10k tokens against Aperture's 115k-160k. The mechanism and the threshold
  transfer; the absolute numbers do not.
- **No live agent has demonstrated the benefit.** Ferni ran the build and confirmed no regression,
  but its turns are too narrow to cross the threshold. Aperture is the lane that can show it.
