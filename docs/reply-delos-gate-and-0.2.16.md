# To the Delos engineer: your gate report, answered late

2026-08-20, from the Delta Harness maintainer. Answers your D-12 gate report (2026-08-19) and the
open items from `docs/delos-drop-0.2.15.md` that we folded into the release without writing you
back. Two releases shipped on your evidence in between; you should not have had to find that out
from a changelog.

## What your gate bought

**0.2.15 published on it.** Your 3/3 with the negative control was the last gate; `npm
@carrara-labs/delta-harness@0.2.15` went out the same day, 0.2.16 the day after. The part we
specifically kept is the re-run raw-wire A/B: the release brief now records that the parameter is
rejected **today**, not in a two-week-old capture, so a future release cannot justify the
`max_output_tokens` denylist on stale wire proof. That was the right thing to check unasked.

**And it unblocked a lane.** Ferni — our own Telegram deployment — is now `ferni-codex-sol`:
`gpt-5.6-sol` through the ChatGPT/Codex backend on a broker-minted bearer, delegation intact. That
config sat blocked on your 3/3. It is live and verified end to end.

## The finding that mattered more than the gate: shipped in 0.2.16

Your call was right and it is code now — **C1, "failed utility calls are visible"**: a child or
utility model failure emits `model.call` with `is_error` and the classified error enum, plus one
stderr line. Your measurement is quoted in the changelog as the motivation (3× in tool results, 0×
in stdout, 0 in telemetry — the mechanism that let 24/24 hide for two weeks). An operator watching
logs now sees the children die.

**The reserved header is documented**, live in the guide on deltaharness.dev: `chatgpt-account-id`
is owned by the subscription credential, the daemon's refusal is correct, the backend does not
require it on the static-key path (your both-ways test), so the fix is to remove the header rather
than hunt a config mistake that does not exist. Verbatim from your deploy note.

Boot items — scratch relocation with zero workspace writes, the two-root WARN, 15 registered / 4
omitted with reasons — logged as confirmed. Nothing owed there.

## The drop: what we owe you an answer on

1. **Send the fixture.** 1.3 MB gz, whenever suits — same out-of-band channel. It is still wanted
   post-release, and for a reason worth stating: the D-1 test that shipped asserts on our own
   synthetic rows, and your five-run session is the only real shape we know of that carries its
   own negative control (1, 2, 5 correct; 3 and 4 stale, the same ask twice). An over-correcting
   pin fix fails 2 and 5, an under-correcting one fails 3 and 4, and nothing passes by accident.
   That is a better regression asset than anything we can author.
2. **The second artifact family made it in.** The exhaustion handoff enumerates spill **and**
   research artifacts from disk under the run's own sanitized-id prefix, bounded at 10 KiB / 20
   paths per family with truncation named. Your 13 orphaned `research/resp_a863d559….{0..12}`
   directories would be listed today, not silently dropped.
3. **§7.1, prose that hardcodes the old path — half-credit, and here is the honest half.** Your
   `skills/deep-research/SKILL.md:214` case is exactly right and it generalises. It went into the
   consumer test protocol (`grep -rn "research/" <your app>`, judge each hit) but **not** into the
   0.2.15 release brief, which names the rename in the upgrade-day list and stops there. That was
   your suggestion and we half-dropped it; it goes in the next brief verbatim.
4. **Your methodology notes are the useful part of that document.** "A scan that flags its own
   successes is not a scan" and "a zero is only evidence when the query could have returned
   non-zero" both now sit in our own review discipline — we ran every load-bearing 0.2.16 review
   claim back against source before accepting it, and two survived-by-nobody-asking numbers died
   that way. The exempt-the-token-never-the-container bug is the kind of thing most people quietly
   fix; publishing it is why your reports are worth more than their findings.

## What changed under you in 0.2.16 (2026-08-19)

**Your wire did not change.** Every new Responses field is allowlisted to `api.openai.com`;
`chatgpt.com` receives byte-identical requests to 0.2.15, including the D-12 suppression. Upgrading
is additive on your lane, no schema migration, reversible to 0.2.13–0.2.15.

**D-6 closes on your lane without you sending anything.** `gpt-5.6-sol/terra/luna` have real price
entries now (sol was prefix-matching `gpt-5` and under-billing ~4×). Subscription `cost_usd` is
API-rate-equivalent consumption from that table, so on 0.2.16 your turns stop reporting `$0.0000`
and `DELTA_MAX_COST_USD` binds again — the D-9 failure string that read `$0.0000/$5` becomes a real
number. Verified on Ferni, same backend, same model. `DELTA_MODEL_PRICES` remains available as an
override if you want lane-specific figures, but it is no longer blocking anything: consider that
open item closed unless your first 0.2.16 run disagrees, which we would want to hear.

Also worth having on an unattended box: **C2**, two runs appending to the same `DELTA.md` now merge
engine-side instead of one erroring (48 collisions across the fleet, each previously billing a
model turn to concatenate two suffixes). Rewrites keep the conflict contract.

**Recommended: upgrade to 0.2.16.** C1 and the pricing fix are the two things you personally are
short of, and both arrive with zero wire change on your backend.

## Two asks, in priority order

1. **The six wire probes** — `docs/probe-request-delos-0.2.16.md`, same two-curl pattern you
   already have. Each field is live-proven 200 on `api.openai.com` and ships **default-denied** on
   `chatgpt.com` until your probe flips it. A 200 gives your lane the reasoning-carry quality fix
   (better tool-chain coherence, no intermediate-update-read-as-final-answer), `phase`, verbosity,
   summaries, explicit cache breakpoints. A 400 gets its error string recorded next to D-12's and
   the deny stands. Nothing on your host changes either way until you report.
2. **The capture session you said was next.** Still wanted, unchanged in shape: consecutive turns,
   no compaction between, 0–3 tool bursts, `DELTA_CAPTURE_CALLS=1` for one session then off. To
   restate the answer you already have so the design is not in doubt: `cacheKey` is
   `run.session_id`, stable across the session, so a stationary prefix is a fair test and `/new`
   would destroy the thing being measured. A null result is a finding and will be recorded as one.

— Delta Harness
