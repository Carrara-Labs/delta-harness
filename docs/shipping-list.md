# Delta shipping list (as of 2026-08-07, 0.2.12 built and unreleased)

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

1. **The `#8` docs convention.** Promised to Aperture and still unwritten: operator reference
   material is pointed at, not resident. Cheap, and it stops the next consumer inventing a fifth
   bundle file and shipping a pointer to nothing.
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

## P1 - next release (0.2.13) "say what changed"

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
- **Spill retention.** `sweepTrash` only touches `.delta/trash`, so `.delta/spill` has never been
  pruned, on lanes where nine of ten volumes are 1GB shared with the SQLite WAL. Deliberately NOT in
  0.2.12: pruning a file an already-written stub still points at turns a bounded promise into a lie,
  and getting that right needs the reference-lifecycle design codex showed is not trivial.
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

## Shipped — Harness 0.2.11 "Context economics" (2026-08-03)

The cache-breakpoint fix, the compaction-tail fix, `prompt_cache_key` on the OpenAI-compatible wire,
and the `max_tokens` deprecation. Published to npm + ghcr; Ferni is on it and the site is deployed.
Specs: `spec-cache-breakpoints.md`, `spec-compaction-tail.md`.

## Next — fleet upgrade, then what 0.2.11 deliberately left

1. **Aperture QS lab lane to 0.2.11**, then the rest of QS, then Intake. Beneficiary and volume rig
   in one.
2. **Meeting Processor last**, as a beneficiary of a proven fix, never as a testbed.
3. **Anthropic's block-count cache lookback.** Demotion shrinks a tool result's size, not its block
   count, so a turn with many parallel tool calls can still miss the previous cached tail.
4. **Budget pre-flight headroom.** A `$10` cap produced `$12.02`.
5. **Idle compaction** (Hermes' `_should_idle_compact`) — compact while idle rather than only under
   pressure. Needs a scheduler hook and has its own failure modes.

## P1 — leapfrog + robustness fast-follows

- **Connect — stream the reply text itself.** 0.5.0 ships rich rendering and a live "what I am
  doing" line, but deliberately not the answer as it is written: only a step with no tool calls
  becomes the answer, so the model's narration can claim things that are never sent, and the token
  deltas are not persisted so it needs a live SSE per task with its own abort and restart story.
  Worth doing on its own terms, not folded into a rendering release.
- ~~Harness — spill demotion.~~ **SHIPPED in 0.2.11**, at the compaction commit rather than per
  turn, so it costs no extra prefix-cache churn.
- **Harness — subagent reliability.** `spawn_subagent` returned "(no output)" on a big extraction
  task, which pushed Ferni onto the costly direct-`web_fetch` path.
- **Connect — the intake 409 durability gap.** If the vault write commits but its response is
  lost, the retry hits the create-only 409 and neither the confirmation nor the agent note fires,
  so a stored credential looks like a failure. Codex found it during the 0.4.3 review. Deliberately
  NOT fixed there: the cheap fix (treat 409 as success) would tell someone their value was saved
  when a different value is in the vault. Wants a real answer, so it waits for a batch.

## P2 — self-extension frontier (earn-it, deferred)

- **Harness 0.3.0 — self-extension.** Gated self-wiring MCP (curated registry + name-referenced key
  + runtime commit) + skill authoring (`create_skill` validated write-rail). The vault's
  name-referenced credentials are the prerequisite this was waiting on.
- **Connect 0.6.0 — self-extension edge.** One-time-link secret fallback + a self-wiring
  approve/confirm surface. Needs H0.3.0.

## Cross-cutting

- **Cookbook — autonomous agent setup (Ferni-style).** Update
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

- **Connect 0.5.0** (2026-08-02) — rich streaming: replies render as Telegram Rich Messages
  (native tables, task lists, headings, code, math) by handing the agent's markdown to Telegram's
  own parser rather than our renderer, plus an ephemeral progress line naming the tool in flight,
  driven by the daemon's existing `?since=` event poll. Four codex passes (the first two returned
  DO-NOT-RELEASE) and live-verified on Ferni against the real Bot API. Corrects a claim this list
  carried: OpenClaw ships Rich Messages already, and Hermes ships rich drafts too, so this is
  parity done in far less code rather than a leapfrog.
- **Connect 0.4.3** (2026-08-02) — what Ferni was already running: the agent is told when a
  credential lands (no restart, and no more routing around a tool that started working),
  intra-word underscores stay literal so a credential name is never renamed by the renderer, an
  outcome-first confirmation, and the note attributed to the actual submitter. Ferni ran all four
  in production before the release; codex then found a double-underscore case
  (`mcp__brain__authenticate`) and a Unicode word-boundary case that live use had not hit.

- **Harness 0.2.10 + Connect 0.4.0** (2026-08-01) — the security track. Final combined battery
  passed 16/16 on a fresh agent running BOTH published artifacts. Encrypted secret vault
  (values never reach model-readable state; `{{vault:NAME}}` resolved at egress; exact-value
  redaction) and in-chat secure intake (Telegram Mini App form POSTing straight to Connect,
  initData-authenticated, single-use). On npm + ghcr; site live.

- **Harness 0.2.8 + Connect 0.3.1** (2026-08-01) — command-surface polish: `/status` plain English