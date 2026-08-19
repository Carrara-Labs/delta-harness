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
4. **A falsified expectation is a result.** §5 lists what each fix SHOULD move. If it moves the
   wrong way, that is a finding to report with transcripts, not a failure to explain away.
   Revert-and-report beats massage-and-pass.
5. **Bench before fleet, fleet before clients.** speed-lab and google-deepmind take the release
   first. carrara rolls on a clean bench verdict. Client lanes roll last, individually, each
   with a boot-line check.

## 2. Phase 0 — preconditions (before touching any lane)

- [ ] The 0.2.14 config A/B is complete OR formally parked with its arms labeled. No mid-battery
      upgrades — your own report documented the pre/post-labeling pain.
- [ ] The battery prompts are pinned in a file, with tier labels (simple ×10 / medium ×8 /
      hard ×5 per lane, per the validation brief §1).
- [ ] Snapshot both bench lanes: workspace tree listing, `DELTA.md` + overflow files,
      `GET /v1/status` output, and the lane DB. This is T0 for the release comparison.
- [ ] Record each lane's env table (the §3b lane×env sweep from the validation brief) — 0.2.15's
      status report will let you VERIFY it for the first time, so the recorded intent matters.

## 3. Phase 1 — the pre-upgrade grep (three integration checks, Aperture-side)

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

## 4. Phase 2 — upgrade the bench lanes

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

## 5. Phase 3 — the acceptance rerun, with per-fix acceptance checks

Run the pinned battery exactly as in the validation brief (interleaved, same day-window, both
lanes). Then evaluate these checks. Each row names the fix, the signal, WHERE to read it, and
the pass bar.

| fix | signal | where | pass bar |
|---|---|---|---|
| **D-1 ask pin** | on every hard-tier run that compacted: the summary's `<original_request>` block contains the RUN's own request text | lane DB: the committed summary rows (`messages` where content carries `<original_request>`); compare against the run's `request` | 100% match; zero pins of an earlier request. The lead-in now reads "the request you are working on" |
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

## 6. Phase 4 — the VM deep-read (unchanged from your standing brief, plus three additions)

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

## 7. Phase 5 — verdict and rollout

- **Clean** (acceptance checks pass, watchlist quiet, artifact quality flat-or-better): roll
  carrara, then client lanes one at a time, reading each first boot line and `/v1/status` diff.
  Freeze the combined (config + 0.2.15) state as the new fleet baseline — this is the baseline
  the OpenAI bench agent and 0.2.16 are both judged against.
- **Mixed** (a check fails or a watchlist item moves): hold the client rollout, send the
  transcripts and the per-tier table. Bench lanes stay on 0.2.15 for diagnosis.
- **Regression on the watchlist:** repin 0.2.14 on the affected lane (reversible, §4.4), report.
  A falsified fix is a first-class result.

## 8. Reporting

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
