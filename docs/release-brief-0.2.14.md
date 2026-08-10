# Release brief — Harness 0.2.14 "the second breakpoint"

Status: **PUBLISHED 2026-08-10** (npm + ghcr + `v0.2.14`, site deployed, Ferni redeployed onto the released package and verified).

## What it is

**Bounds and correctness, plus one prompt-cache fix that no current lane triggers.**

The cache fix is real. Anthropic's lookback is 20 blocks per breakpoint and finds only positions
earlier requests already wrote; our rolling breakpoints landed one block apart, sharing a single
window instead of starting separate ones. A turn issuing **10 or more parallel tool calls** outran
all of them and re-billed the whole prefix. Fixed by chaining contiguous windows.

## What it is worth, and to whom

Measured live on **both wires** (native Anthropic and OpenRouter), arms differing only in placement,
distinct prefixes so neither arm could read the other's cache:

| burst width | old `cacheRead` | new `cacheRead` |
| --- | --- | --- |
| 4 | 9,510 | 9,510 |
| 9 | 9,946 | 9,946 |
| **10** | **2,523** | **10,033** |
| 12 | 2,523 | 10,207 |

Roughly **4.8x cheaper on an affected turn**. The threshold is exactly 10, which is what the model
predicts: a turn adds 2N+2 blocks and adjacent marks cover at most 20.

**Nobody in our fleet triggers it today.** Both Aperture agents batch 2-3 paid calls per turn by
their own design; Ferni calls one or two. This was found by enumerating our own serializer, not by
observing a lane in trouble, and it ships because it is a real defect rather than because anyone is
currently paying for it. If a lane ever raises its batch width, it is already fixed.

## What it does NOT fix, and this matters most

**The open prompt-cache question is still open.** A production session on 2026-08-10 produced three
shortfalls of 2,664 / 9,986 / 2,264 tokens on turns issuing **0-2** tool calls, with `spine_hash`,
`tools_hash` and `ephemeral_bytes` all constant across the run. Stationary prefix, real miss, narrow
burst. That is the original unexplained signature and this release does not touch it.

It is now reproducible on a lane we own, which is the thing that was missing when the diagnostic for
it was first designed. That is the next piece of work, and it is why this release is deliberately not
sold as the answer.

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
