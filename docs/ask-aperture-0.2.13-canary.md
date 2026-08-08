# Canary ask: Harness 0.2.13 "say what changed"

From Delta Harness, 2026-08-08. Branch `feat/0.2.13-say-what-changed`, built, reviewed and
live-tested locally. **Not released.** Plan: `harness-0.2.13-plan.md`. Spec:
`spec-say-what-changed.md`. Results: `results-0.2.13-live.md`.

**What we need:** build an image from this branch and run it on a lab lane (speed-lab or
google-deepmind) against ordinary Quick Search work, between jobs. One query afterwards.

This is the batch that answers your context-ceiling report. It deliberately does **not** fix the
mechanism, because we still do not know it. It ships the instrument that names it.

---

## The one thing that decides the next release

Written down before we built anything, so the first reading is a test rather than a survey:

> **On miss turns, `spine_hash` moves.**

We cannot test this ourselves. Our local workload has no self-writes and no tool activations, which
are the only two things that make the spine move — so on our runs both prefix hashes stayed frozen
across every turn. Your lanes have both. That is the whole reason we are asking.

**The query, after a normal engagement:**

```sql
SELECT turn,
       attributes->>'cache_hit_pct'    AS cache_pct,
       attributes->>'spine_hash'       AS spine,
       attributes->>'tools_hash'       AS tools,
       attributes->>'tools_n'          AS tools_n,
       attributes->>'self_bytes'       AS self_b,
       attributes->>'history_bytes'    AS hist_b,
       attributes->>'ephemeral_bytes'  AS eph_b
FROM agent_events
WHERE event_name = 'model.call'
  AND attributes->>'tier' = 'main'
  AND task_id = '<a task that had misses>'
ORDER BY event_time_ms ASC;
```

Compare each row's hashes against the previous row's, then bucket by `cache_pct`:

| on a miss turn | reading |
|---|---|
| `spine` moved, `tools_n` **changed** | a tool activated or the breaker withdrew one. Expected — cross-check the new `tool.breaker` event |
| `spine` moved, `tools_n` **same** | **the prediction holds.** The spine is mutating between turns and that is the leak |
| both hashes **stable** | the prediction fails. The prefix was intact, so the cause is inside history or on the wire — a defect we cannot currently name from source |

All three are good outcomes. The third is the one we would most want to know early.

## What we measured locally, honestly

Three repetitions per arm of an identical 9-turn growing conversation, ceiling 40k,
`claude-sonnet-5`. Ranges are [min–max].

| metric | 0.2.12 | 0.2.13 | verdict |
|---|---|---|---|
| **compaction events** | 5.00 [5–5] | **3.00 [3–3]** | **established** — zero variance, no overlap |
| mean input tokens | 26,880 | **24,682** | **established** — -8.2%, separated |
| mean cache hit | 61.3% [51.7–71.0] | 68.3% [46.6–79.1] | **NOT established** — ranges overlap |
| `context_irreducible` | 0, 0, 0 | 0, 0, 0 | no regression |
| turns delivered | 9/9 ×3 | 9/9 ×3 | no quality loss |

**A single run had shown cache 52% → 79%. It did not survive repetition** and we are retracting it.
Cache hit is a poor metric on short runs — it moves with the 5-minute TTL against variable
wall-clock timing. Same error class as the -29.9% we retracted in 0.2.12, caught this time by
repeating before reporting.

Compaction count and input volume came back identical on every repetition in both arms, which is
expected: compaction firing is decided by token arithmetic on identical inputs. So 5 → 3 is a
property of the change, not a sample.

**We are not quoting a cost number.** Arm A's utility calls emit nothing — that is the bug S3 fixes —
so its cost sums main calls only while arm B's sums main plus its summary calls. The two numbers do
not measure the same set.

**Our workload is 40k on sonnet, self-designed.** Yours is 200k+ on opus with compaction firing on
nearly every turn. The arithmetic says the effect should be much larger on your shape. We cannot
show that; you can.

## What changes for you on upgrade

| | change | what to expect |
|---|---|---|
| **S5** | the retained-tail budget no longer derives from the compaction ceiling | **The behavioural change.** Your lane kept a ~180k tail on a 200k ceiling, landed at ~99% of budget and re-fired. Expect compaction count to drop and each one to actually shrink. Score on **compaction count, post-compaction `input_tokens`, `context_irreducible`** — never steady-state cache hit, which is 92-100% and will not move. **Note:** below roughly a 33k ceiling this is a deliberate no-op, because the derived remainder already wins |
| **S6** | ceiling derived from a model window; `DELTA_COMPACT_AT_TOKENS` demoted to a clamped override | `claude-opus-5` is seeded at **249,000** from your own field floor, so an opus-5 lane with no override moves from 120k to **209,000**. Your lanes set the override explicitly, so they are unaffected unless it exceeds 209,000 — then it clamps and says so at boot |
| **S2** | compaction attempts that were billed but silent now emit | **`compaction` changes meaning**: it counts *attempts* now, not rewrites. Filter `shrank = true` for your old numbers. Your "161 compactions" was under the old meaning |
| **S3** | utility-lane calls now emit `model.call` | **Filter `tier = 'main'`** anywhere you count turns. Live proof this matters: in one of our runs, **4 compaction events produced 6 billed summary calls** — two took a second attempt. Your 161 is a floor on attempts, not a count |
| **S4** | the breaker latch emits `tool.breaker` | New event type, with the schema bytes withdrawn. Reject-on-unknown-event consumers need it added |
| **S7** | `last_event_ms_ago` on `/v1/busy` while running | Your reconciler's stall constant. Silence, not turn age. **Daemon-wide** — on a daemon serving several runs a noisy one masks a quiet one, so use `/v1/tasks/:id/events` for a per-run decision |
| **S8** | `hosting.md` documents what survives a suspend | Notably: the A4 breaker tally is deliberately re-armed on resume, so a quarantined tool becomes callable again |

**Who sees nothing:** an agent not near a context ceiling, and any lane with a ceiling under ~33k.
New telemetry fields, no behaviour change.

## What we could not verify

1. **The prediction.** Untestable on our workload, as above.
2. **The digests cover engine-assembled input, not the serialized request body.** The provider
   reshapes both segments afterwards. A wire-format switch shows up in the existing
   `gen_ai.provider` / `fallback` attributes instead. We did verify locally that `spine_bytes`
   matches the captured system string **byte for byte** (3,861 = 3,861) on the Anthropic path, so the
   digest is over the right string.
3. **`self_bytes` disambiguates across runs, not within one.** `self` is a per-run snapshot, so a
   mid-run `remember` takes effect next run.
4. **Sub-agents, research fan-out, `eval_n` and tool failures** were never exercised live — unit
   tests only. Your lanes use all of them.

## Two things to watch for

- **Did anything get slower?** S1 hashes the spine and tool specs every turn. Both are small and
  already walked by the token estimate, and it should not appear in `wall_ms` — but it is new work
  on the hot path and we would rather hear it from you than assume.
- **Did compaction get worse anywhere?** S5 should never raise the tail budget; the ceiling-derived
  value still wins whenever it is smaller. A lane with a tight ceiling and large tool schemas is the
  case to watch.

## Practical notes

- `MODEL_BASE_URL` must include `/v1` on the native Anthropic path. Without it you get a 404 whose
  empty body the engine reports as `(empty error body)` with no status code. Pre-existing, not from
  this batch, and now on our backlog — but it cost us an hour today.
- Nothing here is blocked on you. If the canary is inconvenient this week, the reading from any
  ordinary engagement afterwards is just as good.
