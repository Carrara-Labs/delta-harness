# Spec: compaction must be able to shrink the tail it keeps

Status: **spec v2, pre-implementation**. Written 2026-08-03 from fleet telemetry; revised after a
codex design review returned REDESIGN and after reading Pi's and Hermes' runtime context managers.
Pairs with [spec-cache-breakpoints.md](spec-cache-breakpoints.md) — same root cause, other end.

## The measurement

Compaction fires, costs a model call, loses facts, and does not reduce the prompt.

| Corpus | Version | Before | After | Ratio | Still over budget | Identifiers lost |
| --- | --- | --- | --- | --- | --- | --- |
| Control plane | pre-0.1.1 | 101,215 | 117,038 | **143%** | — | 16.5% (4,620 / 27,923) |
| Aperture | 0.2.6 | 161,528 | 161,898 | **100.4%** | **68 / 68** | 28.7% (439 / 1,530) |
| Ferni | 0.2.10 | — | — | — | **26 / 26** | — |

**94 of 94** on current-ish builds. One run compacted **29 times**. 788 of 987 compactions lost at
least one identifier, worst case 30. `context_irreducible` is a warning, not a failure — the engine
sends the oversized prompt anyway, which is why this ran for weeks unnoticed.

## Why it cannot shrink

`run.ts` computes the tail budget correctly and even clamps it to zero. Four things defeat it:

1. **`MIN_TAIL = 2` is a ROW count.** The last two rows are kept whatever their size. Ferni's largest
   single tool result is **27 KB** — ~9,000 tokens by the engine's own estimator.
2. **The orphan-snap is unbounded.** It walks the cut backwards so the tail never starts on a
   dangling tool result — correct for the wire, and a large parallel tool group drags it arbitrarily
   far back.
3. **Nothing re-bounds the kept tail.** `elide` is applied to the summarizer's input, the pinned ask
   and the summary — never to the tail that is retained. `capAndSpill` bounds a result once, at
   birth, and never again.
4. **The entry gate and the success test both measure the wrong thing.**
   `if (rows.length <= MIN_TAIL + 1) return null` is a **count-only** gate, so a session of few-but-
   huge messages never even attempts compaction. And `shrank` compares the summary's bytes to the
   *prefix's* bytes — it never asks whether the **assembled request** got smaller, which is the only
   thing that matters.

## What the other harnesses do (corrected)

My first draft asserted Pi had no equivalent and cited a Hermes file that turned out to be a
training-data tool. Both were wrong, and checking properly changed the design.

- **Pi** has a real compaction module (`packages/agent/src/harness/compaction/`, 1,287 lines).
  `reserveTokens: 16384`, `keepRecentTokens: 20000`, and `shouldCompact` triggers on
  `contextTokens > contextWindow - reserveTokens`. Its context estimate is **anchored on the last
  assistant message's real provider usage** plus an estimate of what followed — the same technique
  Delta already uses in `run.ts`, so we are at parity there. Its genuinely better idea is
  `extractFileOperations`: a **typed artifact ledger (read vs edited files) carried forward from the
  previous compaction's details**, rather than rebuilt from the prefix each generation.
- **Hermes'** runtime manager is `agent/turn_context.py` (1,262 lines), not the trajectory
  compressor. Three ideas we lack:
  - `_compression_made_progress` — progress is a **material (>5%) TOKEN reduction**, explicitly not a
    row-count reduction, because "220 → 220 messages, 288k → 183k tokens" was being misread as
    failure. Delta's `shrank` has the mirror-image bug.
  - `_should_run_preflight_estimate` — a cheap gate with a second branch for the **few-but-huge**
    case that a count-only gate silently skips. That is exactly our `rows.length <= MIN_TAIL + 1`.
  - `_should_idle_compact` — compact while idle rather than only under pressure.
- **OpenClaw** re-bounds tool results for their whole life in context: per-result cap, an aggregate
  ceiling at half the window, and in-place replacement with `[Old tool result content cleared]`,
  kept stable by a `projectionState.frozen` set so a replacement once applied stays applied.

The convergent lesson across all three: **the retained recent window must be bounded by tokens, and
whatever you do to it must be stable across turns.**

## Design

### 1. Demote spilled tool results in the retained tail

`capAndSpill` already writes the full output to `.delta/spill/<run>.<call>.txt` and embeds the path.
Spill files are **never swept** (`sweepTrash` only touches `.delta/trash`). And the compaction commit
**already re-inserts tail rows as new rows** while leaving the originals deactivated for `recall`.

So demotion is a change to *what gets re-inserted*: archive-safe by construction, no new table, no
flag, no retention rule. The W1 pointer ledger already does exactly this for the compacted *prefix*.

Rules, tightened after review:

- Demote only `role: "tool"` rows carrying a **real** spill marker (`SPILL_PATH_RE`, which matches
  the deterministic `capAndSpill` location only).
- **Fail closed on a missing file.** If the spill file does not exist, do not demote — the stub's
  promise must never be a lie. `.delta/spill` therefore joins the durable-workspace contract.
- **Versioned engine sentinel** in the stub, so an already-demoted row is returned byte-identical on
  the next compaction instead of being re-stubbed.
- Keep a **bounded head** in the stub, not just a path. On a later generation this row enters the
  prefix and gets summarized, and the summarizer sees the stub rather than the archived original —
  so the stub has to carry enough signal to summarize.

### 2. Select the tail by protocol unit, not by row

Replaces `MIN_TAIL` **and** the orphan-snap entirely. An assistant-with-`tool_calls` plus its tool
results is one atomic unit; select whole units back from the end until the token budget is spent.
This is both leaner and more correct than a row floor plus a repair loop, and it is the only thing
that can reduce Anthropic's **block count** — which is what its ~20-block cache lookback actually
counts. (My first draft claimed demotion would relieve the lookback. It would not: demotion changes
content size while preserving one tool-result block per row. Claim withdrawn.)

### 3. Budget beats recency

If even the newest unit does not fit, demote inside it too. A hard "keep the newest verbatim" rule
reintroduces the irreducible floor this spec exists to remove.

### 4. Measure progress on the assembled request, in tokens

Adopt Hermes' rule: commit only when the projected request drops **materially**. Replace the
prefix-bytes comparison, and replace the count-only entry gate with a size-aware one so the
few-but-huge session is not skipped.

## What must be proven, not assumed

1. The assembled request after compaction is **materially smaller** — the ratio table is the number
   to beat.
2. `context_irreducible` stops firing on runs that previously hit it.
3. **Identifier retention across TWO generations**, not one. A demoted row later enters the prefix
   and is summarized from the stub; `recall` prefers the active copy; reflection reads active rows.
   This is explicitly **not** neutral and must be measured, not asserted.
4. **Cache hit does not regress.** Demotion rewrites rows exactly once, at an event that already
   invalidates. If hit rate drops, the monotonicity assumption is wrong.
5. `read_file` on a demoted row's path still returns the full original.
6. Idempotence: a second compaction leaves an already-demoted row **byte-identical**.

## Test plan

- **Unit:** oversized spilled result in the tail shrinks; no spill marker → untouched; spill file
  missing → untouched; second compaction is byte-identical; a tool group is never split; budget
  overrides recency when the newest unit alone exceeds it.
- **Live, at volume:** Aperture QS lab lanes in parallel (long, tool-heavy — the shape that triggers
  this) plus Ferni for the autonomous-agent shape, across Anthropic native, OpenRouter and Codex
  sign-in.

## Deliberately not doing

- **No projection/freeze layer.** Writing the demotion into the re-inserted row gets the same
  stability for none of the machinery.
- **No idle compaction** (Hermes' `_should_idle_compact`) in this batch. It is a good idea and a
  different release: it needs a scheduler hook and has its own failure modes.
- **No typed artifact ledger** (Pi's read/edited sets) yet. Our path ledger already survives; typing
  it is an improvement, not a fix.

Related: [[spec-cache-breakpoints]], [[fleet-review-playbook]].
