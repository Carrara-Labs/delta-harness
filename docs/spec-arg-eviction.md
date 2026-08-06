# Spec: bound what the model writes

Status: **v2, pre-implementation.** v1 was reviewed by codex and returned REDESIGN with seven P1s.
Five of them traced to a single root cause, and v2 removes it. Written 2026-08-06 from Aperture's
field measurements (`backlog-aperture-handoff.md`, `aperture-0.2.12-measurements.md`) and a source
read of `~/delta/.refs/{openclaw,pi,hermes-agent}`.

Pairs with `spec-compaction-tail.md` and `spec-cache-breakpoints.md`. 0.2.11 bounded the
tool-result half of the retained tail. This bounds the other half.

---

## 1. The defect

Every large thing entering the context window passes through a bounding rail, most of them two:

| entering the window | on arrival | at compaction |
|---|---|---|
| tool results | `capAndSpill`, 20KB + spill file | `demoteSpilled`, head + pointer |
| retrieval / prompt-context blocks | 10KB block cap | ephemeral, never persisted |
| self-file, summary, artifact ledger | capped | capped |
| images | markers | last two user turns |
| **assistant tool-call arguments** | **nothing** | **nothing** |

`demoteSpilled` (`compaction.ts:176`) opens with `if (m.role !== "tool" ...) return msg`. Arguments
live on the **assistant** message, so no rail has ever shrunk them. They are persisted verbatim and
replayed on every turn until compaction sheds the whole prefix.

Same defect class as both 0.2.11 fixes: a bound that measures part of what it must.

## 2. What the measurements say, and what they do not

Aperture, `speed-lab`, 275-row roster sweep, 30 model calls, `task_id 368df774`:

| | value |
|---|---|
| uncached input, whole run | 1,247,443 |
| of which the five post-compaction reloads | **977,625 (78%)** |
| of which turn 1 | 109,809 (9%) |
| ordinary turn-over-turn growth | 160,009 (13%) |
| per-call cache hit, turn 2 to first compaction | **92-100%** |
| per-call cache hit on each reload | **7-8%** |
| compactions / `context_irreducible` | 5 / 5 |

**The naive story is wrong and this spec must not repeat it.** The model is *not* paying to re-read
its own arguments every turn; the prefix cache absorbs that. The bill is that **each compaction
detonates the prefix**, and the retained tail is too large for the reload to be cheap.

The tail is the problem, not the fixed parts: `cached_tokens` is exactly **15,885** on all five
post-compaction calls. The clearest row: 24 turns compacted to 49 retained rows moved the request
225,623 → 217,109, a **3.8%** fall. The last keeps 46 rows and still assembles 210,312, roughly
**194k of tail across 46 rows**.

### 2.1 The mechanism of the win

A smaller retained tail buys two things that compound: **fewer compactions**, and **a cheaper reload
when one fires**. Two of the five fired back-to-back on a tail that had just been compacted, which
is the signature of a tail that cannot get under budget.

### 2.2 The scoring

Score on **compaction count, post-compaction `input_tokens`, and `context_irreducible` count.**

**Never on steady-state cache hit.** It is already 92-100% and will not move. A run scored that way
reads as "no change" while having removed the only five expensive calls in it.

Quality gate alongside, non-negotiable: **delivered row count and identifier completeness**.

## 3. What the other runtimes do

**Nobody bounds tool-call arguments.** OpenClaw counts them in its estimate and never trims them
(`tool-result-truncation.ts:135`). Pi reads them for a typed file-ops ledger
(`extractFileOpsFromMessage`) and never trims them. Hermes' `turn_context.py` does not touch them.
All three bound results only.

The likely reason is workload: all three are coding runtimes where arguments are file paths and
results are huge, and a roster sweep inverts that. That is a defensible answer to "why has nobody
done this" and it is weak evidence, so it raises the bar on §9's live proof.

**Two of three converge on a principle we half-hold:** restructure history when the cache is already
cold. OpenClaw gates a two-stage prune on the cache TTL having lapsed; Hermes triggers compaction on
a wall-clock idle gap. Delta states this in `demoteSpilled`'s comment and applies it at one moment.
**Deliberately out of scope here** - it does nothing for a workload that compacts under pressure
mid-run with no idle gap. It is the answer to the open "cache decay on long threads" item, and
belongs to 0.2.13 with Ferni as the beneficiary.

**Adopted from Pi:** the summary call must not write cache it can never read back (S8, one line).

---

## 4. What v1 got wrong

v1 wrote the full arguments to a spill file and replaced them with a stub carrying the **path as
prose**, reusing the `saved to <path>` phrasing so `recall` and `collectArtifacts` would pick it up
"for free". Codex found seven P1s. Five of them are the same root cause:

> **A filesystem path parsed out of model-visible prose is not a recovery channel.**

- **collision** - `spillPathFor` maps every non-word character to `_` and truncates at 80, so two
  distinct call ids can alias to one file and race under `Promise.all`;
- **forgeable** - `collectArtifacts` accepts *any* absolute path containing `.delta/spill/` found in
  transcript text, and `searchHistory` takes the first `saved to /…` match, from a hostile tool
  result as readily as from an engine stub;
- **not session-bound** - `read_file` confines a path to the workspace but binds nothing to the
  session, so a guessed path reads another session's artifact;
- **fragile parsing** - the extraction regexes break on a workspace path containing whitespace or
  `;`, silently yielding a truncated path;
- **lifecycle** - a spill referenced by an inactive-but-recallable row could be swept while `recall`
  still advertised it, and durable sessions never age out, so an "active references are exempt" rule
  leaves the byte ceiling unenforceable.

Two further P1s were about meaning rather than plumbing:

- **keyword recall dies.** `msgText` (`db.ts:355`) renders assistant calls as `name(arguments)`, so
  `recall("ABC-123")` finds an identifier inside a stored payload **today**. v1 deleted that text and
  offered enumeration, which lists artifacts but does not search them. This directly violates the
  guardrail Aperture put above the win: *an agent that forgets what it filed is worse than one that
  pays to remember.*
- **"succeeded" does not mean "reconstructable."** A `send_email` that returns `ok` loses the body; a
  query that returns a count loses its filter set. Size alone is not a sufficient eligibility signal,
  and the failure modes are duplicate side effects, repeated work and loops.

One codex P1 was **wrong** and is dismissed: `Bun.write` does create parent directories (verified
directly), so eviction is not inert on a clean workspace - which had to be true, since `capAndSpill`
ships and Aperture has spill files. One P2 was **right and v1 was wrong**: `SAFE_ATTRS` applies only
to `PAYLOAD_EVENTS`, and `compaction` is not one, so compaction attributes already export in full.

---

## 5. Design - S1, structure-aware argument elision

Two changes from v1, each closing a cluster of the above.

### 5.1 The archive is the journal, not a file

`execCall` already writes the full arguments to `journal(run_id, call_id, tool, args, …)` in the
same transaction (`run.ts:~1402`). That row is:

- **keyed**, not named - no sanitization, no truncation, no collision;
- **session-bound by construction** - `journal.run_id → runs.session_id`, so a lookup can be scoped
  the way `searchHistory` already scopes itself, and cannot be aimed at another session;
- **unforgeable** - the engine resolves `(run_id, call_id)` from the row it is rewriting; nothing is
  parsed out of model-visible text;
- **queryable** - which is what restores keyword recall;
- **not on the disk that is under pressure** - nine of ten Aperture lanes are on a 1GB volume shared
  with the SQLite WAL, and this writes no new files at all.

v1 rejected the journal because `retention.ts` prunes it at 7 days and 50k rows. **That is a policy,
not a law, and the policy is now wrong**: a journal row whose arguments have been evicted is no
longer "pure local observability", it is the only copy. Retention learns one rule:

> A journal row is prunable unless its arguments have been evicted and a message row in its session
> still references it - active or inactive, because `searchHistory` deliberately reads inactive rows.

Retention keeps its age and count caps for every other row. Evicted-argument rows are bounded
instead by the session lifecycle they belong to, which is the same contract the messages they
support already live under.

**This deletes S3's disk problem for arguments entirely.** Spill retention is still worth doing for
oversize *results*, but it is no longer coupled to this slice and no longer gates it.

### 5.2 Elide by structure, not by call

v1 replaced the whole argument object. v2 keeps the object and replaces only the values that are
actually large:

```json
// before (91,204 bytes)
{"buffer_id":"stg_7741","page":7,"rows":"[{\"name\":\"…\", … 90KB … }]"}

// after (198 bytes)
{"buffer_id":"stg_7741","page":7,"rows":{"_delta_elided":{"bytes":90731,"sha256":"9f2a…"}}}
```

Rules:

- parse the arguments as JSON; if they do not parse, leave them alone (the repair path at
  `parseToolArgs` already owns malformed arguments);
- walk **top-level values only** - no recursion, no cleverness. A nested walk is more code for a case
  nobody has measured;
- replace any **string or serialized value** exceeding `DELTA_TOOL_ARG_VALUE_MAX_BYTES` with the
  marker object above; leave every other field verbatim;
- if nothing was replaced, write nothing - the row is untouched and no journal row is pinned.

What this buys, directly against codex's two semantic P1s:

- **semantics survive.** `send_email` keeps `to` and `subject` and loses only `body`. The model can
  still see what it did, which is what stops duplicate side effects and re-queries.
- **small identifiers stay searchable in place.** Only the genuinely huge value leaves the window, so
  most of what `recall` finds today it still finds in the message row itself.
- **it stays valid JSON on both wires.** The Anthropic adapter does `JSON.parse(arguments)` with
  `catch { input = {} }` (`provider.ts:1117`); a prose stub would hand the model an **empty argument
  object with no explanation** on the wire Aperture actually runs, invisible to them because they
  test against the native adapter. An object-shaped marker is correct on both wires.
- **idempotent by shape.** A marker object is ~90 bytes, far below any sane threshold, so a second
  pass measures it and declines. `demoteSpilled` learned (codex P1) that a sentinel alone is
  forgeable; size is not.
- **the digest is engine-authored.** `sha256` lets the recovery path prove it returned the right
  body, and gives the live test a cheap integrity assertion.

### 5.3 The seam is unchanged, and codex confirmed it

Eviction happens in the transaction at `run.ts:~1400` that commits the tool result. Codex checked
this specifically and found it sound:

- **resume is safe** - `pendingCalls()` re-reads `assistant.tool_calls` only for calls with no
  answer; here the call is answered, so those arguments can never be needed again. Evicting on
  *arrival* - the seam the `DELTA_TOOL_RESULT_MAX_BYTES` analogy suggests, and what Aperture asked
  for - would lose exactly what a crash-resume needs.
- **zero prefix-cache churn** - the row is created from a provider response and stubbed before the
  next main-model request, so it only ever reaches a provider in elided form. Codex traced the
  compaction and ephemeral paths and confirmed it. Given §2, this is not a detail.
- **ordering is preserved** - the row is UPDATEd in place; `activeSessionMessages` is `ORDER BY id`,
  so re-inserting a copy would sort the assistant message after the tool results it must precede.
- **the shared-row read-modify-write is safe** - the calls of one turn share one assistant row, and
  Bun's `db.transaction` callback is synchronous, so no async continuation can interleave. The
  awaited write happens before it. Codex verified this on Bun 1.3.13.

### 5.4 Eligibility

Evict when the call **succeeded** (result does not begin `[tool error]` or `[interrupted]`) and at
least one top-level value exceeds the threshold.

Codex is right that prefix-sniffing is fail-open in both directions: a hostile result can open with
`[tool error]` to suppress eviction, and a semantic failure that does not use the prefix is treated
as success. v2 accepts this rather than refactoring the codebase's error convention, because the
consequence is now small: the arguments are in the journal, the object's shape and small fields
survive, and recall can retrieve the body. Under v1 a misclassification lost the payload; under v2
it costs a lookup. Noted as a known limit, not designed around.

### 5.5 Thresholds

`DELTA_TOOL_ARG_VALUE_MAX_BYTES`, default **4096**, `0` disables. Measured in **UTF-8 bytes**
(`.length` is UTF-16 - the 0.2.11 lesson).

Below the 20KB result cap on purpose: a result is read once by the next turn, while arguments are
replayed every turn until compaction, so they are worth more per byte. And the default must sit
below the reported case - Aperture handed over 143,905 chars in ~12.4KB chunks, and a 20KB cap would
have evicted **none** of it.

**Guard `NaN`** (codex P2): `Number("garbage")` is `NaN`, and `NaN <= 0` and `bytes <= NaN` are both
false, so a typo'd env var would evict *everything*. Parse with an explicit finite check and fall
back to the default.

**Open, closed before implementation:** Aperture's real argument-size distribution across the five
workspaces, so this is derived from data rather than one figure (§11).

## 6. Design - S2, `recall` gains the archive and enumeration

Two additions, and the first is now **required** rather than a convenience, because it is what keeps
§4's keyword-recall regression from shipping.

**Search the archive.** `searchHistory` gains a second source: journal rows in this session whose
arguments were evicted, matched on `args`, returned as hits labelled `archived` alongside today's
`live` / `compacted`. Same bounded id window, same session binding, same limit. An agent that
banked a customer id inside a 12KB payload can still find it - which is the capability v1 removed.

**Enumerate.** `query` becomes optional; an empty query lists this session's evicted artifacts -
tool name, field, byte count, run seq, digest - newest first. This is Aperture's "index the agent can
list, not just search", and it retires the count-reconciliation discipline they force through
prompting today. No new tool.

**Read back.** A hit carries `(run_seq, call_id, field)`, and `recall` resolves the full value from
the journal on request. No path, nothing parsed from prose, nothing another session can name.

## 7. Design - S7, the instrument (ships first)

Aperture could not answer the reading that scores this. v1 blamed the exporter and was wrong:
`SAFE_ATTRS` gates only `PAYLOAD_EVENTS`, and `compaction` is not one, so its attributes already
export in full.

The real gap is one line: `demoted_only` is set **only on the demotion-only early return**, so the
summarize path never emits it, and all five of their compactions took that path. Emit it on both
paths, and add `tail_bytes_before` / `tail_bytes_after`, which is what actually scores S1.

**Ships before S1** so Aperture can re-run the pinned fixture and establish a clean baseline.

## 8. Design - S9, parallel sub-turn resume (new, found by this review)

Codex found a **pre-existing** correctness bug while checking §5.3, confirmed directly against
source and not present in any test.

The loop reads `lastRunMessage` - the last *active row of the run* - and only reconciles pending
calls when that row is the assistant message (`run.ts:660`). Once any tool result is inserted, it is
not. That is correct when the batch completed, and wrong after a crash **mid-batch**: with calls A
and B in flight, A committing and then a restart leaves the last row as A's tool result, so `pending`
is never computed, B never executes, and the next request carries an unanswered `tool_use` the
provider rejects.

Fix: reconcile against the last assistant message **carrying `tool_calls`**, not the last row. When
nothing is pending the behaviour is byte-identical to today, so the non-crash path is unchanged.

In scope because the resume guarantee is the thing this batch is not allowed to break, and because a
partial parallel batch is exactly the shape argument eviction now interacts with.

## 9. Rejected alternatives

**A spill file with a prose pointer** (v1). §4.

**Deactivate the original row and insert a stubbed copy** (compaction's archive-safe pattern). The
copy takes a new id and `ORDER BY id` sorts it after the tool results answering it, breaking the wire
group. Compaction escapes this only because it re-inserts the whole kept set in order.

**Projection at assembly time** (OpenClaw's model - never mutate, compute the window per call).
Attractive, and rejected on Delta's own terms: a projection must be **stable across turns** or it
churns the prefix every call, which §2 shows is the entire bill. OpenClaw needs a `frozen` set to buy
that stability. A stored elision is stable by construction, and mutation is already Delta's idiom.

**A per-tool `evictArgsOnSuccess` contract.** A new contract every tool author can forget, failing
open silently. Structure-aware elision gets the semantic safety codex asked for without one.

**Head+tail `elide` over the raw argument string.** Not valid JSON, and §5.2 shows invalid JSON is
actively harmful on the Anthropic wire.

**A new artifacts table.** Codex suggested a structured artifact registry, and it is the right shape
- but the journal already *is* one, keyed on exactly `(run_id, call_id)`. Adding a table to hold
what an existing table already holds fails the leanness test.

## 10. Test plan

### 10.1 Unit

- marker is valid JSON and the Anthropic adapter round-trips it to a non-empty `input` (the
  regression test for the failure Aperture would have shipped);
- small fields survive verbatim; only over-threshold values are replaced;
- idempotence: a second pass over an elided row is a no-op;
- `NaN` config falls back to the default rather than eliding everything;
- UTF-8 measurement on a CJK-heavy payload;
- `[tool error]` / `[interrupted]` results keep their arguments;
- ordering: the assistant row still precedes its tool results after elision;
- concurrency: three parallel calls on one shared assistant row, no lost update;
- resume: crash before the result leaves arguments intact and `pendingCalls` re-fires;
- **S9**: crash mid-batch with one of two calls committed, resume executes the second;
- **recall**: an identifier inside an elided value is still found, labelled `archived`, and the full
  value reads back with a matching digest;
- **retention**: a journal row backing an elided argument survives its age cutoff while an ordinary
  journal row of the same age is pruned.

### 10.2 Integration

`bun test` + `scripts/smoke.sh` against a running daemon, plus a seeded session driving a synthetic
large-argument write loop to the compaction threshold, asserting the retained tail shrinks.

### 10.3 Live, on real agents

Deploy from source (`--from-source`), then:

- **the pinned roster fixture** on `speed-lab` via `room-bench.ts`, before and after, fixed row count;
- **a volume battery, 5-10 runs across difficulty levels**: small quick-search runs that must show
  **no change at all** (the control - these never compact), mid-size runs, the 119-row shape, the
  275-row shape, and one deliberately larger than 275 to prove the ceiling moved;
- **the intake-call agent** as a second agent type.

Metric set, agreed with Aperture: compaction count, `context_irreducible` count, post-compaction
`input_tokens`, whole-run uncached input, model-call cost, `demoted_only`. Quality gate: delivered
row count and identifier completeness.

**Regression watch:** any fall in delivered rows or identifier completeness; any rise in `recall`
calls indicating the agent lost track of its work; turn-1 cost on small runs, which must be
unchanged.

## 11. Open, before implementation

1. **Argument-size distribution** across Aperture's five workspaces, to derive §5.5 from data.
2. **`alpha-school` at 6,309B against a 6,400B cap** - operator decision, not engine.
