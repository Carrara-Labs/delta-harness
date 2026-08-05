# Backlog: subagent work-parallelism (Aperture field report, 2026-08-05)

Filed from the Aperture portable-room build. Three engine gaps block
agent-level work parallelism. Nothing here is a bug: each is a
deliberate boundary that a real workload now wants an opt-in past.

## The workload

An Aperture research run maps 6-10 companies and enriches 5-8 people.
Those items are genuinely independent: each needs its own
search -> read -> reason chain, and none needs its sibling's answer.
The agent should be able to split them into silo tracks that run at
once, each carrying enough context to work alone.

Measured on 246 real production runs (`agent_events`, 2026-08-05):

| lane | n | wall | turns | tool calls | calls/turn |
|---|---|---|---|---|---|
| speed-lab / quick-search | 134 | 8.1 min | 18.8 | 34.0 | 1.55 |
| google-deepmind / quick-search | 95 | 8.0 min | 20.4 | 40.9 | 1.77 |
| anthropic / intake-call | 17 | 4.9 min | 17.7 | 32.7 | 1.49 |

Calls per turn sits at 1.5-1.8 everywhere. The work is almost entirely
serialized today.

## What we shipped instead, with no engine change

A turn's calls already run concurrently
(`run.ts` `Promise.all(pending.map(execCall))`), so batching independent
calls into one turn is real parallelism at the tool level. Both Aperture
agents now do that, bounded to 2-3 paid calls per batch because our own
seam has no credit reservation and no in-flight dedupe.

That is the honest available share. It does not get the fresh-context
isolation a subagent track would.

## The three asks

### 1. `DELTA_REASONING_EFFORT` is not inherited

`SUBAGENT_CONFIG_ENV` (`builtins.ts`) passes the model, the fallbacks,
the utility model, the profile and the timeouts - but not the effort. A
`spawn_subagent` child runs at the model default while its parent runs
at the configured level. For a child doing the parent's own work that is
a silent quality drop.

Ask: add `DELTA_REASONING_EFFORT` to the allowlist. One line.

### 2. A child has no MCP mount at all

`DELTA_MCP_SERVERS` is not in `SUBAGENT_CONFIG_ENV` and does not match
`SAFE_PROCESS_ENV`, so a spawned child mounts nothing. It cannot call a
single `aperture__*` tool. `research` children cannot either, for a
different and equally deliberate reason: `childTools` admits only
`def.readonly === true`, and an MCP `tools/list` that sends no
`readOnlyHint` fails closed.

So neither delegation rail can do domain work today. The QS agent
learned this the hard way and wrote it into its own DELTA.md: "Sub-agents
have NO aperture tools."

Ask: an explicit, opt-in way for a child to inherit the parent's MCP
mount. Opt-in matters - a child that inherits the mount inherits the
parent's act-as rights, and that has to be an operator's decision rather
than a default widening. A per-server flag, or a
`DELTA_SUBAGENT_INHERIT_MCP=1` gate, would both work.

### 3. Concurrent children can each spend the whole budget

`runSubagent` passes `remaining.maxTokens / budgetDivisor` with
`budgetDivisor = 1` for `spawn_subagent`. Three children launched in one
turn each receive the FULL remaining token and cost budget, so the run
can spend 3x its ceiling. `eval_n` divides; `spawn_subagent` does not,
and it is the one that fans out under a parallel instruction.

Ask: a divisor derived from the in-flight child count, or a shared
ledger the children draw from.

## Not asked for

A narration subagent. Ruled out on the engine's own terms: every helper
is one the parent waits for, and detached fire-and-forget would break
the resume guarantee. The room's free telemetry feed already is the
parallel communicator.

## Source

`~/ai-recruiter/docs/specs/portable-room.md` §6, and the measurement
tool at `~/ai-recruiter/app/scripts/room-bench.ts`.
