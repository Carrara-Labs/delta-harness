# Backlog: evict what the agent has already banked (Aperture, 2026-08-05)

**This is the top Aperture engine ask.** Filed from the roster-mode
build, where a 275-row people sweep hit `context_irreducible` five
times and still delivered - which is the interesting part, and the
reason this is worth engine work rather than a workaround.

Nothing here is a bug. It is a boundary a real workload now wants a
door through.

---

## The workload

"Give me every software engineer at Notion." The agent screens a
population in pages of 25, and after each page it writes the finished
rows to the product's server (an MCP tool that appends to a staging
buffer). The raw profiles are then dead to it: it has extracted its
judgment, the rows are durable, and it will never need those payloads
again.

Measured on the live run (`speed-lab`, 2026-08-05, 275 rows delivered):

| | value |
|---|---|
| model calls | 30 |
| billed tokens | 1,353k |
| cache hit | 78% |
| compactions | **5** |
| `context_irreducible` errors | **5** |
| cost | $12.63 |
| artifact delivered | 143,905 chars, 275 rows, complete |

Compare the same shape at 119 rows on another lane: 17 calls, 248k
billed, **93% cache, 0 compactions, 0 errors, $3.88**. The work is
linear in rows; the cost is not.

`context_irreducible` is `assembled request still exceeds the context
budget after compaction` - the run repeatedly could not get under the
ceiling even after compacting.

---

## Why it still delivered, and what that proves

The reference failure this project started from met the same wall and
**died at 76 of 168 people**. Its deliverable lived in context, so
compaction ate the work.

The Notion run survived because the rows were already banked
server-side. Hitting the ceiling cost it turns and cache, not the
roster.

So the product-side fix (write results out as you go) is real and it
works. **What it cannot do is stop the sweep from filling the window
in the first place** - because the write itself is a tool call, and
the harness persists the full assistant tool call, arguments included,
then replays active messages on every subsequent turn
(`run.ts` message assembly).

A 143,905-character body handed over in chunks is therefore roughly
**36k tokens of tool-call arguments** sitting in history permanently,
on top of the profile payloads being screened. The agent pays, every
turn, to re-read text it already successfully filed away.

---

## The ask (P1): let a successful tool call's arguments be dropped

When a tool call has succeeded and its arguments are large and
write-shaped, the arguments are no longer load-bearing. The RESULT
matters ("staged 12,431 chars, total 96,204"); the payload does not.

Concretely, one of:

**(a) Tool-level declaration.** A tool advertises
`evictArgsOnSuccess: true` (or the daemon config names such tools).
After a successful call, the harness replaces the stored arguments
with a stub - `[args evicted: 12,431 chars, recoverable via
<pointer>]` - keeping the call, the name and the result intact so the
transcript stays honest and the model still knows the call happened.

**(b) A generic size threshold.** Any successful call whose arguments
exceed N bytes gets the same treatment, with the full text spilled to
disk exactly like oversize tool RESULTS already are today
(`DELTA_TOOL_RESULT_MAX_BYTES` + spill). The mechanism exists; it
currently only points one way.

(b) is probably right - it needs no per-tool contract, and the
existing spill file plus `read_file` is already the recovery path the
agent knows.

### Why this should be safe

- it only touches calls that **already succeeded**;
- the model keeps the call, the tool name and the result, so it can
  still reason about what it did;
- the content is recoverable by design (spill file or a pointer), so
  nothing is destroyed;
- it is the mirror of a mechanism the engine already trusts for
  results.

### What we would expect

The Notion run's 36k tokens of staged body would leave the live
window. On a 78%-cache run whose billed tokens are dominated by
re-sent context, that is the difference between 5 compactions and
none - which at 119 rows was measured as **$3.88 vs $12.63** for the
same job shape.

---

## The second half of the ask: give it back

Nic's framing, and it is the right one: **drop it from context, but
keep a path back, and let the agent see what it has banked.**

Today `recall` searches earlier turns including compacted ones, and
returns spill paths. That is most of the mechanism. What is missing
for this workload:

1. **An index the agent can list, not just search.** After 11 pages,
   "what have I already filed, and how much?" should be answerable
   without a keyword guess. A cheap `recall --list` / manifest of
   evicted-or-spilled artifacts with sizes and turn numbers would let
   an agent reconcile its own work - exactly the count-reconciliation
   discipline we just had to force through prompting.
2. **A stable pointer per eviction**, so "read back page 7" is a
   direct read rather than a search.

This is the piece that makes eviction feel safe to the agent rather
than lossy, and it is what would let a roster genuinely scale past
the ~275-row ceiling we measured.

---

## Priority and framing

**P1, and above the subagent-parallelism asks already filed.** Those
buy latency on a working run. This one is the difference between a
job completing and a job dying - and it is the same failure that
killed the original 168-person roster before any of this work started.

Two guardrails we care about more than the win:

- **Do not trade quality for it.** If evicting arguments makes the
  agent forget what it filed, the cure is worse. Hence the index and
  the recoverable pointer as part of the ask, not a follow-up.
- **Do not trade the resume guarantee.** Whatever is evicted must
  survive a resume, or a mid-roster restart silently loses work -
  precisely the failure mode this whole project was fixing.

---

## What we already did on the product side (so you can scope yours)

- pages of 25, not "pull everything then screen";
- rows written to a server-side staging buffer immediately per page;
- one save at the end (a mid-sweep save consumes the buffer and forces
  a restage - quadratic, forbidden);
- a projection layer that slims list payloads per entity so a 25-row
  page is ~18KB instead of 851KB.

All of that shipped and it is what got 275 rows delivered at all. The
remaining cost is specifically the transcript, which only the engine
can prune.

---

## Reproduce

`agent_events`, `task_id = 368df774-70a0-4f70-b045-611cdce194c2`
(speed-lab, 2026-08-05): 5 `compaction`, 5 `error` with
`error.type = context_irreducible`, 30 `model.call`, cache 78%.

Contrast `task_id = e2c3303e-d479-4780-ac1c-4e5ed933dfad`
(google-deepmind, same shape, 119 rows): 0 compactions, cache 93%.

## Source

`~/ai-recruiter/docs/findings-roster-mode.md` and
`~/ai-recruiter/docs/specs/roster-mode.md` §R5.
