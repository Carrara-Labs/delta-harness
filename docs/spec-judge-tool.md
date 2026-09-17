# Spec: the `judge` tool and judge recipes (judge lane, slice 2)

Draft 2, 2026-09-17 (codex consult 4 folded, E5 evidence added). Builds on slice 1 (`docs/spec-judge-lane.md`, shipped on
`feat/judge-lane`: the shadow lane, `judge.json`, the client, the egress rail). Nic's brief
for this slice, verbatim in intent: let the primary model do the thinking, define the work,
the parameters, the questions and the expected outputs, then outsource the execution to the
System One model; keep the specific use cases pre-built where we know them; and let the agent
save what it designed as a tool it can reuse next time.

## Why this is the right shape

The offline experiments (`docs/study-system-one-jev.md`, E1 to E5) say two things:

- Jev agrees with Opus's own judgment on rows it kept 92% of the time at 0.5 on a real
  sweep, and a generic "does the row fit the ask" question keeps 84 to 91% of what agents
  later listed while removing 37 to 43% of the rest (E1, E1b).
- The generic question is the wrong instrument for a specific ask. The misses are rows the
  ask ruled in for a reason a literal reader cannot infer from "fits" (a Teach For America
  alumnus with the TFA role fifth in the history; an "Inference, OpenAI" headline for a "no
  pure research" brief). A question written FOR that ask ("does `row.roles` include a
  teaching role at Teach For America before the founding role?") is what a literal judge
  needs. That question is exactly what the primary model is good at writing and Jev is good
  at answering thousands of times.

- E5 (Opus 5 writes 2 to 5 Noul questions per ask, Jev executes, same rows and labels as E1b,
  11 asks): agent-designed questions filter more where the generic question is blind (BDR
  ask: 100% of listed rows kept and 54% of the rest removed, against 83% / 31% generic; the
  "verified invite-only" ask 95% / 61%). They also fail in one specific way: an `all` gate
  over a question whose field is often missing (a Europe check on `location` when a third
  of rows carry none) collapsed recall to 33% on one ask and 48% on another. The mechanism
  must treat missing evidence as unknown, never as a no, and the agent must be told so.

So the division of labour is: the frontier model writes the judgment once, code runs it over
every row, the judge answers. The agent never reads the rows it did not ask for. Codex's
framing of the cost: a standalone `judge` call costs one extra model continuation after the
fetch (the model cannot read the result in the generation that emitted the call), so the
common path must let the judge ride the fetch itself.

## Two entry points, one executor

1. **Fetch-integrated (the common path).** A tool that returns rows accepts an optional
   `judge` argument carrying the design (or a recipe name); the engine judges the result
   between redaction and the model, and the model receives the matches, the counts, the
   unresolved references and the fetch cursor in the SAME tool round. Opus designs the work
   in the fetch turn it was already going to spend. Which tools accept `judge` is declared
   by the operator in `judge.json` (`tool.sources.fetch: ["aperture__fiber_call"]`), with
   the `rows` path per tool; the engine strips the `judge` argument before the tool sees it.
2. **Standalone `judge`** for rows that already exist: a spilled result of this run, a typed
   JSON artifact this run wrote, or inline rows. One extra continuation; used for rescreening
   and for sweeps the agent assembled itself.

Both run the slice 1 executor (`JudgeLane`: bounds, scrubbing, deadline, cancellation,
concurrency, cooldown) and both are registered only when the lane is configured (key +
egress) and `tool.enabled` is true in `judge.json`. Safe mode drops them with the lane.

```json
{
  "name": "judge",
  "arguments": {
    "source": { "call_id": "call_7" },
    "judge_fields": ["headline", "location", "roles", "education"],
    "return_fields": ["headline", "location"],
    "ask": "Teach For America alumni who founded a company after teaching",
    "questions": {
      "taught_tfa": { "instructions": "Does `row.roles` include a Teach For America role?", "criteria": { "true": "a corps member, teacher or staff role at Teach For America appears in the roles", "false": "no such role" } },
      "founded": { "instructions": "Does `row.roles` include a founder or co-founder role?" },
      "in_target_metro": { "instructions": "Is `row.location` in or near San Francisco, Austin, Los Angeles or Nashville?" }
    },
    "combine": { "all": ["taught_tfa", "founded"] },
    "threshold": 0.5,
    "return": "matches"
  }
}
```

- `source`: where the rows are, as an engine-issued handle, never a free path. Three forms:
  `{"call_id": "<a tool call of THIS run>"}` (the engine resolves the journaled result,
  bound to the run and the caller; a path is not authorization), `{"artifact": "<a JSON
  file this run wrote under the workspace>"}` (must parse as JSON, capped at 2 MB before
  parsing), or `{"rows": [...]}` inline (capped at 200). The agent never loads the rows into
  its own context.
- `fields`: two lists, both validated against the operator's allowlist for that source
  (`tool.fields[<tool or "*">]` in `judge.json`): `judge_fields`, what the judge sees, and
  `return_fields`, what comes back to the agent. Reading a row, sending it to a vendor and
  returning it to the model are three permissions; `email`-class fields are absent from all
  three unless the operator lists them. Values are bounded as in slice 1, and a field that
  is missing or truncated on a row is reported per row (`missing`, `truncated`), never
  silently read as evidence of absence.
- `ask`, `questions`: Noul only, same validator as `judge.json` (identifiers, lengths,
  criteria shape). 1 to 8 questions.
- `combine`: `{"all": [...]}` or `{"any": [...]}` over question ids (non-empty, known,
  unique), evaluated in code against `threshold` (default 0.5, `>=` passes). Unlisted
  questions are reported, not gating. A gating question whose fields are missing on a row
  makes that row `unknown` for the gate, and unknown rows are returned in their own list,
  never dropped (E5: an `all` gate over a sparse field is how recall collapses).
- `return`: `matches` (the rows that pass, `return_fields` under `data`, plus `i`, the
  source reference and every score), `scores` (index + scores for every row, no fields), or
  `counts` (only the numbers). Default `matches`. Counts are exhaustive: matched, rejected,
  unknown, abstained, unprocessed, and they survive result capping; past the cap the rows
  spill and the head names the counts and the path.

What comes back:

```json
{ "rows_in": 160, "matched": 41, "rejected": 102, "unknown": 11, "abstained": 6, "unprocessed": 0,
  "matches": [ { "i": 3, "ref": { "call_id": "call_7", "path": "output.data[3]" },
                 "scores": { "taught_tfa": 0.97, "founded_after": 0.81, "in_target_metro": 0.12 },
                 "data": { "headline": "...", "location": "...", "roles": [...] } } ],
  "unknown_rows": [ { "i": 9, "missing": ["education"] } ],
  "cost_usd": 0.0031, "model": "jev-1.13.0", "calls": 32 }
```

Numbers and the agent's own field selections only. The judge never writes prose into the
result; the agent writes the take. Order-of-events and date arithmetic ("founded AFTER
teaching") stay in code: the seam's deterministic `screen` rules do dates, the judge does the
semantic half ("this role is a founding role"), and the agent combines the two.

## Recipes: the reusable part

A recipe is the tool's arguments minus `source` and `ask`, saved under a name. The agent
saves one with `judge_save` and runs one with `judge` by naming it:

```json
{ "name": "judge", "arguments": { "recipe": "tfa-alumni-founders", "source": {...}, "ask": "..." } }
```

Recipes live in `skills/judge/<name>.json`, one file each, declarative data only (a recipe
can never grant a permission, name a source, or change provider settings; every use is
revalidated against the current rails). `judge_save` writes a DRAFT: validated with the
shared validator, refusing an existing name unless `revise: true`, which writes a new
revision. A recipe carries `schema_version`, `purpose` (one line, what it selects), the
`judge_fields`, `questions`, `combine`, `threshold`, the judge model it was written against,
`author_run`, and a content `hash`. Trust is a separate, operator-owned state: a recipe is
`draft` until the operator promotes that exact hash (`delta judge promote <name>@<hash>`, or
`tool.recipes.auto_promote: true` on a bench lane); a revision invalidates the promotion.
Drafts are usable by the run that wrote them and, when the operator allows
(`tool.recipes.drafts: "own" | "all" | "none"`), by later runs. Usage counts and selectivity
live in telemetry (`judge.decision` with `recipe` and `recipe_hash`), never inside the file.
The `judge` tool description lists at most 12 promoted recipes by name and purpose at boot;
the rest are discoverable with `judge` `{"list": true}`.

`skills/judge/` is protected by the same rail as the fixed operator files for `write_file`,
`move`, `delete` and delegated code: only `judge_save` writes there. That is the loader
boundary the draft-versus-promoted distinction depends on.

The self-file may mention a recipe by name ("for tenure screens use `judge tenure-solid`");
it never carries the questions. That keeps DELTA.md lean and the questions reviewable in
one place.

## Rails (operator-owned, `judge.json`)

```json
{
  "version": 1,
  "tool": {
    "enabled": true,
    "sources": { "fetch": { "aperture__fiber_call": "output.data" }, "call_id": true, "artifact": true, "inline": true },
    "fields": { "aperture__fiber_call": ["headline", "location", "roles", "education", "skills", "screen"], "*": ["headline", "location"] },
    "budget": { "max_cost_per_run_usd": 0.25, "max_rows_per_call": 500, "max_questions": 8, "deadline_ms": 30000 },
    "children": false,
    "recipes": { "drafts": "own", "auto_promote": false }
  },
  "policies": { "...slice 1 shadow policies, unchanged..." }
}
```

Precedence is one line: env decides whether the lane exists (key + egress), `judge.json`
decides everything else. `enabled` is the one switch. The agent picks fields and questions
inside the operator's field lists; the operator decides which tools accept `judge`, which
fields may be judged or returned per tool, the per-run spend, the deadline, whether research
children may call it (`readonly` does not imply vendor egress), and the recipe policy.
Batch size, request size and concurrency are engine constants (batches are sized by
serialized bytes, not row count). The spend is RESERVED before dispatch against the run's
budget through `reserveBudget`, like a research child, and reconciled after; a request that
fails ambiguously is charged as if it billed. `delta judge test <fixture.json>` prints, with
no network, the matched rails, the resolved rows, the exact outbound payload and the
effective mode, so an operator can see what would leave the box before enabling anything.

## Pre-built recipes (Aperture, in the bundle, not the engine)

The engine ships none. Aperture's bundle seeds `skills/judge/` with the ones the field
reports keep asking for: `fits-ask` (the generic E1 question), `tenure-solid` (short-stay
pattern from `roles`, dates as text), `ic-not-manager`, `current-company-in-list`,
`degree-year-window` (the judge reads the year the education line states), `duplicate-of`
(same person across two rows). Each ships with its threshold from the shadow data.

## Engine behaviour

`judge` runs in-process, in the tool phase, with the slice 1 `JudgeLane` (same client,
concurrency bound, cooldown, scrubbing, bounds). Steps: resolve the source (file read
confined, JSON parsed, `rows` path resolved), validate the arguments with the shared
validator plus the rails, project, batch, judge, combine in code, build the result, charge
`cost_usd` through `chargeUsage`, emit `judge.call` per request and one `judge.decision`
with `origin: "tool"`, the recipe name if any, and the counts. Abstained rows are reported
in the result as `abstained` and listed by index so the agent can read them itself.

Timeouts: the tool's own deadline is `max(RESULT_DEADLINE_MS, rows / batch * timeout /
CONCURRENCY)`, bounded at 60 s; past it the remaining rows abstain and the result says so.

## What the agent is told (tool description, engine-authored)

"Screen many rows with a fast literal judge instead of reading them yourself. Point it at a
spilled or saved result, choose the fields that matter, write 1 to 8 yes/no questions, each
about ONE property visible in those fields (it cannot count, add, or compare dates; ask what
the text says). Get back the rows that pass, with a probability per question. Save a good
question set with judge_save to reuse it by name."

## Tests

Shared validator reuse; source resolution (spill of this run only, workspace file, inline
cap); rails enforced (rows, questions, request chars, per-run cost, sources, recipe saving);
combine all/any with threshold; return modes; abstain listing; result capping; recipe save
(validate, no overwrite, stats update on use); the description lists recipes; the agent
cannot write a recipe with write_file into a name the tool would load (same rail); a
research child cannot call `judge` unless the operator allows it (read-only, so it can: the
test pins that this is deliberate and that the child's spend is charged to the parent).

## The deciding experiment (before the build is judged worth it)

Split the E1b asks into development and held-out sets. On the development asks, freeze the
strongest pre-built recipe (threshold and combine chosen there). On the held-out asks, let
Opus write the questions from the ask and the field schema alone (no rows, no labels, no
prior answers), hold projection, judge version, batching and budget constant, and compare
listed-row retention at the same non-listed-row reduction, paired by ask. Blindly adjudicate
the disagreements (unlisted rows are not proven negatives). Ship the agent-designed path only
if it wins beyond the paired uncertainty with no material per-ask regression, at an
acceptable design-plus-execution cost. E5 is development evidence for this, not the proof.

## Rollout

1. Bench lane only, `tool.enabled: true`, no recipes seeded: watch what the agent designs
   on the 24-task corpus, live, through `judge.decision` (`origin: "tool"`, the recipe hash
   when one was used).
2. Seed the Aperture recipes as drafts; promote after the held-out comparison; twin-lane
   battery against control; blind judge; the bar is the slice 1 bar.
3. Client lanes only with the engineer, promoted recipes only.

## Not in this slice

Choice and Score questions (they need the confidence-versus-selection split codex flagged);
a judge over social posts or documents (needs a text source shape, comes with the Fiber posts
work); `duplicate-of` (needs a pair contract); tenure and year arithmetic (code, via the
seam's screens); the bounded sweep loop (slice 3, unchanged from the slice 1 spec).
