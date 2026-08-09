# Aperture answers the 0.2.12 reply

2026-08-06, from the Aperture engineer. Answers `docs/reply-aperture-0.2.12.md`.
Everything below is queried from the `agent_events` collector on the Aperture prod DB, on the two
task ids you named.

## Short version

You asked for one query and got three readings. Two land where you expected. The third is
unanswerable because the attribute is not exported, and that is worth a line in the batch.

**Schema bulk is not your suspect.** The fixed floor on these lanes is about 16k tokens, not 110k.
Your 60k threshold is not close, and you should not grow a tool-schema item on our account.

**One thing neither of us named is doing most of the damage**, and it changes how you should score
S1: compaction detonates the prefix cache, and the reload afterwards is the bill.

Volumes and run B's byte sequence are at the bottom.

## Reading 1: turn 1 is identical on both runs, and it is not `fixed`

| | speed-lab, 275 rows | google-deepmind, 119 rows |
|---|---|---|
| turn-1 `input_tokens` | 109,809 | 109,928 |

119 tokens apart, 0.11%. That is the result you expected: the floor is the same on both lanes and
the tail is the variable.

It is not the fixed floor. Ordinary quick-search runs on these same lanes start much lower. Sample
from the 45 most recent runs across all five workspaces:

| lane | agent | turn-1 `input_tokens` |
|---|---|---|
| carrara | quick-search | 21,207 / 21,173 / 20,997 / 21,136 / 20,667 / 19,375 / 18,930 |
| speed-lab | quick-search | 20,301 / 19,707 / 19,767 / 19,015 / 18,997 / 18,674 |
| google-deepmind | quick-search | 20,757 / 19,317 / 18,940 / 18,584 / 18,578 |
| carrara | intake-call | 13,490 / 13,487 / 13,487 / 13,372 / 13,350 |
| **the two roster runs** | quick-search | **109,809 / 109,928** |

The fixed prefix is directly measurable, not inferred. On all five post-compaction calls in the
speed-lab run, `cached_tokens` is exactly **15,885**, the same constant every time. That is the
spine plus the full `aperture__*` schema set plus the four bundle files. Our `TOOLS` block in
`app/routes/api.mcp.ts` is 24 tools and 36,671 bytes of source, so schemas are roughly 9 to 10k
tokens of that 15,885.

So the answer to your question is: the schemas are not eating the budget, and the batch should not
grow a tool-schema item. The extra ~91k that both roster runs carry at turn 1 is the run's own
opening payload, which arrives as a user message and is therefore history from turn 1, not fixed.
Both runs were seeded from the same bench fixture, which is why they agree to 0.11%.

The three outliers in the same 45-run sample (221,055 / 140,669 / 120,692, all carrara
quick-search) are large-opening-payload runs too. The floor is flat; the openings are not.

## Reading 2: after compaction, still at the ceiling. Every time.

Five compactions, five `context_irreducible` errors, one run.

| compaction | before | `compacted_turns` | `kept` | `summary_tokens` | next call `input_tokens` |
|---|---|---|---|---|---|
| t14 | 228,253 | 23 | 69 | 1,451 | 214,122 |
| t15 | 214,122 | 8 | 65 | 869 | 203,352 |
| t17 | 216,841 | 6 | 66 | 2,525 | 212,155 |
| t19 | 225,623 | 24 | 49 | 2,365 | 217,109 |
| t20 | 217,109 | 7 | 46 | 2,964 | 210,312 |

The t19 row is the clearest one: 24 turns compacted, down to 49 retained rows, and the request fell
3.8%. The last one keeps 46 rows and still assembles 210,312. Subtract the 15,885 prefix and that is
roughly 194k of tail across 46 rows.

Your reading 2, confirmed. The retained tail is irreducible, and it is not the fixed part.

## Reading 3: `demoted_only` is not exported

The full attribute bag on a compaction event, verbatim:

```json
{"kept":46,"merged":true,"summary_tokens":2964,"compacted_turns":7,
 "summary_cost_usd":0.04842975,"identifiers_audited":30,"identifiers_missing":0}
```

(`identifiers_audited` and `identifiers_missing` are ours, added at ingest.)

There is no `demoted_only`, so we cannot give you the reading you wanted, and neither can any other
consumer. The nearest substitute is `merged`, which was `false` on the first compaction and `true`
on all four after. That tells you the merge path ran; it does not tell you the demotion path ran and
was not enough.

Adding `demoted_only` to the compaction event is the same argument as ask 6: the state that
predicts the failure is computed and then dropped. If it is cheap, it belongs in this batch, because
it is exactly the number that will tell you whether S1 worked.

## The part neither of us named: compaction detonates the prefix cache

After every compaction, `cached_tokens` collapses from roughly 200k to the 15,885 floor, and the
next call re-reads about 195k uncached.

| speed-lab, 275 rows | |
|---|---|
| model calls | 30 |
| uncached input, whole run | 1,247,443 |
| of which: the five post-compaction reloads | **977,625 (78%)** |
| of which: turn 1 | 109,809 (9%) |
| ordinary turn-over-turn growth | 160,009 (13%) |
| model-call cost | $12.63 |
| run cost including compaction summaries | $13.10 |

| google-deepmind, 119 rows | |
|---|---|
| model calls | 17 |
| compactions | 0 |
| uncached input, whole run | 189,671 |
| of which: turn 1 | 109,928 (58%) |
| model-call cost | $3.88 |

Per-call cache hit on the speed-lab run was 92 to 100% from turn 2 straight through to the first
compaction, then 7 to 8% on each of the five reloads. The 78% run-level figure in our handoff is a
token-weighted average that hides this shape; treat the per-call series as the real one.

What that means for S1: the cost is not the model paying to replay the arguments on every turn,
because the cache absorbs that. The cost is that each compaction invalidates the prefix, and the
retained tail is too large for the reload to be cheap. Argument eviction attacks this in the right
place, because a smaller retained tail means both fewer compactions and a cheaper reload when one
happens. Two of the five compactions here fired back-to-back on a tail that had just been compacted.

The scoring consequence is the part we would not want you to miss. **Score S1 on compaction count,
post-compaction `input_tokens`, and `context_irreducible`, not on steady-state cache hit.** Steady
state is already 92 to 100% and will not move, and a run that reads as "cache hit unchanged" will
look like the change did nothing when it may have removed the only five expensive calls in the run.

## Lane volumes, for the spill retention defaults

Yes, they are tight. Nine of ten lanes are on a **1GB** volume, in `iad`, and that single volume
carries the SQLite WAL, the workspace and `.delta/spill` together.

| fly app | volume | size |
|---|---|---|
| aperture-qs-1d11a748b6a5 (alpha-school) | delta_state | 1GB |
| aperture-intake-1d11a748b6a5 (alpha-school) | delta_state | 1GB |
| aperture-qs-agent (anthropic, adopted) | data | 1GB |
| aperture-intake-agent (anthropic, adopted) | delta_state | 3GB |
| aperture-qs-69598a208017 (carrara) | delta_state | 1GB |
| aperture-intake-69598a208017 (carrara) | delta_state | 1GB |
| aperture-qs-0ae48cfb95e6 (google-deepmind, lab) | delta_state | 1GB |
| aperture-qs-703a1dc79389 (long-lake) | delta_state | 1GB |
| aperture-qs-2e5f565dd56a (raindrop) | delta_state | 1GB |
| aperture-qs-3498560efa0d (speed-lab, lab) | delta_state | 1GB |

Pick the defaults for a 1GB disk shared with the database. We can get you the on-disk breakdown
(`.delta/spill` file count and bytes against `df`) on a live lane if that would sharpen the numbers;
say the word and we will run it on carrara and speed-lab.

You are right that adding arguments multiplies the file count on exactly these agents. Shipping
retention in the same release as the thing that fills it is the correct call.

## Run B, for the breaker test

Cap on both runs was 6,400 bytes (`DELTA_SELF_MAX_TOKENS=1600`), carrara quick-search.

- **run A:** 7,975 → 6,956 → 6,813 bytes, latched at 3.
- **run B:** 6,654 → 6,482 → 6,445 bytes, latched at 3. **45 bytes short, shrinking monotonically.**

Run B closes 88% of its gap in three attempts. A material-convergence rule with a hard attempt
ceiling passes it; a one-byte-per-attempt grind still latches at 3. That is the case we wanted.

Two notes for reproducing it. The carrara and google-deepmind quick-search lanes now run
`DELTA_SELF_MAX_TOKENS=2400`, deliberate manifest drift recorded in our runbook, so reproduce
against 1,600 rather than against those lanes as they stand. And alpha-school currently sits at
6,309B against a 6,400B cap, 99% full, which is a live instance of ask 6 waiting for a surface to
show it.

## On your three changes

**The JSON stub.** We would not have caught that. We test against the native Anthropic adapter and
would have shipped a run where the agent sees `{}` and no explanation, which is precisely the
quality trade we told you not to make. Good catch, and it is the reason to build this in the engine
rather than in a consumer.

**Moving the seam into the tool-result transaction.** Better than what we asked for. We asked for
`DELTA_TOOL_RESULT_MAX_BYTES` by analogy without checking what sub-turn resume re-reads. Your
version keeps the resume guarantee and costs zero prefix-cache churn, which given the section above
is not a small detail.

**Spill retention.** Agreed, and see the volume table.

**The journal.** Agreed. A pointer that expires at 7 days is worse than no pointer, because the
agent would trust it.

## On the rest

**The `recall` enumeration.** Making `query` optional is a better answer than the separate index we
described, and you are right that it retires the count-reconciliation discipline we currently push
through prompting. That prompting is fragile and we would be glad to delete it.

**4, 5, 6, 7.** All accepted as you have them. The reservation framing for 4 is right and ours was
not: we described a divisor because `eval_n` has one, without noticing that `spawn_subagent` cannot
know N.

**2 and 3 held for 0.2.13.** Accepted, and the reasoning is better than our filing. We ranked them
as latency asks under work parallelism; your point that a child with a fresh window is context
relief puts them on the same axis as rank 1. Effort inheritance silently raising cost for every
consumer on upgrade is a release-brief change, and we would rather it arrive that way than as a
surprise on our next bump.

**8.** Accepted, and the convention is the better fix. Pointed-at rather than resident is what we
should have concluded ourselves.

## Canary

Yes to both. `room-bench.ts` can pin the roster shape at a fixed row count, which gives you the same
job on the same fixture before and after. We will run it on speed-lab first.

Proposed metric set, so we are measuring the same thing: compaction count, `context_irreducible`
count, post-compaction `input_tokens`, uncached input for the whole run, model-call cost, and
`demoted_only` if it ships. Row count and identifier completeness go alongside as the quality gate,
because a run that gets cheap by losing rows is not a win.

## One request back

`demoted_only` on the compaction event, per reading 3. It is the single cleanest confirmation of
whether S1 did what it is supposed to do, and right now no consumer can see it.
