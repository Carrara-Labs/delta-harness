# Spec: say what changed (0.2.13 Tier 1 + Tier 2)

Implementation spec for `harness-0.2.13-plan.md` slices S1-S8. Written 2026-08-07 against refs
refreshed the same day (`~/delta/.refs/{openclaw@b738e25780, pi@ac4ac9e, hermes-agent}`).

**v2, after a codex review of v1 returned six P1s.** What changed is recorded in "What the review
killed" at the end, because three of the six changed the design rather than the wording.

Tier 3 (S9 breaker schema retention, and the mechanism fix itself) is **not** in this spec.

---

## What the competition does, checked in current source

### The retained-tail budget: both of them decouple trigger from target, and we used to

The strongest single finding, and it makes S5 a two-line fix rather than a design.

| | trigger | target (what it compacts *to*) | coupled? |
|---|---|---|---|
| **pi** | `shouldCompact(contextTokens, contextWindow, s) = contextTokens > contextWindow - s.reserveTokens` (`compaction/compaction.ts:237`) | `keepRecentTokens`, default **20,000**, a flat constant (`settings-manager.ts:785`) | **no** |
| **openclaw** | window-utilisation staged | `agents.defaults.compaction.keepRecentTokens`, operator int (`zod-schema.agent-defaults.ts:146`) | **no** |
| **delta today** | `projected > compactAtTokens` (`run.ts:866`) | `compactAtTokens - fixed - SUMMARY_RESERVE` (`run.ts:872`) | **yes** |

Delta already has the right constant: `RECENT_TOKENS_DEFAULT = 24_000` (`compaction.ts:16`), read at
`compaction.ts:348` as `opts.recentBudgetTokens ?? RECENT_TOKENS_DEFAULT`. The call site always
passes `recentBudgetTokens`, so **the default never applies and the tail is sized by the ceiling**.
On a 200k ceiling with a ~16k fixed floor that is a 180k tail: compaction lands at ~99% of budget and
re-fires next turn.

Two independent competitors converged on the design we already had and abandoned at one call site.

### The model-window catalogue: pi's shape validates ours and adds two guards we lack

- `contextWindow: Type.Optional(Type.Number())` (`core/model-config.ts:165`), provider override as
  `override.contextWindow ?? model.contextWindow` (`provider-composer.ts:121`), `<= 0` throws
  (`:144`), floor default `128000` (`:160`).
- **Guard we lack #1 - model switch.** `agent-session.ts:1972` skips the overflow check when the
  assistant message came from a different model. **Delta has a failover cascade**, so our ceiling and
  our `lastInputTokens` anchor can be set by one model and applied to another.
- **Guard we lack #2 - stale measurement.** `agent-session.ts:1980` skips compaction when the
  assistant message predates the latest compaction boundary. Delta's equivalent is the blunt
  `lastInputTokens = 0` reset at `run.ts:897`, and **that reset is not in the compaction
  transaction** - see S5.

### Prefix identity: nobody does this, and one competitor's diagnostic corrects our metric

OpenClaw has the most cache machinery of the three and it is all **post-hoc from usage numbers**:
`live-cache-regression-runner.ts` (655 lines, live per-provider lanes with baseline floors and a
deliberately stable 160-section prefix, gated behind `OPENCLAW_LIVE_CACHE_TEST=1`) proves caching
still works; `qa-lab/runtime-parity-cache-diagnostics.ts` classifies misses after a run from
`{inputTokens, cacheRead, cacheWrite}`. Neither can localise a miss to a part of the prompt, because
neither looks at the prompt. **S1 is genuinely novel**, which raises the bar on proving it.

One thing worth stealing: **`cacheWasWarmed`** - a miss only counts once the conversation has warmed
its cache, so turn 1 is not scored as a failure. Note their flag never resets, so it excludes the
*initial* cold turn only; a post-suspend cold start would still score as a miss in their model and
must be handled separately in ours.

**Checked, and no change needed: our denominator is already correct.** `provider.ts:1317` normalises
the Anthropic wire to gross (`input = input_tokens + cacheRead + cacheWrite`) and the OpenAI path
(`:1619`) is gross natively, so `cache_hit_pct = cacheRead / input` reads a write-only rewrite as 0%
rather than concealing it. Worth verifying before building on it.

---

## S1 - segmented prefix identity

**The seam.** `run.ts`, immediately before `deps.chat({...})` at `:927`, computed on the exact values
being passed.

### What is emitted

```
model.call += {
  spine_bytes, spine_hash,   // the assembled system string
  tools_bytes, tools_hash,   // the assembled tool specs
  tools_n,                   // count of advertised tools  ─┐ disambiguators,
  self_bytes,                // DELTA.md size this turn     ─┘ already computed
  history_bytes,
  ephemeral_bytes,
}
```

### Why `tools_n` and `self_bytes` are load-bearing, not decoration

`buildSpine` (`spine.ts:34-36`) embeds **the pinned tool index and the `searchable` count inside the
system string**. So a tool activation moves `spine_hash` *and* `tools_hash` together, and a naive
reading would blame the spine for every activation. Since `searchable = allowedMap.size - active.size`
changes exactly when `active` changes, two integers we already have resolve it completely:

| `tools_n` | `self_bytes` | `spine_hash` | reading |
|---|---|---|---|
| changed | any | moved | **tool activation or breaker withdrawal** - expected, and S4 says which |
| same | changed | moved | **self-write** (`remember`) |
| same | same | moved | **the stable context or policy block changed** - the interesting case |
| same | same | stable | prefix intact; a miss here means history or the wire, not the spine |

That last row is the one that would falsify the standing prediction, which is why it must be
reachable rather than inferred.

### The digest is keyed, per daemon

**A raw hash of the system string is a fingerprint of private content.** The spine carries `DELTA.md`,
policy text and operator context (`spine.ts:39-41`), which is low-entropy enough that an unsalted
48-bit digest is dictionary-testable by anyone holding the telemetry. Since these attributes are
exported *without* payload consent, "not reversible" is not the same as "carries no PII".

So: **`Bun.hash(daemonSalt + segment)`**, rendered as 12 hex chars, where `daemonSalt` is random per
daemon process and never exported. Comparisons are only ever made between consecutive turns of the
same daemon, which is exactly the scope the salt preserves. Cross-daemon comparison is not a feature
we want and its absence is the security property.

`Bun.hash` (wyhash, in the runtime, zero deps) is correct here: this detects change, it does not
authenticate. `createHash("sha256")` is already imported in `vault.ts` and is the wrong tool - about
20x slower on a 64KB tool surface, for a property we do not need.

### These are engine-input digests, and the name must not overclaim

The provider transforms both segments after we hash them: Anthropic renames `parameters` to
`input_schema` and lifts system text into a content block with cache metadata (`provider.ts:1228`,
`:1080`); Responses flattens the spec and moves system into `instructions` (`:1496`, `:1429`).

So a hash pair can stay stable while the actual request body changes shape, if the wire format
changes underneath. **That case is already covered by existing telemetry** - `gen_ai.provider` and
`fallback` are on every `model.call` (`run.ts:1060`, `:1076`), so a cascade switch is visible without
these fields. The residual risk is a serializer edit between deploys, which the engine version in
telemetry bounds.

Hashing inside each serializer would close it completely and was rejected: it triples the surface,
puts a telemetry concern inside the wire path, and buys a case that two existing attributes already
report. **The doc comment must say "engine-assembled input, not the serialized request body"** so no
future reader infers a guarantee we did not make.

### Rejected

- **Hash the whole assembled request.** One number that says "something changed" is what the last
  three rounds already had. Localisation is the deliverable.
- **A diff, or retaining the previous prompt.** Needs the previous request stored, moves
  model-visible text into telemetry, and only works where capture was on *before* the interesting
  turn. The two-stage shape is deliberate: **the cheap always-on signal localises, an expensive
  targeted capture confirms.** This investigation had neither.
- **Hashing history and ephemeral.** History would cost a full ~1MB serialisation per turn. It is
  append-only except for two attributable writers - compaction (own event) and the breaker latch,
  which mutates a tool-result row in place (`run.ts:1351`, now emitting its own event under S4) - so
  `history_bytes` plus those two events is sufficient. Ephemeral sits behind the Anthropic
  breakpoints; note that on the OpenAI/Responses paths caching is automatic prefix matching
  (`provider.ts:286`, `:1491`), so ephemeral is **suffix-safe, not universally uncached**, and its
  byte count is tracked for that reason.

## S2 - the non-shrinking compaction attempt

Two exits bill a summary call and emit nothing:

| exit | condition | new `shrank` | new `reason` |
|---|---|---|---|
| `compaction.ts:494` | `ok` response, empty or unusable content, usage already accrued | `false` | `no_summary` |
| `compaction.ts:538` | summary produced, shrink below `MATERIAL` | `false` | `not_material` |
| `compaction.ts:408` | demotion-only, already emits | `true` | - |
| `compaction.ts:558` | committed, already emits | `true` | - |

Both new emissions carry `summary_tokens`, `summary_cost_usd`, and the before/after bytes that failed
the test. Emitting at `:538` does not weaken what that early return protects - the return guards the
*messages transaction* against a non-shrinking rewrite, and a telemetry insert is not that.

`maybeCompact` returning `null` stays silent: that is a true no-op with no usage. Note the
distinction the existing comment already makes at `:493` - a first-call failure is null, a billed
empty response is not.

**Consequence:** a `compaction` count changes meaning from "history rewrites" to "attempts", now
distinguishable by `shrank`. The release brief must say so, because Aperture's "161 compactions" was
computed under the old meaning.

## S3 - utility-tier calls become visible

`model.call` is emitted in exactly one place (`run.ts:1044`). The v1 spec claimed three bypassing
paths; the real inventory is larger and one site does not charge at all:

| site | calls | charged today? |
|---|---|---|
| `compaction.ts:468` | up to **two** summary attempts per compaction | yes, `sumUsage` |
| `research.ts:177`, `:197` | **many concurrent**, charged once as an aggregate (`:359`, `:381`) | yes, aggregate |
| `reflect.ts:172` | one | yes (`:190`) |
| `builtins.ts:977` | `eval_n` judge | **no - the judge result is never charged** |

**Design: one observational emitter that never touches usage.** A single helper takes
`(events, spine, turn, tier, purpose, result)` and emits `model.call`. It is the only new writer, so
double-charging is structurally impossible: accounting stays where it is, emission is added beside
it. Research emits **per child call**, not per aggregate, because the aggregate is what already
hides the fan-out.

New closed-enum attributes, both `SAFE_ATTRS`-eligible: `tier: "main" | "utility"` and
`purpose: "summary" | "research" | "reflection" | "eval_judge"`.

**Turn attribution, stated rather than assumed.** Compaction receives `turn: stepCount`
(`run.ts:878`) while the main call it precedes is `stepCount + 1` (`run.ts:923`), so a first-turn
compaction reports turn 0. Rather than renumber and break existing consumers, the emitter carries the
spine turn as given and adds `before_turn: stepCount + 1` on utility calls, so a join can attribute
the cost to the turn it enabled. Documented, tested, not silently inconsistent.

**Filed, not fixed here:** `eval_n`'s judge usage is never charged to the run
(`builtins.ts:977`). That is a budget-correctness defect, not a telemetry one, and folding it into a
telemetry slice would hide it. It goes to the backlog with its own line.

## S4 - the breaker latch becomes an event

`run.ts:1348` latches silently. Emit `tool.breaker` once per latch with the tool name (a resolved
registry name, so bounded and safe) and the schema bytes withdrawn. This is what made round two of
the investigation untestable from telemetry, and it is also what makes `history_bytes` sufficient
without a history hash, since the latch's in-place row mutation now announces itself.

## S5 - decouple the retained tail from the ceiling, and close the resume gap

### The budget

```ts
const recentBudget = Math.min(
  Math.max(0, deps.compactAtTokens - fixed - SUMMARY_RESERVE_TOKENS),
  RECENT_TOKENS_DEFAULT,
);
```

The ceiling-derived value becomes a **cap**, the existing constant becomes the **target**. A tight
ceiling with large fixed parts still clamps to the smaller number, so today's behaviour is preserved
exactly where it was already right.

**What this does not do, corrected from v1.** It does not guarantee the assembled request fits.
Compaction always retains at least two protocol units (`compaction.ts:353`, `:359`) and demotion can
only shrink spilled results and capped arguments (`:373`, `:382`), so an irreducible tail or oversized
fixed parts still reach `context_irreducible` (`run.ts:905`) and send anyway. `Math.min` changes the
*target*; the overflow retry remains the backstop. v1 claimed a safety property it does not have.

`RECENT_TOKENS_DEFAULT` must be exported from `compaction.ts`, since the clamp is applied in `run.ts`.

**No new knob.** Both competitors expose one. We are deliberately not adding
`DELTA_COMPACT_KEEP_TOKENS`, because the failure being fixed was caused by a knob silently
disagreeing with a derived value.

### The resume gap - a real bug this slice must not ship without

Compaction commits its message rewrite at `compaction.ts:541`. The anchor reset
(`UPDATE runs SET usage = ?, last_input = 0`) happens afterwards at `run.ts:899`, **outside that
transaction**. A crash in the gap resumes with a compacted history and a stale pre-compaction input
anchor (`run.ts:680`), which immediately re-triggers compaction on the first turn back - the exact
per-turn-compaction failure this batch exists to remove, reachable by crash rather than by config.

**Fix:** move the `last_input = 0` reset inside the compaction transaction. `maybeCompact` gains the
run id and performs it in the same `db.transaction` as the message rewrite. The usage update stays in
`run.ts`, since usage is monotonic and a replayed update is harmless; the anchor is not.

### Scoring

Compaction fires far less often and actually shrinks when it does. Score on **compaction count,
post-compaction `input_tokens`, and `context_irreducible`** - never steady-state cache hit, which is
92-100% and will not move. Same trap `harness-0.2.12-plan.md` documented.

## S6 - a `window` column, not a catalogue

`pricing.ts` already has the table, the `DELTA_MODEL_PRICES` override pattern, and an
exact -> leaf -> longest-prefix resolver. Add one optional field and reuse all of it.

```ts
export type ModelPrice = { in: number; out: number; cacheRead: number; window?: number };
```

### Derivation

```
compactAtTokens = env DELTA_COMPACT_AT_TOKENS            (explicit operator override, clamped)
                ?? minWindow(cascade) - OUTPUT_RESERVE   (derived, when every member is known)
                ?? 120_000                               (today's default)
```

**`OUTPUT_RESERVE` is one constant, not a computed `maxOutput`.** v1 said
`window - max_output - reserve`; there is no single `max_output` to subtract. Main calls do not pass
`maxTokens` at all (`run.ts:927`), the Chat and Responses paths therefore send no output cap
(`provider.ts:858`, `:1493`), and Anthropic applies a private 4,096 default plus up to 16k-32k of
reasoning headroom (`provider.ts:364`, `:1197`, `:1208`). A single conservative reserve sized to the
worst of those is honest; a derived one would be fiction.

### The cascade must count unknowns, not skip them

Every configured provider can carry several models and fallbacks can introduce others
(`config.ts:162`, `:674`), and an unpriced model resolves to `null` (`pricing.ts:74`, `:82`). Taking
the minimum of *declared* windows would let one 250k model set a gate that overflows an unknown
fallback.

**Every cascade member gets an effective window: its declared value, or 120,000 when unknown.** The
minimum is taken across all of them. One unknown model in the cascade means today's behaviour, which
is the correct conservative default.

### Overrides must not delete the window

`parsePrices` (`pricing.ts:53`, `:60`) replaces a matched baked entry with a fresh
`{in, out, cacheRead}` object. Adding `window` only to the baked table means any existing
`DELTA_MODEL_PRICES` override silently deletes it and drops that model back to 120k. **Merge the
baked entry rather than replacing it**, and accept an explicit `window` in the override.

### Seeding

| model | window | basis |
|---|---|---|
| `claude-opus-5` | `249_000` | Aperture ran **249,127 input tokens** with zero overflow, zero "prompt too long" and zero forced-compaction retries, with **no 1M beta header sent** (`provider.ts:1261` sends `anthropic-beta` only for `FAST_MODE_BETA`). A 200k window rejects that call, so the window is above 249,127. Seeded *below* the observed floor. |
| everything else | unset | falls back to 120k, exactly today's behaviour |

v1 said "250,000 is the largest value that observation proves". That was wrong: the observation
bounds the window at more than 249,127 *for that request including its output*, which does not
establish 250,000. 249,000 is under the floor and needs no argument.

**The clamp protects the operator override, not the table.** A wrong table entry still overflows, and
nothing in this design prevents that - only conservative seeding and the existing overflow retry do.
Stated because v1 implied more protection than exists.

## S7 - `last_event_ms_ago` on `/v1/busy`

`queue.activity()` (`queue.ts:293`) already queries `runs`. Add the age of the most recent event for
any running run. "How long has it been silent" is what a reconciler is actually asking; turn age is
not, because a turn emitting tool calls every 20s is healthy at four minutes old.

Aperture treated 2 minutes of silence as a stall and carded a healthy 12-hour run with a Resume that
would have duplicated it. Every consumer guesses this constant independently today.

## S8 - suspend expectations in `hosting.md`

Document what survives a suspend, corrected from v1:

- **Survives:** SQLite WAL state, the workspace, and **the activated tool set** - it is persisted to
  `runs.tools` and reloaded on resume (`run.ts:332`, `:353`).
- **Lost, by design:** in-memory run state and the A4 breaker tally, which is explicitly re-armed on
  resume (`run.ts:356`).

---

## Test plan

Unit (`bun test`), per slice. **Every regression test must be verified to fail without its fix** -
two of 0.2.12's did not and were kept only after being made to.

- **S1** - identical input, identical hashes. **A same-length spine mutation still moves the hash**
  (the whole point). A tool activation moves `spine_hash` *and* `tools_hash` *and* `tools_n` - assert
  all three, since asserting only `tools_hash` would pass on a broken localisation. A self-write
  moves `spine_hash` and `self_bytes` with `tools_n` unchanged. Bytes are utf8 byte lengths, not
  `.length`. The salt is not exported and two daemons hash the same spine differently.
- **S2** - the `no_summary` exit (`:494`) and the `not_material` exit (`:538`) each emit exactly one
  `compaction` with `shrank:false`, the right `reason`, and non-zero `summary_cost_usd`; a true
  first-call failure emits nothing; a two-attempt summary reports both attempts' cost.
- **S3** - compaction emits `tier:"utility"`; **research fan-out emits one event per child call**, and
  the sum of emitted usage equals the aggregate charged (the double-count guard); reflection and
  `eval_judge` each emit; the main call still emits `tier:"main"`; `before_turn` is `stepCount + 1`
  including the first-turn case where `turn` is 0.
- **S4** - latching emits `tool.breaker` once, not per subsequent failure.
- **S5** - a 200k ceiling with a 16k fixed floor yields a 24k budget, not 180k; a 40k ceiling with a
  30k fixed floor yields the smaller derived value; **fixed parts alone exceeding the ceiling still
  reaches `context_irreducible` rather than looping**; a second identical turn after a compaction does
  not re-fire; **a crash between the compaction commit and the anchor reset resumes without
  re-compacting** (the resume-gap regression, child-process test).
- **S6** - a known model derives from `window`; an unknown one gets 120k; **a mixed cascade takes the
  minimum including unknowns as 120k**; an env override above the effective window clamps and warns;
  **a `DELTA_MODEL_PRICES` override preserves `window`**; a malformed window is ignored, never fatal.
- **S7** - absent when idle; present while running; **increases during silence and drops when a new
  event arrives** (v1 said "monotonic", which is the opposite of the intended behaviour).

Live, before any release (the release gate in `CLAUDE.md`):

1. `bun test` + `scripts/smoke.sh` against a running server.
2. Codex on each slice after implementation.
3. **The S1 wire check**: capture one real request with `DELTA_CAPTURE_CALLS=1` and confirm the
   captured body's system text and tool specs correspond to the emitted digests, on the Anthropic
   path specifically. This is the check that catches "we hashed something the provider does not
   send"; a hash that stays still when it should move is worse than no hash.
4. Deploy from source to a real agent, run a workload large enough to compact, confirm S5 by
   compaction count rather than by cache hit.
5. Aperture canary on a lab lane (speed-lab or google-deepmind) with `room-bench.ts`, between jobs.

## Risks

- **S1 digests engine inputs, not the request body.** Accepted, bounded by `gen_ai.provider` +
  `fallback` already being emitted, and named accordingly in the code comment.
- **S5 makes compaction fire more often on tight ceilings.** It should not - the clamp keeps the
  smaller value - and the tight-ceiling test exists for exactly this.
- **S6 seeds a wrong window.** Only one model is seeded, below a proven floor. A wrong table entry is
  not protected by the clamp; the overflow retry is the backstop.
- **S2 changes what a `compaction` count means.** Release brief must say so.
- **Most consumers see nothing.** An agent not near a context ceiling gets new telemetry fields and no
  behaviour change at all. That is the line the release brief must carry.

## What the review killed

Recorded because three of these changed the design, and because "the review found nothing" is the
outcome that should be suspicious.

1. **S1 could not localise a tool change.** The spine embeds the tool index and the `searchable`
   count, so activation moves both hashes - and the v1 test would have passed on a broken
   implementation. Fixed with `tools_n` + `self_bytes` as disambiguators.
2. **An unsalted always-exported prompt digest is a privacy hole.** Low-entropy spine content is
   dictionary-testable. Fixed with a per-daemon salt.
3. **The resume gap.** The anchor reset sits outside the compaction transaction, so a crash in that
   window resumes into immediate re-compaction. Not in v1 at all; now a required part of S5.
4. **`maxOutput` does not exist to be subtracted.** Replaced with one honest constant.
5. **The cascade minimum must include unknown models**, or one known large window sets a gate that
   overflows an unknown fallback.
6. **`parsePrices` would have deleted the new window** for anyone already using `DELTA_MODEL_PRICES`.
7. Factual corrections: history is *not* append-only outside compaction (the breaker mutates a row in
   place); ephemeral is suffix-safe rather than universally uncached; activated tools *do* survive a
   restart; the `eval_n` judge is never charged; pi's `shouldCompact` is at `:237`.

## What the CODE review killed (round 2 and 3)

The spec review above caught six design errors. Two code reviews then caught six more, and three of
them were fixes that were *present but dead in production* while every test passed — the exact
failure this batch exists to remove, arriving inside the batch itself.

**P1, round 2:**

1. **Research telemetry never fired.** `runResearch` builds its child `ToolCtx` field-by-field and
   did not copy `onUtilityCall`, so the emission was always a no-op. Research is the site where
   per-call emission matters most, because the fan-out is charged as one aggregate.
2. **The S5 crash gap stayed open on overflow recovery.** The proactive compaction passed
   `anchorRunId`; the forced one did not, and `clearAnchor` silently no-ops without it. So the path
   that runs on a turn that already failed still resumed with a stale anchor.
3. **S7 shipped the wrong public field name.** `Response.json()` does no case conversion, so
   `/v1/busy` returned `lastEventMsAgo` where the spec promised `last_event_ms_ago`.

**P2/P3, rounds 2 and 3:**

4. A `window <= OUTPUT_RESERVE` derived a ceiling of **0**, compacting every request forever. Windows
   that cannot clear `MIN_USABLE_CEILING` are now treated as unknown.
5. **`self_bytes` does not disambiguate within a run** — `self` is a per-run snapshot. The spec's
   table claimed resolution it does not have; the code comment now says what it actually resolves.
6. **`loadConfig(env)` ignored an injected `DELTA_MODEL_PRICES`**, because `pricing.ts` freezes its
   table from `process.env` at import. Both derivation functions now take the table.
7. A comment claimed a query optimization `EXPLAIN` does not support. Reverted, and the comment now
   states the real cost.
8. **`maxSafeCeiling` keeps ignoring unknown cascade members, deliberately.** It and
   `deriveContextCeiling` answer different questions: the default is ours to choose so an unknown
   makes it conservative; an override is the operator's explicit decision and we overrule it only on
   positive evidence. Counting unknowns there would clamp nearly every deployment, since one model
   carries a window today.

**And the tests were wrong twice.** First round: two of them hand-rolled the logic they were meant to
verify. Second round: two more would have gone green again if their fix were reverted — the anchor
test supplied `anchorRunId` itself, and nothing drove `runResearch` at all. A third attempt at the
overflow test passed trivially because a fresh run's anchor is `0` from birth, so the run needed a
real anchor before the assertion meant anything.

Every load-bearing test is now verified by reverting its fix and watching exactly one test break.

## Consumer-visible changes on upgrade

For the release brief:

- **`model.call` now includes utility calls.** Filter `tier === "main"` anywhere turns are counted.
- **`compaction` now includes unsuccessful attempts.** Filter `shrank === true` for the old meaning.
- **`tool.breaker` is a new event type.** Exhaustive event enums will reject it.
- **`/v1/busy` gains an optional field** while running. Additive; strict exact-object decoders reject.
- **An opus-5 config with no override moves from 120k to 209k.** A cascade containing any
  unknown-window model stays at 120k.
- **Who sees nothing:** an agent not near a context ceiling. New fields, no behaviour change.
