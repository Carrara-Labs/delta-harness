# Harness 0.2.14 — "the second breakpoint"

Status: **PUBLISHED 2026-08-10.** Written 2026-08-10.

**The release changed shape twice in one day.** It was scoped as a diagnostic ("name the miss"),
codex returned NO-GO on that instrument, and then the mechanism was found by enumerating our own
breakpoint walker: the two rolling `cache_control` marks land one block apart on every parallel tool
burst, sharing a single 20-block lookback window instead of starting two, so ~10 parallel tool calls
re-bills the whole prefix. Measured live at 4.8x cheaper on an affected turn, byte-identical below
the threshold. Evidence: [`results-breakpoint-spacing-live.md`](./results-breakpoint-spacing-live.md).

So 0.2.14 leads with a **fix**, not an instrument, and the diagnostic work shrinks to a supporting
role. That is a materially easier case for a consumer being asked to spend an expensive upgrade.

Specs: [`spec-cache-break-correlator.md`](./spec-cache-break-correlator.md) ·
[`spec-capability-prose-lock.md`](./spec-capability-prose-lock.md).
Evidence: [`research/competitor-cache-instrumentation-2026-08-10.md`](./research/competitor-cache-instrumentation-2026-08-10.md).

## The scoping constraint that shapes this release

**Aperture is on 0.2.11 and is holding for 0.2.14.** They skipped 0.2.12 (never published) and
canaried but did not deploy 0.2.13. A lane upgrade costs them real time, so they are spending it
once.

That makes 0.2.14 a **cumulative release, not an incremental one**, and the brief must be written
for an 0.2.11 → 0.2.14 jump. Scoping the contents against a 0.2.13 diff would be scoping against a
baseline no consumer is actually on. Ferni is the only lane on 0.2.13.

Two consequences:

1. **The release must be worth one trip.** Anything Aperture would predictably need within a month
   should be in it, because the next upgrade is another negotiation.
2. **The migration is the 0.2.13 migration.** Crossing 0.2.11 → 0.2.14 takes the one-way schema step
   (v14 → v15, 28 to 30 migrations) that 0.2.13 introduced. Nothing about 0.2.14 makes that cheaper
   or reversible.

## What Aperture actually receives

Most of the value is already built. This is the honest ledger for their jump, not a changelog for
the new work.

### Already shipped, waiting for them (0.2.12, absorbed into 0.2.13)

| item | their ask |
| --- | --- |
| S1 argument eviction with an index and a pointer back | #1 |
| S4 concurrent `spawn_subagent` budget as a live reservation | #4 |
| S5 self-write breaker latches on converging attempts | #5 |
| S6 self-file fullness on `/v1/status` | #6 |
| S6 `/v1/status` reports the raw profile alias | #7 |
| S7 `demoted_only` on the compaction event | explicit request |
| **S9 parallel sub-turn resume** — a crash mid-batch silently stranded uncommitted calls, forever | they could not have known |
| the marker-echo bug, found on a live run after five review rounds passed the design | they could not have known |

Measured on both arms, same work (10 pages / 120 records / 0 corrupt): **5 compactions to 0**, input
tokens **-29.9%**, peak call **-26.2%**, cost **-36.5%**. One run per arm against a nondeterministic
model, so indicative rather than conclusive.

**One correction that must reach the brief: S1 argument eviction is OPT-IN.**
`DELTA_TOOL_ARG_MAX_BYTES` defaults to zero, so a lane that upgrades without a configuration change
receives **none** of that token reduction. Presenting the measured numbers as something they get by
upgrading would be false. The brief must ship a configuration diff, not just a version number.

### Already shipped, waiting for them (0.2.13)

**S5 is the one that matters for them and it is a correctness fix, not an optimisation.** They
measured 0.2.12 compacting 8 times, still hitting `context_irreducible` 5 times, and overrunning
their own 60k ceiling by 18%. On 0.2.13: **4 compactions, all shrinking, zero errors, peak under the
ceiling.** No effect below a ~33k ceiling.

Plus S1 segmented prefix identity, S2 the silent non-shrinking compaction attempt, S3 `model.call`
for utility-tier calls, S6 the pricing `window` column, S7 `last_event_ms_ago` on `/v1/busy`.

### New in 0.2.14

**Revised 2026-08-10 after a codex pass returned NO-GO on the first draft.** What changed is recorded
in full at the end of this document; the table below is the corrected scope.

| # | item | why it is in this release |
| --- | --- | --- |
| 1 | **contiguous rolling breakpoint windows** — the mechanism behind the 1-in-25 miss, found and measured | their defect, 27/27 on their lane, unexplained for three releases. **This is the headline** |
| 2 | **`calls` bounded by age and bytes** (`DELTA_RETENTION_MAX_CALL_BYTES`, 32MB) | at ~700KB/call a 200-turn engagement is ~120MB against 1GB volumes shared with the WAL |
| 3 | `min(prev, current)` bound on `cache_shortfall_tokens` | a turn that shrank reported a large false shortfall, and compaction is what makes turns shrink |
| 4 | child capability prose locked to the enforced filter by test | stops the class of defect that made their sub-agent docs wrong for ten releases |
| 5 | schedule read paths carry the control server's reason | an agent filed a blocker on a bare `409` |
| 6 | empty provider error bodies carry their status; a 404 names the missing `/v1` | cost an hour locally, and no competitor has this |

Items 2, 5 and 6 are **already on `main`**, built and tested, unreleased.

**The cache-miss correlator is NOT in this release.** It was the headline of the first draft; codex
showed its fire condition would have missed the very events it was built for, and then the mechanism
was found without it. `cache_shortfall_tokens` stays as the field signal, corrected.

**Cut from the draft after review:**

- **`sweepSpill` — reverted, not deferred.** A 7-day mtime sweep of `.delta/spill` would have
  destroyed recoverable output on Aperture's first boot. A spill path's reference set is every
  message row that mentions it, and `recall` surfaces compacted rows as well as live ones. Reverted
  the same day with a regression test; the item stays open in `shipping-list.md` and needs a real
  lifecycle rather than a timer.
- **Emitted-byte `wire` hashing — removed as dead code.** Both serializers are deterministic given
  identical inputs, so the hash cannot move when the assembled digest does not. Worse, on the
  OpenAI-compatible path there is no `body.system` at all (the system lives inside `body.messages`),
  and that is the route Aperture's canary actually ran.
- **`ToolDef.readonly` required — deferred.** Blast radius across every builtin, synthetic tool and
  fixture, with no immediate Aperture benefit. The default already fails closed: only a literal
  `readonly === true` is admitted. Compile-time requiredness proves someone typed a boolean, not
  that the boolean is right.

## What is deliberately out

| item | why not now |
| --- | --- |
| ~~**the mechanism fix**~~ | **FOUND AND SHIPPED.** The fifth candidate was not a guess: it was the shipping-list item "Anthropic's block-count cache lookback", described correctly since 0.2.11 and never tested as the suspect. Confirmed by the vendor's own docs and measured live |
| **TTL-gated two-stage prune** (OpenClaw's) | a complete validated design worth porting, but it interacts with compaction and they shipped two double-compaction bugs at exactly that seam. Its own release |
| **persist and reuse the spine bytes** (Hermes') | structurally makes the miss impossible rather than observable, which is better, but it is a rebuild of how the spine reaches the wire |
| **heartbeat just under the cache TTL** | a real cost lever, but it belongs to Connect and the lane config, not the engine, and Aperture's burst shape benefits least |
| **request capture below the serializer** | gated on the correlator returning `none` at a meaningful rate. Building it now would be the fourth instrument bought on analogy rather than evidence |
| **effort inheritance**, **opt-in MCP mount** | **DEFERRED to 0.2.15, and this reverses the earlier call.** They were moved in when 0.2.14 was a diagnostic that needed justifying. It is now a measured fix for the exact defect the waiting consumer escalated, which justifies the trip by itself. Each independently changes cost/latency or act-as authority and needs its own brief. Codex agreed on the second pass |

## Semantics that break dashboards

Carried forward from 0.2.13 and **still new to anyone on 0.2.11**:

- `model.call` now includes utility-tier calls. Filter `tier = 'main'` to restore the old meaning.
- `compaction` counts **attempts**, not rewrites. Filter `shrank = true`.
- `cache_hit_pct` is retired as a health metric. It is a ratio with a moving denominator and reads
  59% to 100% on a byte-identical prefix. Score on `cache_shortfall_tokens`.

## Who sees nothing

Standing practice, and Aperture's own note earned it: **name the consumer for whom this changes
nothing.**

A lane that does not run request capture, does not use sub-agents, never hits a schedule error, and
whose prefix is already stable sees **no change in cost, latency, or behaviour**. The correlator
fires only on a confirmed cache-read drop. On a healthy lane it is silent, and silence is the
correct output.

Nothing in this release makes a healthy lane faster or cheaper. Anyone told otherwise should ask for
the number.

## Version

PATCH, and consistently so: `version.ts` reserves MINOR for additive changes at the **seam**, and
optional config (`DELTA_RETENTION_MAX_CALL_BYTES`), telemetry events (`cache.break`, `cache.stable`)
and forward-only migrations are named as riding PATCH in a 0.2.x line.

Note the asymmetry worth flagging in review: **0.2.14 itself adds no migration** (the diff from
`v0.2.13` does not touch `src/db.ts`), so 0.2.13 → 0.2.14 is reversible. 0.2.11 → 0.2.14 is not,
because of the step 0.2.13 already took.

## Release gate

Unchanged and non-negotiable: `bun run lint && bun run typecheck && bun test && bun run build`, then
`scripts/smoke.sh` against a live wire, then **deploy from source to a real agent and finish the
human-in-the-loop test before publishing**. `bun test` alone does not catch the discriminated-union
narrowing errors that gate the tag; that happened on 2026-08-10.

Then a codex pass. "Proven in production" has never once substituted for it.

After publishing: redeploy **without** `--from-source` so the lane runs the released packages, and
run the post-release battery against the published tarball.

## Open risks

1. **The correlator may return `none`.** If the prefix is stationary, the emitted bytes are
   stationary, and the cache still breaks, we will have built an instrument that proves the cause is
   somewhere else. That is a real possible outcome and it is still progress, because it is the first
   result that would justify capture on evidence.
2. **Thresholds are borrowed.** 0.95 and 1000 tokens come from OpenClaw and are unvalidated on our
   shape. Expect the first Aperture reading to retune them.
3. **Making `ToolDef.readonly` required touches every tool definition.** Mechanical, but it is the
   largest blast radius in the release and the part most worth a review pass.
4. **Aperture's upgrade is one-way, and "a snapshot exists" is not the gate.** Take the whole `/data`
   volume, and remember `DELTA_WORKSPACE` is not `/data/workspace` everywhere and a sleeping lane
   fails `fly ssh` in a way that reads like a broken lane. Then **grep the archive for `DELTA.md`**.
   Then do the part the previous procedure omitted: **restore it and boot 0.2.11 against it.** For a
   migration with no reverse, a restore-and-boot drill is the only evidence that the rollback path
   exists at all (codex).
5. **The resolved context ceiling changed after 0.2.11.** The derived and clamped ceiling can move
   compaction timing materially at 115k-160k turns. The canary must record the exact provider
   cascade and the *resolved* ceiling, not merely that the binary started.
6. **First-boot pruning writes a large WAL** while deleting old ~700KB captures, and deletes do not
   shrink the already-allocated database file (the sweep relies on freelist reuse and does no
   `VACUUM`). It bounds future growth; it does not hand 120MB back to a full volume. A lane already
   near its volume limit needs that reclaimed by other means before upgrading.

## Review record — codex, 2026-08-10, verdict NO-GO on the first draft

Kept here rather than summarised away, because two of the findings were defects already sitting on
`main` and the reasoning that produced them is the part worth remembering.

**Two bugs, both mine, both from the previous week, both fixed the same day:**

1. **`sweepSpill` would have deleted live data.** I answered the reference-lifecycle objection
   against the wrong horizons. `queue.ts` already carried a comment, at the one place that deletes
   spill, stating that durable sessions depend on those files surviving across runs. The code told
   me and I shipped past it. Reverted, with a test locking the boot sweep out of the directory.
2. **The byte budget counted characters.** SQLite `LENGTH()` on TEXT returns characters, so
   `DELTA_RETENTION_MAX_CALL_BYTES` under-counted a multi-byte payload by up to ~3x. Now
   `LENGTH(CAST(... AS BLOB))`. **My live end-to-end verification passed because the test data was
   ASCII** — a reminder that "verified on a real daemon" and "verified" are different claims.

**Three design errors in the spec:**

3. The `wire` hash cannot fire for the observed defect (deterministic serializers), and references a
   `body.system` that does not exist on the affected route.
4. The fire condition compared `cacheRead` against the previous `cacheRead`. The observed misses
   were 466, 4,993 and 7,172 tokens; against a 115k-160k prefix the 5% gate never fires on the first
   two. **The instrument would have missed the events it was built for.** The correct form is the one
   already shipped: `min(prevGross, currentGross) - cacheRead`, flat 1024 floor, no ratio gate.
5. The spec described `prefix` as riding `turn.start`; it rides `model.call`. And `provider` /
   `fallback` cannot be in an inbound snapshot at all, because the serving provider is unknown until
   the failover cascade returns.

**One thing worth more than the review:** Anthropic ships a **cache diagnostics** beta that reports
`model_changed` / `system_changed` / `tools_changed` / `messages_changed` against a previous response
id, with no raw prompt storage. If it behaves as documented on our native path, the provider answers
the question the correlator was built to infer. It is not a complete answer — Aperture's
OpenRouter-primary lane may not expose it — so it is a native-path supplement, not a replacement.

**Independent of the review**, a static enumeration of our own rolling-breakpoint walker found that
both marks land 1 block apart on any parallel tool burst, and that at a burst width of ~16+ the
previous turn's marks fall outside Anthropic's documented 20-block lookback. The second mark exists
specifically to survive that case (`provider.ts:1152-1155`, codex #7) and does not. This is the
shipping-list item "Anthropic's block-count cache lookback", open since 0.2.11 and never tested as
the mechanism. It is hypothesis five and it is not confirmed; the live test is a provoked wide-burst
turn on Ferni, with the prediction stated in advance that the following turn's cache read collapses.
