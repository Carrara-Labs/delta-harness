# To the Aperture engineer: the lab validation assignment — prove the config, clean the memories

2026-08-19, from the Delta Harness maintainer. This is the working brief for the window while we
cut 0.2.15 and build the OpenAI-native 0.2.16. The full argued config track — every variable,
every number, the sequencing rule, the heartbeat wiring, the `restVerb` check — is here:

- **The config track (read this first):**
  `/Users/nictouron/delta-harness/docs/reply-aperture-qs-config.md`
- Verdicts on your R1–R9 report, receipts recomputed:
  `/Users/nictouron/delta-harness/docs/aperture-asks-0.2.15-triage.md`
- The lane-level data behind the three variables:
  `/Users/nictouron/delta-harness/docs/harness-0.2.15-plan.md` (the release you'll receive) and
  `/Users/nictouron/delta-harness/docs/aperture-qs-tuning-findings.md`

All four are on `Carrara-Labs/delta-harness` `main` as of `10cfba3`+, so `git -C
~/delta-harness pull` gets you current.

This brief adds the part that is yours end-to-end: **a controlled A/B on the lab workspaces, and
a memory-hygiene sweep across the fleet.** The goal, stated once: by the time 0.2.15 lands, the
Quick Search agent should already be measurably better on the engine you run today, its config
frozen as the baseline, and its learned memory free of rules that stopped being true — so the
release lands on solid ground and its effect is attributable.

## 1. The A/B: speed-lab (treatment) vs google-deepmind (control)

Both are bench lanes, both on 0.2.14, both yours to burn. One design decision matters more than
everything else:

**Only the environment differs between the two lanes. Everything else — engine version, DELTA.md
content, seeds, vocab, the request battery — is identical.** If you refresh memories on the
treatment lane but not the control, the A/B measures config + memory hygiene as one blob and
neither is attributable. So the §3 hygiene sweep runs on BOTH lanes first, identically, and the
env split comes after.

### Setup

1. Run the §3 hygiene sweep on both lanes. Snapshot both workspaces (files + `/v1/status`) as
   the T0 record.
2. **Control (google-deepmind):** config untouched — whatever it runs today, recorded.
3. **Treatment (speed-lab):** the full recommended set, both steps at once (the two-step
   sequencing in the config track is for *production* rollout, where reverting cheaply matters;
   a bench A/B with a control lane doesn't need it):

   ```
   DELTA_CACHE_TTL=1h
   DELTA_SELF_MAX_TOKENS=4000
   DELTA_TOOL_ARG_MAX_BYTES=4096
   ```

4. Do the `restVerb` check from the config track §4 first (`select workspace_id, engine_version
   from agent_lane`). Whatever the fleet turns out to be doing — suspend or stop — make both
   lanes do the **same** thing for the A/B, or wake costs contaminate the wall-clock numbers.

### The battery: three tiers, same prompts, both lanes

Design the requests to hit the three regimes your production traffic actually has. My suggested
shape — adjust the prompts to your catalog, but keep the tier structure and the counts:

| tier | shape | n per lane | what it stresses |
|---|---|---:|---|
| **simple** | single factual lookup, 0–3 tool calls, no save (e.g. "how many X at company Y in our records") | 10 | first-signal latency, cache warmth between runs, the TTL |
| **medium** | multi-step search + assemble + one `qs_save_artifact` (e.g. "shortlist 5 candidates for role Z with one-line rationales") | 8 | the save path, arg staging (`qs_stage_body`), self-writes |
| **hard** | full screening/research run, 10–30 min class, historically compacts (e.g. "screen this list of 30 against the brief and file the roster") | 5 | compaction count, post-compaction reload cost, identifier survival, budget behavior |

Run them interleaved (not all-simple-then-all-hard) and inside the same day-window on both lanes,
so provider weather — an Opus 429 storm would otherwise swamp the signal — hits both arms
equally. Alternate which lane goes first per prompt.

### What to measure (telemetry side)

Per tier, per lane — the four numbers from the config track plus the run-level basics:

1. compactions per run
2. first-post-compaction `input_tokens` + cache hit (the §2 join query in
   `aperture-qs-tuning-findings.md`)
3. cost per run
4. remember refusal rate (`error.class='self_cap'`)
5. wall-clock p50/p90 per tier
6. cache hit % overall and on first-call-of-run (the TTL's target band)
7. tool error rate by tool (this also re-baselines your 17.6% `qs_save_artifact` number after
   your app-side fix)

Expected signatures, so you know what "working" looks like: treatment should show fewer
compactions and lower cost on **hard** (the arg cap), higher first-call cache hit on **simple**
(the TTL), and near-zero self_cap refusals everywhere (the cap raise). **Simple-tier wall clock
should NOT move much** — if treatment gets *slower* on simple, suspect the arg-cap echo guard
and look at the transcripts.

### What to inspect (the part telemetry can't see)

After the battery, go into both VMs and read the workspaces — this is the half of the analysis
your last report proved the value of, and I'm explicitly asking for it again:

- **DELTA.md, before vs after:** did the treatment agent actually use its new headroom — did the
  pending/overflow lessons get merged in? Did the control agent keep paying the trim tax? Diff
  against the T0 snapshot.
- **Overflow machinery:** on treatment, the shantytown should stop growing
  (`*-pending*.md`, `*-overflow*.md`, trim-debt ledgers). If new overflow files appear on
  treatment at a 16 KB cap, that is a finding.
- **Transcript spot-reads on hard runs:** on treatment, look for the arg-elision marker and the
  chunked re-issue behavior — confirm the agent chunks *forward* rather than redoing completed
  work (redo is the revert signal; one clean example each way in the report, please).
- **Artifact quality:** for the hard tier, compare the actual filed rosters/artifacts between
  lanes — same people found? identifiers intact after compaction? This is the accuracy check
  no counter captures, and it's the baseline for judging 0.2.15's identifier appendix later.
- **Disk hygiene:** `.delta/spill/`, research dirs, scratch — anything orphaned during the
  battery, on either lane.

### The verdict, and what it triggers

- **Clear improvement** (cost/compaction down on hard, cache up on simple, refusals ~0, no
  redo-loops, artifact quality flat-or-better): freeze the treatment config as the fleet
  recommendation, roll it to carrara, then client lanes — *before* 0.2.15, so the release lands
  on the improved baseline.
- **Mixed** (TTL and self-cap win, arg cap ambiguous): ship Step 1 fleet-wide, hold the arg cap,
  send me the transcripts — it becomes a 0.2.16 default-flip question with your data attached.
- **Any regression signal**: revert that variable, keep the rest, report. A falsified
  recommendation is as useful to me as a confirmed one — your report already proved you know
  that.

Either way: the same battery re-runs, unchanged, on 0.2.15 when it lands. That re-run is the
release acceptance test, and it's why the prompts should be pinned/reusable rather than ad hoc.

## 2. Timing

This whole assignment fits the window while we cook: hygiene sweep + setup in a day, the battery
over 2–3 days, the write-up after. If 0.2.15 arrives before you finish, **finish the A/B on
0.2.14 first** — do not upgrade mid-battery; that's the sequencing rule from the config track
and your own report's pre/post-upgrade labeling pain.

## 3. The hygiene sweep: refresh every workspace's DELTA.md and config

Across **all** workspaces — the lab lanes first (they gate the A/B), then carrara and the client
lanes as a follow-up. Two halves:

### 3a. Memory: keep what agents learned, kill what stopped being true

Your own report named the failure mode: *"a learned workaround outliving the bug it worked
around."* The sweep, per lane, reading DELTA.md **and** every overflow/pending file:

**Harvest (keep, and promote to the shared seed):** the genuinely earned practices — carrara's
"COUNT THE ASSEMBLED BODY" defense, the defensive drafting rules that cut save-refusals from 12%
to 3%, the API traps each lane learned alone. Cross-pollinate; three lanes converging on the
same lesson independently is your strongest signal of a real one.

**Correct or delete (the poisoned set) — the known ones, verify each against current reality
before touching it:**

| stale memory | why it's stale | action |
|---|---|---|
| "`qs_step` batched updates race and revert" | your 08-05 server fix; costs a turn per tick since | delete; note why |
| NEVER-DELEGATE / "sub-agents launder guesses" | true until `readOnlyHint` lands on your MCP tools; false after | correct **after** the annotation + one verified spawn (config track §3) |
| "DELTA.md is capped at 9600 bytes" and every byte-count rule derived from it | cap becomes 16,000 on the new config | update numbers on treated lanes; on control, leave as-is until rollout |
| "`remember` disables after 3 rejections, compress BEFORE saving" | still TRUE on 0.2.14/0.2.15 — the breaker stays. But the panic-drafting it induced matters less at 16 KB | keep the rule, soften the workflow around it; revisit at 0.2.16 |
| "a successful save can land OVER the cap" | engine check is deterministic; pending your env-history pull (config track §1) | once the R3a mystery closes, correct with the real cause |

**The correction discipline:** when you edit an agent's memory, say *why* inside the entry
("corrected 2026-08-19: server fix 08-05 removed the race") — otherwise the agent re-learns the
old rule from its own transcripts and overflow files. And since concurrent runs edit these
files, do the sweep with each lane quiesced (busy-gate false), through the `remember`
path or the Cockpit editor — both snapshot the old version, so every edit is revertible.

**Also purge the overflow files themselves** once merged: a corrected DELTA.md next to an
uncorrected `delta-dropped.md` full of the old rules is a re-poisoning vector.

### 3b. Config: one recorded, uniform, intentional set per lane

- Build the lane × env table for the whole fleet: `DELTA_SELF_MAX_TOKENS`, `DELTA_CACHE_TTL`,
  `DELTA_TOOL_ARG_MAX_BYTES`, `DELTA_REASONING_EFFORT`, `DELTA_COMPACT_AT_TOKENS`, budgets,
  `DELTA_CAPTURE_PAYLOADS`, `DELTA_MODEL_PRICES`. Today that table has three different self caps
  chosen by nobody; after the sweep every value should be either the recommended one or a
  documented exception.
- Kill dead knobs while you're in there: anything set that 0.2.14 no longer reads, anything
  unset that the lane's workload wants (the config track's do-not-touch list applies —
  reasoning effort and compact-at stay put).
- Cross-check each lane's *effective* values via `GET /v1/status` after restart — the status
  surface reports self-file fullness today and will report more in 0.2.15 (D-3); until then the
  env table is your source of truth, so make it real.
- While you have alpha-school open: pull its **machine config revision history** — that's the
  R3a env-history ask from the config track, and it closes the one genuine mystery left in your
  report.

## 4. What comes back to me

1. The **A/B report**, same shape as your last one — receipts, per-tier tables, the
   workspace-file findings, and the verdict. That report decides the fleet config *and* feeds
   the 0.2.16 default-flip question.
2. The **hygiene changelog**: per lane, what was harvested, corrected, deleted, and why.
3. The **restVerb check** result and the **alpha-school env history**.
4. Anything the deep read of the VMs surfaces that neither of us predicted — that category has
   been the most valuable input to the last two releases, and I'd bet on it again.

While you run this, we're cutting 0.2.15 (twelve items, three born from your report) and
building the OpenAI-native 0.2.16 behind it. Your frozen baseline is what both of them will be
measured against — which makes this assignment, quietly, the foundation of the whole release
train.

— Delta Harness
