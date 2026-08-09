# Field report: the Sphere 600-profile engagement (Aperture, 0.2.11)

Written 2026-08-07 from a real client job, not a lab. Aperture's carrara Quick Search lane ran a
600-profile sourcing sweep for ~12 hours across several runs, then a consolidation run the next
morning. This is what the engine did.

**Lane**: `aperture-qs-69598a208017` (fly), agent id `quick-search-carrara`.
**Image**: `ghcr.io/carrara-labs/delta-harness:0.2.11`, native Anthropic, `claude-opus-5`,
effort `medium`, `DELTA_COMPACT_AT_TOKENS=200000`, `DELTA_STEP_MAX_TOKENS=16384`,
`DELTA_MAX_COST_USD=35`.

**Headline**: prompt caching cost this engagement **72% of its model spend**, and the cause is not
the cache code. It is [spec-compaction-tail.md](spec-compaction-tail.md) firing every turn and
rewriting the context. The two open specs are one bug from the field's side.

---

## 1. P1 — a shrinking context invalidates the cache, and compaction shrinks it every turn

### The measurement

39 consecutive turns from the daemon's own log. For each turn: input tokens, and whether the input
was larger or smaller than the previous turn's.

```
input SHRANK vs prev turn -> 16 miss / 0 hit
input GREW   vs prev turn -> 4 miss / 18 hit
```

**Sixteen for sixteen.** Every single turn whose assembled context came out shorter than the last
one's missed the cache. Not a decline - a switch.

The trace, so the shape is unmistakable (`delta_in` is this turn's input minus the previous turn's):

| turn | in | cache | delta_in |     | turn | in | cache | delta_in |
| ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 238,151 | 98% | +4,436 | | 13 | 207,624 | 9% | **-22,517** |
| 3 | 245,153 | 97% | +7,002 | | 14 | 224,726 | 91% | +17,102 |
| 4 | 238,202 | **8%** | **-6,951** | | 15 | 223,384 | 9% | **-1,342** |
| 5 | 226,721 | **8%** | **-11,481** | | 16 | 235,888 | 94% | +12,504 |
| 6 | 228,396 | 99% | +1,675 | | 17 | 221,991 | 9% | **-13,897** |
| 7 | 230,045 | 99% | +1,649 | | 18 | 226,752 | 96% | +4,761 |

A miss floors at 8-9%, which is the system + tools prefix surviving and nothing else - the same
floor [spec-cache-breakpoints.md](spec-cache-breakpoints.md) found on Ferni. But the Ferni shape was
a **monotonic decline** as context grew. This is an **oscillation**, and it tracks one variable.

### Why the context keeps shrinking

`DELTA_COMPACT_AT_TOKENS` is 200,000. The steady-state working context on this job is
**207k-245k**. The agent is therefore *permanently above its own compaction threshold*: compaction
fires, fails to get under budget (94/94 in spec-compaction-tail), and fires again next turn. Each
firing rewrites the tail. Any rewrite that nets shorter than the previous prompt invalidates
everything after the prefix.

So the causal chain is:

> threshold set below the working set → compaction runs ~every turn → context length oscillates →
> every downward step is a full cache miss → 5.7x cost on that turn.

Neither spec sees this alone. spec-compaction-tail measures that compaction does not shrink;
spec-cache-breakpoints measures that breakpoints land badly. **The field cost is the product of the
two**, and it is much larger than either estimated.

### What it cost

Same 39-turn window:

| | turns | spend | share | avg/turn |
| --- | ---: | ---: | ---: | ---: |
| cache < 50% | 21 (53%) | **$31.86** | **87%** | $1.52 |
| cache >= 50% | 18 (46%) | $4.76 | 13% | $0.26 |

**5.7x per turn.** If misses had cached like hits, this window would have cost $10.32 instead of
$36.62 - **$26.30 recoverable, 72% of spend**. That window is about two hours of a twelve-hour
engagement.

### Reproduce it

```sh
fly logs -a <lane-app> --no-tail \
  | grep -oE "\[turn [0-9]+\] [^ ]+ in=[0-9]+ out=[0-9]+ cache=[0-9]+%"
```
Then pair each turn's `in` with the previous turn's and bucket by sign of the delta. No capture flag
needed - the standard turn line already carries input and cache hit rate.

### What to change

1. **Make compaction hysteretic.** Compact *down to a low-water mark* well under the threshold, not
   just below it. A compaction that leaves the context at 99% of budget re-triggers next turn, which
   is what turns one bug into a per-turn tax.
2. **Do not let the threshold sit below the steady-state working set.** 200k against a 230k working
   set means "always compacting". Either the default is wrong for long-tool-output agents, or the
   engine should say loudly that it is in permanent-compaction mode. Right now `context_irreducible`
   is a warning nobody reads.
3. **Place breakpoints so a tail rewrite cannot invalidate the head.** Already the subject of
   spec-cache-breakpoints; this report is the cost justification for prioritising it.
4. **Emit the signal.** A `cache_hit_pct` + `context_delta` pair per turn in `agent_events` would
   have made this visible on day one instead of requiring a log archaeology session.

### Replication, on a clean uniform workload (2026-08-07, same lane)

The sweep data above is mixed-workload. A later run on the same lane does one thing over and over -
read 3 pages of a saved list, write notes, repeat - and gives a textbook trace:

| turn | in | cache | delta_in | | turn | in | cache | delta_in |
| ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 225,895 | 97% | +6,446 | | 6 | 218,104 | 95% | +10,611 |
| 3 | 224,303 | **9%** | -1,592 | | 7 | 213,974 | **9%** | -4,130 |
| 4 | 219,165 | **9%** | -5,138 | | 8 | 224,700 | 94% | +10,726 |
| 5 | 207,493 | **9%** | -11,672 | | 9 | 220,630 | **9%** | -4,070 |

`SHRANK -> 5 miss / 0 hit. GREW -> 0 miss / 3 hit.` Running total across both runs: **21 shrinks,
21 misses, zero hits.** A -1,592 token step is enough to do it, so this is not a size threshold -
any net-negative step invalidates.

**The compounding effect, which is the actionable part.** The workload alternates by construction:
a paged read GROWS the context, the note-write that follows SHRINKS it. So every read/write pair
buys exactly one cache miss. Aperture's `qs_read_artifact` pages a list at a fixed 10 rows, so
re-reading its own 520-row roster costs 52 sequential reads - and therefore manufactures on the
order of 25 cache misses at ~$1.28 each, against ~$0.21 for a cached turn.

That means the consumer-side paging ceiling and this engine bug are **not independent**: the page
size sets the number of grow/shrink oscillations, and each oscillation costs 6x. Either fix helps;
both together are multiplicative. Worth saying to consumers explicitly - "batch your reads" is a
cost instruction, not just a latency one, for as long as a shrinking context nukes the prefix.

---

## 2. P2 — turn duration must bound any consumer's liveness heuristic

Measured over the same window:

| median | p90 | max | over 120s |
| ---: | ---: | ---: | ---: |
| 70s | 148s | **227s** | 6 / 39 |

Across the larger sweep, 10% of turns ran longer than two minutes, max 249s. During those turns the
engine emits **nothing** - no tool call, no message, no write.

Aperture's reconciler treated "no seam activity for 2 minutes" as a stall signal, and carded a
healthy 12-hour run with a Resume button that would have duplicated it. That was Aperture's bug and
Aperture fixed it (age from last sign of life, not run start). But the general lesson belongs here:

> **Any consumer's silence threshold must exceed the engine's max turn latency, and the engine
> should publish what that is.**

A `/v1/busy` that answered "busy, and my current turn started 90s ago" would let every consumer get
this right instead of each guessing a constant. Worth considering for the busy endpoint.

---

## 3. P2 — a wake failure lost in-memory state mid-engagement

```
23:47:55 proxy ERROR could not wake up machine due to a timeout requesting from the machines API
23:48:01 proxy ERROR instance refused connection. is your app listening on 0.0.0.0:8080?
23:48:03 app   delta: code CLI 'codex' not found - 'code' tool disabled this run
```

The third line is a **cold boot**, not a resume - so the suspended machine's memory was gone and the
run had to be re-dispatched. Scale-to-zero plus a long autonomous run means this is a real failure
mode, not a curiosity. Worth documenting in [hosting.md](hosting.md) at minimum: what a consumer
should expect to be durable across a suspend, and what is not.

---

## 4. WIN — suspend/resume wire refresh works exactly as designed

Recording this because it is the fix that did NOT fail:

```
07:36:18 delta: heartbeat gap 412s (suspend/resume or stall) - refreshing provider wire
07:36:19 [wire] warmup https://openrouter.ai answered in 52ms (probe 2)
07:36:21 [wire] warmup https://api.anthropic.com probe 1 dead - evicted a stale socket
07:36:21 [wire] warmup https://api.anthropic.com answered in 34ms (probe 2)
```

The dead pooled socket after suspend - the 300s turn-1 stall that cost a whole speed-lab
investigation - was detected and evicted in 3 seconds, automatically, with no turn impact. The
0.2.5 stall batch is doing its job on a lane that suspends several times a day.

---

## 5. Minor

- **`codex` CLI absent on the lane** disables the `code` tool silently-ish (one info line at boot).
  Fine if intentional for this profile, but a consumer reading the tool list would not know.
- **One retry, cleanly handled**: `[model retry] anthropic/claude-haiku-4.5 attempt 1 failed (net:
  model stream stalled after first token) -> retry in 644ms`. The utility model stalling after the
  first token happened twice in twelve hours and self-healed both times.
- **Cost ceiling behaviour**: `DELTA_MAX_COST_USD=35`, run peaked at $23.70. Never hit, but the
  agent's own reasoning referenced "budget left" - worth checking what the agent can actually see of
  its remaining budget, since it made a delivery decision ("I do not have budget left to do this
  run") partly on that basis.

---

## Where this came from, and how to get back to it

- Lane: `aperture-qs-69598a208017`, machine `1850222f379458`, region iad.
- Room: `aperture.is/carrara/quick-search/we-are-working-for-a-client-sphere-https` (staff-visible;
  credits counter is staff-only).
- Raw evidence: `fly logs -a aperture-qs-69598a208017 --no-tail` - the turn lines carry input,
  output, cache %, cost and latency with no capture flag set. The log shipper retains roughly a
  rolling window, so **pull it before it ages out** if this needs re-verifying.
- Aperture-side companion entries: `~/ai-recruiter/docs/backlog.md`, section "Sphere engagement
  findings (2026-08-07)".
- Related specs already open here: [spec-compaction-tail.md](spec-compaction-tail.md),
  [spec-cache-breakpoints.md](spec-cache-breakpoints.md),
  [backlog-aperture-context-eviction.md](backlog-aperture-context-eviction.md),
  [harness-0.2.12-plan.md](harness-0.2.12-plan.md).

The single most useful thing in this document is §1's shrink/grow correlation. It is cheap to
re-measure on any lane, it needs no instrumentation, and it turns "caching is disappointing" into a
specific, falsifiable claim about compaction.
