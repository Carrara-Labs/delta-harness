# The 1-in-25 cache miss: mechanism found, fixed, and measured live

Date: 2026-08-10. Branch `feat/0.2.14-name-the-miss`, commit `b34fe3f`.

## The mechanism

Anthropic's prompt-caching docs:

> **"The lookback window is 20 blocks.** The system checks at most 20 positions per breakpoint,
> counting the breakpoint itself as the first. If the system finds no matching entry in that window,
> checking stops (or resumes from the next explicit breakpoint, if any)."

> **"Important limitation:** The lookback can only find entries that earlier requests already wrote.
> If a growing conversation pushes your breakpoint 20 or more blocks past the last write, the
> lookback window misses it. **Add a second breakpoint closer to that position from the start so a
> write accumulates there before you need it.**"

We place two rolling `cache_control` marks for exactly this reason (codex #7, 0.2.11). Enumerating
the real serializer showed **they land one block apart on every parallel tool burst, at any width**.
Two adjacent marks share a single lookback window instead of starting two, so the second mark has
never done the job it was added for.

A width-N parallel tool turn is ~2N blocks: one assistant message carrying N `tool_use` blocks, plus
N tool-result messages. So roughly **10 parallel tool calls** was enough to outrun both marks.

## The fix

`rollingMarks` (`provider.ts`) holds the second mark a full lookback window behind the first,
counted in **blocks** rather than messages, because one native message can carry many blocks. Shared
by both serializers: a previous breakpoint fix shipped to the compat wire only and left native, the
wire the affected agent runs, reproducing the bug in full (codex P1).

When no eligible message sits far enough back, one mark is returned rather than two adjacent ones.
That is not a regression: adjacent marks cover a single block more than a lone mark does.

## Live measurement

Two turns through the harness's own `chat()` against `api.anthropic.com`, `claude-sonnet-5`. Arms
differ **only** in mark placement. Each arm uses a distinct system prefix so arm B cannot read the
cache arm A just wrote; without that the control is contaminated and the broken placement looks fine.

**Superseded below.** The first cut of the fix had an off-by-one (it placed the second mark at
B-21 rather than B-20, leaving one block covered by neither window) and *regressed* burst width 9,
which the adjacent marks it replaced had handled. Found by codex, confirmed by simulation, fixed by
chaining contiguous windows. The measurements below the "Corrected" heading are the ones that count.

### Burst width 12 — above the threshold

| arm | turn 2 `cacheRead` | turn 2 `cacheWrite` | turn 2 input |
| --- | --- | --- | --- |
| old (adjacent marks) | **2,522** | 8,745 | 11,269 |
| new (spaced marks) | **10,206** | 1,061 | 11,269 |

The old placement read back only the system prefix and **re-wrote 8,745 tokens** of transcript it had
already paid to cache one turn earlier.

Priced at Anthropic's rates (writes 1.25x base, reads 0.1x), effective input cost for that turn:

- old: `2,522 x 0.1 + 8,745 x 1.25` = **11,183**
- new: `10,206 x 0.1 + 1,061 x 1.25` = **2,347**

**4.8x cheaper on an affected turn**, which sits right beside the 5.7x Aperture measured on theirs.

### Burst width 4 — below the threshold, the control

| arm | turn 2 `cacheRead` | turn 2 `cacheWrite` |
| --- | --- | --- |
| old | 9,510 | 365 |
| new | 9,510 | 365 |

**Byte-identical.** The fix is a no-op below the threshold. That is what separates a mechanism from
a general improvement, and it was predicted before the run.

### Simulated width sweep

Modelling the documented rule (can turn N+1's breakpoints reach a position turn N wrote?):

| | cache survives to burst width |
| --- | --- |
| old | **8** |
| new | **~20** |

## Why nobody could explain the lane distribution

Aperture fans out over records and measured the defect **27/27** on affected turns. Ferni calls one
or two tools at a time and never reproduced it across an 11-turn reading with a stationary prefix.

A defect gated on parallel-tool width appears on exactly one of those two lanes. That is the
distribution we observed and could not account for through four dead mechanisms.

## Name the consumer who sees nothing

**Any lane whose turns call fewer than ~8 tools in parallel sees no change at all**, in cost,
latency, or behaviour. The width-4 control above is that consumer, measured rather than asserted.

## What is deliberately not done

A **third** rolling mark would extend survival to a burst width of ~40 and is a one-line change
(`marks.length < 3`); the docs confirm "cache breakpoints themselves don't add any cost". It is not
taken here because it spends the last of Anthropic's 4 slots (we use 1 system + 2 rolling) and **no
lane has yet been measured emitting bursts wider than 20**. Take it when an observed burst width says
so, not before.

## Honesty ledger

- Two turns per arm, one run each. The effect is large and the control is clean, but this is not a
  distribution.
- The fixture is synthetic: a ~10k-token prefix and `noop` tools. Aperture's turns are 115k-160k, so
  the absolute numbers do not transfer; the mechanism and the threshold do.
- The simulated sweep models Anthropic's documented rule, not their implementation. The live
  measurement is the evidence; the sweep only says where to look.
- Verified on a real agent for REGRESSION only (see below). Ferni's turns are too narrow to
  exercise the fix, so no live agent has yet demonstrated the benefit. Aperture is the lane that
  can, and has not run it.

## Verified on a real agent (Ferni, 2026-08-10)

Deployed `--from-source` per the release gate, confirmed by finding `CACHE_LOOKBACK_BLOCKS` in the
running image at `/app/src/provider.ts` (the version string still reads 0.2.13, so it proves nothing
on a pre-release build). No schema migration on this branch, so the deploy is reversible by
redeploying without the flag.

One real turn through the daemon seam, 8.8s, correct answer:

| field | value |
| --- | --- |
| `cache_shortfall_tokens` | **241** (the structural ephemeral floor) |
| `spine_hash` / `tools_hash` | stationary across both main calls |
| `tools_n` | 18 |
| `gen_ai.request.effort` | `medium` (the config fix from earlier the same day is live) |
| `cache_hit_pct` | **58** |

That last row is worth keeping. A 58% "hit rate" alongside a 241-token shortfall is an essentially
perfect cache, and it is exactly why 0.2.13 retired the ratio.

**This confirms no regression; it does not confirm the benefit.** Ferni calls one or two tools at a
time, so it sits below the threshold by construction and the fix is a no-op there. The benefit is
the live width-12 measurement above, and the lane that will feel it is Aperture.

A caveat found while probing: the task status is `done`, not `completed`. A poller written against
`completed` reports a timeout on a run that finished in nine seconds.


## Corrected fix, and the threshold located exactly (2026-08-10, second pass)

Codex found a P1 in the first cut: a breakpoint at block B covers B..B-19 inclusive, so the next
window must begin at **B-20**. Taking "the first eligible position at least 20 blocks back" lands on
B-21 for one-block messages, leaving B-20 covered by neither window — and that regressed burst width
9, which the ADJACENT marks it replaced had reached. The spacing test passed anyway because it
asserted the proxy (marks >= 20 apart) rather than the property (can turn N+1 reach a turn N write).

Corrected: marks are **chained**, each starting a window contiguous with the one before it, taking
the furthest-back eligible position still inside the window. Three marks now, not two: Anthropic
allows four and the system prefix takes one, breakpoints cost nothing, and with only two a burst of
17+ still missed because the burst's own assistant message is one long ineligible span.

### Live, arms differing only in placement

| width | old `cacheRead` | old `cacheWrite` | new `cacheRead` | new `cacheWrite` |
| --- | --- | --- | --- | --- |
| 9 | 9,946 | 800 | 9,946 | 800 |
| **10** | **2,523** | 8,397 | **10,033** | 887 |
| 12 | 2,523 | 8,745 | 10,207 | 1,061 |

Turn 1 of every run wrote its full prefix and read 0, so both arms provably started uncontaminated.

**The threshold is exactly 10**, which is what the model predicts: a width-N burst is 2N blocks, a
turn adds 2N+2 with the reply and the next user message, and two adjacent marks cover a growth of at
most 20. Width 9 (growth 20) sits inside that and is identical on both arms; width 10 (growth 22)
falls outside it and is where the old placement collapses.

Width 9 is also the case the broken first cut regressed, so it is now a regression test in two
directions at once.

### Simulated reach, corrected

| | cache survives to burst width |
| --- | --- |
| before any fix | **9** |
| first cut (off-by-one) | 8, and it *regressed* width 9 |
| corrected, 2 marks | 16 |
| corrected, 3 chained marks | **19** |

Beyond 19 there is a hard structural limit: a burst of 20+ parallel tools is a single assistant
message of 20+ `tool_use` blocks, which is **larger than the entire lookback window**. No amount of
chaining can step over one message that big. That limit is asserted in the tests so it stays a known
boundary rather than a surprise.

### What the tests now assert

The proxy test is gone. In its place:

- **Reachability across burst widths 1-16, on both wires**: can turn N+1's windows reach a position
  turn N actually wrote? That is the property; spacing is only a means to it.
- **Width 9 pinned on its own**, because it is the exact boundary an off-by-one reintroduces and a
  sweep someone later trims would quietly drop it.
- **The contiguity arithmetic pinned deterministically** on uniform one-block messages
  (`[50, 30, 10]`), because with three chained marks a one-block hole only bites when a write lands
  exactly in it — so an off-by-one shifts *which* widths fail rather than failing outright, and the
  sweep alone cannot catch it. Both off-by-one variants fail this test.
