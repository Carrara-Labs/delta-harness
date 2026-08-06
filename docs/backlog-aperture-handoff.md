# Aperture handoff to the Delta Harness engineer

2026-08-06. Consolidates every open Aperture ask into one document.
The three deep docs referenced below still hold the full derivation;
nothing here contradicts them.

## Who is asking

Aperture (`ai-recruiter`) is the first external consumer of the OSS
harness. **8 lanes across 5 workspaces, all on 0.2.11 at `medium`
effort**, two agent types (quick-search, intake-call), running paid
client work daily.

We dogfood every harness release before the fleet rolls
(`docs/fleet-review-playbook.md`). The 0.2.11 verification is the
reference for what that looks like: an 18-run battery on the lab lane,
then a canary, then a live smoke on all 8. Cost/run $2.12 vs $2.18
baseline, p50 13.7s vs 14.9s, p95 53.1s vs 55.8s, cache 91.8% vs 92.7%
token-weighted, zero `context_irreducible`, 18/18 succeeded. We rolled
fleet-wide the same day.

That is the standing we are asking from: we measure before we ask, and
we ship the workaround first.

---

## What we want, in one paragraph

**We want the engine to let an agent forget what it has already
finished, without losing the ability to look it up.** Every other ask
below is small. This one decides whether a long job completes. Our
workloads have grown from "screen 20 people" to "screen every engineer
at Notion", and the binding constraint is no longer the model, the
tools, or our own code - we have fixed everything we can reach. It is
that the harness replays a successful write back into the window on
every subsequent turn, so an agent pays forever to re-read output it
already banked.

**The second thing we want is smaller and less urgent: let a subagent
do the parent's actual work.** Three deliberate boundaries (no effort
inheritance, no MCP mount, no budget division) mean the delegation
rails exist but cannot touch domain work. Our runs sit at 1.5-1.8 tool
calls per turn across 246 production runs. Work parallelism is the
largest untaken latency win we can see, and we cannot take it.

Everything after that is a real bug, a visibility gap, and a one-line
docs mismatch.

---

## The asks, ranked

| # | ask | size | evidence | doc |
|---|---|---|---|---|
| **1** | **Evict a successful tool call's arguments, with an index and a pointer back** | mechanism | 5 compactions, $12.63 vs $3.88 same job shape | `backlog-aperture-context-eviction.md` |
| 2 | Effort inheritance for subagents | one line | source read | `backlog-aperture-subagent-parallelism.md` §1 |
| 3 | Opt-in MCP mount for children | small | agent wrote the limit into its own DELTA.md | same, §2 |
| 4 | Budget divisor for concurrent `spawn_subagent` | small | 3 children each get the full ceiling | same, §3 |
| 5 | Self-write breaker latches on converging attempts | small | 45 bytes short and shrinking when cut off | `backlog-aperture-field-report-0211.md` §1 |
| 6 | Self-file fullness on `/v1/status` | small | 47 `self.pressure` events, one lane at 99% | same, §2 |
| 7 | `/v1/status` reports the raw profile alias | one line | `src/server.ts:430` | same, §3 |
| 8 | A fifth bundle file (new, and we already worked around it) | small | 4 lanes shipped a pointer to a file that did not exist | below |

---

## 1. Let a successful tool call's arguments leave the window

### The ask

When a tool call has succeeded and its arguments are large and
write-shaped, the arguments stop being load-bearing. The RESULT
matters ("staged 12,431 chars, total 96,204"); the payload does not.
Let those arguments spill to disk with a stub and a stable pointer,
exactly the way oversize tool RESULTS already do
(`DELTA_TOOL_RESULT_MAX_BYTES`). The mechanism exists and currently
only points one way.

A generic size threshold is probably righter than a per-tool
`evictArgsOnSuccess` flag: no new contract, and the existing spill file
plus `read_file` is already the recovery path the agent knows.

### The measurement

"Give me every software engineer at Notion." The agent screens in
pages of 25 and writes finished rows to our server after each page. On
the live run, `speed-lab`, 2026-08-05, 275 rows delivered:

| | 275 rows (speed-lab) | 119 rows (google-deepmind) |
|---|---|---|
| model calls | 30 | 17 |
| billed tokens | 1,353k | 248k |
| cache hit | 78% | **93%** |
| compactions | **5** | 0 |
| `context_irreducible` | **5** | 0 |
| cost | **$12.63** | $3.88 |

Same job shape. The work is linear in rows; the cost is not.

The deliverable was 143,905 chars handed over in chunks, so roughly
**36k tokens of tool-call arguments** sit in history permanently, on
top of the profile payloads being screened, and get replayed every
turn.

`task_id = 368df774-70a0-4f70-b045-611cdce194c2` and
`e2c3303e-d479-4780-ac1c-4e5ed933dfad` in `agent_events`.

### Why this earns rank 1

The run that started this whole project met the same wall and **died at
76 of 168 people**, because its deliverable lived in context and
compaction ate it. The Notion run survived only because the rows were
already banked server-side, so hitting the ceiling cost turns and cache
rather than the roster.

That is the point. **The product-side fix works and it is already
shipped.** What it cannot do is stop the sweep from filling the window,
because the write itself is a tool call. Every other ask on this list
makes a working run faster. This one is the difference between a job
finishing and a job dying.

### The half of the ask that is not eviction

Drop it from context, but keep a path back, and let the agent see what
it has banked:

1. **An index it can list, not just search.** After 11 pages, "what have
   I filed, and how much?" should be answerable without a keyword
   guess. `recall` searches; it does not enumerate. A manifest of
   evicted-or-spilled artifacts with sizes and turn numbers would let
   an agent reconcile its own count, which is discipline we currently
   have to force through prompting.
2. **A stable pointer per eviction**, so "read back page 7" is a direct
   read.

### Two guardrails we care about more than the win

- **Quality must not pay for it.** An agent that forgets what it filed
  is worse than one that pays to remember. The index and the pointer
  are part of the ask, not a follow-up.
- **The resume guarantee must hold.** Anything evicted has to survive a
  restart, or a mid-roster resume silently loses work, which is the
  exact class of failure this project has spent itself removing.

### What we already did, so you can scope yours

Pages of 25 rather than pull-then-screen; rows written to a server-side
staging buffer per page; one save at the end (a mid-sweep save consumes
the buffer and forces a restage, which is quadratic); a projection
layer that slims list payloads per entity so a 25-row page is ~18KB
instead of 851KB. All shipped. The remaining cost is specifically the
transcript.

---

## 2-4. Let a subagent do the parent's work

### The workload

An Aperture research run maps 6-10 companies and enriches 5-8 people.
Those items are genuinely independent: each needs its own
search -> read -> reason chain and none needs its sibling's answer.

### The measurement

246 real production runs, `agent_events`, 2026-08-05:

| lane | n | wall | turns | tool calls | calls/turn |
|---|---|---|---|---|---|
| speed-lab / quick-search | 134 | 8.1 min | 18.8 | 34.0 | 1.55 |
| google-deepmind / quick-search | 95 | 8.0 min | 20.4 | 40.9 | 1.77 |
| anthropic / intake-call | 17 | 4.9 min | 17.7 | 32.7 | 1.49 |

1.5-1.8 calls per turn everywhere. The work is almost entirely
serialized.

### What we shipped instead, with no engine change

A turn's calls already run concurrently (`run.ts`
`Promise.all(pending.map(execCall))`), so batching independent calls
into one turn is real tool-level parallelism. Both agents now do that,
bounded to 2-3 paid calls per batch because our own seam has no credit
reservation and no in-flight dedupe. That is the honest available
share, and it does not get the fresh-context isolation a subagent track
would.

### 2. `DELTA_REASONING_EFFORT` is not inherited

`SUBAGENT_CONFIG_ENV` (`builtins.ts`) passes the model, the fallbacks,
the utility model, the profile and the timeouts, but not the effort. A
`spawn_subagent` child runs at the model default while its parent runs
at the configured level. For a child doing the parent's own work that
is a silent quality drop. **One line.**

### 3. A child has no MCP mount at all

`DELTA_MCP_SERVERS` is not in `SUBAGENT_CONFIG_ENV` and does not match
`SAFE_PROCESS_ENV`, so a spawned child mounts nothing and cannot call a
single `aperture__*` tool. `research` children cannot either, for a
different and equally deliberate reason: `childTools` admits only
`def.readonly === true`, and an MCP `tools/list` that sends no
`readOnlyHint` fails closed.

The evidence this bites: our QS agent learned it the hard way and wrote
it into its own DELTA.md, unprompted: *"Sub-agents have NO aperture
tools."*

Ask: an explicit, **opt-in** way for a child to inherit the parent's
mount. Opt-in matters, because a child that inherits the mount inherits
the parent's act-as rights, and that should be an operator's decision
rather than a default widening. A per-server flag or
`DELTA_SUBAGENT_INHERIT_MCP=1` would both work.

### 4. Concurrent children can each spend the whole budget

`runSubagent` passes `remaining.maxTokens / budgetDivisor` with
`budgetDivisor = 1` for `spawn_subagent`. Three children launched in
one turn each receive the FULL remaining token and cost budget, so a
run can spend 3x its ceiling. `eval_n` divides; `spawn_subagent` does
not, and it is the one that fans out under a parallel instruction.
This is a correctness ask, not a performance one.

---

## 5. The self-write breaker cuts off converging attempts

Our carrara QS lane's DELTA.md hit its 1,600-token (6,400-byte) cap
after five days of self-learning. Two independent runs, same shape:

- run A: 7,975 -> 6,956 -> 6,813 bytes, breaker latched at 3.
- run B: 6,654 -> 6,482 -> 6,445 against a 6,400 cap, breaker latched.
  **45 bytes short and shrinking monotonically when it was cut off.**

`STORM_CLASSES` (`src/run.ts:1191`) contains `self_cap`, and
`breakerKey` collapses every cap refusal to the constant key
`[class] self_cap`, precisely because the byte counts vary and would
otherwise defeat equality matching. That was the correct fix for the
2026-07-30 grinding storm. It also discards the only signal that
separates grinding from converging.

**Do not implement our original suggestion** (exempt monotone-shrinking
sequences). It is unbounded: an agent shedding one byte per attempt
would never latch. The rule should be **material convergence**, the
same discipline as the 0.2.11 compaction fix: an attempt resets the
streak only if it closes a meaningful fraction of the remaining gap,
with a hard attempt ceiling regardless. Run B closes 88% of its gap in
three tries and sails through; a one-byte grind still latches at 3.

Run B is a reproducible test case, free.

**Preserve what went right.** The refusal messages carry landed-size vs
cap, and that detail is what made the attempts converge at all. When
latched, the agent wrote itself pending-merge files with a compaction
plan and executed byte-budgeted rewrites the next run. Keep the byte
counts in the message.

---

## 6. Self-file fullness is invisible to operators

47 `self.pressure` events on one lane, discoverable only by querying
the collector. Today `alpha-school` sits at **6,309B against a 6,400B
cap, 99%**, which means that lane can no longer learn, and we found it
by forensics rather than by any surface.

Ask: `self: {bytes, cap}` on `/v1/status`, next to model, budget and
vault. You already compute `{bytes, cap, elided}` at `src/run.ts:313`
for the event. Note it cannot be another boot-snapshot field, since
self bytes are per-run; it needs a live read the way `vault` already
does at `src/server.ts:~437`.

Fullness turned out to be the single best predictor of degraded
self-learning across our fleet.

---

## 7. `/v1/status` reports the raw profile alias

`src/server.ts:430` returns `profile: c.profile` verbatim, so
`DELTA_PROFILE=work` reports `"work"` while the 0.2.7 changelog and the
guide both say status reports the canonical name (`trusted`). Behavior
is fine. It is a docs-vs-wire disagreement, one line either way.

---

## 8. A fifth bundle file (new, lowest confidence)

The harness seeds exactly four files (`BUNDLE_MANIFEST`): DELTA.md,
POLICY.md, vocab.json, PROMPT_CONTEXT.md. We invented a fifth, a
reference playbook, found no convention for it in the docs, README or
site, and never built delivery. **Four production lanes shipped a
pointer to a document that did not exist.** That was our error, not
yours.

We fixed it on our side with no engine change: `lane-push.ts` now
syncs `agent/<type>/notes/*` to `/data/workspace/notes/` over ssh with
per-file sha256 verification, and POLICY.md carries a descriptive
pointer that tells the agent to say so out loud if the file is missing.

The reason it is still worth raising: our QS POLICY.md is now **6,146B
/ ~1,537 tokens against the 1,600-token cap, 63 tokens of headroom**.
The next thing we add there has to displace something. A supported
path for operator-owned reference material that is pointed at rather
than always-resident (a `DELTA_BUNDLE_FILES_B64` path->content map, or
just a documented convention) would take that pressure off.

We understand a "no" here. Four files is a deliberate leanness choice
and we routed around it. File this only if the answer is that a fifth
file is a convention you want rather than a widening.

---

## What we are deliberately not asking for

- **A narration subagent.** Ruled out on the engine's own terms: every
  helper is one the parent waits for, and detached fire-and-forget
  would break the resume guarantee. The room's telemetry feed already
  is the parallel communicator.
- **Promoting the parallel-tool cache caveat.** We saw exactly one 19%
  cache-hit call at 76k input tokens in 357 calls, sandwiched between
  90%+ calls, consistent with the bounded-lookback miss you documented.
  One case in 357 is evidence to keep it on the backlog, not to
  schedule it.
- **Anything about the 0.2.11 rollout.** It went 8 for 8 with zero
  surprises.

## One thing to keep doing

Your release brief said plainly that QS would see no cache gain because
it never emits the derived blocks, and that compaction never fires at
our 200k threshold. That paragraph saved us a wild-goose chase across a
five-release jump and produced a clean verification with zero
back-and-forth. **Naming the consumer who will see nothing, before they
go looking for it, is worth more than the release note.**

---

## Standing context

- Field reports here are **filed, not scheduled.** Pull them when a
  release window opens.
- Sources: `~/ai-recruiter/docs/findings-roster-mode.md`,
  `docs/specs/roster-mode.md` §R5, `docs/specs/portable-room.md` §6,
  `docs/research/harness-0211-verification-reply.md`,
  `docs/fleet-runbook.md`.
- The measurement rig is `~/ai-recruiter/app/scripts/room-bench.ts`.
- We are happy to run any of this again on a lab lane before you build,
  and to be the canary for whatever lands.
