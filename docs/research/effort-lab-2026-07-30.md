# Effort lab, 2026-07-30 — findings and operator guidance

One-day registered experiment on a production-identical retrieval agent (Aperture
quick-search, Opus 5, prod-identical Fly lane, engine 0.2.5 + the two lab commits now
graduated into 0.2.6). Four sequential arms × 12 fixed queries in 4 difficulty tiers,
plus revisions and chat follow-ups; 72/72 runs succeeded. Two blind graders, pre-registered
hypotheses and decision rules, and a same-config repeat arm as the drift control.
Full data, rig, and peer-review brief live with the operator (not in this repo — the raw
material contains real-people data). Independent peer review of the findings is in flight;
treat the recommendation table as provisional until it lands.

## What was measured (`DELTA_REASONING_EFFORT`, Opus 5, adaptive thinking)

| Arm | Fresh p50 | Fresh p90 | Arm cost | Output tokens | Blind quality (of 10) |
| --- | --- | --- | --- | --- | --- |
| high | 515s | 1091s | $42.05 | 598k | 9.07 |
| medium | 484s | 566s | $47.29* | 468k | 8.88 |
| low | 240s | 377s | $20.03 | 302k | 8.60 |
| high repeat (drift control) | 620s | 989s | $43.5 | +35% vs morning | 9.0 |

\* medium's cost was materially inflated by the self-write refusal storm below (~$10 of waste).

Registered reading, numbers only:

- **low**: -56% typical latency, -52% cost vs high; quality 0.47 lower, inside the
  pre-registered 0.75 non-inferiority margin. Both graders produced the same ordering
  (high > medium > low).
- **medium**: roughly flat p50 vs high but halves the p90 tail.
- **high** was the only arm that triggered org-wide rate limiting at 4-concurrent
  (267 retries; 88 calls — 27% of the arm's turns — silently served by the fallback
  model). That silence is why 0.2.6 adds the `model.fallback` event.
- The same-config repeat came in 25% SLOWER than the morning high despite the warmest
  tool cache: same-config day variance is ±25% on p50, so read end-to-end deltas as
  directional and demand effects well above that band (the low-vs-high -56% is).

Effort is a deploy-time knob (env), one value per agent; request metadata can override
per run. It applies to the main model only. Different agent archetypes can rationally sit
at different points on this curve — a retrieval agent you iterate on values latency; an
accuracy-first agent may pay the high-effort tail for the quality ceiling.

## The self-write refusal storm (and the wrong first diagnosis)

Fleet telemetry showed ~83% of `remember` calls failing instantly, across every
workspace. First diagnosis — "the tool is policy-refused because `DELTA_ALLOW_SELF_WRITE`
was never granted" — was **wrong**: under a `work` profile (`allowed: "*"`) self-write is
always granted; `DELTA_ALLOW_SELF_WRITE` only widens *finite* profiles (see
`grantSelfWrite`). The real mechanism:

- The deployment seeded a 3176-byte `DELTA.md` under the default 3200-byte cap
  (`DELTA_SELF_MAX_TOKENS=800` × 4). **24 bytes of headroom to learn anything.**
- Nearly every `remember` bounced off the size guard (or the concurrent-run conflict
  guard); the agent ground retries at full-context cost after finishing its task; the
  occasional success was the model cannibalizing its own seed.

Operator rules that fall out of this:

1. **Seed `DELTA.md` at no more than half the self-file cap.** The other half is the
   agent's room to learn. Check: `wc -c DELTA.md` vs `DELTA_SELF_MAX_TOKENS × 4`.
2. `DELTA_ALLOW_SELF_WRITE` matters only when your profile is a finite tool list;
   `work` grants self-write regardless.
3. The misdiagnosis happened because telemetry said only `is_error: true` — 0.2.6 adds
   `error.class` on failed `tool.result` events (`self_cap`, `self_conflict`,
   `self_spine_echo`, `self_empty`, `self_unavailable`, `self_protected`, `timeout`,
   `transient`, `categorical`) so refusal storms are classifiable from a single query:

   ```sql
   select attributes->>'error.class', count(*) from agent_events
   where event_name = 'tool.result' and (attributes->>'is_error')::boolean
   group by 1;
   ```

The existing categorical-failure breaker (0.2.4 A4) could not see this storm: the size-cap
message embeds a changing byte count, so no two failures compare equal. Whether the breaker
should learn class-based aggregation is a 0.2.7 question — decide it from `error.class`
data, not another anecdote.

## Fast mode (`DELTA_SPEED=fast`) — wired, not yet exercised

The 0.2.6 wire ships inert-by-default: set `DELTA_SPEED=fast` and calls to models on the
hard allowlist (Opus 5, Opus 4.8) carry `speed: "fast"` + the `fast-mode-2026-02-01` beta;
the served speed comes back on `model.call` telemetry. Facts from the official docs, not
yet validated first-party:

- Up to 2.5× output tokens/sec. **TTFT is NOT improved.** Effort and speed are orthogonal:
  effort ≈ how many tokens get generated, fast ≈ how fast each one streams.
- 2× price ($10/$50 per MTok on Opus 5); cache read 0.1× ($1); the 1.25× cache-write
  multiplier stacks unchanged. Override metering via
  `DELTA_MODEL_PRICES={"claude-opus-5":{"in":10,"out":50,"cacheRead":1}}` when running fast.
- Access is org-gated (research preview); a lane on an unallocated org gets normal-speed
  serving. Probe: send a small request with the beta header and check `usage.speed` in
  `message_start`.
- Switching speed on one conversation invalidates its prompt cache — don't flip it
  mid-thread.

Projection from this lab's token profile (NOT a measurement): low effort + fast on the
same battery would put typical fresh runs around 1.8-2.5 min at roughly $2/run. A second
registered battery (multi-lane, query-interleaved crossover) is the planned confirmation
once org access lands.
