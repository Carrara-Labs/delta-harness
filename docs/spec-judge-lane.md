# Spec: the judge lane (System One decisions inside the harness)

Draft 1, 2026-09-17. Slice 1 of the TypeSafe Jev integration. Companion study:
`docs/study-system-one-jev.md`. Codex consult 1 shaped the shape below (start at the
seam, then a typed judge dependency beside the utility lane, an operator-owned policy
file, shadow mode first, no agent-callable judge tool).

## Goal

Let an operator declare, in one small file, a set of fast typed judgments the engine
runs on tool results, without any prompt change, any agent involvement, or any new
turn. First use: tag or filter rows of a search result against the user's ask so the
frontier model reads fewer, better rows. Configured like the utility lane: a key and a
model in env, a policy file in the bundle, off by default.

## Non-goals (this slice)

- A bounded fetch loop (sweep worker). Slice 2, see the end.
- Dispatch-time classification, model routing, recall rerank. Later slices.
- Any change to what the agent can do. The agent cannot call the judge, cannot edit its
  policies, and never sees a judge decision as an instruction.

## Config (env, operator-owned)

| var | default | meaning |
| --- | --- | --- |
| `DELTA_JUDGE_KEY` | unset | enables the lane; unset = lane off, every policy inert |
| `DELTA_JUDGE_URL` | `https://api.typesafe.ai/v1/systemone` | endpoint |
| `DELTA_JUDGE_MODEL` | `jev-1.13.0` | pinned version, never an alias by default |
| `DELTA_JUDGE_TIMEOUT_MS` | `3000` | per request; a timeout abstains |
| `DELTA_JUDGE_PRICE_PER_MTOK` | `0.042` | input-token price for cost accounting |
| `DELTA_JUDGE_MODE` | unset | when set to `shadow`, forces every policy to shadow: the kill switch short of unsetting the key |

Safe mode drops the lane like every non-floor capability. The key never reaches a
child (research) process or a tool.

## Policy file: `judge.json` (bundle, fixed, operator-owned)

Ships like `vocab.json`: `DELTA_JUDGE_JSON_B64`, re-seedable by `delta bundle apply`,
in `FIXED_OPERATOR_FILES` so the agent's write rail refuses it. Validated at boot the
way `vocab.json` is (valid JSON object, known keys, bounded sizes); a bad file fails
boot with a named reason, never a silently inert lane.

```json
{
  "version": 1,
  "policies": {
    "fiber_rows": {
      "on": "tool.result",
      "tool": "aperture__fiber_call",
      "rows": "output.data",
      "row_fields": ["headline", "location", "roles", "education", "screen"],
      "context": "run.input",
      "questions": {
        "fits": {
          "type": "noul",
          "instructions": "Does `row` fit what `ask` is looking for: role, seniority, location, kind of company, and every explicit requirement or exclusion? Judge only from the row.",
          "criteria": { "true": "plausibly fits", "false": "clearly does not fit or a stated requirement rules them out" }
        }
      },
      "mode": "shadow",
      "threshold": { "fits": 0.3 },
      "batch": 10,
      "max_rows": 200
    }
  }
}
```

Fields:

- `on`: only `tool.result` in v1. Other decision points (`before_turn`, `run.start`)
  are reserved words, rejected at validation so a future meaning cannot be guessed.
- `tool`: exact tool name, or a glob with one trailing `*`.
- `rows`: dot path into the parsed JSON result to an array of objects. A result that
  is not JSON, or where the path is not an array of objects, is skipped, counted in
  telemetry as `skipped: shape`.
- `row_fields`: keys (dot paths) copied from each row into the state. Absent = whole
  row, capped at 4,000 chars. Keeps the state small and keeps contact fields out.
- `context`: what `ask` is. v1 accepts `run.input` (the message that started the run,
  capped at 4,000 chars) or a literal string. Nothing from history, the self file, or
  the policy prose: the judge sees the ask and the rows, never the conversation.
- `questions`: the TypeSafe question map, verbatim, with one convention: `` `row` `` in
  an instruction is rewritten to `` `rows[i]` `` per row. Types `noul`, `choice`,
  `score` as the API defines them.
- `mode`: `shadow` (judge, record, change nothing), `tag` (append `_judge` to each
  judged row before the model sees it), `filter` (rows whose every thresholded
  question falls below its threshold are moved out of the result into a spill file;
  a pointer replaces them). Default `shadow`. `filter` never deletes: the file is
  `read_file`-able and the pointer names the count and the path.
- `threshold`: per question. Noul compares the probability; choice and score compare
  `confidence`. Absent = tag only, never filter.
- `batch`: rows per request, 1 to 50, default 10. `max_rows`: rows judged per tool
  result, default 200; rows past it are left untouched and counted.

## Engine behaviour

One insertion point: `execCall` in `run.ts`, after `redactSecretValues` and before
`capAndSpill`, so the judged-out rows never inflate the inline result and the spill
file lands clean. Steps, all inside `applyJudge(result, policy, deps)`:

1. Parse the result as JSON; resolve `rows`; skip on any shape mismatch.
2. Build batches of `batch` rows; each request's state is
   `{ ask, rows: [projected rows] }` with one question per row per policy question.
   Requests run with concurrency 4 and the per-request timeout.
3. Map answers back by index. A failed or timed-out batch abstains: its rows are
   untouched in every mode, and the batch is counted as `abstained`.
4. Apply the mode. `tag` writes `_judge: { fits: 0.87 }` on the row (numbers only,
   never text from the judge). `filter` splits rows below every threshold into the
   spill file `.delta/spill/<run>.<call>.judged.json` and leaves
   `{"_judged_out": {"count": N, "path": "...", "note": "rows below threshold, read_file to recover"}}`
   in their place at the end of the array.
5. Add the judge cost to the run's usage so budgets see it, and emit telemetry.
6. Re-serialize with the original formatting rules (JSON.stringify, no pretty print)
   and hand the result on to `capAndSpill` unchanged in every other respect.

Guarantees: the judge never throws into the turn; the tool result is byte-identical
in shadow mode; a row is never modified beyond the added `_judge` key; nothing the
judge returns is ever inserted as prose; the judge sees at most `max_rows` rows of
`row_fields` and the capped ask; the state never carries secrets (row_fields are an
allowlist) and the key is only ever in the header of the judge request.

## Telemetry

New events, exported with the same consent rules as `model.call`:

- `judge.call` per request: `policy`, `mode`, `rows`, `questions`, `latency_ms`,
  `input_tokens`, `cost_usd`, `model` (the answering version from the response),
  `status`, `error.class` (`timeout`, `auth`, `quota`, `transient`, `request`).
- `judge.decision` per tool result: `policy`, `mode`, `tool`, `rows_in`, `rows_judged`,
  `rows_tagged`, `rows_filtered`, `rows_abstained`, `skipped` (`shape`, `max_rows`),
  `p50` and `p10` of the first thresholded question. This is what a shadow run is
  scored on before anyone flips a policy to `tag` or `filter`.

## What the agent sees

- shadow: nothing.
- tag: `_judge` numbers on rows. POLICY.md may tell the agent what they mean, in the
  operator's words. The engine adds no prose.
- filter: fewer rows and one pointer object. The agent can recover with `read_file`.

## Tests (bun test, no network)

A fake fetch injected through deps. Cases: lane off without a key; safe mode off;
boot rejects a malformed `judge.json` with the field named; non-JSON result skipped;
path not an array skipped; batch and max_rows boundaries; `` `row` `` rewrite per
index; tag writes numbers only; filter moves exactly the below-threshold rows, writes
the spill file, leaves the pointer, and keeps the array order otherwise; timeout and
5xx abstain per batch with rows untouched; shadow leaves the result byte-identical;
usage cost added once; both events emitted with the listed attributes; the key never
appears in any event, message row, or spill file.

## Rollout

1. Land the lane with shadow as the only mode used in the fleet. Point one bench lane
   at it with the `fiber_rows` policy above.
2. Score the shadow decisions against the rows the agent kept (the offline
   experiment E1 already gives the shape: kept-row recall and unkept-row filter rate
   by threshold). Choose the threshold per policy from that curve, never from the
   cookbook.
3. Flip the bench lane to `tag`, run the 24-task battery twin-lane against control
   with the blind judge. Then `filter` on the same rig. No client lane before both.
4. The engineer owns the Aperture policy text and the seam's row shapes; the harness
   owns the mechanism. `judge.json` lives in `app/agent/quick-search/` like
   `vocab.json` and rides the same reseed path.

## Slice 2 (not now): the bounded sweep

A policy `on: "loop"` that lets code, not the frontier model, page through a tool:
`{ tool, next: { from: "output.next_from", arg: "from" }, until: { question, threshold, min_yield }, max_pages, credit_cap }`.
The frontier model calls the tool once with the plan; the engine repeats the call,
judges each page, stops on the contract (target reached, yield under `min_yield` for
two pages, `max_pages`, or the cap), and returns one result holding the accepted rows
plus the counts and a `continuation` cursor. Stopping on low yield asks the model to
replan; it never declares the user's task complete. Credits are enforced by the seam
before each billable call (that is the product's cap, not the judge's). Designed after
slice 1 has shadow data and after the seam exposes cursors uniformly.
