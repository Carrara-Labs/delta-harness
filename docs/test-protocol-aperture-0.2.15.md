# Test protocol — validating harness 0.2.15 on the Aperture fleet

2026-08-19, from the Delta Harness maintainer. This is the operational spec for setting up and
running the 0.2.15 validation: the principles, the setup, the per-fix acceptance checks with the
exact signal each one should move, and the verdict logic. It composes with two standing docs
rather than replacing them:

- `docs/brief-aperture-lab-validation.md` — the A/B design, the three-tier battery, and the
  memory-hygiene sweep (your standing assignment; this protocol reuses its battery verbatim)
- `docs/handover-aperture-0.2.15.md` — what changed and what did not, per consumer

Release receipts if you need to argue with a number: `docs/release-brief-0.2.15.md`,
`CHANGELOG.md` §0.2.15.

---

## 1. Principles — the five rules everything below follows

1. **One variable per comparison.** The config track (TTL / self cap / arg cap) and the engine
   version are separate experiments. Never change both between two measured arms. If your
   0.2.14 config A/B is still running, finish it first — its treatment config, frozen, is the
   config both 0.2.15 arms run.
2. **The battery is pinned and re-runnable.** Same prompts, same tier structure, same counts,
   interleaved, same day-window on both lanes. The 0.2.15 acceptance test is literally the
   0.2.14 battery re-run on the new engine — that is what makes the delta attributable to the
   release and nothing else.
3. **Telemetry AND the VM, always.** Every claim gets a counter and a file. Your last report's
   most valuable findings came from reading workspaces, not dashboards; this protocol assigns
   both explicitly per check.
4. **A falsified expectation is a result.** §2 states what each fix should move and §7 gives
   the per-fix pass bar. If it moves the
   wrong way, that is a finding to report with transcripts, not a failure to explain away.
   Revert-and-report beats massage-and-pass.
5. **Bench before fleet, fleet before clients.** speed-lab and google-deepmind take the release
   first. carrara rolls on a clean bench verdict. Client lanes roll last, individually, each
   with a boot-line check.

## 2. What to expect: the 0.2.14 → 0.2.15 measurement table

This is the contract the rerun tests. Left column = the number we measured on 0.2.14 (your lanes
and the fleet, recomputed from the databases); middle = what 0.2.15 should show; right = how to
read it. Anything that lands outside its expected cell — in either direction — goes in the report.

| metric | 0.2.14 measured | 0.2.15 expected | how to measure |
|---|---|---|---|
| wrong-task pins on compacted runs | **27/27** on `aperture-qs-69598a208017` (42/42 fleet-wide), 0 harmless | **0/N** — structurally impossible | hard tier: diff each committed summary's `<original_request>` block against the run's own `request` |
| identifier survival through compaction | **18–34% lost**, worst cases 30/30 | materially better for HARVESTED classes (paths, years, multi-digit numbers — see W2 for what is NOT covered) | your artifact-quality check + grep committed summaries for the "Load-bearing values" appendix |
| `self_cap` breaker latches on `remember` | 86/240 refusals blind → repeated latches; lanes stopped learning | refusal RATE unchanged (the engine cap didn't move); each refusal resolves in **≤1 informed retry**; latches **~0** | telemetry: `error.class='self_cap'` sequences vs breaker events |
| budget-exhausted run output | one sentence of counters ($141 / 158 min of paid work returned as nothing, 11 runs) | `output_text` = plan + this run's artifact paths + advice; counters ONLY in `runs.error` | any budget-hit run in the battery; assert every listed path exists on disk |
| tool-call rejection visibility | invisible (9.4% of one lane's calls, uncounted) | a **measured per-lane baseline** by reason — no target; the number itself is the deliverable | telemetry: count `tool.rejected` by `reason` |
| fleet config verifiability | recorded intent only; 16-configured/13-running went unnoticed elsewhere | `/v1/status.tools` matches the env table; omissions loud at boot | Phase 2 checks |
| **simple-tier p50/p90, cost, cache hit** | your A/B baseline | **NO change** — the regression guard; D-1 acts only after a compaction, which simple never triggers | per-tier timing table |
| compaction frequency + summary cost | your A/B baseline | **NO change** — D-1 changes WHAT is pinned, not WHEN compaction fires; the A-1 appendix is reserved INSIDE the existing summary cap | compaction events per run; summary tokens |
| hard-tier artifact quality (right people, intact IDs) | your A/B baseline | **flat or better** — the accuracy verdict for D-1 + A-1 together | the deep-read comparison, both lanes |

**The hoped-for improvements, in one paragraph:** post-compaction runs stay on the live task
(accuracy on your longest, most expensive searches), identifier-bearing facts survive
compression, budget-hit runs return recoverable work instead of nothing, self-learning stops
silently latching off, and the fleet's configuration becomes verifiable instead of assumed.
The hoped-for NON-changes matter equally: simple-tier speed, cost, cache behavior, and
compaction frequency should be indistinguishable from 0.2.14.

## 3. Warnings: failure modes to design test scenarios for

These are the places a problem would hide. Each one wants a deliberate scenario, not just the
standard battery.

**W1 — the continuation-session shape. This is the one to take seriously.** D-1's measurement
(27/27 wrong-task on your paid lane) says the old first-run pin was poison for QS traffic as it
exists today. But note the inverse risk honestly: the OLD behavior *accidentally preserved* a
rich first request for any session shaped as `[detailed brief in run 1 → terse follow-ups]`.
Under 0.2.15, if run N is "continue with the next 10" and compaction fires mid-run, the pinned
trusted text IS that terse continuation — the rich brief survives only inside the untrusted
historical summary (plus the identifier appendix). **Design this scenario explicitly:** run 1 =
a detailed search brief with named constraints (role, seniority, geography, exclusions, target
count); runs 2..k = terse continuations ("next batch", "refine by X"); make run k long enough to
compact; then check the filed artifact against the run-1 constraints. If this shape degrades,
three mitigations in order of cheapness — (a) your driver re-sends the standing brief with each
request (immediate, no release needed), (b) the agent keeps standing constraints in its `todo`
plan, which is re-injected verbatim every turn and survives compaction untouched, (c) durable
constraints in `DELTA.md`. And report it with transcripts: a measured need here is exactly what
promotes the deliberately-scoped-out "named session standing goal" feature into 0.2.16 — the
spec rejected inferring a standing goal from row order, not the feature itself.

**W2 — what the identifier appendix does NOT guarantee.** It carries the AUDITED classes:
`.delta` paths, years, and multi-digit numbers. Person names, emails, and company names are not
harvested — their survival still rides on the summarizer and shows up only in your
artifact-quality check. Do not read "identifier appendix" as "nothing can be lost"; the hard
tier's same-people-found comparison remains the real accuracy test.

**W3 — does a failed run's `output_text` reach an end user's screen?** The new handoff contains
VM-local file paths — meaningful to the agent and to you, meaningless to a QS end user. If any
Aperture surface renders a failed run's `output_text` verbatim, decide the app-layer treatment
(summarize, strip paths, or keep for internal users). The old counters were equally wrong to
show; the new text is at least actionable — but check where it lands.

**W4 — sessions that straddle the upgrade.** A session whose early compactions pinned run 1
(old engine) and whose later compactions pin the live run (new engine) is internally consistent
but reads oddly in transcript spot-checks. Label pre/post-upgrade runs when you sample straddling
sessions, or exclude them from the comparison.

**W5 — telemetry ingest meets a new event type.** `tool.rejected` is payload-bearing (`reason`
exports bare; the raw requested name only under payload capture). Confirm your ingest tolerates
an unknown event type BEFORE the rollout — a pipeline dropping it quietly would erase one of
this release's deliverables.

**W6 — keep A-4a and the config-track cap raise attributable.** A-4a changes retry BEHAVIOR
(one informed retry instead of blind loops); the config track's `DELTA_SELF_MAX_TOKENS` raise
changes refusal RATE. If your treatment arm carries the cap raise, report the two effects
separately, or the release gets credit (or blame) for a config change.

## 4. Phase 0 — preconditions (before touching any lane)

- [ ] The 0.2.14 config A/B is complete OR formally parked with its arms labeled. No mid-battery
      upgrades — your own report documented the pre/post-labeling pain.
- [ ] The battery prompts are pinned in a file, with tier labels (simple ×10 / medium ×8 /
      hard ×5 per lane, per the validation brief §1).
- [ ] Snapshot both bench lanes: workspace tree listing, `DELTA.md` + overflow files,
      `GET /v1/status` output, and the lane DB. This is T0 for the release comparison.
- [ ] Record each lane's env table (the §3b lane×env sweep from the validation brief) — 0.2.15's
      status report will let you VERIFY it for the first time, so the recorded intent matters.

## 5. Phase 1 — the pre-upgrade grep (three integration checks, Aperture-side)

Run these against your app/control-plane code BEFORE upgrading anything. Each is a deliberate
0.2.15 behavior change; the release is fine with all three, but your integration must be checked
once:

1. **`${workspace}/research/` readers.** Research artifacts now write under
   `.delta/research/`. The engine is self-consistent (tools return the new paths; old trees
   still resolve), but any Aperture-side script, cron, or dashboard that reads the bare
   `research/` directory by convention must be updated or confirmed absent.
   `grep -rn "research/" <your app>` and judge each hit.
2. **`output_text` failure parsing.** A failed run's `output_text` is now a user-facing handoff;
   the counters (`budget exhausted: N/M …`) live ONLY in `runs.error` and the `error` event.
   Grep your driver/UI for anything string-matching `budget exhausted` or parsing counters out
   of `output_text`, and move it to `runs.error`.
3. **`code`-tool connector reliance.** The delegated CLI default now appends
   `--disable apps --disable plugins` (needs codex-cli ≥ 0.146.0). If any lane deliberately uses
   an account connector through `code`, set `DELTA_CODE_CLI` explicitly — it is used verbatim.
   If no lane uses `code` at all, this is a no-op.

## 6. Phase 2 — upgrade the bench lanes

1. Pin `@carrara-labs/delta-harness@0.2.15` (published, provenance-signed) in your lane deploy
   and roll speed-lab + google-deepmind. **Both lanes, same engine** — the config difference
   between them is the config A/B's business, not this one's.
2. **Capture the first boot's stderr on each lane.** Expected lines, all normal:
   - `delta: N tools registered. Omitted: …` — only when something is omitted/unusable. Diff the
     named omissions against the lane's intent; every entry is either expected or a
     misconfiguration you just found for free.
   - `delta: note: legacy research/ artifacts exist…` — fires once if old trees exist; the trees
     are safe to delete at leisure.
   - No scratch WARN unless you set `DELTA_SCRATCH_DIR` (you do not need to for this test —
     your workspaces are scratch checkouts; the knob exists for document-vault deployments).
3. **Verify per lane, before any battery run:**
   - `GET /healthz` → `"version":"0.2.15"`.
   - `GET /v1/status` (seam token) → new `tools` block present. Record
     `registered`/`unusable`/`omitted` as the post-upgrade baseline and diff against the Phase 0
     env table. `unusable` entries heal live when a credential lands — no restart; `omitted`
     entries need a config fix + restart.
   - One trivial turn (`store:false`) returns normally.
4. **Rollback path, so you know it before you need it:** 0.2.15 adds no schema migration —
   repin 0.2.14 and redeploy; reversible from 0.2.13/0.2.14 (NOT from ≤0.2.11 states, which
   carry the 0.2.13 one-way step — irrelevant if your lanes are already ≥0.2.13, which they are).

## 7. Phase 3 — the acceptance rerun, with per-fix acceptance checks

Run the pinned battery exactly as in the validation brief (interleaved, same day-window, both
lanes). Then evaluate these checks. Each row names the fix, the signal, WHERE to read it, and
the pass bar.

| fix | signal | where | pass bar |
|---|---|---|---|
| **D-1 ask pin** | on every hard-tier run that compacted: the summary's `<original_request>` block contains the RUN's own request text | lane DB: the committed summary rows (`messages` where content carries `<original_request>`); compare against the run's `request` | 100% match; zero pins of an earlier request. Pair with the W1 continuation scenario (§3) — the standard battery alone does not exercise that shape |
| **D-9 handoff** | any run that hits a budget ceiling returns plan + artifact paths, never counters, in `output_text`; counters intact in `runs.error` | `runs` table: `result.output_text` vs `error` on failed runs | every budget failure follows the split; every listed path exists on disk |
| **A-1 appendix** | identifier survival through compaction | the artifact-quality check you already run on the hard tier (same people found, IDs intact), plus: committed summaries containing "Load-bearing values" carry ids verbatim | identifier loss rate materially down from your measured 18–34%; report the number either way |
| **A-4a remember** | `self_cap` refusals resolve in ONE informed retry; breaker latches on `remember` → ~0 | telemetry: `tool.result` events with `error.class='self_cap'` followed by a success, vs breaker events | latch count ~0 across the battery; any remaining latch is a real finding — attach the transcript |
| **A-2 rejected** | rejection visibility | telemetry: count `tool.rejected` by `reason` per lane | the event exists and produces a per-lane baseline rate. No target — this is instrumentation; the number itself is a deliverable (it feeds the 0.2.16 auto-activate decision) |
| **D-3 status** | the tools report matches reality | `GET /v1/status` per lane vs the Phase 0 env table; try one live heal (drop a fake key into the vault on a bench lane, watch `unusable` clear without restart) | zero unexplained entries; the live-heal works |
| **D-5/D-4 skills** | if any lane uses local skills: add a skill mid-session, confirm search finds it without restart | agent-side `search_tools`/skill search | found without restart. Skip if no lane runs local skills |
| **D-12** | (already gate-passed live by the Codex-lane deployment) nothing to re-test on your lanes — they run Anthropic wires | — | n/a; relevant only when you bench the OpenAI QS agent |

**Regression watchlist — the two risks worth active suspicion, per the maintainer's own callout:**

- **Simple-tier wall clock and answer quality must NOT move.** D-1 only acts after a compaction,
  which the simple tier essentially never triggers; if simple-tier numbers move, something else
  is wrong — report it before rolling further.
- **Hard-tier artifact quality is the D-1/A-1 verdict.** If post-compaction runs on 0.2.15 ever
  drift off-task where 0.2.14 did not, that inverts the release's headline claim. We measured
  42/42 wrong-task pins on the old code, including 27/27 on your paid lane, so the prior is
  strongly in the fix's favor — but the battery, not the prior, is the verdict.

## 8. Phase 4 — the VM deep-read (unchanged from your standing brief, plus three additions)

Everything in the validation brief §1 "What to inspect" still applies (DELTA.md diff vs T0,
overflow machinery, transcript spot-reads, artifact quality, disk hygiene). Add:

1. **Post-compaction transcripts on the hard tier:** find the summary block; confirm the pinned
   request is the live one and, where the summarizer dropped identifiers, the
   "Load-bearing values" appendix carries them.
2. **Any failed run's transcript:** the handoff should also appear as the run's final assistant
   message (it enters the transcript for resume), and its paths should be readable via
   `read_file` from the next turn.
3. **`.delta/research/` contents:** new research runs (if any lane fans out) land there; the old
   `research/` tree stops growing.

## 9. Phase 5 — verdict and rollout

- **Clean** (acceptance checks pass, watchlist quiet, artifact quality flat-or-better): roll
  carrara, then client lanes one at a time, reading each first boot line and `/v1/status` diff.
  Freeze the combined (config + 0.2.15) state as the new fleet baseline — this is the baseline
  the OpenAI bench agent and 0.2.16 are both judged against.
- **Mixed** (a check fails or a watchlist item moves): hold the client rollout, send the
  transcripts and the per-tier table. Bench lanes stay on 0.2.15 for diagnosis.
- **Regression on the watchlist:** repin 0.2.14 on the affected lane (reversible, §6.4), report.
  A falsified fix is a first-class result.

## 10. Reporting

Same shape as your two prior reports — receipts, per-tier tables, workspace findings, verdict —
plus the new deliverables this release makes possible:

1. per-lane boot line + `/v1/status` tools diff (the fleet's first verified config table),
2. the baseline `tool.rejected` rate by reason,
3. the identifier-survival number on the hard tier (before: 18–34% loss),
4. anything the deep-read surfaces that neither of us predicted — still the highest-yield
   category two releases running.

Then the OpenAI phase begins per `docs/handover-aperture-0.2.15.md` §5: bench QS agent on
`api.openai.com` + `gpt-5.6-sol`, same battery, capture the wire differences — those findings
steer the 0.2.16 cut we are building while you run this.

— Delta Harness
