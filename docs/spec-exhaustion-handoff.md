# Spec: a budget-exhausted run must hand back what it already has

Status: **spec v1, pre-implementation.** D-9 (minimum) + D-10 of `docs/backlog-delos-field-report.md`.
Batch: `harness-0.2.15-plan.md`, item 2. The full partial-answer call is **0.2.16 and out of scope
here** — §7 says why the split is not a dodge.

## 1. The defect

`run.ts:780-783`, and again on the post-compaction re-check at `run.ts:936-939`:

```ts
const why = `budget exhausted: ${stepCount}/${b.maxSteps} steps, ${billed}/${b.maxTokens} tokens, $${usage.costUsd.toFixed(4)}/$${b.maxCostUsd}`;
events.emit("error", spine, { "error.type": "budget", message: why });
return finalize(deps, run, spine, "failed", selfWriteNote(why), model, usage);
```

The reason string becomes the run's entire output. Everything the run produced is still on disk and
none of it is offered:

- the **spill files** (`capAndSpill`, 20KB+ results written under `.delta/spill/`),
- the **artifact ledger** compaction accumulates precisely so pointers outlive the tool rows it
  deactivates (`compaction.ts:274 collectArtifacts`),
- the **`todo` plan**, which the agent maintains itself,
- any **child summaries** already returned.

Then `finalize` puts that same string in *both* `output_text` and `runs.error` (`run.ts:1751-1770`), so
the operator diagnostic and the user-facing answer are one value. Connect delivers it verbatim wrapped
in **"Try again in a moment"** — advice that reproduces the failure exactly and costs the user another
full run to discover.

## 2. Why this is not a Delos-shaped problem

We were going to defer the whole item. Then we counted what it has already destroyed on lanes we ship
to — runs with a `budget` error event, on 0.2.11:

| lane | runs lost | tool calls | model spend | wall time | worst single run |
|---|---:|---:|---:|---:|---|
| `aperture-qs-69598a208017` | 5 | 525 | $84.05 | 98 min | 295 calls / $14.82 |
| `aperture-qs-agent` | 6 | 246 | $56.93 | 60 min | 106 calls / $11.51 |
| **total** | **11** | **771** | **$140.98** | **158 min** | |

$141 and two hours forty minutes of paid client work, eleven times, each returning one sentence of
counters. Delos's 66-step / 379-call / 137-page / 33-minute loss is the same defect, not an outlier of
unattended operation.

Note which axis bound: every one of the eleven hit the **token** ceiling. Steps never came close
(fleet max 62 of 100), which is also why `DELTA_MAX_STEPS` is a ride-along in this release and not a
headline.

## 3. Credit where the existing design is right

Two things already work and must not be disturbed:

- **The 85% nudge** (`run.ts:868-874`) fires once per run, is ephemeral, is qualitative rather than a
  gameable counter, and the caps held to within 0.15% on a 3M-token run. It is not *sufficient*,
  because a single `research` call can exceed the entire remaining headroom — there is no step at which
  the model can wrap up when one step is larger than what is left. That is an argument for this spec,
  not against the nudge.
- **`selfWriteNote`** (`run.ts:442-445`) is already the precedent for exactly this shape: a failure
  that names a durable side effect so the result does not read as "nothing happened". 0.2.7 built it
  for `remember`. This spec generalises it.

## 4. The fix

### 4.1 Split the diagnostic from the answer

`finalize`'s `text: string` becomes a discriminated pair:

```ts
type Outcome = { user: string; diagnostic?: string };

function finalize(deps, run, spine, status, out: string | Outcome, model, usage): RunRow
```

Accept a bare string so the ~dozen existing call sites need no edit; only the budget paths pass the
object. Inside:

- `payload.output_text` ← `out.user`
- `runs.error` ← `out.diagnostic ?? out.user`
- the `error` event keeps the diagnostic, as it already does at `run.ts:782`.

**This is the release's only signature change and its whole blast radius.** Enumerate the call sites in
the diff; do not let a string silently land in the wrong field.

### 4.2 Build the handoff

Replace `selfWriteNote(why)` on the two budget paths with a composed note. Order matters — the
recoverables come before the apology, because a truncated message must not lose them:

```
This run hit its budget before finishing. Nothing below was lost.

Plan at the point it stopped:
- [done] …
- [doing] …

Full results already on disk (read_file these, or `recall` a keyword):
- /data/bundle/.delta/spill/resp_….call_….txt
- …

[note: a change to your self-file (DELTA.md) was saved during this turn and persists.]

The work was too large to finish in one run. Narrow the question rather than repeating it.
```

Sources, all of which already exist:

| block | source | bound |
|---|---|---|
| plan | the run's `todo` state, same read the ephemeral plan block uses (`run.ts:848-858`) | reuse the existing 4,000-char elide |
| artifacts | `collectArtifacts` over this **session's** rows, active **and** inactive | `LEDGER_MAX_PATHS` 40 / `LEDGER_MAX_CHARS` 4000, already defined at `compaction.ts:181-182` |
| self-write | `committedSelfWrite`, unchanged | one line |

**The ledger must cover two artifact families, not one.** This spec's first version said "spill
files", and the Delos operator checked the exhausted run against disk:

```
/srv/asteria/.delta/spill/resp_a863d559*      26 files, 5.4 MB
/srv/asteria/research/resp_a863d559*.{0..12}  13 directories
```

A ledger built only from `SPILL_PATH_RE` enumerates the 26 and **silently under-reports the run by 13
research directories** — which on this run is where the child output actually went, since it made 24
child starts. Either the ledger covers the research tree too, or the handoff says in words that it
does not. Covering it is better: the paths are engine-derived from `runId` + `seq`
(`research.ts:275`), so they need no new trust argument.

**And it must NOT list the model's scratchpad.** `${workspace}/scratch/<runId>` is wiped for *every*
terminal run at `queue.ts:403`, which fires just after `settle()` — i.e. moments after `finalize`
builds this text. Listing it would hand the user paths guaranteed to be gone before they read them.
Say so in a comment; the next person will otherwise "fix" the omission.

`collectArtifacts` is currently private (`compaction.ts:274`) and takes the compacted prefix rows.
Export a thin wrapper rather than the function itself, so the caller cannot pass arbitrary rows:

```ts
/** Every artifact pointer this session has produced — spill files AND research trees — bounded by the
 * same ledger caps compaction uses. Reads INACTIVE rows too: compaction deactivates the tool row but
 * the file outlives it. Deliberately excludes `scratch/<runId>`, which queue.ts:403 wipes on every
 * terminal run, so a pointer to it would be dead before the user read it. */
export function sessionArtifacts(db: Database, sessionId: string): string[]
```

**Do not re-derive paths from the workspace root.** Scan with the existing `SPILL_PATH_RE`
(`compaction.ts:180`), which matches on the `.delta/spill/` segment and is therefore already agnostic
to the scratch-root change in `spec-scratch-dir.md`. Those two specs land in the same release; this is
the seam between them.

### 4.3 The user sentence

D-10 in one line: the user gets *what happened, that nothing was lost, and what to do differently*.
Never the counters. `budget exhausted: 66/100 steps, 3004644/3000000 tokens` is an operator string and
belongs in `runs.error`, the `error` event, and the log — all three of which already carry it.

Connect's "Try again in a moment" wrapper is Connect's bug to fix, but it only became harmful because
the harness handed it an internal string. Note it in the release brief so the Connect side gets
scheduled.

## 5. What must not change

1. **The guard's timing.** The budget check stays exactly where it is, before the model call. This spec
   adds no model call and no network I/O — building the handoff is three SQLite reads and string
   concatenation, so it cannot itself fail the run it is trying to rescue.
2. **`status` stays `failed`.** The run did not succeed. Anything that keys off status keeps working.
3. **The bound.** The whole handoff is capped. Two of the three blocks reuse caps that already exist;
   assert a total ceiling in the test so a 40-path ledger plus a full plan cannot produce a 20KB
   "failure message".
4. **No absolute paths outside the workspace/scratch root.** Paths come from the same regex-derived set
   the ledger already trusts and puts in context today. This adds no new disclosure.
5. **Idempotence on the second budget path.** `run.ts:936` fires after a compaction charge. It must
   produce the same handoff, not a second, differently-shaped one — factor the builder, call it twice.

## 6. The test that fails without the fix

`test/run.budget.test.ts`:

1. Profile with `maxTokens` low enough to exhaust after two turns.
2. A stub tool returning >20KB twice, so `capAndSpill` writes two real spill files.
3. One `todo` write.
4. Run to exhaustion. Assert:
   - `output_text` contains **both** spill paths and the plan text;
   - `output_text` does **not** contain `"budget exhausted:"` or `"/3000000"`;
   - `runs.error` **does** contain `"budget exhausted:"`;
   - the `error` event still carries `error.type: "budget"`;
   - `output_text.length` is under the asserted ceiling.
5. Repeat via the post-compaction path (`run.ts:936`) and assert the same handoff.

Pre-fix, every assertion in 4 fails. Verify that before keeping the test.

## 7. Why the split is honest, not a dodge

The full fix — one cheap final call asking the model to answer from what is in context — is a real
behaviour change: it spends tokens *after* the budget is exhausted, which needs a reserve carved out
before the guard fires, a decision about which model serves it (the utility lane is the obvious
candidate and it changes the answer's quality), and a story for what happens when that call also
fails. That is a spec, not a patch, and getting it wrong means a run that cannot terminate.

What ships here is the part with no such questions: **the artifacts were already on disk and already
enumerated; we simply were not telling anyone.** Delos's acceptance criterion — *"a run that spent 3M
tokens should never return zero bytes of substance"* — is met by this alone. The 0.2.16 work raises the
quality of that substance from pointers to prose.

## 8. For the reviewer

1. **Does the handoff belong in the transcript?** `finalize` inserts `outputText` as an assistant
   message on any non-`done` status (`run.ts:1755-1758`), so this enters the next turn's context
   automatically. Good for resume — the agent can pick up its own plan and read its own spill. Also new
   context nobody budgeted, on a session that just proved it was over budget. Options: keep it (cheap,
   bounded, useful), or split so the payload is rich and the transcript row stays the one-liner.
   **The spec has no strong view and this is the most consequential open question in it.**
2. **`string | Outcome` overload, or bite the bullet and update every call site?** The overload is
   smaller and admits the exact confusion it is meant to prevent.
3. **Should a `done` run also get an artifact ledger?** Out of scope, arguably the same defect for
   successful long runs. Say if you think it belongs.
4. **Real orphans are available for the test.** Delos's exhausted run
   (`resp_a863d55947b84728acf1f03816ec74ef`, 66 steps / 379 tool calls / 19 compactions / 33 minutes)
   still has its 26 spill files and 13 research directories on disk, so the ledger can be tested
   against orphans that a real run produced rather than ones the test fabricated. Fixture form is
   redacted-structural — see the reply thread; bodies are not needed, since the assertion is about
   which paths are enumerated.
5. **Is `sessionArtifacts` over inactive rows a performance risk?** The carrara lane's DB is 204MB and
   one session held 16 runs. The scan is regex over `msg` text with no index. Measure before merging; if
   it is slow, bound it to the current run's rows and accept a smaller ledger.
