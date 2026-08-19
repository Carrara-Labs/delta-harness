# Harness 0.2.15 — "stop losing the task and the output"

Status: **plan v1, pre-implementation.** Written 2026-08-17 from `docs/backlog-delos-field-report.md`
(639d053), re-ranked against twelve Aperture lane databases and Ferni's live DB. Reply to the reporter
is `docs/reply-delos-field-report.md`; the reviewable summary is `docs/harness-0.2.15-triage.html`.

## What this release is

Nine changes. Two of them fix defects that are **already costing a paying consumer money and
correctness**; the rest are the cheap visibility and configuration gaps that let those two hide.

The theme is not the one the field report proposed ("a tool that cannot work should not be
registered") — that survives, narrowed, in `spec-tool-usability.md`. The two largest items are about
a run doing the wrong work and a run throwing good work away.

| # | item | spec | size |
|---|---|---|---|
| 1 | D-1 · pin the compacting run's request, not the session's first | `spec-session-ask-pin.md` | 1 query + a fallback deletion |
| 2 | D-9-min + D-10 · hand back the recoverables on exhaustion | `spec-exhaustion-handoff.md` | medium — one signature change |
| 3 | D-3 + D-2 · tool registration and usability, visible | `spec-tool-usability.md` | small |
| 4 | D-12 · no `max_output_tokens` on the Codex backend | `spec-codex-output-cap.md` | one conditional |
| 5 | D-7 · `DELTA_SCRATCH_DIR` | `spec-scratch-dir.md` | small, with a migration hazard |
| 6 | D-11 · read `DELTA_MAX_STEPS` | this doc, §1 | 2 lines |
| 7 | D-8 · disable CLI connectors by default | this doc, §2 | 1 line + a brief note |
| 8 | D-4 · accept YAML block scalars in skill frontmatter | this doc, §3 | ~6 lines |
| 9 | D-5 · re-scan the skill index behind an mtime check | this doc, §4 | ~10 lines |

**Order matters for two of them.** Items 1 and 2 both touch `run.ts`/`compaction.ts`; land 1 first
because it is the smaller diff and its regression test is the fixture item 2 also needs. Item 4
unblocks `config/ferni-codex-sol`, which is held until it lands.

## Addendum 2026-08-19: three Aperture items close the cut (post-Codex)

The Aperture two-week report (`~/ai-recruiter/docs/research/qs-harness-asks-2026-08-19.md`) was the
last open input. Verified verdicts and receipts: `docs/aperture-asks-0.2.15-triage.md`. The first
draft added five items; a Codex adversarial pass (session `01a0196c…`, 2026-08-19) demoted two of
them and corrected the surviving three. Final additions:

| # | item | from | Codex correction folded in |
|---|---|---|---|
| 10 | A-1 · identifier appendix after the compaction summary retry loop | R4 | byte-bound ids individually AND in aggregate; **reserve appendix bytes inside `SUMMARY_CAP`** (never append after the elide); build the final serialized row before the shrink gate, as today; test both "missing ids present" and "compaction still commits" |
| 11 | A-2 · `tool.rejected` telemetry on the unknown-tool branch | R9a | add it to the exporter's `PAYLOAD_EVENTS` set (`exporter.ts:41`) and export only a closed reason enum (`not_allowed` / `breaker_disabled` / `unknown`); the raw model-controlled tool name stays local unless payload capture is on |
| 12 | A-4a · `self_cap` refusal carries current file + exact headroom | R3b | `writeSelf` returns structured `{current, overBy, cap}` fields; ONLY the `remember` tool renders them into the model-facing message — the Cockpit endpoint keeps the short error. Precedent: `self_conflict` already embeds the current file, and `toolErrorClass` matches `self_cap` by prefix regex before any embedded text (`run.ts:1391`) |

**Demoted to 0.2.16 by the Codex pass** (both were honestly MEDIUM, not LOW):

- **A-3 auto-activate** — it changes execution semantics, not just residency: a model could execute
  a side-effecting allowed tool from a guessed name without ever seeing its schema
  (`search_tools` currently provides argument grounding), and `execCall`'s contract, the
  activation/journal atomicity, and resume semantics all need design. A-2 measures the class
  first; fix follows the data. Pairs with the R7 parity design.
- **A-5 cache-diagnosis pass-through** — the previous-response-id chain must be per-run
  state threaded through provider closures that are shared across runs (`index.ts:59`), must
  advance only on successful attempts across the retry/model-hop cascade, must compose the
  `anthropic-beta` header with fast mode, and must isolate the utility lane. That is exactly the
  CachePlan/ModelControls shape — it belongs in the 0.2.16 provider-controls batch. Interim: run
  the beta **out-of-band** against captured Ferni payloads; the defect investigation does not wait
  for the engine.
- **A-4b latch-norm overflow path** — deferred into the R3d rail design: the promise is hollow for
  profiles granted `remember` but not `write_file` (`profiles.ts:88`), and `scratch/<runId>` is
  wiped at termination. A durable overflow rail is a feature, not a norm string.

**Two plan corrections from the same pass:** (1) R1/R2 shipped in **v0.2.4**, not 0.2.10 — the
earlier read truncated a lexically-sorted tag list; the verdict (host wiring only) is unchanged.
(2) D-5 (§4): stat the individual `SKILL.md` files, not the parent directory mtime — the
directory-mtime version documented a miss on re-description, which is the exact case operators
expect it to catch.

Final 0.2.15: **12 items** (nine Delos + A-1, A-2, A-4a). The D-1 → D-9 ordering above still
governs; per Codex, verify D-8's `--disable` flags against the pinned codex executable before any
merge, and keep A-1 in the same slice as the D-1/D-9 compaction work.

## Explicitly not in this release

- **D-9-full**, the cheap final call for a partial answer from context. The genuine behaviour change;
  0.2.16 with its own spec.
- **D-6.** The mechanism in the report is false — `priceUsd` runs on the Responses path
  (`provider.ts:1756`) and `gpt-5.6-sol` prices at $1.25/$10/$0.125 via the `gpt-5` prefix; Ferni
  meters 488 of 488 calls. We ship nothing until Delos returns `DELTA_MODEL_PRICES`. If it contains a
  zero-price override, this closes as configuration.
- **The history digest / prompt-cache defect.** 0.2.16, unchanged, and it now starts with a targeted
  one-session `DELTA_CAPTURE_CALLS` run because the fleet's `calls` tables are empty by doctrine.
- **The Anthropic-branch `max_tokens` headroom asymmetry** (`provider.ts:1310-1330`). Nine live
  truncation warnings on the carrara lane say it is real. 0.2.16, while `provider.ts` is open.
- **Self-file write collisions** (48 on the fleet — retry rather than return an error). 0.2.16.

## The five one-diff items

### §1 — D-11 · `DELTA_MAX_STEPS`

`profiles.ts:129-138` reads `DELTA_MAX_TOKENS` and `DELTA_MAX_COST_USD` and lets each override the
profile in either direction. Add the third axis in the same shape:

```ts
const envSteps = Number(process.env.DELTA_MAX_STEPS);
// ...
budget: {
  ...selected.budget,
  ...(Number.isFinite(envSteps) && envSteps >= 1 ? { maxSteps: Math.floor(envSteps) } : {}),
  ...(Number.isFinite(envTokens) && envTokens >= 0 ? { maxTokens: envTokens } : {}),
  ...(Number.isFinite(envCost) && envCost >= 0 ? { maxCostUsd: envCost } : {}),
}
```

**`>= 1`, not `>= 0`**, deliberately different from the other two: a zero token or cost budget is a
coherent "refuse all work" setting, but `maxSteps: 0` makes the guard fire before step 1 and every run
fails with a budget error the operator cannot diagnose. Floor it and document it.

Scope note for the release brief: the fleet's binding constraint is tokens, not steps — max steps
reached across 204 Aperture runs is 62. This is a knob for deep-research-at-`xhigh` shapes, not a
fleet fix, and the brief should say so rather than implying anyone else will see a change.

### §2 — D-8 · the delegated CLI inherits every connector on its account

`config.ts:306`:

```ts
codeCli: (env.DELTA_CODE_CLI ?? "codex exec --sandbox workspace-write --skip-git-repo-check").split(" ")
```

Becomes `"codex exec --sandbox workspace-write --skip-git-repo-check --disable apps --disable plugins"`.

The demonstration: a delegated `codex exec` session asked to prove its Gmail skill was inert **listed
the operator's real inbox, 6,913 messages, write scope.** Nothing on the host granted it — the CLI had
signed in with device auth to a personal ChatGPT account carrying a Gmail plugin, and the connection
lives server-side on the auth token. An agent given no send-capable tool could send mail as its owner
in one hop.

**This is a behaviour-changing default**, so it inverts our usual release-brief rule. We normally name
the consumer who will see *nothing*; here we must name the consumer who **will** see a change: anyone
who deliberately relies on an account connector through `code` must now set `DELTA_CODE_CLI`
explicitly. Verify the flags exist on the pinned `codex` version before merging — a bad flag makes
`codeCliResolves` fail and silently disables the `code` tool entirely (`builtins.ts:795-798`), which
would be a worse outcome than the hole.

### §3 — D-4 · skill frontmatter is regex-parsed

`local-skills.ts:37`:

```ts
const description = block.match(/^description:\s*([^\r\n]+)\s*$/m)?.[1]?.trim() ?? "";
```

A YAML folded or literal block (`description: >` / `description: |`) captures the indicator character.
Line 39's truthiness check passes, so the skill **registers** — but `search()` scores query words
against `name + description` only (`local-skills.ts:81`), so it can never be surfaced. Two Delos
skills were unreachable for months, and the reason nobody noticed is that Claude Code parses real
YAML: the identical file works on a laptop and is invisible on the server.

Do not add a YAML parser (zero runtime deps). Accept the block form and floor the length:

```ts
let description = block.match(/^description:\s*([^\r\n]+)\s*$/m)?.[1]?.trim() ?? "";
if (/^[>|][-+0-9]*$/.test(description)) {
  // folded/literal block scalar: take the indented continuation lines
  const after = block.slice(block.indexOf(description) + description.length);
  description = after.split(/\r?\n/).slice(1)
    .filter((l) => /^\s+\S/.test(l)).map((l) => l.trim()).join(" ").trim();
}
if (description.length < 10) console.error(`delta: skill '${name}' has a description of ${description.length} chars — it will not be retrievable by search.`);
```

The warning is the part that matters most: a real description is never under ten characters, and this
class of defect is defined by its silence.

### §4 — D-5 · the skill index is built once, in the constructor

`LocalSkillsAdapter` scans `workspace/skills` at construction (`local-skills.ts:46`) and caches
`{name, description, location}`. A skill added, renamed or re-described afterwards is invisible to
`search()` until the daemon restarts — though it still loads **by name**, which is what makes it easy
to miss.

Re-scan inside `search()` behind a directory mtime check: `statSync(this.root).mtimeMs` against a
stored value, rescan only when it moves. Do not watch the path (a watcher is a timer by another name
and this daemon must be able to suspend). The scan reads a handful of file prefixes.

Note the limit honestly in the guide: a *mutated* `SKILL.md` inside an existing directory does not
change the parent's mtime on every filesystem, so this catches add/remove/rename reliably and
re-description only sometimes. Delos's workaround — a 2-minute external timer that fingerprints the
skill set and restarts the daemon, deferring while a run is in flight — is what we are trying to
delete, and it does catch that case. If the reviewer thinks the partial fix is worse than none, say
so; the alternative is stat'ing each `SKILL.md`, which is still cheap.

## Test plan

Every item ships with a test that **fails without its fix** — the practice earned in 0.2.12, where two
regression tests were kept for exactly that reason and one had passed without its fix.

| item | test | fixture |
|---|---|---|
| D-1 | a two-request session, compaction on request 2, assert the pin is request 2's text and request 1's is absent | synthesised; cross-checked against the Delos DB |
| D-9-min | a run forced to exhaust with two spilled results, assert `output_text` names both paths and the plan, and `runs.error` still carries the counters | synthesised |
| D-3/D-2 | boot with no `EXA_API_KEY` and no `controlUrl`; assert `web_search` is **registered and reported unusable**, the three schedule tools **omitted with a reason** | unit |
| D-12 | body-assembly asserts no `max_output_tokens` for a `chatgpt.com` base and one present for `api.openai.com` | unit |
| D-7 | spill under a non-workspace scratch root demotes; a row written under the legacy root **still** demotes | unit |
| D-11 | `DELTA_MAX_STEPS` raises and lowers `maxSteps`; `0` is refused | unit |
| D-4 | a folded-scalar description is retrievable; a 3-char description warns | unit |
| D-5 | a skill added after construction is found by `search()` | unit |

Plus the standing gate: `bun test` and `bash scripts/smoke.sh` against a running server.

## Review protocol

Each spec is reviewed independently so a REDESIGN on one does not stall the rest:

1. **Local Codex** on each spec, pre-implementation. The history here is that this is worth doing —
   `spec-arg-eviction.md` went to v3 across two rounds and the second round killed an assumption both
   earlier versions shared.
2. **Online Codex** on the same specs, for a second reading that has not seen the local review.
3. Implement in the order above; local Codex again on the diff.
4. Deploy from source to a real agent (`sh connect/deploy/deploy.sh --from-source`) and finish the
   human-in-the-loop test **before** publishing. A critical path we know is unverified blocks the
   release.
5. Publish, then redeploy **without** `--from-source` and run the post-release battery against the
   published tarball.

## Questions the reviewers should answer

1. **D-1: should the seq-1 fallback exist at all?** The spec argues for deleting it — 42 of 42
   measured pins were the wrong task, so a fallback that reproduces the defect is not a safety net.
   No pin is safer than a wrong pin. Push back if you disagree.
2. **D-9-min: is the handoff block a transcript message or only a response payload?** `finalize`
   currently inserts `outputText` as an assistant message on any non-`done` status
   (`run.ts:1755-1758`), so it enters the next turn's context by default. That is useful for resume
   and it is also new context nobody budgeted for.
3. **D-7: is the legacy-root fallback in `demoteSpilled` acceptable, or does it want a migration?** A
   silent demotion failure on historical rows reintroduces the exact defect 0.2.11 fixed.
4. **D-3: callback or return-shape change** for reporting omissions out of `builtinTools`? The spec
   picks the callback for blast radius; the return shape is more honest.
5. **Semver.** 0.2.15 is additive, like 0.2.7 through 0.2.14. `src/version.ts` documents additive =
   MINOR. Either the doc moves or the practice does, and this is the release to settle it.
