# Spec: bound what the model writes

Status: **v3, pre-implementation.** Two codex rounds. v1 returned REDESIGN on seven P1s that shared
one root cause; v2 removed it and returned REDESIGN on one that mattered. v3 answers it by giving
up on something v1 and v2 both assumed. Written 2026-08-06 from Aperture's
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

### 5.0 The thing v1 and v2 both assumed, and v3 gives up

Both earlier drafts tried to guarantee that an evicted payload is retrievable **forever**. Codex
showed why that cannot hold: durable sessions have no expiry, so any "pin the archive" rule turns
bounded storage into unbounded storage. Its formulation is exact, and worth keeping:

> Durable recall, no durable-session expiry, and a hard storage ceiling cannot all be true.

v2 also made a factual error: it claimed the journal is "not on the disk that is under pressure".
The journal is inside SQLite, on the same 1GB volume as the WAL and the workspace. v2 converted
seven-day data into permanent data on the exact disk this batch is trying to protect.

v3 gives up the third property, and splits the ask in two:

| | what it answers | size | lifetime |
|---|---|---|---|
| **the manifest** | "what have I filed, and how much" | ~90 bytes per elision | as long as the message |
| **the body** | "show me exactly what I sent on page 7" | the full payload | best-effort, existing journal retention |

The manifest is what Aperture actually asked for when they said an agent must be able to *reconcile
its own count*. It is small enough to keep forever without a policy. The body is large, genuinely
rarely needed, and can be honestly absent.

**And the manifest needs no new storage at all: it is the marker already sitting in the message
row.** It lives exactly as long as the message it belongs to, is session-scoped by construction, and
costs one line of retention policy: none.

### 5.1 The archive is the journal, and retention does not change

`execCall` already writes the full arguments to `journal(run_id, call_id, tool, args, …)` in the same
transaction (`run.ts:~1402`), and codex confirmed the row is written before execution and never
overwritten by the success upsert. That row is:

- **keyed**, not named - no sanitization, no truncation, no collision;
- **session-bound by construction** - `journal.run_id → runs.session_id`, so a lookup can be scoped
  the way `searchHistory` already scopes itself and cannot be aimed at another session;
- **unforgeable** - the engine resolves `(run_id, call_id)` from the row it is rewriting; nothing is
  parsed out of model-visible text;
- **queryable** - which is what restores keyword recall;
- **already bounded** - `retention.ts` prunes it at 7 days and 50k rows.

**`retention.ts` is not modified.** No pinning rule, no exemption, no reference-counting, no
directory sweep. This is the entire answer to codex's surviving P1, and it removes code rather than
adding it.

The cost is that a body is retrievable for as long as the journal keeps it, not forever. That is the
right trade for the workload: a roster run lasts minutes, so the body is always present while the run
is alive, which is the whole window in which "an agent that forgets what it filed" can bite. Across
days, Aperture does not need it - the rows are banked in their product, which is the premise of the
original ask.

**Absence must be honest, and this design makes it cheap.** The marker embeds no path and makes no
promise about a file, so it cannot rot into a lie the way v1's pointer could. Retrieval reports
availability: `recall` returns the body when the journal still has it, and says plainly that it was
pruned when it does not.

### 5.2 Elide by structure, not by call

v1 replaced the whole argument object. v3 keeps the object and replaces only the values that are
actually large:

```json
// before (91,204 bytes)
{"buffer_id":"stg_7741","page":7,"rows":"[{\"name\":\"…\", … 90KB … }]"}

// after (188 bytes)
{"buffer_id":"stg_7741","page":7,"rows":{"_delta_elided":{"bytes":90731,"field":"rows"}}}
```

Rules, tightened after review:

- operate on the arguments **already parsed** by `parseToolArgs` for execution - never parse twice;
- **only a non-array JSON object is eligible.** Root arrays, primitives and `null` are left alone,
  matching what `parseToolArgs` already accepts (`run.ts:~1283`);
- walk **top-level values only** - no recursion. A nested walk is more code for a case nobody has
  measured;
- measure a string value by its UTF-8 bytes, any other value by the UTF-8 bytes of
  `JSON.stringify(value)`, and replace it with the marker when it exceeds the threshold;
- if nothing was replaced, write nothing - the row is untouched.

**No digest.** v2 carried a `sha256` so recovery could prove it returned the right body. Recovery
resolves by primary key from a table the engine wrote, so there is nothing to prove, and hashing
every large argument on a hot path buys nothing. Dropped on leanness grounds.

What this buys, against the two semantic P1s:

- **semantics survive.** `send_email` keeps `to` and `subject` and loses only `body`. The model can
  still see what it did, which is what prevents duplicate side effects and re-queries.
- **top-level identifiers stay searchable in place.** Only genuinely huge values leave the window.
- **it stays valid JSON on both wires.** The Anthropic adapter does `JSON.parse(arguments)` with
  `catch { input = {} }` (`provider.ts:1117`); a prose stub would hand the model an **empty argument
  object with no explanation** on the wire Aperture actually runs, invisible to them because they
  test against the native adapter.
- **idempotent by shape.** A marker is ~60 bytes, far below any sane threshold, so a second pass
  measures it and declines. `demoteSpilled` learned (codex P1) that a sentinel alone is forgeable;
  size is not.

**Honest limits**, both raised by codex and both accepted rather than designed around:

- a **nested** identifier does not stay in the message. `{"payload":{"customer_id":"ABC-123","body":…}}`
  loses both when `payload` exceeds the threshold. Archive search (§6) is the recovery path.
- value **types** change: a string, array or object value all become a marker object. Acceptable for
  a historical, already-completed call; the key structure is what the model reasons over.
- a legitimate argument could itself contain `_delta_elided`. This is cosmetic rather than
  exploitable: readback resolves from the journal by key and returns the real arguments, so a forged
  marker can only produce a phantom enumeration entry, never a false body.

### 5.3 The seam is unchanged, and codex confirmed it twice

Eviction happens in the transaction at `run.ts:~1400` that commits the tool result.

- **resume is safe** - `pendingCalls()` re-reads `assistant.tool_calls` only for calls with no
  answer; here the call is answered. Evicting on *arrival* - the seam the
  `DELTA_TOOL_RESULT_MAX_BYTES` analogy suggests, and what Aperture asked for - would lose exactly
  what a crash-resume needs.
- **zero prefix-cache churn** - the row is created from a provider response and elided before the
  next main-model request, so it only ever reaches a provider in elided form. Codex traced the
  compaction and ephemeral paths and confirmed it.
- **ordering is preserved** - UPDATE in place; `activeSessionMessages` is `ORDER BY id`, so
  re-inserting a copy would sort the assistant message after the tool results it must precede.
- **the shared-row read-modify-write is safe** - the calls of one turn share one assistant row, and
  Bun's `db.transaction` callback is synchronous, so no async continuation can interleave. Verified
  by codex on Bun 1.3.13.
- **the output-capped path is ineligible** - it records full arguments as `done` with a synthetic
  error result and never enters `execCall`, so arguments survive for reissue.

### 5.4 Eligibility

The call **succeeded** (result does not begin `[tool error]` or `[interrupted]`) and at least one
top-level value exceeds the threshold.

Codex is right that prefix-sniffing is fail-open both ways. v3 accepts this rather than refactoring
the codebase's error convention, because the consequence is now small: the object shape and small
fields survive, and the body is in the journal. Under v1 a misclassification lost the payload; here
it costs a lookup. A known limit, not designed around.

### 5.5 Thresholds

`DELTA_TOOL_ARG_MAX_BYTES`, default **0 (off) for the first cycle**; `4096` is the recommended
value once enabled. Shipping opt-in because the echo guard is new and cannot be proven complete
against arbitrary MCP argument schemas — see §13. UTF-8 bytes (`.length` is UTF-16 -
the 0.2.11 lesson).

Below the 20KB result cap on purpose: a result is read once by the next turn, arguments are replayed
every turn until compaction. And it must sit below the reported case - Aperture handed over 143,905
chars in ~12.4KB chunks, and a 20KB cap would have evicted **none** of it.

**Guard `NaN`** (codex P2): `Number("garbage")` is `NaN`, and both `NaN <= 0` and `bytes <= NaN` are
false, so a typo'd env var would elide *everything*. Parse with an explicit finite check.

## 6. Design - S2, `recall` gains the archive and enumeration

Required, not a convenience: it is what stops §4's keyword-recall regression from shipping.

**Bounded by construction.** Codex's objection to v2 was that "search the journal" had no bounded
candidate set. It does now, because discovery runs off the manifest: scan the **same bounded id
window `searchHistory` already uses** for messages carrying `_delta_elided` markers, which yields a
small, explicit set of `(run_id, call_id, field)` references. The journal is then hit by **primary
key**, never scanned. Growth in the journal cannot slow this down.

**Three modes on one tool, one new optional parameter:**

- `recall(query)` - as today, plus archived hits. A match inside an elided value is returned labelled
  `archived`, alongside today's `live` / `compacted`.
- `recall()` - enumerate this session's elisions: tool, field, bytes, run seq. Aperture's "index the
  agent can list, not just search", which retires the count-reconciliation prompting they do today.
- `recall(artifact: "<run_seq>:<call_id>:<field>")` - read one body back, or a plain statement that
  the journal no longer holds it.

**Dedupe** keys on `(run_id, call_id)`, exactly as tool rows already dedupe in `searchHistory`, so a
term appearing in both the visible fields and the archived body yields one hit, and archived hits
cannot crowd live transcript results out of the limit.

Session binding is preserved by joining `journal → runs` and binding `runs.session_id`, the same
discipline `searchHistory` uses today. Matching stays literal escaped `LIKE` plus `indexOf`, so the
ReDoS-free guarantee is unchanged.

## 7. Design - S7, the instrument (ships first)

Aperture could not answer the reading that scores this. v1 blamed the exporter and was wrong:
`SAFE_ATTRS` gates only `PAYLOAD_EVENTS`, and `compaction` is not one, so its attributes already
export in full.

The real gap is one line: `demoted_only` is set **only on the demotion-only early return**, so the
summarize path never emits it, and all five of their compactions took that path. Emit it on both
paths, and add `tail_bytes_before` / `tail_bytes_after`, which is what actually scores S1.

**Ships before S1** so Aperture can re-run the pinned fixture and establish a clean baseline.

## 8. Design - S9, parallel sub-turn resume (new, found by this review)

Codex found a **pre-existing** correctness bug while checking §5.3, confirmed directly against source
and covered by no test.

The loop reads `lastRunMessage` - the last *active row of the run* - and only reconciles pending
calls when that row is the assistant message (`run.ts:660`). Once any tool result is inserted, it is
not. That is correct when the batch completed, and wrong after a crash **mid-batch**: with calls A
and B in flight, A committing and then a restart leaves the last row as A's tool result, so `pending`
is never computed, B never executes, and the next request carries an unanswered `tool_use` the
provider rejects.

**The obvious fix is wrong**, and codex caught it in v2's wording. "Reconcile against the last
assistant carrying `tool_calls`" would, on an ordinary run that finished a batch and then produced a
final answer, select the *older* tool-calling assistant, find nothing pending, and fall through to
another model call instead of finalizing. That changes the non-crash path.

The safe formulation is narrower:

- when the last active row is an **assistant**, behave exactly as today;
- **only** when the last active row is a **tool result**, walk back to the latest active assistant
  carrying `tool_calls` and reconcile that batch's calls against the journal and message rows;
- when nothing is pending, fall through exactly as today.

So the provider-visible non-crash path is byte-identical, and the mid-batch crash is repaired.

Test both shapes, not just the crash: an ordinary tool batch followed by a final assistant answer
must still finalize on the first pass.

In scope because the resume guarantee is what this batch must not break, and because a partial
parallel batch is the shape argument elision now interacts with.

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
- but the journal already *is* one, keyed on exactly `(run_id, call_id)`. Adding a table to hold what
an existing table already holds fails the leanness test.

**Pinning journal rows so an archive survives forever** (v2). §5.0. It converts bounded storage into
unbounded storage on a 1GB volume, and no schema trick avoids that while durable sessions never
expire. v3 keeps the *manifest* forever instead, which is ~90 bytes rather than ~90KB.

**A content digest on the marker** (v2). Recovery resolves by primary key from a table the engine
wrote, so there is nothing to verify, and hashing every large argument on a hot path buys nothing.

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
- **S9**: crash mid-batch with one of two calls committed, resume executes the second; AND an
  ordinary batch followed by a final assistant answer still finalizes on the first pass (the
  regression the naive fix would have caused);
- root arrays, primitives and `null` arguments are left untouched;
- **recall**: an identifier inside an elided value is found and labelled `archived`; the body reads
  back by `artifact` reference; a term visible in BOTH a surviving field and the archived body yields
  ONE deduped hit; archived hits cannot crowd live hits out of the limit;
- **recall after pruning**: once the journal row is gone, readback says so plainly rather than
  returning an empty or misleading body;
- **enumeration** is discovered from markers in the bounded id window, so journal size does not
  affect its cost;
- a forged `_delta_elided` in a legitimate argument produces no false body on readback.

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

## 11. Implementation checklist (codex round 3, PROCEED WITH CHANGES)

Things that must be right in code, not in prose.

1. **A recalled body must never become a spill file.** `recall(artifact)` output passes through
   `capAndSpill` like any tool result, so a large body would write an unswept file into a durable
   session, and repeated recalls would duplicate it. Return the body in chunks below the effective
   result cap with a cursor, and guarantee this mode never spills.
2. **Bound the TOTAL, not just each value.** A per-value threshold still admits an arbitrarily large
   object of sub-threshold values, and many oversized fields produce an arbitrarily large manifest.
   After top-level elision, enforce a total serialized-byte and marker-count bound: elide the next
   largest values as needed, and if keys plus markers still exceed it, collapse to ONE root marker
   carrying total bytes and field count.
3. **Bound the discovery window physically.** The existing `(session_id, active, id)` index cannot
   range on `id` without constraining `active`, so the scan is not actually bounded. Add
   `(session_id, id)` and verify the query plan. Journal access is always exact `(run_id, call_id)`
   plus session binding, never `LIKE journal.args`.
4. **Identities and ordering.** Enumeration dedupes by `(run_id, call_id, field)`; keyword hits dedupe
   by `(run_id, call_id)`. Existing assistant dedupe by role+text is insufficient. Search the
   transcript first and fill the remaining limit from archived hits, so archived results cannot
   starve live ones. Include inactive rows: compaction copies create duplicates and a failed finalize
   only deactivates.
5. **Structured artifact reference.** `"<run_seq>:<call_id>:<field>"` is ambiguous - provider call ids
   and JSON keys can contain colons. Use `{run_seq, call_id, field}`. Resolve the run inside the
   current session, verify a marker exists for that exact field, then read by primary key, so a
   forged marker can never yield a claimed body.
6. **Elision is pure and atomic.** Pass the already-parsed execution object to a synchronous helper.
   Keep the raw arguments in `journal`. Leave the message byte-identical when nothing changes. Treat
   a serialization failure as a no-op. Commit the marker rewrite, the journal completion and the tool
   result in ONE transaction. Guard config with `Number.isFinite`; `0` disables, invalid uses default.
7. **S9 exactly as formulated**, and note a journal `done` row with no tool message must still flow
   through `execCall` so the missing result row is materialized.
8. **Leanness.** Drop `field` from the marker - the enclosing key already supplies it. No digest, no
   table, no retention exception, no argument file. **Land S9 separately.** And **S8 is not a one-line
   compaction change** - the serializers add cache breakpoints automatically, so it belongs in its own
   cache patch.

## 12. Open, before implementation

1. **Argument-size distribution** across Aperture's five workspaces, to derive §5.5 from data.
2. **`alpha-school` at 6,309B against a 6,400B cap** - operator decision, not engine.

---

## 13. Live results (2026-08-06)

Ten live tests on a real model (`anthropic/claude-haiku-4.5` via OpenRouter), two daemons, isolated
workspaces, identical prompts, `DELTA_TOOL_ARG_MAX_BYTES=0` as the 0.2.11 control arm.

**The quality gate is reported FIRST, because one arm failed it and the cost numbers from that run
were worthless.**

| 10-turn session | OFF (0.2.11) | ON (0.2.12) |
|---|---|---|
| pages / records / corrupt | 10 / 120 / 0 | 10 / 120 / 0 |
| compactions | **5** | **0** |
| total input tokens | 232,851 | 163,189 (**-29.9%**) |
| peak call input | 15,269 | 11,268 (**-26.2%**) |
| cost | $0.2404 | $0.1526 (**-36.5%**) |
| model calls | 20 | 28 |

The single-batch roster shape is sharper still: peak call input **34,034 → 9,605 (-72%)**, cache hit
on the final call **13% → 88%**.

### What the telemetry proved

S7 earned its place immediately. All five OFF compactions report
`tail_bytes_before == tail_bytes_after` with `demoted: false` — compaction ran, paid a model call,
and shrank the retained tail by **nothing**, because the bulk is assistant arguments that
`demoteSpilled` cannot touch. That is Aperture's `context_irreducible` signature, visible in
telemetry for the first time.

The roster arm also shows WHY: all eight writes land in ONE protocol unit, so compaction's
`groups.length <= 1` guard means there is nothing it is even allowed to shed.

### The bug only a live run could find

**The model imitates the marker.** Seeing `_delta_elided` in its own history as a `content`
argument, the agent copied the shape into a LATER `write_file`, and the tool persisted the
placeholder: **4 of 10 pages filed as garbage** while the run merely looked cheaper. The
pre-guard run's "-60%" was fraudulent - bought by throwing away 40% of the work.

Fixed by rejecting an echoed marker on ingress: the engine writes markers and never receives one,
so a marker arriving on a call is always this mistake. It became a loud, self-correcting retry.

Two rounds were needed, and the second was also live-only: a `content` parameter takes a STRING, so
the model echoes SERIALIZED json and an object-only check sails past it.

### An improvement tested and rejected

Keeping a bounded head of the original value in the marker (the `demoteSpilled` pattern), on the
theory that the model copies the placeholder because it is the only example of the field it can see.
Measured: echo rejections **20 → 26** and input tokens **163k → 202k**. It gave the model a more
plausible thing to copy and cost bytes by construction. Reverted.

### Known cost, to name in the release brief

The guard's retries cost ~8 extra model calls on a 10-turn session (20 → 28). The run is still
cheaper on every other axis, and the alternative is silent data loss. Reducing the echo rate is a
0.2.13 question, not a blocker.

---

## 14. OPEN REGRESSION — elision causes the agent to redo work (2026-08-06)

Found on the fourth live run, after the echo guard was made stateless. It is not caused by the
guard, and it invalidates the cost figures in §13.

**Duplicate writes to the same path, ten-turn session, same prompt:**

| arm | `write_file` calls for 10 pages | paths written more than once | worst path |
|---|---|---|---|
| elision OFF (0.2.11) | 10 | **0** | — |
| elision ON, run A | 15 | 5 | `long-1.json` × 3 |
| elision ON, run B | 18 | 4 | `long-1.json` × **10** |

The control never re-writes. Both elision arms do. In run B the agent wrote the same page ten times
while only **one** echo rejection occurred in that run, so the retries are not the guard asking
again — they are the agent redoing work it had already completed.

**The likely mechanism, stated as a hypothesis and not yet proven:** within the same run, the agent
issues the write, elision fires at the commit, and on the very next model call the agent sees its own
tool call carrying `content: {"_delta_elided": …}`. The tool result does say
`wrote 9752 chars to pages/long-1.json`, but the agent appears to weigh the hollow-looking argument
more heavily than the result, and writes again to be sure.

If that is right, the design is eliding **too early**. The elision is correct and free at the commit
seam for a call the agent will never revisit, and actively harmful for one it is still reasoning
about in the same breath.

### What this does NOT invalidate

- the mechanism: five compactions with `tail_bytes_before == tail_bytes_after` is still the real
  failure, and arguments are still the only unbounded thing in the window;
- the quality gate: every arm delivered 10 pages and 0 corrupt files;
- the other six slices, which are independent of this.

### What it does invalidate

**§13's cost numbers.** Run A measured -29.9% input tokens while silently doing 50% more writes;
run B measured **+22.9%**. A single run per arm cannot separate this effect from model
nondeterminism, and that is a flaw in the method, not just in the result.

### Candidate fixes, in order of how lean they are

1. **Elide at the compaction commit rather than at the tool-result commit.** Exactly where
   `demoteSpilled` already acts, for exactly its reason: the prefix is being rewritten at that
   instant anyway, so it still costs no cache churn, and a call the agent is actively reasoning
   about keeps its arguments. Spec v1 rejected this as "too late"; the live data says the earlier
   seam buys rework. This is the smallest change and the best-supported by evidence.
2. **Age-gate the elision** — elide only calls older than N turns. More knobs, same effect as (1)
   with worse ergonomics.
3. **Make the marker read as success.** Attempted and REVERTED (§13): a bounded head made echoes
   worse, 20 to 26, because it gave the model a more convincing thing to imitate.

### The methodological correction

One run per arm against a nondeterministic model is not a measurement. Every figure in §13 should
have been reported with that caveat and was not. **Before any release claim, this needs repeated
runs per arm with duplicate-write count as a first-class metric alongside compaction count** — which
is precisely what Aperture's pinned fixture and bench rig exist for.

---

## 15. The compaction seam: safe, and inert (2026-08-06)

Built and live-tested. Three arms, same prompt, same model, ten-turn session.

| | 0.2.11 | early seam | compaction seam |
|---|---|---|---|
| pages / records / corrupt | 10 / 120 / 0 | 10 / 121 / 0 | 10 / 120 / 0 |
| `write_file` calls | 10 | **18** | **10** |
| **duplicate writes** | 0 | **4** | **0** |
| echo rejections | 0 | 5 | **0** |
| model calls | 20 | **36** | **20** |
| input tokens | 232,851 | 286,124 | 246,667 |
| cost | $0.2404 | $0.2015 | $0.2444 |

**The rework is gone.** Duplicate writes 4 → 0, `write_file` calls 18 → 10, model calls 36 → 20. The
hypothesis in §14 was right: eliding a row the agent is still reasoning about is what made it redo
work, and moving the seam past that point removes it entirely. The echo guard also became
vestigial (5 → 0 rejections), exactly as predicted.

**And it delivers nothing.** Elision fired **zero times** across the whole session. The tail-walk
that demotes and elides only runs while `tailTokens > budget`, and the group-selection above it has
already sized the tail to fit. So on this workload the loop never entered, and the arm is
byte-for-byte 0.2.11 behaviour.

### A correction to §13 and §14

I reported "10 of 10 compactions shrank the tail by zero bytes" as evidence that compaction was
broken and paying a model call for nothing. **That reading was wrong.** The tail did not shrink
because it did not need to — compaction's job there was shedding the *prefix* into a summary, which
it did. `tail_bytes_before == tail_bytes_after` is the expected reading whenever the tail already
fits, not a failure.

The metric is still worth having; I over-read it. The genuine failure it exposes is the narrower
case where the tail *is* over budget and still cannot shrink, which is Aperture's
`context_irreducible` shape and not this fixture.

### What this leaves

Two seams tested, neither shippable:

| seam | rework | win |
|---|---|---|
| tool-result commit | **4-10 duplicate writes** | large (163k vs 232k on one run) |
| compaction commit | none | **none — never fires** |

The win comes from arguments leaving the ACTIVE WINDOW early, so every later turn is smaller. The
rework comes from them leaving too early, while the agent is still reasoning about that turn. Those
are the same lever at different settings, which points at the remaining candidate:

**Age-gated elision.** Elide a call's arguments once it is N turns old — old enough that the agent
has moved on, early enough that the window shrinks before compaction is reached. `N = 2` or `3` is
the obvious starting point, and it is testable directly against these three arms.

That is a smaller change than either seam tried so far: no new machinery, just a predicate on turn
age at the point the window is assembled or at each turn's commit for the rows that have aged out.

### Method note

This is still one run per arm. The rework signal is structural and trustworthy (0 vs 4 duplicate
writes, 10 vs 18 calls). The token and cost figures are not — three runs of the early seam produced
163k, 286k and 202k on the same fixture. **No cost claim should be made from this table.**
