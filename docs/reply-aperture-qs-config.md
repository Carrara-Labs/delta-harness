# To the Aperture engineer: the config track — a better Quick Search on the engine you already run

2026-08-19, from the Delta Harness maintainer. Companion to
`docs/aperture-asks-0.2.15-triage.md` (the R1–R9 verdicts, every number recomputed from your
receipts) and `docs/harness-0.2.15-plan.md` §Addendum (the closed 0.2.15 cut). This message is
about neither release. It is about **what you can change today, on 0.2.14, on the lab
workspaces**, so that by the time 0.2.15 lands you are laying it on top of a stable, measured,
better-configured baseline instead of a moving one.

First: your report is the best field document this project has received. Every headline number
survived recomputation from the raw JSONL — the refusal rates, the identifier losses, the latency
distribution, the 162 stationary-prefix rows. The withdrawn cooldown ask and the softened
save-refusal complaint both check out too, which is what makes the rest credible. Thank you.

## 0. Why config-first, and the sequencing rule that governs everything below

The plan we're aligned on internally is a four-stage ladder:

1. **Config baseline (this message):** tune the existing 0.2.14 agents on the lab workspaces,
   measure the impact, freeze the winning config.
2. **0.2.15 on top of that baseline:** you re-run the same measurements after the upgrade, so the
   release's effect is separable from the config's effect.
3. **A Quick Search agent on the 0.2.16 OpenAI-native build**, on a bench workspace, stabilized.
4. **Only then, the OpenAI workspace** for the frontier-lab client.

The rule that makes stage 2 meaningful: **never land a config change and an engine version in the
same measurement window.** Your own report is proof of how much this matters — half its findings
had to be labeled pre/post-upgrade because 0.2.14 landed mid-period, and two complaints dissolved
under that split. If the three variables below land together with 0.2.15, neither is attributable
and a regression in either is undiagnosable. Config now, release later, same four numbers both
times.

**The four numbers**, for every step in this message (you already collect all of them):

| # | metric | source |
|---|---|---|
| 1 | compactions per run | `compaction` events |
| 2 | first-post-compaction `input_tokens` and cache hit | join `model.call` on `compaction` by ts (my §2 query, in `aperture-qs-tuning-findings.md`) |
| 3 | cost per run | `per-run-summary` |
| 4 | remember refusal rate | `tool.result` where `error.class='self_cap'` |

Plus one perceived-speed number once the §3 wiring lands: **time to first rendered signal** in the
room, which your `first-response-latency` export already measures as time-to-first-words.

## 1. The three environment variables (engine config, lab-testable today)

All three exist in 0.2.14. Each is one env var and a machine restart; each reverts by removing it.
None is in the 0.2.15 diff, so nothing here can be confused with the release later. Full data
behind each: `docs/aperture-qs-tuning-findings.md` (measured on `aperture-qs-69598a208017`'s own
database — 140 runs, $669, pre-0.2.14 snapshot, so every magnitude is an upper bound on your
current build).

Roll them in **two steps, not one**, so the behavioral change is separable from the infra change:

### Step 1 (infra-only, cannot change agent behavior): `DELTA_CACHE_TTL=1h` + self-cap raise

**`DELTA_CACHE_TTL=1h`** — the only accepted value is the literal string `1h`. This is pure
billing/latency plumbing: the model never sees anything different. Your own R6 dataset motivates
it twice over: the cold band on the carrara lane is *between* runs, not within them (zero
intra-run gaps over 5 minutes — falsified my own initial hypothesis), and the diagnosis matrix
for "requests match but cache read is zero" points at TTL lapse as the first suspect. Cache
writes bill at 1.25×; the lane is read-dominated (2,105 of 2,718 calls at 91% hit), so the
premium is repaid. Ferni has run this since 2026-08-03 with no regression. Measure with your own
`cache_shortfall_tokens` before/after — you already proposed exactly this pairing in your
ownership list.

**`DELTA_SELF_MAX_TOKENS`: unify the fleet at 4000** (the engine multiplies by 4, so that is a
16,000-byte cap). The argument, from both our datasets:

- Your fleet-wide numbers: 86/240 learning writes refused; speed-lab 66%, alpha-school 57%.
- My lane-level numbers: 125 self-cap refusals = **42% of all tool errors** on the carrara QS
  lane. Every refusal is a paid turn that produced nothing.
- Your workspace exhibits: alpha-school has **11 KB of lessons in a waiting room**
  (`PENDING-delta-edit.md`) that don't fit its 9.6 KB cap; carrara maintains a prioritized
  deletion ledger at frontier prices on the user's clock. A 16 KB cap absorbs both pending merges
  with headroom.
- Fleet drift today: 4000 / 2400 / 1600 across lanes, none chosen for a workload. Uniformity is
  itself worth something: your agents share learned material via your seed harvesting, and a
  lesson that fits one lane's file should fit another's.

Check live fullness on `GET /v1/status` (the `self` field) per lane before restarting, so you
know each lane's before-state. **This raise is pressure relief, not the fix** — the fix
(distill-don't-refuse, the scoped memory rail) is 0.2.16+ engine work. But it immediately stops
the lesson bleed, and it converts your "GC tax" estimate into a measurable delta on metric 4.

Note on your R3a "inconsistent cap" finding, while you are in these files: the engine-side check
is deterministic (`Buffer.byteLength` against the cap, every write path, unchanged since 0.1.0),
and your telemetry shows each lane's cap constant within the captured window. Six saves landing
at 10,251–9,837 bytes against a 9,600 cap therefore require the cap to have been *higher at those
moments*. **Please pull alpha-school's daemon env history** (Fly machine config revisions will
show it) — if the cap was raised and re-lowered at any point, the mystery closes as config drift
and nothing ships for it; if it genuinely never changed, I need to know that, urgently, because
it would mean a write path I haven't found.

### Step 2 (behavior-visible, canary alone): `DELTA_TOOL_ARG_MAX_BYTES=4096`

The strongest cost lever in either dataset, and the one that needs its own window because the
model can *see* it (oversized arguments come back elided with a marker and the call is refused,
so the agent re-issues in chunks).

- 4.83 MB of stored tool-call arguments on the carrara QS lane; **41.2% reclaimable at a 4 KB
  cap, 81% of it from one tool** (`aperture__qs_stage_body` — the model staging long report
  bodies as arguments, the exact case this rail was built for).
- Reference measurement, same work both arms: compactions **5 → 0**, input tokens −29.9%, cost
  −36.5%.
- Why this attacks your top cost line: unbounded arguments are the one large thing entering
  context with no bounding rail, replayed every turn until compaction sheds them. Fewer bytes →
  later compaction → fewer of the $1.07 first-post-compaction reloads that are 30.6% of the
  lane's spend.
- **Known cost:** the echo guard adds roughly 8 extra model calls on a long filing session.
- **Revert signals**, watch both: compactions per run going *up*, or the agent redoing work it
  already completed. Either one → remove the var, tell me, and it becomes a 0.2.16 question
  instead.

This is also the change your own "arg-eviction A/B on the bench lanes" item covers — run it as
that A/B if you prefer; the pinned-job replay form is stronger evidence than a live window.

### What deliberately does NOT change (please hold the line on these)

- **`DELTA_REASONING_EFFORT` stays `medium`.** The −56%/half-cost figure for `low` is
  chat-shaped; Quick Search is research-shaped, the profile most likely to degrade. Test after
  the demo on a bench rig if you want the data.
- **`DELTA_COMPACT_AT_TOKENS` stays 200000.** Usable ceiling for `claude-opus-5` is ~209k after
  the output reserve; 9k of headroom buys nothing and overshooting trades a cache miss for a hard
  overflow.
- **`DELTA_CAPTURE_PAYLOADS=1` stays.** It is the telemetry enrichment that produced your report,
  not a debug capture.
- **Production lanes stay stop-mode** until the §4 soak is green.

## 2. Host wiring: the heartbeat you asked for already exists — here is the exact contract

R2's engine surface shipped in **v0.2.4** and has been on your fleet the whole period. The gap is
that nothing in the QS room consumes it. The wiring, with one ordering rule that matters:

1. **`POST /v1/tasks`** returns `202 {id}` immediately, before any model work.
2. **Poll first:** `GET /v1/tasks/:id/events?since=0&limit=200` returns every persisted event so
   far plus a `cursor` and a `done` flag. This replays `run.enqueued`, `run.started`,
   `turn.start` — nothing is missed regardless of timing.
3. **Then tail:** `GET /v1/tasks/:id/events?coarse=1` is the live SSE feed — `turn.start`,
   `tool.call`/`tool.result`, `model.call`, `model.retry`, `compaction`, terminal `done` frame
   with the payload. Drop `coarse=1` if you also want the per-token `output_text.delta` narrative.
4. **`GET /v1/tasks/:id`** carries `created_at` / `started_at` / `finished_at`, so the room can
   render "waking the agent" separately from "working on your question" — the split your users
   actually experience.

**The ordering rule: poll before you tail.** The SSE feed replays nothing; a client that opens it
after POST can miss the earliest events and see silence until the 15-second keepalive. Poll from
`since=0`, render, then tail from live. (Credit where due: an adversarial Codex review caught
this failure mode in my own first draft of the guide.)

What this buys on your own numbers: the first honest signal moves from p50 43 s / p90 152 s to
effectively the poll round-trip, and on the next 429 storm the room can render "provider
overloaded, retrying (attempt 3)" from the `model.retry` events you already trust — the two users
who waited 224 s and 195 s in silence on 08-18 would have watched the retries instead. This is
the single highest-leverage demo item on either of our lists, and it is entirely yours, with zero
engine risk.

## 3. The sub-agent unlock is probably one annotation on your MCP server

R7's verdict surprised me and will likely surprise you: research children **do** inherit the
parent's read-only tools — including MCP tools. The gate is `annotations.readOnlyHint === true`
on the tool, fail-closed (`mcp.ts:327`). If your data tools (`fiber_call`, the QS lookups) don't
set `readOnlyHint`, children get web-only universes — which is exactly the "workers guessed
instead of reading our data" failure both your lanes banned spawning over.

**The check:** set `readOnlyHint: true` on every genuinely read-only tool your MCP server
exposes, then run one deliberate `research` spawn on a bench lane and confirm the child can call
a data tool. If that works, your largest unquantified latency lever — parallelizing the
embarrassingly-parallel screening runs — un-bans itself with no engine change. Also remove or
counter the NEVER-DELEGATE rules the agents wrote into their memory files, or they will keep
refusing the feature after it works (see §5 on stale superstitions).

Honest boundary: schema-parity and credential design for *write*-capable children is real 0.2.16+
engine work. The read-only inheritance is what un-blocks screening parallelism, and it may be
live on your side this week.

## 4. The suspend soak (R1) — but first, check what your fleet is actually doing

**Before anything else: R1's premise may be stale.** Your report says "we still run
stop-not-suspend," but your own control plane disagrees on paper: `agent-lane.server.ts:94`
(`restVerb`) selects **suspend** for any lane whose observed `engine_version` is ≥ 0.2.4 — the
generalized form of the flip Nic approved on 2026-07-29 after your own head-to-head
(`suspend-vs-stop-0.2.4.md`: resume 105 ms–1.1 s vs 10–14 s stop-wake, A2 held through a 36-min
drift). Your lanes run 0.2.14, so as written you should already be suspending. Either
`engine_version` is null in prod for those lanes (never health-refreshed → conservative stop),
or R1 was written from the July field report's state rather than the code — the same
stale-learned-fact pattern you diagnosed in `qs_step`. **The check:**
`select workspace_id, engine_version from agent_lane` in prod, or look at a machine's state
after a run settles (`suspended` vs `stopped`). If you're already suspending, R1 is closed and
the −3.6 s is already banked; tell us and we'll mark it. Cost is not a factor either way — both
verbs rest at storage-pennies; the difference is purely wake speed and the (fixed) lease risk.

If the check says stop, the engine work shipped in v0.2.4 (lease renew-or-reacquire) and 0.2.5
(post-resume connection self-heal + first-byte deadline), and your fleet has run both all
period — unexercised. What's missing is not code, it is **evidence under a long hold** (your
July decision doc itself lists the multi-hour drift as the open follow-up), and only your side
can produce it:

- Ensure **speed-lab** (or whichever bench lane you prefer) is actually resting via suspend —
  health-refresh it so `restVerb` sees 0.2.14, and keep the two July riders: `autostart: false`
  on the service (any stray HTTP silently resumes a suspended machine) and the busy-gate before
  resting.
- Let it run its normal week. Watch three things: daemon exits after resume (there should be
  none), first-turn latency after wakes (should drop toward the ~1.1 s resume figure), and any
  `lease` anomalies in the logs.
- Production lanes don't move until that is a week clean. And for the demo itself, your own 24h
  plan is right and stands regardless: **keep the demo machine started** — that removes the wake
  entirely, which is worth more than R1 for one afternoon. One expectation to keep clean:
  suspend does NOT warm the prompt cache (it is server-side and TTL-based), so the between-runs
  cache cold band persists under either verb — that is §1's `DELTA_CACHE_TTL` lever, not this
  one.

Report the soak result either way — "a week clean under suspend" is the sentence that lets every
lane take the −3.6 s.

## 5. Memory hygiene: execute what the agents already wrote, and fix the stale lessons

Three of your items, endorsed with one addition:

1. **Execute the trim ledgers.** carrara's `delta-trim-debt.md` is a prioritized deletion plan
   with per-entry byte estimates. After the cap raise, apply it once by hand (or let the agent do
   it with the new headroom) and merge alpha-school's 11 KB pending file. Do this *after* Step 1
   so the merges land under the new cap.
2. **Harvest the three lanes' independently-learned API traps into the shared seed** — your item,
   no notes, except: do it after the `qs_step` correction below so you don't propagate a stale
   rule fleet-wide.
3. **Correct the stale superstitions explicitly.** Your `qs_step` "batched updates race" rule has
   been false since your 08-05 server fix and now costs a turn per tick; the NEVER-DELEGATE rules
   become false the day §3 lands. Learned workarounds outliving their bugs is a real failure mode
   of learning agents — you named it, and the R3d rail design will carry your
   "re-verify-after-upgrade" affordance. Until then the correction is editorial: update the
   DELTA.md files, note *why* in the entry so the agent doesn't re-learn the old rule from its
   own history.
4. **Your app-side error rates are worth a pass before the demo:** `qs_save_artifact` failed
   17.6% of calls on the carrara lane (26 of 148) and `qs_start` 9.8%. The agent recovers, which
   is why nobody noticed, but each failure is a visible turn. Your coerce-don't-reject +
   staged-dry-run item covers this; it's the right fix and worth doing this week.

## 6. What lands next, and what you'll need to test each time

**0.2.15** (cut is final; twelve items, three of them born from your report): the compaction
identifier appendix — the summary will carry every audited-missing identifier deterministically,
so your 34%-loss finding stops producing wrong artifacts regardless of summarizer quality;
`tool.rejected` telemetry — your invisible A14 class becomes countable (please also re-verify
alpha-school's vocab seeding, as you offered, so the first dataset is clean); and structured
`self_cap` refusals carrying the current file + exact headroom, so one-shot compression works
without a re-read. Plus the Delos batch: stale-ask pinning after compaction, budget-exhaustion
handoffs (a run that spent $14 will hand back its plan and artifact paths instead of one
sentence — your 11 lost runs / $141 were the deciding evidence), honest tool listing on
`/v1/status`, and a relocatable scratch root.

**Your test pass on 0.2.15:** the same four numbers over a comparable window, plus three
release-specific checks — identifier appendix present in post-compaction summaries
(`identifiers_missing > 0` events should now correspond to summaries that still contain those
identifiers), `tool.rejected` events appearing (or their true absence finally meaning something),
and refusal messages carrying the current file. Your canary-volunteering on carrara + lab lanes
is accepted, gratefully.

**Then the OpenAI stage — and please don't jump it early.** The reason the OpenAI Quick Search
agent waits for **0.2.16** and not 0.2.15: the current Responses wire drops the model's encrypted
reasoning items between turns. GPT-5.6 documents that consecutive tool-call chains need those
items replayed; without them, multi-step tool work measurably degrades — exactly Quick Search's
shape. 0.2.16 carries that (reasoning replay), plus explicit prompt-cache breakpoints, verbosity/
summary controls, and the provider-neutral cache plan. Building the test agent on 0.2.15 would
bake the one known quality gap into your baseline.

When 0.2.16 lands, the shape of the bench agent (we'll finalize together):

```
MODEL_API=responses            # against api.openai.com — the metered API, NOT a codex sign-in
DELTA_MODEL_PRIMARY=gpt-5.6-sol
DELTA_REASONING_EFFORT=medium  # sol has no fast mode; effort and variant are the latency levers
DELTA_MODEL_PRICES=...         # gpt-5.6 entries — the engine's baked table predates the family
```

on a **bench workspace first**: run your standard pinned jobs, compare against the Anthropic
baseline on the same four numbers plus answer-quality spot checks, stabilize, and only then
create the client-facing OpenAI workspace. The metered-API choice is deliberate: the codex
subscription surface 400s on undocumented parameters and is the wrong thing to discover during a
demo.

## 7. The sequence, as a checklist

| step | what | owner | window | gate to next |
|---|---|---|---|---|
| 0 | capture the live-0.2.14 baseline numbers (your report largely is this) | you | now | — |
| 1 | `DELTA_CACHE_TTL=1h` + self-cap 4000 fleet-unified, lab lanes | you | 2–3 days / ~30 runs | metrics 3–4 improved or flat, nothing worse |
| 2 | `DELTA_TOOL_ARG_MAX_BYTES=4096`, canaried alone (or your pinned-job A/B) | you | 2–3 days / ~30 runs | metrics 1–3 improved; neither revert signal |
| — | in parallel, off the measurement path: R2 room wiring · R7 `readOnlyHint` + one spawn test · suspend soak on speed-lab · trim-ledger execution · stale-lesson corrections · `qs_save_artifact` fix | you | this week | — |
| 3 | freeze the winning config; that is the baseline | both | before 0.2.15 | — |
| 4 | 0.2.15 upgrade, lab lanes → carrara → clients; re-run the four numbers + the three release checks | both | on release | your green light |
| 5 | 0.2.16 bench agent on `gpt-5.6-sol` via Responses; stabilize on pinned jobs | both | on release | stable + quality parity |
| 6 | create the OpenAI workspace | you | after 5 | demo |

Steps 1–2 and the parallel column are independent of anything we ship. If every engine release
slipped a month, the config track alone would still make Quick Search faster, cheaper, and more
honest about what it's doing.

## 8. Asks back, so the loop closes

1. Alpha-school's **daemon env history** (the R3a question — cap drift or a write path I can't
   find).
2. The **`restVerb` check result** (already suspending, or stop with null `engine_version`?), then the **soak verdict** on speed-lab after a week of suspend.
3. The **`readOnlyHint` result** — did one annotated spawn read your data?
4. Your **R6 dataset, standing** — accepted with thanks; continuous pipe preferred over
   on-request export. We're also running Anthropic's cache-diagnosis beta out-of-band against
   captured payloads on our side; between the two, the stationary-prefix defect should finally
   get a name.
5. The **step 1/2 numbers** when the windows close — they decide whether the arg cap graduates to
   an engine default in 0.2.16, which would make this the second time your fleet's data set an
   engine default.

— Delta Harness
