# Harness 0.2.12 plan - "bound what the model writes"

Batch scoped 2026-08-06 from the Aperture handoff (`docs/backlog-aperture-handoff.md`, d49d96a),
after a source pass over every claim in it. Aperture is the first external consumer, 8 lanes on
0.2.11, running paid client work daily, and has offered to canary.

## The finding this batch exists for

Every large thing that enters the context window passes through a bounding rail, most of them two:

| entering the window | on arrival | at compaction |
|---|---|---|
| tool results | `capAndSpill` (20KB + spill file) | `demoteSpilled` (head + pointer) |
| retrieval / prompt-context blocks | 10KB block cap | ephemeral, never persisted |
| self-file, summary, artifact ledger | capped | capped |
| images | markers | last 2 user turns |
| **assistant tool-call arguments** | **nothing** | **nothing** |

`demoteSpilled` (`compaction.ts:176`) opens with `if (m.role !== "tool") return msg`. The one thing
the model itself authors is the one thing no rail can shrink, in either direction.

This is the same defect class as both 0.2.11 fixes: a bound that measures part of what it must. The
0.2.11 commit was "bound the tail it keeps", and it bounded the tool-result half of that tail. This
batch finishes it. That framing is what keeps it lean - no per-tool `evictArgsOnSuccess` contract,
no new knob, no new tool.

Aperture's measurement, same job shape on two lanes: 275 rows at 78% cache, 5 compactions, 5
`context_irreducible`, $12.63; 119 rows at 93% cache, 0 compactions, $3.88. Results plateau because
they are capped on arrival. Arguments accumulate because nothing caps them.

## S0 - the gate (no code)

We can prove arguments are unbounded. We cannot prove they caused those five `context_irreducible`
errors. `run.ts:816` computes the history budget as `compactAtTokens - fixed - SUMMARY_RESERVE`, and
`fixed` includes the full tool schemas. Aperture mounts a large `aperture__*` surface, which shrinks
the history budget every turn. The comment at the error site names both suspects: "fixed parts too
big / irreducible tail".

If schema bulk was the binding floor, S1 is correct and does not move their number.

Turn 1's `input_tokens` is essentially `fixed` (spine + tool schemas + the first user message), so
comparing it against the run's peak separates the two. Aperture runs this against their own
`agent_events`; our copy of the table is a dev branch with no rows.

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
WHERE task_id IN ('368df774-70a0-4f70-b045-611cdce194c2',   -- 275 rows, speed-lab
                  'e2c3303e-d479-4780-ac1c-4e5ed933dfad')   -- 119 rows, google-deepmind (control)
  AND event_name IN ('model.call', 'compaction', 'error')
ORDER BY task_id, event_time_ms ASC;
```

What we are reading:

- **turn-1 `input_tok`** on both runs. Near-identical across the two = the fixed floor is the same
  and the tail is the variable. A large turn-1 (say north of 60k) means tool schemas are eating the
  budget before history gets any, and S1 alone will not clear the errors.
- **`input_tok` on the call immediately after each compaction.** Still near the ceiling = the
  retained tail is irreducible, which is the argument blob, since `demoteSpilled` cannot touch it.
- **`demoted_only`** on each compaction event. `true` means the free path fired and still was not
  enough.

S1 ships regardless. This only decides whether the batch also needs a tool-schema item, and it
stops us forecasting a win we have not earned.

## S1 - evict a successful call's arguments

**The seam.** Not on arrival, which is where Aperture asked for it by analogy to
`DELTA_TOOL_RESULT_MAX_BYTES`: the call has not run yet, and `pendingCalls()` (`run.ts:1122`)
re-reads `assistant.tool_calls` from the message row to fire unanswered calls after a crash.
Stubbing there loses exactly what a resume needs, which is the guarantee Aperture said matters more
than the win.

The seam is the transaction at `run.ts:1400` that writes the tool result. The call has succeeded,
so resume never needs its arguments again, and the assistant row is not sent to a provider until
the *next* call, so rewriting it there costs zero prefix-cache churn. Same reasoning that put
`demoteSpilled` at the compaction commit, one turn earlier.

**The stub must be valid JSON.** `provider.ts:1117` parses `tc.function.arguments` with
`catch → input = {}`. A prose stub becomes an empty argument object on the Anthropic wire, so the
agent would see a write call with no arguments and no explanation - silently trading the quality
Aperture told us not to trade. Shape:

```json
{"_delta_evicted": {"bytes": 12431, "path": "<workspace>/.delta/spill/<run>.<call>.args.txt"}}
```

**Its own spill path.** `spillPathFor(workspace, runId, callId)` is keyed on the call, so a call
that spills both an oversize result and evicted arguments would write both to one file, and
`demoteSpilled` derives that same path from row identity to decide what to stub. Arguments get an
`.args.txt` suffix, and `db.ts`'s pointer extractor (`/saved to (\/[^\s;]+)/`) has to recognise it.

**Fail closed**, exactly as `demoteSpilled` does: no spill file on disk means no eviction. A stub
promising a file that is not there is worse than the bytes it saves.

**Rejected: use the journal as the archive.** It already stores every call's arguments verbatim and
durably, which looks like a free archive with no second copy. `retention.ts` prunes it at 7 days and
50k rows and documents it as pure local observability. Pointing an agent at it hands back a pointer
that expires. Aperture's spill-file instinct is right.

**Rejected: deactivate the original row and insert a stubbed copy** (the archive-safe pattern
compaction uses). A new row sorts after the tool results it must precede, breaking the wire group.
Compaction gets away with it because it re-inserts the whole kept set in order.

## S2 - let the agent list what it banked

Aperture's second half, and their guardrail makes it part of S1 rather than a follow-up: an agent
that forgets what it filed is worse than one that pays to remember.

Most of this exists. `msgText` (`db.ts:355`) already renders assistant tool calls as
`name(arguments)`, so `recall` searches argument text today and already surfaces inactive rows.
What is missing is enumeration, so `query` becomes optional: an empty query lists this thread's
spilled and evicted artifacts with sizes and run seq. No new tool, no new concept for the agent.

## S3 - bound the spill directory

Nobody asked for this; S1 forces it. `sweepTrash` only touches `.delta/trash`, so `.delta/spill`
has never been pruned. Today only results above 20KB spill. Adding arguments multiplies the file
count on exactly the long-running agents with the smallest disks. Bound by age and count the way
`retention.ts` bounds the journal, and keep it consistent with the fail-closed check in S1 - a
pruned spill must make the stub honest, not leave a dangling pointer.

## S4 - subagent budget reservation

`runSubagent` (`builtins.ts:767`) reads `remainingBudget()` at spawn, and `chargeReportedUsage`
only runs when the child exits. Three children launched in one turn each read the full remaining
budget before any sibling has charged a token, so a run can spend 3x its ceiling.

Aperture asked for a divisor. A divisor is what `eval_n` can do because it knows N upfront;
`spawn_subagent` does not. Fix is a live reservation decremented at spawn and reconciled on exit.
Correctness, not performance.

## S5 - material convergence in the self-write breaker

`STORM_CLASSES` (`run.ts:1191`) keys every cap refusal to the constant `[class] self_cap`, which was
the right fix for the 2026-07-30 grinding storm and also discards the only signal separating
grinding from converging. Aperture's run B went 6,654 → 6,482 → 6,445 against a 6,400 cap and
latched at 3, forty-five bytes short and shrinking.

Their own correction is the right rule, and we should not implement their original suggestion:
exempting monotone-shrinking sequences is unbounded, since one byte per attempt would grind forever.
An attempt resets the streak only if it closes a material fraction of the remaining gap, with a hard
attempt ceiling regardless. `MATERIAL` already exists in `compaction.ts` for the same reason, so
this reuses a concept instead of adding a rule.

Keep the byte counts in the refusal (`self.ts:119` already carries landed-size vs cap) - that
detail is what made the attempts converge at all. Run B is a free reproducible test case.

## S6 - status surface

- **`self: {bytes, cap}` on `/v1/status`.** The data exists at `run.ts:313`. It cannot be another
  boot-snapshot field since self bytes are per-run, so it needs a live read the way `vault` does at
  `server.ts:~437`. A lane sits at 6,309B against a 6,400B cap right now and can no longer learn,
  found by forensics rather than by any surface. Aperture reports fullness as the single best
  predictor of degraded self-learning across their fleet.
- **Canonical profile name.** `server.ts:430` returns `c.profile` verbatim where the 0.2.7
  changelog and the guide both promise the canonical name.

## Not in this batch

- **Effort inheritance and the opt-in MCP mount for children** (their #2 and #3). Held for 0.2.13.
  Effort inheritance is one line of code but not a one-line decision: every existing child runs at
  the model default today, so inheriting silently raises cost and latency for every consumer on
  upgrade, and that belongs in a brief. The MCP mount is a security widening, since a child
  inheriting the mount inherits act-as rights, and mixing it into a context release makes both
  harder to verify. Worth noting they filed these as latency asks when the mount is really the other
  structural answer to the same context problem - a child with a fresh window is context relief.
- **A fifth bundle file** (their #8). Declined as engine work, accepted as documentation. Four files
  is a deliberate leanness choice and they routed around it correctly with an ssh sync. The real
  signal is their POLICY.md sitting at 63 tokens of headroom, and the answer is that operator
  reference material is pointed at rather than resident, which the workspace plus `read_file`
  already does. What is missing is a written convention, so the next consumer does not invent a
  fifth file and ship a pointer to nothing.

## Verification

Per the release gate: `bun test` + `scripts/smoke.sh`, codex on every slice, then deploy from source
to a real agent and run the roster shape before publishing. S1 is the only slice with a live gate;
S4 through S6 touch disjoint paths and are unit-testable.

The honest live test is the one that produced the report: a roster sweep large enough to compact,
measured on cache hit, compaction count and `context_irreducible` before and after. Aperture offered
the lab lane and the canary, and their rig is `~/ai-recruiter/app/scripts/room-bench.ts`.

The release brief names who will see nothing. Their closing note is that our 0.2.11 brief saying QS
would see no cache gain saved them a five-release wild goose chase. Any consumer whose tool calls
are small - which is most of them - sees no change from S1.
