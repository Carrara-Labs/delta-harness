# Reply: the Quarry Brain fleet inventory — five findings, answered against the live systems

2026-08-21, from the Delta Harness maintainer. Answers `quarry-brain/docs/delta-agents/BRIEF-harness-engineer.md` (2026-08-20).

I took the brief at its word and verified everything myself: ran your SQL against the Delta
Postgres, read the live machine through the Fly Machines API (config only — I did not touch it,
and I did not trigger reconcile/materialize, per gotcha #30), and diffed the exact binary you run
(`v0.2.4` tag) against the current line. Every number below is from those sources, today. The
inventory itself is excellent — accurate where I could check it, and honest about the one thing
it couldn't know (more on that first, because it changes the shape of Finding 1).

---

## Finding 1 — it is not an assembly floor. It is a known, fixed retention defect, amplified by three hand-patched knobs.

**First, the bad news about the diagnostic you proposed: it cannot be run on your fleet yet.**
I ran your exact `spine_bytes/tools_bytes/…` query. It returns **zero rows** for every
`context_irreducible` run. Those attributes shipped in **0.2.13** (the segmented prefix-hash
work); your meeting processor runs 0.2.4 and cannot emit them. Nobody at Quarry "hasn't looked"
— nobody *could* have. The only fleet rows that carry the anatomy are Ferni's (0.2.13+, 74
calls). So upgrading is not merely a fix candidate for this finding — it is the **precondition
for diagnosing it** with the query you wrote.

**But the code answers the question anyway.** In `v0.2.4:src/run.ts:738`, the retained history
tail after compaction is derived **from the trigger itself**:

    recentBudget = compactAtTokens - fixed - SUMMARY_RESERVE

With your live `DELTA_COMPACT_AT_TOKENS=160000`, compaction "succeeds" by shrinking history to
~150k tokens — i.e. it lands just under its own trigger, the next turn's tool results push it
straight back over, and the loop compacts again, shrinks a little, still exceeds, and emits
`context_irreducible`. That is your ~6-events-per-run signature. We hit exactly this on our own
fleet: the 0.2.13 release note calls it out ("compaction landed just under budget and re-fired
next turn"), and the spec that motivated the fix measured **94 failures out of 94** under the
old rule. 0.2.13 replaced the derived tail with a **flat 24k low-water mark**, decoupled from
the trigger — after that, the knob decides *when* compaction fires, never how much it reclaims.

Three consequences worth stating plainly:

1. **The knob history is a red herring on 0.2.4 — in the painful direction.** Raising the
   threshold 80k → 160k *raised the retained tail* by the same amount, which made the thrash
   worse, not better. The bundle's 80k was the right instinct; the hand-patch to 160k re-broke
   it. (It also likely pushed assembled requests past the codex backend's effective window —
   I measured a max `input_tokens` of **253,993** on a pre-error call, which no 200k window
   accepts. Your own bundle comment records that this backend is tighter than a raw API.)

2. **The assembly is nowhere near the floor.** Ferni's measured anatomy (the only fleet data
   that exists): spine ≈ 9.6 KB + tools ≈ 8.2 KB + self ≈ 2.4 KB + ephemeral ≈ 0.7 KB — about
   **21 KB, call it 5–6k tokens** — against a history p50 of 38 KB and p90 of 107 KB. Your
   meeting bundle's fixed parts are richer (self 3k tokens, policy 1.2k) but still land around
   10–12k tokens total. History dominates; the assembly does not.

3. **The one genuine irreducibility contributor on that machine is another hand-patch:
   `DELTA_TOOL_RESULT_MAX_BYTES=200000`.** The bundle deliberately leaves this at the 20k
   default ("page the transcript via read_file"); the machine env raises the inline cap to
   200 KB, which lets a single `get_meeting_context` result sit as one ~50k-token message.
   Compaction summarizes *across* messages and demotion only shrinks spilled results — no
   version of the engine can split one message. A 50k-token single message inside a retained
   tail is irreducible by construction. Restore 20k (or at most ~50k) when you touch the machine.

**Severity calibration:** this failure mode is a tax, not an outage. Of the 166 runs that ever
emitted `context_irreducible`, **139 finished `done`** — the error is warn-and-proceed, and the
post-provider overflow retry is the backstop. The cost is money and latency (re-billed
near-ceiling prompts, overflow retries), plus the 26 that went on to fail — but those failed on
**budget**, and that chain belongs to Finding 5.

**Your secondary question — should an irreducible request degrade rather than error?** The
current line already degrades: pre-send estimation, spill demotion, one overflow rescue per
turn, and (0.2.15) a budget-exhaustion handoff that returns the plan and artifacts instead of a
counter string. What we deliberately do **not** do is drop tools mid-run — silently removing
capabilities from an agent that has already planned around them trades a visible error for an
invisible wrong answer, and (per the data above) the tool block isn't the floor anyway.
`context_irreducible` stays an *event*, not a failure; after 0.2.13 it should be rare enough to
alert on rather than drown in.

---

## Finding 2 — yes, upgrade, and here is exactly what matters in 0.2.5 → 0.2.16

The releases that bear on your failure modes:

| Release | What it changes for you |
|---|---|
| **0.2.13** | The flat-24k retention fix (kills the Finding-1 thrash). Segmented prefix-hash telemetry: `spine_bytes`, `history_bytes`, `tier`, `gen_ai.request.effort` — the attributes your Finding-1 query needs. Bounded model-written args. **Carries the one-way migration (below).** |
| **0.2.15** | Compaction pins the run's **own** request, not the session's first (42/42 stale pins measured wrong-task on our fleet — your meeting path uses `store:false` per-meeting turns, so exposure is limited, but any threaded session on 0.2.4 has this bug). `max_output_tokens` is never sent to `chatgpt.com/backend-api/codex` — **your exact backend** — where it 400s every `research`/reflection/eval child (24/24 died invisibly on the deployment that found it). `DELTA_MAX_STEPS` becomes a real knob. Exhaustion handoff. |
| **0.2.16** | Failed child/utility calls emit `model.call` with `is_error` (the invisibility that hid those 24/24 for two weeks). Real `gpt-5.6` pricing. Append-append self-file merges. |

**The risks, in order of how much they'd hurt:**

1. **The 0.2.13 migration is one-way.** A machine rolled back below 0.2.13 after booting it
   will not boot, and recreating the volume destroys the agent's learned `DELTA.md`. Snapshot
   the volume and verify `DELTA.md` is in the archive **before** upgrading — the exact
   procedure is in our CHANGELOG under 0.2.13 (and `hosting.md`).
2. **Sol metering jumps ~4× the moment 0.2.16 boots.** 0.2.4 prefix-matches `gpt-5.6-sol`
   against the `gpt-5` price entry and under-meters ~4×; 0.2.16 fixes it. Your live
   `DELTA_MAX_COST_USD=10` — and env *does* override the profile in both directions, on 0.2.4
   too, so it is genuinely $10 today. A dense meeting your bundle comment prices at "~$3" will
   meter ~$12 post-upgrade and **fail on budget**. On the broker/subscription lane the marginal
   cost is ~$0 and `cost_usd` is API-rate-equivalent metering, so raise the budget deliberately
   (≈$25) — with the caveat that the same budget governs the metered Anthropic fallback, where
   dollars are real. (Corollary: the bundle comment "env can only NARROW the profile budget
   (Math.min)" is wrong for every version you run — the override-both-ways semantics predate
   0.2.4. Worth fixing so the next tuner doesn't reason from it.)
3. **A previously-inert knob goes live.** The machine sets `DELTA_MAX_STEPS=160`; 0.2.4 does
   not read it (nothing in the binary does), 0.2.15+ does. 160 is above the old effective
   ceiling of 100, so this is a loosening — probably intended, but decide it on purpose.
   `DELTA_LLM_PROVIDER=anthropic` is inert on **both** versions; delete it, it's noise that
   will mislead the next person. `DELTA_MODEL` and `DELTA_PROFILE=work` alias cleanly.
4. **0.2.15's visible behavior changes:** research artifacts move to `.delta/research/`; a
   failed run's `output_text` becomes a user-facing handoff (counters move to `runs.error` —
   anything parsing "budget exhausted" out of output text must switch); the delegated code CLI
   default adds `--disable apps --disable plugins`.
5. **Upgrade mechanics on the hand-patched machine:** your `upgrade` endpoint is env-safe, so
   use it; the danger is only `materialize()`. Your own brief already nails this.

**Sequence I'd run:** upgrade one low-traffic agent first and watch a day → snapshot the
meeting-processor volume → upgrade it **and in the same change** reset the machine env to the
bundle's values (compact 80k — or 100k now that the tail is flat, effort **medium** per your own
tuning data, tool-result cap 20k, budget ~$25, steps decided) → re-run your Finding-1 query a
week later. It will return rows this time, and it will answer the assembly-vs-history question
with your own workload rather than my Ferni proxy.

---

## Finding 3 — both sub-questions answered, with dates

**The 1,602-row null band is closed, not ongoing.** I dated it: 1,142 stripped rows on
2026-07-22 and 460 on 2026-07-23, then zero forever after — `DELTA_CAPTURE_PAYLOADS=1` was set
on the machine on 2026-07-24 and every row since is populated. The mechanism is the 0.2.4
binary's pre-`SAFE_ATTRS` behavior (strip the *entire* attribute object without payload
consent); `SAFE_ATTRS` shipped in 0.2.6. Two corollaries: the rows with attributes prove the
flag is on, because they contain `tool_calls` — a key `SAFE_ATTRS` deliberately excludes — and
after the upgrade you could turn payload capture **off** and still keep tokens, cost, latency
and error class. Given the transcripts a meeting agent handles, I'd consider that.

**The missing `tier` is pure 0.2.4 lag.** `tier` arrived with `emitUtilityCall` in 0.2.13 —
which is why the only rows in your table that carry it (`claude-opus-5 main 73`,
`haiku utility 22`) are Ferni's. Upgrade closes it; nothing in your configuration is wrong.

**On the structural blindness of `/usage`:** you already ingest `run.finished` (with status)
and `model.call` (with cost) into `agent_events` — the collector *is* the usage ledger. Rather
than opening `agent_runs` rows the meeting path can't close, I'd point `/usage` and
`/performance` at `agent_events`, or close the loop from your own telemetry (see Finding 5).

**One caveat for your dashboards:** the pre-0.2.16 sol rows are under-metered ~4×, so the
"$668/30d" is more like ~$1,150 API-equivalent — and about $470 of it is one transitional week
(w/o 2026-07-27: 754 metered Opus calls at $228 + 184 OpenRouter-sol at $124, the hand-patch
changeover). Steady state since 2026-08-03 is sol-only at $20–65/week. Expect the graphs to
step up 4× at upgrade; nobody should panic.

---

## Finding 4 — acknowledged; your plan is right

Nothing for the harness or the provisioner to change — your split (credentials ride
`setAppSecrets()`, env carries config) is the correct one and the leak is the hand-patch
bypassing it. Two notes for the rotation: the machine also carries the OpenRouter/Anthropic
fallback route in `DELTA_PROVIDERS`, so rotate with the fallback lane in mind, and when you
re-apply env post-rotation, that is the natural moment to do the full env reset from Finding 2.

---

## Finding 5 — what the daemon actually does, and why your 17 will never self-heal

The full mechanism, from our side of the seam:

1. `POST /v1/tasks` → 202. The run row is durable (SQLite WAL, checkpoint per turn) even for
   `store:false`.
2. **Machine dies mid-run:** `recover()` resumes the run on next boot — this works on your
   fleet today (8 `run.resumed` events in your telemetry). While a run is alive,
   `GET /v1/tasks/:id` answers, and `GET /v1/tasks/:id/events` (which exists **on 0.2.4 too**)
   serves persisted progress events — poll or SSE. "Is run X alive" = status is
   queued/running *and* events are still advancing. Your control plane currently uses neither:
   the driver is fire-and-forget by design.
3. **Run finishes `failed` with `store:false`:** the daemon **purges everything at settle** —
   run row, transcript, spill, research. That is the ephemeral zero-trace contract your spec
   asked for (§C1a). After that, `GET /v1/tasks/:id` has nothing to return. This is the answer
   to "what should the control plane see": for a failed ephemeral run, *nothing, by contract* —
   which is exactly why your ledger shows `dispatched` forever.
4. **Why the sweep didn't clear them:** `sweepStuckMeetings` re-drives only rows younger than
   `MEETING_REDRIVE_MAX_AGE_MS` = **6 hours**. Within that window it re-drove into the same
   failing configuration (0.2.4 + effort=high + 160k + $10-effective budget — your ~30 budget
   errors cluster 07-15 → 08-11, matching the stuck rows' 07-24 → 08-10 creation dates), then
   the rows aged out into "abandoned": counted, surfaced, never re-driven again, by your own
   design. The 8 `dead` deliveries are the other class — the dispatch itself threw 8 times.
   **The 17 will not self-heal.** After the upgrade + env reset, re-drive them by hand
   (reset to `claimed` outside the 6h fence, or a one-off variant of the sweep).

**What I'd change on your side:**

- **Record the task id.** `dispatchTask` returns it; `meeting_origin` doesn't store it (no
  such column). With it, you can join your *own* `agent_events` — `run.finished` carries the
  terminal status — and close the ledger from telemetry you already collect, with zero new
  harness surface and zero polling.
- If you want the daemon to keep the answer instead: set **`idempotency_terminal: true`** on
  the dispatch and make the key **per-generation** (origin_key + attempt), not just origin_key.
  Terminal runs then persist even for `store:false` (that is the documented exception to the
  purge), `GET /v1/tasks/:id` answers `failed` + `runs.error` after the fact, and each re-drive
  is a fresh key so exactly-once semantics never block a retry. Trade-off stated plainly: the
  exception keeps the transcript too, so it weakens zero-trace — pick it only if that's
  acceptable for meeting content.

**What we'll take onto our side:** the honest gap in the surface is that an ephemeral run's
*terminal status* dies with its transcript. A privacy-preserving tombstone — run id, status,
error class, counters, no content, TTL'd — would let a fire-and-forget dispatcher learn the
outcome without weakening zero-trace. That fits our error-as-value doctrine and is now a
candidate for 0.2.17. If you adopt the task-id + telemetry join above you don't need to wait
for it.

---

## Your ask #4 — the bundle itself

The bundle (`meeting-processor.ts`) is genuinely well-built — measured comments, correct
seeding discipline, the self/policy budget raises are exactly how those knobs are meant to be
used. The problem is not the bundle; it is that the machine no longer runs it. Every regression
above (160k, effort high, 200k inline cap) is a machine-env hand-patch *away* from the bundle's
own documented tuning. The fix is the env reset in Finding 2's sequence, plus one comment
correction (the Math.min claim) and one deletion (`DELTA_LLM_PROVIDER`).

Worth returning the compliment from your brief: the telemetry pipeline write-up is right that
the salted-digest/allowlist design is meant to be copied, and your two-key fence and
propose-only guard are better than what we usually see on the consumer side. The system is
sound. It is running a year of our fixes behind, on hand-patched knobs, and both of those are
one deliberate afternoon to close.

— Delta Harness
