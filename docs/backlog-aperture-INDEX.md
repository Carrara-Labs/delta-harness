# Aperture asks for the Delta Harness, ranked

Aperture is the first external consumer of the OSS harness and runs 8
lanes across 5 workspaces on 0.2.11. These are the engine asks, in the
order we would want them, with the reason each earns its place.

Reviewed 2026-08-05.

| # | ask | doc | why this rank |
|---|---|---|---|
| **1** | **Evict a successful tool call's arguments, with an index and a pointer back** | `backlog-aperture-context-eviction.md` | the difference between a job finishing and dying |
| 2 | Effort inheritance for subagents | `backlog-aperture-subagent-parallelism.md` §1 | blocks real work parallelism |
| 3 | Opt-in MCP mount for children | same, §2 | same, and small |
| 4 | Budget divisor for concurrent `spawn_subagent` | same, §3 | correctness: 3 children can each spend the full ceiling |
| 5 | Self-write breaker latches on converging attempts | `backlog-aperture-field-report-0211.md` §1 | real bug, low frequency |
| 6 | Self-file fullness invisible to operators | same, §2 | we hit it; found by forensics, not by a surface |
| 7 | `/v1/status` reports the raw profile alias | same, §3 | cosmetic |

## Why #1 is first

Every other ask makes a working run faster or cheaper. #1 decides
whether a run completes.

The measured case: a 275-row roster on `speed-lab` hit
`context_irreducible` five times, took 5 compactions, ran at 78% cache
and cost $12.63. The same job shape at 119 rows on another lane: 0
compactions, 93% cache, $3.88. The work is linear in rows; the cost is
not, because the agent re-reads its own already-filed output on every
turn.

The 275-row run delivered anyway - the product now banks rows
server-side as it goes, so hitting the wall costs turns rather than
the deliverable. That is the whole reason this is an engine ask and
not a bug report: **we fixed everything we can reach.** What remains is
the transcript, and only the engine can prune that.

The original failure this came from - a 168-person roster that died at
76 - was the same wall without the server-side banking. So this is not
a hypothetical scaling worry; it is the failure mode that started the
project, met again at a larger size.

## The shape of the ask, in one line

Let a successful, large, write-shaped tool call's ARGUMENTS leave the
live window the way oversize tool RESULTS already do - spilled,
pointered, and listable - so an agent can clear what it has banked
without losing the ability to look back at it.

## Two things we care about more than the win

- **Quality must not pay for it.** An agent that forgets what it filed
  is worse than one that pays to remember. The index and the stable
  pointer are part of the ask, not a follow-up.
- **The resume guarantee must hold.** Anything evicted has to survive a
  restart, or a mid-roster resume silently loses work - which is
  exactly the class of failure we have spent this project removing.

## Standing context

- 8 lanes, 5 workspaces, all on 0.2.11 at `medium` effort.
- Aperture dogfoods every harness release before the fleet
  (`docs/fleet-review-playbook.md` in this repo).
- Field reports here are filed, not scheduled - pull them when a
  release window opens.
