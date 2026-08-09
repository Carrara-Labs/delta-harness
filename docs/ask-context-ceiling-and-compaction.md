# Ask: raise the context ceiling, and stop compaction from nuking the cache

From Aperture, 2026-08-07, after a 12-hour 600-profile client engagement on
`delta-harness:0.2.11`. Companion to
[backlog-aperture-field-report-sphere.md](backlog-aperture-field-report-sphere.md), which has the
raw traces.

**The ask in one line:** we believe the engine is compacting on nearly every turn when it does not
need to compact at all, and that this is costing roughly **72% of our model spend**. We think it is
mostly configuration, but we cannot tell from the outside whether the ceiling is mis-set, the
default is wrong for data-heavy agents, or compaction itself needs work. Everything below is the
evidence and the paths so you can decide.

---

## P1 - the whole finding

### 1. What we measured

Turn lines from the daemon's own log, no capture flag needed. For each turn: input tokens, and
whether the assembled context was larger or smaller than the previous turn's.

```
input SHRANK vs previous turn ->  27 miss / 0 hit
input GREW   vs previous turn ->   4 miss / 21 hit
```

**Twenty-seven for twenty-seven.** Every turn whose context came out shorter than the last one's
missed the prompt cache. A miss floors at 8-9%, which is the system + tools prefix surviving and
nothing else. A step of **-1,592 tokens was enough**, so this is not a size threshold: any
net-negative step invalidates.

A clean 9-turn trace on a uniform workload (read 3 pages of a saved list, write notes, repeat):

| turn | input | cache | delta |
| ---: | ---: | ---: | ---: |
| 2 | 225,895 | 97% | +6,446 |
| 3 | 224,303 | **9%** | -1,592 |
| 4 | 219,165 | **9%** | -5,138 |
| 5 | 207,493 | **9%** | -11,672 |
| 6 | 218,104 | 95% | +10,611 |
| 7 | 213,974 | **9%** | -4,130 |
| 8 | 224,700 | 94% | +10,726 |
| 9 | 220,630 | **9%** | -4,070 |

### 2. What it costs

Over a 39-turn window:

| | turns | spend | share | avg/turn |
| --- | ---: | ---: | ---: | ---: |
| cache under 50% | 21 (53%) | **$31.86** | **87%** | $1.52 |
| cache 50%+ | 18 (46%) | $4.76 | 13% | $0.26 |

**5.7x per turn.** Had misses cached like hits, that window costs $10.32 instead of $36.62 -
**$26.30 recoverable, 72% of spend** - and it is about a sixth of one engagement.

### 3. Why we think the context keeps shrinking

Our lane runs `DELTA_COMPACT_AT_TOKENS=200000`. The steady-state working context on this job is
**207k-245k**. So the agent sits permanently above its own compaction threshold: the pre-send gate
fires nearly every turn, compaction rewrites the tail, and every rewrite that nets shorter kills
the prefix.

The relevant code, as we read it:

- [`src/run.ts:866`](../src/run.ts) - `if (projected > deps.compactAtTokens)` is the pre-send gate.
- [`src/run.ts:872`](../src/run.ts) - `recentBudget = compactAtTokens - fixed - SUMMARY_RESERVE_TOKENS`.
- [`src/config.ts:315`](../src/config.ts) - the knob **defaults to 120,000**.
- [`src/config.ts:59`](../src/config.ts) - the field doc: *"balanced (120k) - the default; safe on
  any >=200k-window model... large (160k+) - fewer compactions... set this HIGHER only when the
  model's real window supports it - keep it below `model_window - max_output`."*

### 4. The part we cannot check from outside, and the reason we think it is a misconfiguration

**The engine has no idea how big the model's context window is.** We could not find a model ->
window table anywhere in `src/`. `compactAtTokens` is a single operator env knob with a fixed 120k
default, and nothing reconciles it against the model actually in use.

That matters because of a deduction from our own logs: **calls at 245,153 input tokens succeeded.**
If the window were 200k they would have failed. So the real window is comfortably above 245k -
and we were compacting at 200k anyway, every turn, for no reason.

Our models (`claude-opus-5`, and the 1M-context variants) carry far more headroom than 200k. If
that is right, the correct setting for this agent is something like 700k-800k and compaction should
essentially never fire on this workload. We would go from ~50% of turns paying 5.7x to ~0%.

**What we would like you to check:**

1. Is 120k still the right default in 2026, or is it sized for a 200k-window era? A data-heavy
   agent hits it in a handful of turns.
2. Should the engine derive the ceiling from the model rather than take it on faith? A wrong knob
   is silent - the only symptom is a cache bill.
3. Is there a guard for the inverse error (a ceiling set ABOVE the real window)? Today that turns
   compaction into overflow.
4. Is `context_irreducible` reachable as a signal? Per
   [spec-compaction-tail.md](spec-compaction-tail.md) compaction failed to get under budget
   **94 times out of 94** on current builds. From our side that is invisible.

### 5. What the other harnesses do - and both have shipped this exact fix

This is the strongest argument that it is a known class of bug, not our misuse.

**Pi** keeps a per-model `contextWindow` in a model catalogue with provider overrides, and a
`native: { contextWindow }` vs runtime distinction. Their changelog:

> *"Fixed inherited GitHub Copilot extended context window models to use `contextWindow: 1000000`,
> **preventing premature compaction and under-budgeting**"* - pi #6439

That is our bug, their words, and their answer was **1,000,000**.

**OpenClaw** carries `contextWindow`, `contextTokens` and `maxTokens` at both provider and model
level, and distinguishes a model's **native window** from its **runtime cap** (e.g. aligning
`openai-codex/gpt-5.5` to "Codex's 272K runtime cap plus 400K native window"). They also shipped:

> *"use the resolved runtime context token budget for non-context-engine tool-result overflow
> checks, so long tool-heavy sessions **no longer compact early** when `contextTokens` is larger
> than native `contextWindow`."*

Sources are in `~/delta/.refs/pi` and `~/delta/.refs/openclaw`.

**The shape both converged on:** a model catalogue that knows each model's window, a native-vs-runtime
distinction, and a compaction budget DERIVED from that rather than set by hand. Delta has one hand-set
number and no catalogue.

### 6. What we would ask for, in order

1. **A model -> context-window catalogue**, with the compaction ceiling derived from it by default
   (`window - max_output - reserve`) and the env knob as an override rather than the only input.
2. **Hysteretic compaction.** Compact down to a low-water mark well under the ceiling, not just
   below it. A compaction that leaves the context at 99% of budget re-fires next turn, which is what
   turns one event into a per-turn tax.
3. **Cache-safe rewriting.** If the tail must be rewritten, place breakpoints so the head survives -
   this is [spec-cache-breakpoints.md](spec-cache-breakpoints.md), and this report is the cost
   justification for prioritising it.
4. **Emit the signal.** `cache_hit_pct` and `context_delta` per turn in `agent_events` would have
   made this visible on day one instead of needing a log archaeology session.

**Our read:** `spec-compaction-tail` and `spec-cache-breakpoints` are one bug seen from both ends,
and the joint cost is much larger than either estimated alone.

---

## P2 - publish the turn clock

| median | p90 | max | over 120s |
| ---: | ---: | ---: | ---: |
| 70s | 148s | **227s** | 6 / 39 |

During those turns the engine emits nothing - no tool call, no message, no write. Aperture's
reconciler treated 2 minutes of silence as a stall and carded a healthy 12-hour run with a Resume
button that would have duplicated it. That was our bug and we fixed it, but every consumer is
guessing this constant independently.

A `/v1/busy` that answered *"busy, current turn started 90s ago"* would let all of us get it right.

## P2 - a wake failure lost in-memory state

```
23:47:55 proxy ERROR could not wake up machine due to a timeout requesting from the machines API
23:48:01 proxy ERROR instance refused connection. is your app listening on 0.0.0.0:8080?
23:48:03 app   delta: code CLI 'codex' not found - 'code' tool disabled this run
```

The third line is a cold boot, not a resume, so the suspended machine's memory was gone and the run
had to be re-dispatched. Scale-to-zero plus long autonomous runs makes this a real failure mode.
Worth stating in [hosting.md](hosting.md) what a consumer should expect to survive a suspend.

## What worked, and we want it recorded

```
07:36:18 delta: heartbeat gap 412s (suspend/resume or stall) - refreshing provider wire
07:36:21 [wire] warmup https://api.anthropic.com probe 1 dead - evicted a stale socket
07:36:21 [wire] warmup https://api.anthropic.com answered in 34ms (probe 2)
```

The dead pooled socket after suspend - the 300s turn-1 stall that once cost a whole speed-lab
investigation - detected and evicted in three seconds, automatically, no turn impact. The 0.2.5
stall batch is doing its job on a lane that suspends several times a day. This is the fix that did
not fail, on a day when several did.

---

## The upside, and why we are pushing on this

This engagement is the hardest thing we have asked an agent to do, and the agent side of it worked.

A client asked for 600 senior AI engineers in SF against a specific brief. Over ~12 hours the agent:

- **Refused the premise, with numbers.** 6,875 people at the target companies, only 1,202 at the
  seniority asked for. It made the tier mix an explicit user decision instead of quietly padding.
- **Stopped and asked before spending**, with a 14-row benchmark built to straddle the boundary, then
  finished once aligned.
- **Caught eight company name-traps** - Persona resolving to a staffing agency, Zip to a LinkedIn
  puzzle game, Harvey to Harvey Nash - any one of which would have poisoned a tier.
- **Reported its own mistakes unprompted**, including ~50 credits burned on a malformed search, and
  corrected a published figure before anyone acted on it.
- **Delivered 520 people in one artifact across 13 tiers**, then **368 work emails**, and found the
  cheapest path to the last 214 itself: it reconstructed exactly who it had already revealed from
  its own stored payloads and spent 428 credits instead of 824.
- **Flagged a hygiene problem nobody asked about**: ~8% of revealed addresses are a former
  employer's domain.

That is a genuinely hard job done well, and it is the use case we most want to be fast at:
**retrieve a large, judged, evidence-carrying list quickly.** We are close. What stands between us
and it is not the agent's reasoning - it is engine economics and latency. Hence this document.

---

## Where the data lives, so you can dig in yourself

| what | where |
| --- | --- |
| Lane | fly app `aperture-qs-69598a208017`, machine `1850222f379458`, region iad, agent id `quick-search-carrara` |
| Image | `ghcr.io/carrara-labs/delta-harness:0.2.11`, native Anthropic, `claude-opus-5`, effort `medium` |
| Config | `DELTA_COMPACT_AT_TOKENS=200000`, `DELTA_STEP_MAX_TOKENS=16384`, `DELTA_MAX_COST_USD=35`, `DELTA_MAX_TOKENS=4000000` |
| Raw turn lines | `fly logs -a aperture-qs-69598a208017 --no-tail` - carries input, output, cache %, cost and latency with NO capture flag. **Pull it before the window ages out.** |
| Structured telemetry | `agent_events` table, Aperture prod DB, filtered `workspace_slug='carrara' and agent_type='quick-search'`. Ask us for access. |
| Aperture-side manifest | `ai-recruiter/app/agent/quick-search/manifest.json` |
| The room itself | `aperture.is/carrara/quick-search/we-are-working-for-a-client-sphere-https` - ask us for a seat, it is worth reading the agent's own messages |

### Reproduce the headline in one command

```sh
fly logs -a aperture-qs-69598a208017 --no-tail \
  | grep -oE "\[turn [0-9]+\] [^ ]+ in=[0-9]+ out=[0-9]+ cache=[0-9]+%"
```

Pair each turn's `in` with the previous turn's and bucket by the sign of the delta. It needs no
instrumentation and it reproduces on any lane, which is why we think it is worth your time before
anything else on this list.
