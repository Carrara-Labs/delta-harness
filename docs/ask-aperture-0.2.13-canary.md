# Ask: canary 0.2.13 on a lab lane

For Aperture, 2026-08-07. Branch `feat/0.2.13-say-what-changed`, built and reviewed, **not
released**. Plan: `harness-0.2.13-plan.md`. Spec: `spec-say-what-changed.md`.

**What we need from you:** build an image from this branch and run it on a lab lane (speed-lab or
google-deepmind) against ordinary Quick Search queries. We cannot do the live half ourselves — there
is no model key in our build environment, so everything below is verified by 914 unit tests, three
codex passes and a local daemon boot, and none of it has met a real model.

This is the batch that answers your context-ceiling report. It deliberately does **not** fix the
mechanism, because we still do not know it. It ships the instrument that names it.

---

## The one thing that decides the next release

We wrote the prediction down before building, so the first reading is a test rather than a survey:

> **On miss turns, `spine_hash` moves.**

Everything else in this batch is a correctness fix. This is the question.

**The query, once a lane has run a normal engagement:**

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

Compare each row's hashes against the previous row's, and bucket by `cache_pct`.

| what you see on a miss turn | reading |
|---|---|
| `spine` moved, `tools_n` **changed** | a tool activated or the breaker withdrew one. Expected; cross-check the new `tool.breaker` event |
| `spine` moved, `tools_n` **same** | **the prediction holds.** The spine is mutating between turns and that is the leak |
| both hashes **stable** | the prediction fails. The prefix was intact and the cause is inside history or the wire — a defect we cannot currently name from source, and worth knowing with certainty |

Any of the three is a good outcome. The third is the one we would most want to know early.

## What else is in it, and what it will do to your numbers

| | change | what you should see |
|---|---|---|
| **S5** | the retained-tail budget no longer derives from the compaction ceiling | **The one behavioural change with a real effect.** Your lane kept a ~180k tail on a 200k ceiling, landed at ~99% of budget and re-fired. Expect compaction count to drop sharply and each one to actually shrink. Score on **compaction count, post-compaction `input_tokens`, and `context_irreducible`** — never on steady-state cache hit, which is 92-100% and will not move |
| **S6** | ceiling derived from a model window; `DELTA_COMPACT_AT_TOKENS` demoted to a clamped override | `claude-opus-5` is seeded at 249,000 from your own field floor, so an opus-5 lane with no override moves from 120k to **209,000**. Your lanes set the override explicitly, so they are unaffected unless the override exceeds 209,000 — in which case it clamps and says so at boot |
| **S2** | compaction attempts that were billed but silent now emit | **`compaction` changes meaning**: it now counts *attempts*, not rewrites. Filter `shrank = true` to reproduce your old numbers. Your "161 compactions" was under the old meaning |
| **S3** | utility-lane calls now emit `model.call` | **Filter `tier = 'main'`** anywhere you count turns, or research fan-out and compaction summaries will inflate it. This is also the fix for "161 is a floor on attempts" |
| **S4** | the breaker latch emits `tool.breaker` | New event type. Reject-on-unknown-event consumers will need it added |
| **S7** | `last_event_ms_ago` on `/v1/busy` while running | Your reconciler's stall constant. Daemon-wide, not per-run: on a daemon serving several runs a noisy one masks a quiet one, so use `/v1/tasks/:id/events` for a per-run decision |

**Who sees nothing:** an agent not near a context ceiling. New telemetry fields, no behaviour change.

## What we could not verify, stated plainly

1. **Nothing has met a real model.** No key here. Boot, config derivation and the clamp were checked
   against a live daemon; every turn-level claim is unit-tested only.
2. **The digests cover engine-assembled input, not the serialized request body.** The provider
   reshapes both segments afterwards (Anthropic renames `parameters`→`input_schema` and lifts system
   into a content block; Responses flattens). A wire-format switch is reported by the existing
   `gen_ai.provider` and `fallback` attributes rather than by these. **The check worth running once:**
   capture a request with `DELTA_CAPTURE_CALLS=1` and confirm the captured system text and tool specs
   correspond to the emitted digests on the Anthropic path. A hash that stays still when it should
   move is worse than no hash.
3. **`self_bytes` disambiguates across runs, not within one.** `self` is a per-run snapshot, so a
   mid-run `remember` lands on disk and takes effect next run. Within a run it is constant by
   construction.
4. **S5's effect size is a guess.** We know it stops the re-fire loop; we do not know what that is
   worth on your workload. That is the number we would most like back.

## Two things we would ask you to look for

- **Did anything get slower?** S1 hashes the spine and tool specs every turn. Both are small and
  already walked by the token estimate, and it should not show up in `wall_ms` — but it is new work
  on the hot path and we would rather you told us than us assuming.
- **Did compaction get *worse* anywhere?** S5 should never raise the tail budget: the ceiling-derived
  value still wins whenever it is smaller. A lane with a tight ceiling and large tool schemas is the
  case to watch.

## What we are doing meanwhile

Not releasing. 0.2.12 is still uncut, and this branch sits behind it. The mechanism fix stays
unwritten until the reading above says what it is — the same reason you held your ask.
