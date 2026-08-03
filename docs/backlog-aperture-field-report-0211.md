# Backlog: Aperture field report on 0.2.11 → self-write breaker + operator visibility

Status: **filed, not scheduled.** Nothing here is a work order yet.

## Where this came from

The Aperture (ai-recruiter) engineer verified Harness **0.2.11** on 2026-08-03, then rolled it
fleet-wide the same day, and wrote back with findings. This document is that reply plus our own
verification of its code claims.

- **Source reply (verbatim):** `~/ai-recruiter/docs/research/harness-0211-verification-reply.md`,
  reproduced in full as the appendix below so this repo is self-contained.
- **What prompted it:** the verification brief we sent for the 0.2.6 → 0.2.11 jump (five releases),
  covering the lab-lane-first protocol, the compatibility audit, and the baselines to beat.
- **Their scope:** lab lane (google-deepmind QS) 18-run battery, then carrara QS canary, then a
  live smoke on every QS lane and healthz/status on the intake lanes. All 8 lanes across 5
  workspaces plus both provisioning manifests now on 0.2.11.
- **Their verdict:** PASS on all four criteria. Cost/run $2.12 vs $2.18 baseline, p50 13.7s vs
  14.9s, p95 53.1s vs 55.8s, cache 91.8% token-weighted vs 92.7% (noise), zero
  `context_irreducible`, zero fallbacks, 18/18 succeeded. Post-rollout sweep: all failure counters
  zero, cache 90-93% weighted on every lane.

Related: `project_harness_0211_fleet_verify` (memory), `reference_fleet_review`,
`spec-compaction-tail.md`, `spec-cache-breakpoints.md`.

---

## 1. The self-write breaker cuts off CONVERGING compaction attempts

**Verified against source.** Real.

Their carrara QS lane's DELTA.md hit its 1,600-token (6,400-byte) cap after five days of
self-learning. Two independent runs, same shape:

- run A: 7,975 → 6,956 → 6,813 bytes, then the breaker latched at 3.
- run B: 6,654 → 6,482 → 6,445 against a 6,400 cap, then latched. **45 bytes short and shrinking
  monotonically when it was cut off.**

`STORM_CLASSES` at `src/run.ts:1191` contains `self_cap`, and `breakerKey` collapses every cap
refusal to the constant key `[class] self_cap` — *precisely because* the byte counts vary and would
otherwise defeat equality matching. That was the correct fix for the 2026-07-30 effort lab's
grinding storm (100+ same-cause refusals, ~$10 of waste, never latching). But it discards the only
signal that separates grinding from converging. The breaker cannot tell 6,654 → 6,482 → 6,445 from
the same refusal three times.

**This is the same bug class as the compaction bug 0.2.11 just fixed:** progress measured by a
proxy instead of by the quantity that actually matters. Hermes' `_compression_made_progress`
demands a material token reduction rather than a row-count proxy; we needed that discipline in
compaction and we need it here. Two instances of one lesson in one release cycle.

### Correction to their proposed fix

They suggest exempting monotone-shrinking `self_cap` sequences from the 3-strike latch. **We should
not implement that as stated.** It is unbounded: an agent shedding one byte per attempt never
latches and grinds forever, which is exactly the failure the breaker exists to stop.

The rule should be **material convergence**, the same shape as the compaction fix: an attempt
resets the streak only if it closes a meaningful fraction of the remaining gap to the cap, and a
hard ceiling on total attempts stays in place regardless. Run B closes 88% of its gap in three
tries and sails through; a one-byte-per-try grind still latches at 3.

Run B is a reproducible test case handed to us for free.

### What went right (worth preserving)

Their words: the agent's failure behavior was excellent. Refusal messages carry landed-size vs cap,
and *that detail is what made its attempts converge*. When latched it wrote itself pending-merge
files in the workspace with a compaction plan and executed byte-budgeted rewrites the next run.
The rail's error-as-value design made that possible. Any fix must keep the byte counts in the
message.

They unjammed it by raising the cap to 2,400 tokens (the deliberate manifest drift already recorded
for the carrara and GDM QS lanes).

## 2. Self-file fullness is invisible to the operator surface

**Verified against source.** Real, and slightly more work than they estimate.

47 `self.pressure` events on one lane, discoverable only by querying the collector. They ask for
`self: {bytes, cap}` on `/v1/status` next to model, budget and vault.

We already compute exactly `{bytes, cap, elided}` at `src/run.ts:313` for the `self.pressure`
event, so the data exists. But `/v1/status` is served from the **boot-config snapshot** and self
bytes are computed **per run**, so this cannot be another snapshot field. It needs a live read, the
way `vault` already reads live off `opts?.vault` at `src/server.ts:~437`. Still cheap.

Their supporting argument is the strong part: fullness was the single best predictor of degraded
self-learning in their fleet.

## 3. `/v1/status` reports the raw profile alias, docs say canonical

**Verified against source.** Real, one-line.

`src/server.ts:430` returns `profile: c.profile` verbatim, so `DELTA_PROFILE=work` reports
`"work"`. The 0.2.7 changelog and the guide both say status reports the canonical name
(`trusted`). `getProfile()` already resolves through `ALIASES` at `src/profiles.ts:49` and carries
the canonical `name`. Behavior is fine, the alias resolves; this is a docs-vs-wire disagreement.

## 4. A data point for the parallel-tool cache caveat

**No action. Keeps the caveat where it is.**

One 19% cache-hit call at 76k input tokens mid-run, sandwiched between 90%+ calls, consistent with
the bounded-lookback miss we shipped as a known caveat. **One clear case in 357 calls.** That is
the evidence needed to keep it on the backlog rather than promote it, and it confirms the caveat
paragraph in the release brief did its job.

## 5. Watch item: intake lanes now send `prompt_cache_key`

**No action yet.** Their intake lanes are OpenRouter-primary, so 0.2.11's `prompt_cache_key` fix
lands exactly on that wire. Baseline cache 79.0%, low enough that a real gain would be visible.
They will report once real intake traffic accumulates.

---

## The non-bug takeaway

Their opening: our expectation-setting "was exactly right and saved us a wild-goose chase" — that
QS would show no cache gain because it never emitted the derived blocks (the win is Ferni-shaped),
and that compaction never fires at their 200k threshold.

One paragraph of honesty about **who wins what** bought a clean verification on a five-release jump
with zero back-and-forth. Make it standard in every consumer-facing release brief: name the
consumer who will see nothing, before they go looking for it.

Also validated: the bump ergonomics (image-only machine update, healthz version, `/v1/busy` gate,
`/v1/status` verification) went 8 for 8 with zero surprises, and both compatibility notes we
audited (HTTP MCP transport unaffected by the 0.2.10 stdio change, `work` still valid as an alias)
checked out in the field.

---

## Appendix: the source reply, verbatim

> # Re: Harness 0.2.11 - verified, rolled fleet-wide, field notes
>
> *Reply to the harness engineer's verification brief, 2026-08-03. Sent after the lab verification
> AND the full fleet rollout, same day.*
>
> ## What we ran
>
> Your protocol, then the full rollout in your order:
>
> 1. Lab lane (google-deepmind QS): image-only bump, full 18-run battery (12 searches across four
>    difficulty tiers + 6 tool-heavy follow-ups) through the real app. **PASS on all four
>    criteria**: cost per run $2.12 vs $2.18 baseline, p50 13.7s vs 14.9s, p95 53.1s vs 55.8s,
>    cache 91.8% token-weighted vs 92.7% (within noise), zero `context_irreducible`, zero
>    fallbacks, 18/18 succeeded.
> 2. Carrara QS canary + a live search smoke on every QS lane (all succeeded with artifacts,
>    169-722s wall), intake lanes healthz/status-verified. All 8 lanes across 5 workspaces now on
>    0.2.11, both provisioning manifests too. Post-rollout sweep: all failure counters zero, cache
>    90-93% weighted on every lane.
>
> Your expectation-setting was exactly right and saved us a wild-goose chase: QS shows no cache
> gain because it never emitted the derived blocks (the win is Ferni-shaped), and compaction never
> fires at our 200k threshold. Both compatibility notes (HTTP MCP, `work` alias) checked out. The
> bump ergonomics were excellent: image-only machine update, healthz version, `/v1/busy` gate,
> `/v1/status` verification - 8 for 8 with zero surprises.
>
> ## Field findings, in priority order
>
> ### 1. The self-write breaker cuts off CONVERGING compaction attempts
>
> The best data of the day. Our carrara QS lane's DELTA.md hit its cap (1,600 tokens = 6,400 bytes)
> after five days of self-learning, and we got to watch the remember rail under sustained real
> pressure across three jammed runs. Two independent runs show the same shape:
>
> - run A: rewrite attempts landed 7,975 -> 6,956 -> 6,813 bytes, then the categorical breaker
>   latched at 3.
> - run B: 6,654 -> 6,482 -> 6,445 vs cap 6,400, then latched. **It was 45 bytes short and
>   converging monotonically when the breaker cut it off.**
>
> The storm-latch is doing its job against repeated identical refusals, but a cap-refusal sequence
> with strictly DECREASING landed sizes is not a storm - it is an agent binary-searching its way
> under the cap and almost there. Suggestion: exempt monotone-shrinking `self_cap` sequences from
> the 3-strike latch (or give them a couple more strikes). One more attempt would have ended the
> jam two runs earlier.
>
> Worth knowing: the agent's failure behavior was actually excellent. The refusal messages carry
> landed-size vs cap (that detail is what made its attempts converge), and when latched it wrote
> itself pending-merge files in the workspace with a compaction plan and executed byte-budgeted
> rewrites next run. The rail's error-as-value design made that possible. We unjammed it by raising
> the cap to 2,400 tokens; its own backlog merge is now pending.
>
> ### 2. Self-file fullness is invisible to the operator surface
>
> 47 `self.pressure` events on one lane and we only knew because we queried the collector.
> `/v1/status` already reports model, budget, and vault - adding `self: {bytes, cap}` would let a
> fleet dashboard watch fullness without SSH-ing into machines. Cheap and high-value: fullness
> turned out to be the single best predictor of degraded self-learning.
>
> ### 3. `/v1/status` reports the raw profile alias, docs say canonical
>
> With `DELTA_PROFILE=work`, status returns `profile: "work"` while the 0.2.7 changelog and guide
> both say the canonical name (`trusted`) is what status reports. Behavior is fine (the alias
> resolves); it is a docs-vs-wire disagreement. `src/server.ts` returns `c.profile` verbatim rather
> than the resolved profile's `name`.
>
> ### 4. A data point for your parallel-tool cache caveat
>
> During a tool-heavy battery run we observed a 19% cache-hit call at 76k input tokens mid-run,
> sandwiched between 90%+ calls - consistent with the bounded-lookback miss you flagged as the
> known caveat. Confirms it is real but rare in our mix (one clear case in 357 calls). Fine to keep
> on the backlog; not hurting us at QS volumes.
>
> ### 5. Watch item: intake lanes now send `prompt_cache_key`
>
> Our intake lanes are OpenRouter-primary, so the 0.2.11 `prompt_cache_key` fix lands exactly on
> their wire. Baseline cache was 79.0% - we will report whether it moves once real intake traffic
> accumulates. If it climbs, that is your fix's second win in our fleet.
>
> Thanks again - the release note's honesty about who wins what made this the easiest verification
> we have run.
