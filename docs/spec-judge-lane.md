# Spec: the judge lane (System One decisions inside the harness)

Draft 2, 2026-09-17, as BUILT on `feat/judge-lane` (commits 04d9a22, 78049e8), codex rounds
1 to 3 folded. Companion study: `docs/study-system-one-jev.md`. Slice 2 (the agent-designed
`judge` tool and recipes) is `docs/spec-judge-tool.md`.

## Goal

Let an operator declare, in one small file, a set of fast typed judgments the engine runs on
tool results, without any prompt change, any agent involvement, or any new turn. First use:
score rows of a search result against the user's ask so a later mode can hand the frontier
model fewer, better rows. Configured like the utility lane: a key and a model in env, a policy
file in the bundle, off by default.

## What shipped in slice 1

Shadow only. The engine judges the rows of a matching tool result and records per-row scores
on a telemetry event. The result the model sees is the same string, byte for byte: it is never
re-serialized. That is what makes the lane safe to run on a live lane while thresholds are
chosen from real data.

## Non-goals (this slice)

- Changing any tool result (`tag`, `filter`): the next slice, gated on shadow data and on the
  conditions at the end of this page.
- A bounded fetch loop (sweep worker). Slice 3.
- Dispatch-time classification, model routing, recall rerank. Later.
- Any change to what the agent can do. The agent cannot call the judge, cannot edit its
  policies, and never sees a judge decision.

## Config (env, operator-owned)

| var | default | meaning |
| --- | --- | --- |
| `DELTA_JUDGE_KEY` | unset | the credential; alone it does NOT enable the lane |
| `DELTA_JUDGE_EGRESS` | unset | `1` = the operator authorizes sending projected rows and the ask to the judge endpoint. A key is not consent; both are needed. Unsetting it is the kill switch. |
| `DELTA_JUDGE_URL` | `https://api.typesafe.ai/v1/systemone` | endpoint |
| `DELTA_JUDGE_MODEL` | `jev-1.13.0` | pinned version, never an alias by default |
| `DELTA_JUDGE_TIMEOUT_MS` | `3000` | per request; a timeout abstains |
| `DELTA_JUDGE_PRICE_PER_MTOK` | `0.042` | input-token price for cost accounting |

Safe mode drops the lane like every non-floor capability. The key is registered as a secret
value at boot, so an echoing endpoint cannot land it in a row, an event or a file, and it
never reaches a child (research) process or a tool. A key plus policies without
`DELTA_JUDGE_EGRESS=1` logs one boot warning and stays off.

## Policy file: `judge.json` (bundle, fixed, operator-owned)

Ships like `vocab.json`: `DELTA_JUDGE_JSON_B64`, re-seedable by `delta bundle apply`, in
`FIXED_OPERATOR_FILES` so the agent's write rail refuses it. Boot and `apply` share one strict
validator; a bad file fails boot with the field named, never a silently inert lane.

```json
{
  "version": 1,
  "policies": {
    "fiber_rows": {
      "on": "tool.result",
      "tool": "aperture__fiber_call",
      "rows": "output.data",
      "row_fields": ["headline", "location", "roles", "education", "screen"],
      "ask": { "from": "run.input", "after": "The user's question: \"\"\"", "until": "\"\"\"" },
      "questions": {
        "fits": {
          "instructions": "Does `row` fit what `ask` is looking for: role, seniority, location, kind of company, and every explicit requirement or exclusion? Judge only from the row.",
          "criteria": { "true": "plausibly fits", "false": "clearly does not fit or a stated requirement rules them out" }
        }
      },
      "threshold": { "fits": 0.3 },
      "batch": 5,
      "max_rows": 200
    }
  }
}
```

Fields:

- `on`: only `tool.result`. `before_turn`, `run.start` and `loop` are reserved words,
  rejected at validation so a future meaning cannot be guessed.
- `tool`: an exact tool name. One policy per tool; two policies on one tool are refused.
- `rows`: dot path (with `[i]` indices) into the parsed JSON result to an array of objects.
  Own-property traversal only; prototype segments are rejected. A result that is not JSON,
  or where the path is not a non-empty array of objects, is skipped (`skipped: shape`).
- `row_fields`: required, non-empty, the dot paths copied from each row into the state.
  Nothing else leaves the box. Each value is bounded (1,000 chars per string, 12 items per
  array with 300 chars each, objects as clipped JSON), the whole row under 4,000 chars; a
  field that does not fit is dropped whole and the row is flagged `_truncated`.
- `ask`: what the judge is told the user wants. `{"from":"run.input","after":"<marker>",
  "until":"<marker>"}` takes the text of the run input after a marker the operator names,
  up to an optional end marker, capped at 2,000 chars; or `{"literal":"..."}`. `after` is
  required: the whole run input is never sent (a dispatch card carries a run token). Markers,
  not regexes: linear, no backtracking on hostile input. No marker match = the policy
  abstains (`skipped: no_ask`).
- `questions`: Noul only in this slice (a probability that a statement is true), identifiers
  as keys, `instructions` up to 2,000 chars, optional `criteria` `{true, false}`. `` `row` ``
  in an instruction is rewritten to `` `rows[i]` `` per row.
- `mode`: `shadow` only in this slice.
- `threshold`: per question, in (0,1). In shadow it only counts `rows_would_filter` (rows
  below EVERY thresholded question). An empty object is treated as absent.
- `batch`: rows per request, 1 to 20, default 5 (small batches limit what a hostile row can
  do to its neighbours). `max_rows`: 1 to 500, default 200; rows past it are counted as
  `rows_capped`, never sent.

## Engine behaviour (as built)

One call site in `execCall` (`run.ts`), AFTER the tool's journal row and message row are
committed, so judging can never delay or lose a tool outcome and a restart replays the
journal without re-judging. The judge sees the redacted PRE-cap result (the whole payload,
not the elided middle). Inside `JudgeLane.judge`:

1. Cooldown check, ask resolution, JSON parse, `rows` path; any mismatch skips with a named
   reason and no request.
2. Batches of `batch` rows. Each request carries `{ask, rows}` with every string scrubbed at
   the leaf (registered secrets and secret-shaped text) BEFORE clipping, then bounded; one
   Noul question per row per policy question.
3. One cancellation per result: an 8 s deadline and the run's own abort signal both trip it,
   and it reaches every in-flight request and every slot wait. Four requests in flight
   process-wide, a released slot handed directly to the next waiter (no barging). The
   cooldown (three consecutive failures, one minute) is rechecked before every send.
4. Answers are matched by generated id and must be a finite noul in [0,1]; anything else
   abstains that row. A provider error body is scrubbed before it reaches telemetry; the
   answering model id must be a plain identifier; usage must be a finite bounded count.
5. The decision is emitted and the cost is charged to the run once through `chargeUsage`
   (dollars only, never tokens: a judge call reads the result, it is not model context).

Guarantees: the tool result string is never touched; the lane never throws into a turn; rows
are never lost (judged + abstained + capped = rows_in); nothing the judge returns is inserted
anywhere the model reads.

## Telemetry

Both events are payload-bearing in the exporter: without payload consent only counters, enums,
cost and the model id leave the box; `scores`, `p10`, `p50` and error text need
`DELTA_CAPTURE_PAYLOADS=1`.

- `judge.call` per request: `policy`, `mode`, `rows`, `latency_ms`, `status`, and on
  success `input_tokens`, `cost_usd`, `model`; on failure `error.class` (`timeout`, `auth`,
  `quota`, `transient`, `request`), `http_status`, `error.message` (scrubbed).
- `judge.decision` per tool result: `policy`, `mode`, `tool`, `call_id`, `rows_in`,
  `rows_judged`, `rows_abstained`, `rows_capped`, `rows_would_filter`, `skipped` (`shape`,
  `no_ask`, `cooldown`, `max_rows`, `deadline`), `scores` (JSON list of `[row index, noul]`
  for the first thresholded question), `p10`, `p50`, `calls`, `cost_usd`, `input_tokens`,
  `latency_ms`, `model`. The per-row scores joined to the rows the agent later kept (by
  `call_id` and index) are what a threshold is chosen from.

## What the agent sees

Nothing. Shadow changes no byte of any result.

## Tests (`bun test`, no network; 22 cases in `test/judge.test.ts`)

Validator: every malformed field named, reserved `on`, prototype keys, empty threshold, one
policy per tool. State: own-property paths, allowlist + bounds, marker extraction (and its
linear cost on a 400 KB input), leaf scrubbing of a newline-bearing secret, answer validation.
Client: key only in the header, echoing endpoint, fake model id, `1e309` usage, timeout,
cancellation, 429, non-JSON. Lane: batching and would-filter counts, partial failure, cooldown
mid-result and its expiry, `max_rows` accounting, a deadline with a 200 ms request
outstanding, six parallel results never exceeding four in flight, cancellation by signal.
Config: key without egress stays off, safe mode, boot failure named. Bundle apply: seeds,
refuses, leaves the old file. Exporter: the no-consent attribute set, exactly. Run loop:
byte-identical message row AND journal row, the ask without the token line or the routing
card, only the allowlisted fields sent, event order `tool.result` then `judge.call` then
`judge.decision`, cost charged once, a real journal replay never re-judged, an unmatched tool
never judged.

## Rollout

1. One bench lane, `DELTA_JUDGE_EGRESS=1`, the `fiber_rows` policy above, shadow. The
   engineer profiles the run ids with the lab's peek script so the two studies share
   telemetry.
2. Score the shadow decisions against the rows the agent kept (E1b gives the curve shape:
   generic question keeps 84% of listed rows at 0.3 and removes 43% of the rest). Choose the
   threshold per policy from that curve, never from a cookbook.
3. `tag`, then `filter`, on the same rig under the conditions below, twin-lane against
   control with the blind judge. No client lane before both.
4. The engineer owns the Aperture policy text and the seam's row shapes; the harness owns the
   mechanism. `judge.json` lives in `app/agent/quick-search/` like `vocab.json` and rides the
   same reseed path.

## Conditions for `tag` and `filter` (from codex, before either ships)

A rewritten result must be lossless: a JSON round-trip changes key order, number spelling,
unicode escapes and big integers, so `tag`/`filter` need a splice on the original string or an
explicit abstention on inputs the round-trip would alter. A `_judged_out` pointer must live
outside the row array (inside it, it becomes an apparent candidate). Filtering on a Choice or
Score needs the selection separated from the confidence. Missing evidence is unknown, never a
negative. The spill pointer is published only after a successful atomic write, and the
compaction ledger must recognize the new file name. Rows judged out must be recoverable with
`read_file` and listed by original index.

## Slice 3 (not now): the bounded sweep

A policy `on: "loop"` that lets code, not the frontier model, page through a tool:
`{ tool, next: { from: "output.next_from", arg: "from" }, until: { question, threshold, min_yield }, max_pages, credit_cap }`.
The frontier model calls the tool once with the plan; the engine repeats the call, judges each
page, stops on the contract (target reached, `max_pages`, the cap, or source exhaustion) and
returns one result holding the accepted rows plus the counts and a `continuation` cursor. Low
yield asks the model to replan; it never declares the user's task complete (E4: on a
completeness ask the per-page yield is flat, so only a cap stops a sweep). Credits are enforced
by the seam before each billable call. Designed after slice 2 has shadow data and after the
seam exposes cursors uniformly.
