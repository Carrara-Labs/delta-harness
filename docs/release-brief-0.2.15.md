# Release brief — Harness 0.2.15 "stop losing the task and the output"

Status: **PUBLISHING 2026-08-19.** D-12 gate **PASSED** by Delos on the live Codex lane: 3/3
children succeeded, zero `Unsupported parameter` errors, and the negative control (forcing
`acceptsMaxOutputTokens()` true on the same backend, same minute) reproduced 0/3 with the exact
error string — plus a fresh raw-wire A/B confirming the parameter is still rejected today, so the
denylist is load-bearing now, not a historical artifact. Their boot checks all confirmed (scratch
relocation with zero workspace writes, legacy note, status report, 978 tests, tsc clean).

Formerly: STAGED, pending publish. Implemented, Codex-reviewed twice (spec pass +
full-diff pass, nine findings fixed), 978 tests green, deployed `--from-source` to Ferni and
verified live (smoke, threaded turns, a real budget exhaustion, spill under the new scratch root,
and an operator Telegram battery — all clean). Remaining gate at time of writing: Delos's live
3/3-children check for the Codex-backend fix.

## What it is

Twelve changes, all born from field measurement — the Delos unattended-deployment report (nine
items) and the Aperture two-week production report (three items, filtered from nine asks by an
adversarial review). The theme: **a run doing the wrong work, and a run throwing good work away.**

## What it is worth, and to whom

Every number below was recomputed from the lane databases, not quoted from reports.

| defect | measured cost | who was paying it |
| --- | --- | --- |
| compaction pinned the session's FIRST request as the trusted task | 42/42 exposed compactions pinned the wrong task, 0 harmless; 23/27 stale pins were longer than the live ask | Aperture QS (27), Ferni (13), Delos |
| exhausted runs returned counters, not work | 11 runs, 771 tool calls, $140.98, 158 min of paid work destroyed | both Aperture QS lanes |
| a missing credential was silent until it billed | one question: 74 calls, 724,804 tokens, wrong answer (vs 37 calls / 350k / right with the key) | Delos; anyone mis-provisioned |
| children 400 on the Codex subscription backend | 24/24 child starts failed, billed | the ferni-codex-sol path; the OpenAI demo route |
| `remember` refusals gave no headroom | 86/240 saves refused blind → breaker; lanes stopped learning | the whole fleet |
| summaries dropped load-bearing identifiers | 18–34% missing; worst cases 30/30 | Aperture QS accuracy |
| engine scratch polluted precious workspaces | untrusted fetches committed to git + phone; the workaround gitignore ate 5 real folders | Delos's vault; any doc-workspace deploy |
| the delegated CLI inherited account connectors | demonstrated: operator's real inbox, 6,913 messages, write scope | every deployment with `code` |
| skills silently unsearchable / index frozen at boot | 2 skills dead for months; a 2-min restart-timer workaround | Delos |

**Who sees change on upgrade day (the honest list):** every deployment gets the `research/` →
`.delta/research/` rename; anyone relying on a CLI account connector through `code` must set
`DELTA_CODE_CLI` explicitly; anything parsing `budget exhausted` out of `output_text` must read
`runs.error`. Everything else is opt-in (`DELTA_SCRATCH_DIR`, `DELTA_MAX_STEPS`) or additive
(status report, telemetry event, richer refusals, appendix).

**Who sees NO change:** single-request sessions render byte-identically apart from one lead-in
sentence; default (unset `DELTA_SCRATCH_DIR`) spill and scratchpad paths are byte-identical;
sub-10-parallel-call turns, budgets, wire formats, and the seam are untouched.

## Verification record

- Test-first throughout: every item's test failed on the old code before its fix; 978 tests, 0
  failures, typecheck + lint clean.
- Codex spec review reshaped D-7 (the relocation as first specced would have made every artifact
  unreadable to the model) before a line was written; the full-diff review found nine more issues
  (worst: relocated images claimed "attached" but silently withheld) — all fixed with regression
  tests.
- Live: local daemon smoke + a genuine over-budget run returning its plan and spill paths;
  `--from-source` on Ferni — the boot immediately exposed a real pre-existing omission (`codex`
  was never installed in the image, so `code` had been silently missing since day one), the
  legacy-research probe found real pre-0.2.15 artifacts, a forced big-fetch spilled under
  `/data/scratch` with zero new writes to the workspace, and a five-run operator Telegram battery
  passed with no errors.

## The acceptance measurement

The Aperture A/B battery (`docs/brief-aperture-lab-validation.md`) re-runs unchanged on 0.2.15 —
same pinned prompts, both lanes — so the fleet-level before/after is attributable. Expected
signatures: identifier survival up on the hard tier (A-1), zero wrong-task pins post-compaction
(D-1), self_cap refusals resolving in one retry instead of breaker latches (A-4a), and rejection
counts visible for the first time (A-2).

## Post-publish checklist

1. `npm publish` (harness 0.2.15; connect stays 0.5.0 — untouched this release).
2. Tag `v0.2.15`, push tag.
3. Redeploy Ferni WITHOUT `--from-source` (deploy pin already staged at 0.2.15) and re-run the
   smoke + status checks against the published tarball.
4. Site deploy (changelog + guide).
5. Hand Aperture the upgrade brief; they lead lane testing on the published version.
6. `config/ferni-codex-sol` is unblocked — Delos confirmed 3/3.

## Carried to 0.2.16 from the gate run (Delos)

- **A child's provider 400 has no observable surface outside the tool return value.** On the
  negative control the error appeared 3x in tool results and 0x in stdout — an operator watching
  logs sees a clean run while every child dies and bills. That is the mechanism behind "24 starts,
  24 failures" surviving two weeks. By the D-2/D-3 principle it wants a log line or its own
  telemetry event. 0.2.16.
- **Delos fixture DB is ready** (1.3 MB gz, leak-scanned, both target runs present with spill
  paths intact) — validate the D-1/D-9 tests against it post-release.
- `DELTA_MODEL_PRICES` from Delos still blocked on their side; D-6 stays open.
