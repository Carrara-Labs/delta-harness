# Reply to the Aperture handoff

2026-08-06, from the Delta Harness engineer. Answers `docs/backlog-aperture-handoff.md` (d49d96a).
Batch plan lives at `docs/harness-0.2.12-plan.md` in the harness repo.

## Short version

Six of your eight are in 0.2.12. Two are held for 0.2.13 with a reason. One is a no on the engine
and a yes on the docs. We need one query from you, and it does not block the build.

| # | your ask | where it lands |
|---|---|---|
| 1 | evict a successful call's arguments, plus an index and a pointer | 0.2.12, reframed (below) |
| 2 | effort inheritance for subagents | 0.2.13 |
| 3 | opt-in MCP mount for children | 0.2.13 |
| 4 | budget divisor for concurrent `spawn_subagent` | 0.2.12, as a reservation |
| 5 | self-write breaker latches on converging attempts | 0.2.12, your corrected rule |
| 6 | self-file fullness on `/v1/status` | 0.2.12 |
| 7 | `/v1/status` profile alias | 0.2.12 |
| 8 | a fifth bundle file | no on the engine, yes on a written convention |

## Your rank 1 is not a feature request

We went looking for the rail that bounds tool-call arguments before deciding how to build one.
There isn't one, and the shape of the gap is the useful part:

| entering the window | on arrival | at compaction |
|---|---|---|
| tool results | `capAndSpill`, 20KB plus a spill file | `demoteSpilled`, head plus pointer |
| retrieval and prompt-context blocks | 10KB block cap | ephemeral, never persisted |
| self-file, summary, artifact ledger | capped | capped |
| images | markers | last two user turns |
| **assistant tool-call arguments** | **nothing** | **nothing** |

`demoteSpilled` opens with `if (m.role !== "tool") return msg`. The one thing the model itself
authors is the one thing no rail can shrink, in either direction.

That makes this the same defect as the two we shipped in 0.2.11: a bound that measures part of what
it must. The 0.2.11 commit was "bound the tail it keeps", and it bounded the tool-result half of
that tail. Your ask is that fix, finished. It needs no per-tool `evictArgsOnSuccess` contract, no
new knob and no new tool, which is why it can ship as a small diff in code we already trust rather
than as a subsystem.

Your read that a generic size threshold beats a per-tool flag was right, and so was your instinct to
mirror the spill mechanism rather than invent one.

## The one thing we need from you

We can prove arguments are unbounded. We cannot prove they caused your five `context_irreducible`
errors, and we would rather not forecast a win we have not earned.

The history budget is computed as `compactAtTokens - fixed - SUMMARY_RESERVE`, and `fixed` includes
your full tool schemas. Your `aperture__*` mount is large, and it shrinks the space left for history
on every turn. The comment at the error site names both suspects: "fixed parts too big / irreducible
tail". If schema bulk was the binding floor on that run, argument eviction is still correct and will
not clear those five errors on its own, and you should know that before you canary it.

Turn 1's `input_tokens` is essentially `fixed`, so comparing it against the run's peak separates the
two. We tried to run this ourselves and could not: our copy of `agent_events` in the control plane
does not carry your task ids, and the `DATABASE_URL` in `ai-recruiter/app/.env` points at a branch
with zero rows. We did not go looking for your production credentials.

```sql
SELECT event_name,
       turn,
       (attributes->>'gen_ai.usage.input_tokens')::bigint  AS input_tok,
       (attributes->>'gen_ai.usage.cached_tokens')::bigint AS cached_tok,
       attributes->>'cache_hit_pct'   AS cache_pct,
       attributes->>'error.type'      AS err,
       attributes->>'compacted_turns' AS compacted_turns,
       attributes->>'kept'            AS kept,
       attributes->>'demoted_only'    AS demoted_only
FROM agent_events
WHERE task_id IN ('368df774-70a0-4f70-b045-611cdce194c2',
                  'e2c3303e-d479-4780-ac1c-4e5ed933dfad')
  AND event_name IN ('model.call', 'compaction', 'error')
ORDER BY task_id, event_time_ms ASC;
```

Three readings, in order of what they settle:

1. **turn-1 `input_tok` on both runs.** Near-identical means the fixed floor is the same on both
   lanes and the tail is the variable, which is the result we expect. A large turn 1, north of
   roughly 60k, means the schemas are eating the budget before history gets any, and the batch
   grows a tool-schema item.
2. **`input_tok` on the call immediately after each compaction.** Still near the ceiling means the
   retained tail is irreducible, and the argument blob is the only thing in that tail we cannot
   currently shrink.
3. **`demoted_only` on each compaction event.** `true` means the free demotion path fired and still
   was not enough, which is the cleanest single confirmation that the remaining bulk is not a
   spilled tool result.

Send the output, or the three numbers. We are building S1 either way.

## Three things we changed from what you specified

Worth knowing now, because two of them change what you will see.

**The stub has to be valid JSON.** Our Anthropic adapter parses `tc.function.arguments` and falls
back to `{}` on a parse failure. Your proposed `[args evicted: 12,431 chars, recoverable via
<pointer>]` is not JSON, so on the wire you actually run, the agent would see a write call with an
empty argument object and no explanation. That is exactly the quality trade you told us not to make,
and it would have been invisible in testing on an OpenAI-compatible endpoint. The stub will be an
object carrying the byte count and the path.

**The seam is not on arrival.** You asked for this to work like `DELTA_TOOL_RESULT_MAX_BYTES`, which
fires when the result lands. At that point the call has not run, and our sub-turn resume re-reads
`assistant.tool_calls` from the message row to fire unanswered calls after a crash. Stubbing there
would lose precisely what a resume needs, which is the guarantee you said matters more than the win.
We are putting it in the transaction that writes the tool result: the call has already succeeded, so
resume never needs the arguments again, and the assistant row is not sent to a provider until the
next call, so the rewrite costs zero prefix-cache churn.

**We are also bounding the spill directory, which nobody asked for.** Our boot sweep only touches
`.delta/trash`, so `.delta/spill` has never been pruned. Today only results above 20KB land there.
Adding arguments multiplies the file count on exactly the long-running agents with the smallest
disks, so retention ships in the same release as the thing that fills it. If you have lanes with
tight volumes, tell us the sizes and we will pick the defaults around them.

One thing we did not change: we briefly wanted to skip spill files entirely, since our journal
already stores every call's arguments verbatim and durably. It is pruned at 7 days and 50k rows and
is documented as pure local observability, so pointing an agent at it would hand back a pointer that
expires. Your spill-file instinct was correct and ours was not.

## Your index is half-built already

`recall` already renders assistant tool calls as `name(arguments)` when it searches, and it already
surfaces rows that compaction deactivated. What it lacks is enumeration, which is your actual ask.
So `query` becomes optional: an empty query lists this thread's spilled and evicted artifacts with
sizes and run seq. No new tool and no new concept for the agent to learn, which also means the
count-reconciliation discipline you are currently forcing through prompting gets a real surface.

## 4, 5, 6, 7

**4 is a reservation, not a divisor.** `runSubagent` reads the remaining budget at spawn, and the
child's usage is only charged back when it exits. Three children launched in one turn each read the
full remaining budget before any sibling has spent a token. A divisor is what `eval_n` can do because
it knows N upfront; `spawn_subagent` does not. We are decrementing a live reservation at spawn and
reconciling on exit. You were right that this is correctness rather than performance.

**5 lands with your corrected rule, not your original one.** You were right to withdraw the
monotone-shrinking exemption as unbounded. Material convergence with a hard attempt ceiling is the
same discipline as the 0.2.11 compaction fix, and we already carry a `MATERIAL` constant for exactly
that reason, so this reuses a concept instead of adding a rule. The byte counts stay in the refusal
message. Please send run B's exact sequence if you still have it; you offered it as a free test case
and we will take it.

**6 and 7 are in.** 6 as a live read next to `vault`, since self bytes are per-run and cannot come
from the boot snapshot, which you had already worked out. Your point that fullness is the best
predictor of degraded self-learning is the reason it is worth a surface rather than an event.

## 2 and 3 are held for 0.2.13, deliberately

Not because they are hard. Because they are a different kind of change.

Effort inheritance is one line of code and not a one-line decision: every child in every deployment
currently runs at the model default, so making them inherit silently raises cost and latency for
every consumer on upgrade. That belongs in a release brief rather than in a patch note.

The MCP mount is a security widening. A child that inherits the mount inherits the parent's act-as
rights, which you flagged yourself when you asked for opt-in. Mixing that into a context-economics
release makes both harder to verify, and this batch already has one slice that needs a live gate.

One reframe worth having: you filed these as latency asks, under work parallelism. The mount is
really the other structural answer to the same problem rank 1 describes, because a child with a
fresh window is context relief. That raises their value rather than lowering it. Eviction is roughly
a tenth of the work for the same goal, so it goes first, but 2 and 3 are not a consolation prize.

## 8 is a no on the engine and a yes on a convention

Four files is a deliberate leanness choice and we are keeping it. You routed around it correctly,
and the sha256-verified sync plus a POLICY.md pointer that tells the agent to say so out loud when
the file is missing is a better answer than a fifth seeded file would have been.

The signal we are acting on is your POLICY.md sitting at 63 tokens of headroom. The answer is that
operator reference material should be pointed at rather than resident, which the workspace plus
`read_file` already supports. What was missing is that nobody wrote it down, which is why you
invented a fifth file and four lanes shipped a pointer to a document that did not exist. That is our
documentation gap, not your error. It gets a written convention in this batch.

## Taking you up on the canary

Yes to the lab lane, and yes to being the canary. The honest live test for S1 is the one that
produced your report: a roster sweep large enough to compact, measured on cache hit, compaction
count and `context_irreducible` before and after. If `room-bench.ts` can pin the Notion shape at a
fixed row count, that is the comparison we want.

Two asks alongside the query: the sizes of any lane volumes that are tight, for the spill retention
defaults, and run B's byte sequence for the breaker test.

## On your closing note

We will keep naming the consumer who will see nothing. For this batch, that line is already
written: any agent whose tool calls are small, which is most of them, will see no change from S1 at
all. The win is specific to write-shaped calls with large payloads, which today means your roster
sweeps and very little else.

Your 0.2.11 verification, and the fact that you shipped the product-side fix before asking us for
anything, is why this batch is scoped the way it is.
