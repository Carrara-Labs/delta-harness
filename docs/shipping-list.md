# Delta shipping list (as of 2026-08-10, 0.2.14 PUBLISHED)

**0.2.14 is out** (npm + ghcr + `v0.2.14`, site deployed, Ferni on the released package). It is a
bounds-and-correctness release; its cache fix needs 10+ parallel tool calls and no lane in our fleet
issues more than 3. The prompt-cache defect Aperture escalated is **still open** and is now
reproducible on Ferni. Aperture manifests are bumped to 0.2.14 but **not rolled**: the restore-and-boot
drill comes first, then lab lanes, then carrara, then clients.

## Where 0.2.12 stands

Built on `feat/0.2.12-bound-writes`. 873 tests green, typecheck + lint clean, smoke passing against
a live server, ten live tests on a real model. **Not released**, and the remaining work is ceremony
plus one measurement we should not take ourselves.

### What it answers, against Aperture's eight asks

| # | ask | status |
|---|---|---|
| 1 | evict a successful call's arguments, with an index and a pointer back | **shipped** (S1 + S2) |
| 2 | effort inheritance for subagents | 0.2.13 |
| 3 | opt-in MCP mount for children | 0.2.13 |
| 4 | budget divisor for concurrent `spawn_subagent` | **shipped** as a live reservation (S4) |
| 5 | self-write breaker latches on converging attempts | **shipped** (S5) |
| 6 | self-file fullness on `/v1/status` | **shipped** (S6) |
| 7 | `/v1/status` reports the raw profile alias | **shipped** (S6) |
| 8 | a fifth bundle file | declined as engine work; **the docs convention is still unwritten** |

Plus their one explicit request back - `demoted_only` on the compaction event (S7) - and two defects
they could not have known about:

- **the parallel sub-turn resume bug** (S9): a crash mid-batch silently stranded the calls that had
  not committed, forever. Pre-existing, no test covered it, found while reviewing the elision seam.
- **the marker-echo bug**: our own new marker taught the agent to send it as content. Found on a
  live run, not by five review rounds.

### What it is worth

Same work delivered on both arms (10 pages / 120 records / 0 corrupt): **5 compactions to 0**,
input tokens **-29.9%**, peak call **-26.2%**, cost **-36.5%**. On a single-burst filing shape, peak
call input **34,034 to 9,605** and final-call cache **13% to 88%**.

**Treat these as indicative, not conclusive.** One run per arm against a nondeterministic model.
Aperture has a pinned fixture and a bench rig and offered to canary; that is the real number.

## Before it can be cut

1. ~~**The `#8` docs convention.**~~ **DONE** 2026-08-08 - `bundle-reference-material.md`.
2. **CHANGELOG, `version.ts`, `package.json`, site changelog.** The ceremony in
   `reference_delta_release_ceremony`.
3. **The release brief**, which must name three things:
   - consumers whose tool calls are small see **no change at all** (verified: an identical trivial
     turn cost exactly the same on both arms);
   - a lone `spawn_subagent` now receives **half** the unreserved remainder rather than all of it;
   - the echo guard costs roughly **8 extra model calls** on a long filing session.
4. **Deploy from source to a real agent** and finish the human-in-the-loop test. The release gate is
   explicit that a local daemon is not this step.
5. **Aperture canaries** on `speed-lab` with `room-bench.ts`, scored on compaction count,
   post-compaction `input_tokens` and `context_irreducible` - never on steady-state cache hit.

## P1 - next release (0.2.13) "say what changed" - **BUILT on `feat/0.2.13-say-what-changed`**

**Status 2026-08-07:** Tier 1 + Tier 2 (S1-S7) implemented, 914 tests green, typecheck + lint clean,
three codex passes (the last returned clean). **Not released, and the live half is unrun** - there is
no model key in the build environment, so every turn-level claim is unit-tested only. The canary ask
is `ask-aperture-0.2.13-canary.md`. Tier 3 and the mechanism fix remain deliberately unwritten until
that reading lands.

**Full plan: [`harness-0.2.13-plan.md`](./harness-0.2.13-plan.md)** - the defect, how each proposed
mechanism died, the tier dependency argument, the written prediction, the scoring traps and the
honesty ledger. Visual explainer for a non-engine reader:
[`harness-0.2.13-explainer.html`](./harness-0.2.13-explainer.html)
([published](https://claude.ai/code/artifact/06f9afe2-7ecf-4a93-9b66-8fe0e04a68e0)). Source thread:
`ask-context-ceiling-and-compaction.md` and `reply-aperture-context-ceiling{,-2,-3}.md`.

**Why it is instrumentation-first.** Aperture measured a real defect - a turn whose assembled context
comes out shorter than the previous turn's misses the cache, 27/27, at 5.7x a cached turn and 72% of
spend nominally recoverable. Two mechanisms were then proposed for it and **both were killed by
data**: compaction (68% of misses had no compaction event) and the A4 breaker (only 10 tool errors in
30 hours, so it never latched - vacuous rather than negative). The mechanism is still unnamed,
because every instrument either side proposed measured *size* when the cache keys on *identity*. A
same-size prefix mutation is cache-fatal and byte-invisible, and the spine carries a per-turn counter
that can produce exactly that.

**Standing prediction, written before the data:** `spine_hash` moves on miss turns.

| tier | items | why here |
|---|---|---|
| **1 - first** | S1 segmented prefix identity (`{bytes, hash}` per segment) · S2 the silent non-shrinking compaction attempt · S3 `model.call` for utility-tier calls · S4 the breaker latch as an event | Every remaining decision is currently a guess, and one release has already had its headline number retracted |
| **2 - rides along** | S5 tail budget decoupled from the ceiling · S6 `window` column on `pricing.ts` with the env knob demoted and clamped · S7 `last_event_ms_ago` on `/v1/busy` · S8 suspend expectations in `hosting.md` | Provable from source, so it waits for no one's data |
| **3 - gated** | S9 keep a quarantined tool's schema resident (**ships labelled "not the fix for your bill"**) · the mechanism fix itself, deliberately unwritten | Shipping a mechanism fix now would be the third guess in a row |

**Return, priced by confidence:** diagnostic (certain - three rounds and a 12-hour forensic session
collapse to a two-column join); correctness (high - S5/S3/S6); mechanism (**contingent, unproven** -
50-60% off affected lanes if the prediction lands; 72% is a ceiling nobody should promise).

### Also open, carried from before

- **Reduce the echo rate.** New, born from this release. The guard makes it correct and
  self-correcting, but the retries are a real cost. One hypothesis is already dead: keeping a preview
  of the original inside the marker made it *worse* (20 to 26 refusals, 163k to 202k tokens) because
  it gave the model a more convincing thing to imitate.
- **Spill retention. STILL OPEN, and a TTL is the wrong shape — do not re-attempt it.** A boot-time
  7-day mtime sweep (`sweepSpill`) was built on 2026-08-10 and **reverted the same day** after codex
  caught it. The reference-lifecycle objection was never actually answered: I resolved it against
  the `journal` and `events` horizons, which are not the reference holders. The real ones are the
  **transcript**, **compaction's accumulated pointers** (`compaction.ts:collectArtifacts`, which
  exists precisely so a spill pointer outlives the tool message compaction deactivates), and
  **`recall`**, which reconstructs spill paths and surfaces COMPACTED rows as well as live ones. So
  the referencing set is "anything ever mentioned in this thread", which no age approximates and
  which a reference-aware sweep would find almost entirely undeletable.
  **On a lane like Aperture that depends on cross-run recall, the sweep destroys recoverable output
  on first boot.** `queue.ts` already had the correct policy and a comment stating it: wipe run
  spill ONLY for ephemeral (`store: false`) turns, which have no durable transcript by construction.
  Bounding this directory needs a real lifecycle — spill owned by the session row and dropped with
  it, or reference counting — not a timer. Regression-locked by a test asserting the boot sweep
  leaves `.delta/spill` alone.
- **Effort inheritance** (their #2). One line of code, not a one-line decision: every existing child
  runs at model default today, so inheriting silently raises cost and latency for every consumer on
  upgrade. Belongs in a brief, not a patch note.
- **Opt-in MCP mount for children** (their #3). A security widening - a child inheriting the mount
  inherits act-as rights. Filed by them as a latency ask; it is really the other structural answer to
  the same context problem, since a child with a fresh window is context relief.
- **Cold-cache restructuring.** OpenClaw gates a two-stage prune on the cache TTL having lapsed;
  Hermes triggers compaction on a wall-clock idle gap. We state the principle in `demoteSpilled` and
  apply it at exactly one moment. Does nothing for a job that fills up mid-run with no pause, so it
  is not an Aperture item - it is the answer to the open **cache decay on long threads** item, with
  Ferni as the beneficiary.
- **No cache write on the summary call** (Pi's `cacheRetention: "none"`). We pay to store a cache
  entry that can never be read back. Codex checked and it is NOT the one-liner the plan claimed: the
  serializers add breakpoints automatically, so it needs its own cache patch.

## P1 - opened by the 0.2.14 work (2026-08-10)

### The prompt-cache question is still open, and now reproducible

0.2.14 fixed a real breakpoint-placement defect that **no current lane triggers** (it needs 10+
parallel tool calls; both Aperture agents batch 2-3 by design, Ferni 1-2). The defect that was
actually escalated is untouched.

A production Ferni session produced three shortfalls of **2,664 / 9,986 / 2,264** tokens on turns
issuing **0-2** tool calls, with `spine_hash`, `tools_hash` and `ephemeral_bytes` constant across all
eight calls. Stationary prefix, narrow burst, real miss. Same signature Aperture measured 27/27.

**The Aperture fleet dataset (2026-08-10, 129 turns / 7 runs, both builds) sharpens this and
falsifies the phrase everyone has been using, including us.**

**"Prefix intact" is not established by any measurement we currently take.** `spine_hash` and
`tools_hash` cover the spine and the tool specs. The history segment - the only segment that changes
every turn, and the one every one of these misses points at - is exported as `history_bytes` and
nothing else. A same-size mutation anywhere in history is invisible to this telemetry, which is
precisely the failure mode [[feedback_cache_keys_on_identity]] was written about. Every "stationary
prefix, real miss" claim in this dataset, ours included, is really "spine and tools stationary; the
history segment unmeasured".

**Add a history digest before building anything else.** It splits the open defect cleanly in two:
- history moved → we are mutating the prefix. A serialization bug we own, fixable by us.
- history stationary → we are placing breakpoints badly. An engine bug in `rollingMarks` placement.

Nothing currently distinguishes these, and they need opposite fixes.

**It is NOT "one line next to `spine_hash`", and that framing would ship a useless instrument.**
`spine_hash` works as a change signal because the spine is stable between turns. History *grows*
every turn, so a digest of the whole thing always moves and answers nothing. The instrument has to
cover **the span that also existed on the previous call**:

- `history_hash` over everything sent now, so the NEXT turn has an anchor to compare against.
- `history_prefix_hash` over only the first `lastHistoryN` messages, directly comparable to the
  previous turn's `history_hash`.
- `history_n`, so a reader can tell a suppressed comparison from a matching one.

That needs `lastHistoryN` carried across turns beside `lastInputTokens`, and suppressed the same way
on the first call of a run and after a compaction, where there is no comparable span and a mismatch
would be noise indistinguishable from signal. Serializing per-message (`history.map(JSON.stringify)`)
lets both digests come from one pass.

**The cost objection in `run.ts` is false and should be deleted with the change.** It rejects a
digest for costing "a full ~1MB serialization every turn", but `msgBytes` is
`utf8(JSON.stringify(ms))` - that stringify is already paid. Measured on a 1MB history: stringify
0.097ms (already paid), `Bun.hash` 0.066ms (the entire addition), against a turn that takes seconds.
The comment's other half, "two events already answer it", is an assertion that no third writer
mutates history, never controlled for, and precisely the assumption the open defect puts in doubt.

**What the dataset shows once compaction turns are separated out.** Compare each miss against
`prevInput - prevCached`, the region the previous turn actually paid for, and the misses split into
two families with nothing in between:

| family | signature | reading |
| --- | --- | --- |
| post-compaction (shape 2) | history delta strongly negative, shortfall far exceeds the new region | the 0.2.13-and-earlier collapse; `cached` froze at exactly 18,399 for the rest of the run |
| stationary-prefix (shape 1) | history delta positive, shortfall is a *fraction* of the new region | the open defect |

In shape 1 the useful number is not the shortfall, it is **how far into the previous turn's new
region the next turn's cache read reached before stopping**. It lands on two discrete values, never
in between:

- **~679 tokens in**, then stop. Four independent runs, same turn index, shortfall **exactly 7,172
  tokens** in all four, with `self_bytes` of 4,321 / 4,321 / 5,042 / 6,251. Identical to the token
  across a 45% spread in self-file size, which rules out spine drift as the cause.
- **~188 tokens short of the end**, having reached 8,700-9,900 tokens of new material fine.

A read that stops at a discrete offset rather than a random one is a read ending at the last
*written* breakpoint. That is placement, not TTL (gaps were 8-37s), not spine, not tools.

The first candidate was `rollingScanFrom`, which starts the newest mark's scan at
`length - 1 - ephemeralCount` and so assumes the ephemerals occupy the final slots of the array.
**Checked and falsified**: `run.ts:969` assembles `[system, ...withImages, ...ephemeral]` and passes
`ephemeral.length`, so the assumption holds exactly. Recorded because the next person will have the
same idea.

What survives in that class is **mark ineligibility at the tail**. Both wires refuse to mark a
message that ends in a `tool_use` block or carries an image, on the reasoning that those are rebuilt
every turn. When the tail is ineligible the newest mark falls back to an earlier message, and
everything after it goes unwritten - which is exactly a read that stops at a discrete offset short
of the end. Aperture's `quick-search` attaches image markers, so it is a lane where this can fire.
This is a hypothesis with a mechanism, not a conclusion. It is cheap to settle offline: `toAnthropic`
is exported and mark positions are deterministic, so replaying a captured request pair
(`DELTA_CAPTURE_CALLS=1`) and printing where the marks land answers it without a single API call.

**This is the thing to instrument next**, and unlike when the correlator was first specced, it is
reproducible on a lane we own. Design notes:
- Do NOT rebuild `spec-cache-break-correlator.md` as written. Its `wire` hashing cannot fire
  (deterministic serializers) and its fire condition would have missed 466 and 4,993-token events.
- Anthropic ships a **cache diagnostics beta** (`cache-diagnosis-2026-04-07`) returning
  `system_changed` / `tools_changed` / `messages_changed` against a previous response id, hashes
  only, ZDR-eligible. **Claude API only**, so it covers Aperture's `quick-search` lane and Ferni,
  but not the OpenRouter `intake-call` lane. Try it before building anything.
- Export a bounded `tool_calls_n` scalar so burst width can be joined to the next turn's shortfall
  without exporting tool names (codex).

### Cache warmth: two levers, opposite workload shapes, different packages

Settled 2026-08-10. **A heartbeat must never live in the engine.** `CLAUDE.md` already states the
rule as "budgets, not timers", and a timer would mean the daemon can never suspend, which deletes
the pausable-and-cheap property that defines a Delta agent.

| lane shape | example | lever | home |
| --- | --- | --- | --- |
| always-on, human returns unpredictably | Ferni on Telegram | heartbeat just under the TTL | **Connect**, opt-in per chat |
| bursty task runs, long gaps between | Aperture rooms | restructure when the cache is already cold | **engine** |
| scheduled batch, gaps by design | Quarry Brain | neither; the gap is the point | - |

- **Heartbeat (Connect).** Measured need: a 10-minute gap cost **5.4x** on Ferni (`in=40,751
  cached=6,602 $0.2319` against `in=41,265 cached=40,510 $0.0427` twenty seconds later). Caveat the
  vendor docs gloss: at the 5-minute default you need ~12 beats an hour and each reads the full
  prefix, which is near break-even. It only clearly wins **paired with a 1h TTL on the rolling tail**,
  one beat replacing one full re-cache.
- **TTL-gated restructure (engine).** OpenClaw's `pruneExpiredCacheTtlToolResults`: gate on the TTL
  having lapsed, then two pressure thresholds, soft trim then hard clear, as a non-destructive
  projection, resetting the clock only when it actually changed something. It fires **on a turn,
  never on a timer**, so it is suspend-safe by construction and fits the harness philosophy. This is
  the lever that serves Aperture and Quarry. They shipped two double-compaction bugs at exactly the
  compaction/marker seam, so budget for that.

### ~~Before Aperture crosses the one-way step~~ DONE 2026-08-10

**The restore-and-boot drill PASSES.** Aperture ran it end to end on a throwaway app against a real
`google-deepmind` v14 archive: restore v14, boot 0.2.11, migrate to 0.2.14, roll back, watch 0.2.11
refuse v15 and crash-loop, restore, full recovery. The rollback path is now a tested claim rather
than an assumed one. Two findings folded into `hosting.md`: `DELTA.md` survives even the crash loop
(bundle apply runs before the DB open), and recovery needs an init override such as `sleep infinity`
because you cannot ssh into a machine whose daemon exits on boot.

**The fleet crossed on 2026-08-10**: all 12 Aperture lanes 0.2.11 → 0.2.14, no rollbacks.

### Spill lifetime, still unsolved

See the entry above: a TTL is the wrong shape and was reverted before release. Needs spill owned by
the session row, or reference counting.

## P1 - opened by the Quick Search tuning pass (2026-08-19)

Full findings, with every query inline so the numbers are reproducible:
[`aperture-qs-tuning-findings.md`](./aperture-qs-tuning-findings.md). Visual:
[`aperture-qs-quick-wins.html`](./aperture-qs-quick-wins.html). Measured on
`aperture-qs-69598a208017`, 140 runs, 2,718 model calls, $669.02 metered - **0.2.11 snapshot data, so
every magnitude is an upper bound on the current 0.2.14 build.**

### The opt-in default produced zero adoption, and that is the finding

`DELTA_TOOL_ARG_MAX_BYTES` defaults to **0 = off** (`config.ts:230`). It was built for Aperture as
their rank-1 ask, measured at **-36.5% cost / -29.9% input tokens / 5 compactions to 0**, and shipped
opt-in for one cycle because its marker-echo guard was new. That cycle has passed. **No lane in the
fleet has ever set it** - including the lane it was built for, by us.

On that lane today: 4.83 MB of stored tool arguments, **1.99 MB (41.2%) reclaimable at a 4 KB cap**,
and **81% of the reclaim is one tool** (`aperture__qs_stage_body`, 206 calls, avg 11,831 B, max
47,709 B). Exactly the case named in the config comment when the rail was written.

**Candidate: flip the default to 4096.** An opt-in default for a measured win is a default of "nobody
gets it". 0.2.16 with a canary, or 0.2.15 if the config canary lands clean first.

### The post-compaction reload is 30.6% of spend and has no telemetry naming it

192 calls - 7.1% of traffic - at 32% cache hit on 226,897 average input tokens, **$205.05 of $669.02**.
$1.07 a call against $0.16 for an ordinary one. It is structural (a prefix rewrite costs one full
re-cache), so the lever is compacting less often, not changing compaction.

It is only visible by joining `model.call` against `compaction` on timestamp, which nobody does.
**A `turns_since_compaction` scalar on `model.call` makes it a one-column group-by.** Sibling of the
history-digest item above; same instrumentation gap, different segment.

### Effective tuning config is invisible

Three different `DELTA_SELF_MAX_TOKENS` across one fleet (4000 / 2400 / 1600), and **no lane sets
`DELTA_TOOL_ARG_MAX_BYTES` or `DELTA_CACHE_TTL`** - none of it reported anywhere. Extends D-3 in
`spec-tool-usability.md`: `/v1/status` should report the **effective tuning values**, not only tools.
On the QS lane the self cap alone accounts for **125 refused self-writes, 42% of that lane's tool
errors**, and a lane that has silently stopped learning.

### Falsified, recorded so nobody re-argues them

- **Self-file writes churn the prefix cache.** False - calls within 2 min of a `remember` show
  *higher* cache hit (93% vs 82%) and lower cost. The self-file is small against a 130k prompt and
  sits in the stable segment.
- **Tool latency matters for run time.** False - model time beats tool time **12.4 : 1** on this lane.
- **The 5-minute cache TTL lapses mid-run.** False - zero intra-run gaps over 5 minutes. The cold band
  is *between* runs, which still argues for `DELTA_CACHE_TTL=1h`, but for a different reason.

### Not ours, worth telling Aperture

`aperture__qs_save_artifact` failed **26 of 148 calls (17.6%)**; `aperture__qs_start` 15 of 153 (9.8%).
The agent recovers, which is why it went unnoticed, but each failure costs a visible turn.

## P2 - open, unchanged

- **Connect: stream the reply text itself.** 0.5.0 ships rich rendering and a live progress line but
  deliberately not the answer as it is written.
- **Connect: the intake 409 durability gap.** The cheap fix would tell someone their value was saved
  when a different value is in the vault, so it waits for a real answer.
- **Harness 0.3.0 self-extension**, **Connect 0.6.0 self-extension edge.** Earn-it, deferred.
- **Semver drift.** `src/version.ts` documents additive = MINOR; 0.2.7 through 0.2.11 all shipped
  additive work as third-digit bumps. **0.2.12 is additive too** - this release is the moment to
  either follow the doc or change it.
- **`npm deprecate`** `@carrara-labs/delta-connect@0.4.0` and `@0.4.1`. Needs Nic's npm auth.

## Standing practice, earned this round

- **Name the consumer who will see nothing** in every release brief. Aperture's own note; it saved
  them a five-release wild goose chase.
- **Report the quality gate before any cost number.** A run that gets cheap by losing rows is not a
  win, and this release produced exactly that failure before the guard landed.
- **Verify a regression test fails without its fix.** Two of this release's did; both were kept for
  that reason rather than assumed.
- **Live-test the thing reviews cannot see.** Five source-reading review rounds passed the marker
  design. The first real agent broke it.

## Shipped - Harness 0.2.11 "Context economics" (2026-08-03)

The cache-breakpoint fix, the compaction-tail fix, `prompt_cache_key` on the OpenAI-compatible wire,
and the `max_tokens` deprecation. Published to npm + ghcr; Ferni is on it and the site is deployed.
Specs: `spec-cache-breakpoints.md`, `spec-compaction-tail.md`.

## Next - fleet upgrade, then what 0.2.11 deliberately left

1. ~~**Aperture QS lab lane to 0.2.11**, then the rest of QS, then Intake.~~ **DONE 2026-08-10** -
   the fleet went straight to 0.2.14, all 12 lanes.
2. **Meeting Processor last**, as a beneficiary of a proven fix, never as a testbed. Still open.
3. ~~**Anthropic's block-count cache lookback.**~~ **THIS WAS THE 1-IN-25 CACHE MISS.** Filed here
   as an optimisation since 0.2.11, carried through three releases, and never once tested as the
   suspect while four other mechanisms were proposed and killed. It was written down correctly the
   whole time: *"a turn with many parallel tool calls can still miss the previous cached tail."*
   **Fixed 2026-08-10** (`rollingMarks`): our two rolling breakpoints landed ONE block apart on
   every tool burst, sharing a single 20-block lookback window instead of starting two, so ~10
   parallel calls outran both. Live: turn-2 `cacheRead` 2,522 → 10,206 at width 12, byte-identical
   at width 4. See `results-breakpoint-spacing-live.md`.
   **The lesson is about the backlog, not the cache:** a mechanism sitting in a to-do list is not
   being considered. When a defect resists explanation, re-read the list for something already
   described that nobody has ruled out.
4. **Budget pre-flight headroom.** A `$10` cap produced `$12.02`.
5. **Idle compaction** (Hermes' `_should_idle_compact`) - compact while idle rather than only under
   pressure. Needs a scheduler hook and has its own failure modes.

## P1 - leapfrog + robustness fast-follows

- **Connect - stream the reply text itself.** 0.5.0 ships rich rendering and a live "what I am
  doing" line, but deliberately not the answer as it is written: only a step with no tool calls
  becomes the answer, so the model's narration can claim things that are never sent, and the token
  deltas are not persisted so it needs a live SSE per task with its own abort and restart story.
  Worth doing on its own terms, not folded into a rendering release.
- ~~Harness - spill demotion.~~ **SHIPPED in 0.2.11**, at the compaction commit rather than per
  turn, so it costs no extra prefix-cache churn.
- **Harness - subagent reliability.** `spawn_subagent` returned "(no output)" on a big extraction
  task, which pushed Ferni onto the costly direct-`web_fetch` path.
- **Connect - the intake 409 durability gap.** If the vault write commits but its response is
  lost, the retry hits the create-only 409 and neither the confirmation nor the agent note fires,
  so a stored credential looks like a failure. Codex found it during the 0.4.3 review. Deliberately
  NOT fixed there: the cheap fix (treat 409 as success) would tell someone their value was saved
  when a different value is in the vault. Wants a real answer, so it waits for a batch.

## P2 - self-extension frontier (earn-it, deferred)

- **Harness 0.3.0 - self-extension.** Gated self-wiring MCP (curated registry + name-referenced key
  + runtime commit) + skill authoring (`create_skill` validated write-rail). The vault's
  name-referenced credentials are the prerequisite this was waiting on.
- **Connect 0.6.0 - self-extension edge.** One-time-link secret fallback + a self-wiring
  approve/confirm surface. Needs H0.3.0.

## Cross-cutting

- **Cookbook - autonomous agent setup (Ferni-style).** Update
  `reference_telegram_assistant_recipe` + the cookbook doc so a new Ferni-style agent is configured
  to survive heavy loads from day one (async delivery, utility model, heavy-run POLICY, compaction
  tuning, the subagent caveat), and now the vault + intake wiring.
- **Semver drift.** `src/version.ts` documents additive = MINOR, but 0.2.7 through 0.2.10 all
  shipped additive work as third-digit bumps. Connect has since gone the other way, taking 0.5.0
  for an additive release, so the two packages now disagree with each other as well as with the
  doc. Either the doc or the practice should move.
- **`npm deprecate` @carrara-labs/delta-connect@0.4.0 and @0.4.1.** Needs Nic's npm auth. Never
  `unpublish`.
- **Struck as stale:** "harness v4 live smoke, never run against a live daemon." That lineage
  landed - `retrieval.ts`, `research.ts` and `compaction.ts` are in `main` and Ferni has exercised
  them in production since 0.2.10.

## Recently shipped (context)

- **Connect 0.5.0** (2026-08-02) - rich streaming: replies render as Telegram Rich Messages
  (native tables, task lists, headings, code, math) by handing the agent's markdown to Telegram's
  own parser rather than our renderer, plus an ephemeral progress line naming the tool in flight,
  driven by the daemon's existing `?since=` event poll. Four codex passes (the first two returned
  DO-NOT-RELEASE) and live-verified on Ferni against the real Bot API. Corrects a claim this list
  carried: OpenClaw ships Rich Messages already, and Hermes ships rich drafts too, so this is
  parity done in far less code rather than a leapfrog.
- **Connect 0.4.3** (2026-08-02) - what Ferni was already running: the agent is told when a
  credential lands (no restart, and no more routing around a tool that started working),
  intra-word underscores stay literal so a credential name is never renamed by the renderer, an
  outcome-first confirmation, and the note attributed to the actual submitter. Ferni ran all four
  in production before the release; codex then found a double-underscore case
  (`mcp__brain__authenticate`) and a Unicode word-boundary case that live use had not hit.

- **Harness 0.2.10 + Connect 0.4.0** (2026-08-01) - the security track. Final combined battery
  passed 16/16 on a fresh agent running BOTH published artifacts. Encrypted secret vault
  (values never reach model-readable state; `{{vault:NAME}}` resolved at egress; exact-value
  redaction) and in-chat secure intake (Telegram Mini App form POSTing straight to Connect,
  initData-authenticated, single-use). On npm + ghcr; site live.

- **Harness 0.2.8 + Connect 0.3.1** (2026-08-01) - command-surface polish: `/status` plain English
## Found by the 0.2.13 canary (2026-08-08)

- **`calls` has NO retention.** `pruneLocalState` (`retention.ts`) bounds `journal` and `events` and
  nothing else, so the request-capture table grows unbounded. At Aperture's 115k-160k-token turns a
  captured request is roughly 0.5-0.7MB, so a 200-turn engagement is ~120MB against volumes that are
  1GB on nine of ten lanes and shared with the SQLite WAL. Anyone running `DELTA_CAPTURE_CALLS=1` on
  a real workload must pull and disable promptly. Sibling of the open spill-retention item and it
  should be fixed with it.
  **Measured on Ferni, 2026-08-10, and it had already happened to us:** 174 rows holding 16.5MB at
  ~95KB a call, 45% of a 36MB database on a 1GB volume, from a flag staged as TEMPORARY a week
  earlier and never pulled. Pruned by hand and the flag turned off. A diagnostic that has to be
  remembered will not be. **FIXED, unreleased (on `main`, 2026-08-10):** `pruneLocalState` bounds
  `calls` by age plus a BYTE budget (`DELTA_RETENTION_MAX_CALL_BYTES`, 32MB), not a row count,
  because a captured call is ~95KB on one lane and ~700KB on another. The newest call is always
  kept even when it alone exceeds the budget, so the bound can never discard the turn being
  debugged; overshoot is one call. **RELEASED in 0.2.14.**
- **`DELTA_CAPTURE_PAYLOADS` vs `DELTA_CAPTURE_CALLS` has now cost two engineers a day each** - once
  on our side, once on Aperture's, in the same week, in opposite directions. Partly mitigated in
  0.2.13: `/v1/dev/runs/:id/calls` now returns `capture_enabled` and, when empty, says *why* rather
  than returning a bare `[]` that reads as "this run made no calls". The names themselves are still
  the trap.
- **A 404 with an empty body reports `(empty error body)` with no status code.** Cost an hour
  locally when `MODEL_BASE_URL` lacked `/v1`. Include the HTTP status when the body is empty.
