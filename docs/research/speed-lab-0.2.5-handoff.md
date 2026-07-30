# 0.2.5 speed-lab handoff - for the delta-harness engineer

*Written 2026-07-30 by the Aperture speed-lab session (overnight run, Nic's brief).
You are the release owner. Everything below exists so you can review this batch
against the harness philosophy, satisfy yourself it is beneficial and non-breaking,
verify scale-to-zero survives untouched, and - if aligned - ship it as 0.2.5.*

## 0. Fetch the work

```
cd ~/delta-harness
git fetch --all
git checkout speedlab/0.2.5        # local branch, based on main @ 005fe22
git log --oneline main..speedlab/0.2.5
```

Ten commits, in order: the stall batch (`9638387`), the codex hardening pass
(`532c407`), version bump to 0.2.5 (`2e8e895`), the implicit wire-staleness guard
(`76bb74d`), CHANGELOG (`cd4423a`), guide + hosting docs (`89c2db7`, plus
`DELTA_CACHE_TTL` docs), and the opt-in cache-retention knob. Diff surface:
`src/provider.ts`, `src/config.ts`, `src/run.ts`, `src/index.ts`, two test files,
CHANGELOG, `site/public/guide.md`, `docs/hosting.md`. No schema migrations, no
seam changes, no new required env.

A container image of exactly this branch is already built and soak-proven:
`registry.fly.io/aperture-qs-3498560efa0d:speedlab-rc3` (Fly-registry scoped to the
lab app; you will publish the real `ghcr.io/carrara-labs/delta-harness:0.2.5` via the
normal tag flow).

## 1. Why this research happened - problem and hypothesis

**Problem.** Aperture's quick search (a Delta agent on a scale-to-zero Fly lane,
0.2.4) sometimes sat visibly dead for minutes after a user asked a question. On
2026-07-29 the engine telemetry showed **6 of 18 prod runs losing 250-300 seconds
on turn 1**: `turn.start` fired instantly, the first `model.call` completed ~5
minutes later carrying only 4-12s of real provider latency. Always turn 1, always
after >5 min of lane idle, never mid-run (353/360 other calls < 1s pre-call
overhead). One 254s hit on the intake lane proved it engine-wide, not
product-specific. During the stall the daemon logged NOTHING (only successful
calls print) and emitted NO events - the host UI shimmered a dishonest
"Reading your request…" for five minutes.

**Hypothesis (proven).** After a Fly suspend/resume, the NAT path behind the
fetch pool's idle keep-alive sockets is gone. The first provider call rides a
corpse socket and hangs in connect/first-header - the one phase the per-chunk
idle watchdog cannot see (it arms only once a body stream exists), bounded by
nothing but the 600s absolute cap. Retries burned invisibly until a fresh socket
happened to win.

**The kill experiment.** On a dedicated lab lane: suspend the machine, hold N
minutes, resume-and-dispatch a tiny task, and 15s later fire a second task that
forces a fresh socket. At a 13-minute hold: **first task stalled 251s, the
fresh-socket probe answered in 1ms.** Holds <= 6 min were always clean - the
boundary is NAT expiry. Data: `stall-soak-results.jsonl` in the archive.

## 2. What 0.2.5 does about it

Three layers, plus visibility, plus one opt-in knob:

1. **First-byte deadline** - `firstByteMs` per provider, `DELTA_FIRST_BYTE_MS`
   env, default 30s, `0` disables. Bounds connect + time-to-first-header through
   the SAME watchdog AbortController (armed before fetch, disarmed the moment it
   resolves; `sseLines` takes over from the first chunk). Typed abort reason so
   the error names the real deadline; stays RETRIABLE; independent of
   `DELTA_STREAM_IDLE_MS` (idle 0 does not disable it - codex insisted, rightly).
2. **Wire-suspect windows** - the hard guarantee. Two triggers, one mechanism:
   explicit (heartbeat wall-clock-gap resume detection in index.ts, single-flight
   with 60s cooldown) and implicit (any call after >5 min without a successful
   fetch - the resumed task's first call can beat the heartbeat tick by up to
   10s, so the provider guards itself). A suspect call sends `keepalive: false`:
   fresh socket in, none pooled after. Verified empirically on Bun 1.3.13 as a
   true per-request pool bypass (socket identity via server-side remote port).
   Cost: one TLS handshake on the first call after long idle. That is the whole
   cost.
3. **`warmupWire`** - best-effort preconnect at boot + on resume detection: 3s
   HEAD probes per provider origin, stops after two fast successes or 8 probes.
   Pays DNS+TLS off the turn path and opportunistically drains corpses. Never
   throws, never rejects (guarded URL parse - an invalid configured baseUrl
   crashed the daemon in the first draft; codex caught it, reproduced, fixed),
   never on a turn's critical path.
4. **Retry visibility, end to end** - `onRetry` observer on ChatRequest fires at
   every real cascade TRANSITION (kind `retry` | `reauth` | `next_model` |
   `next_provider`; terminal failures are NOT reported as retries; `chatVia` owns
   the next-provider report because only it knows one exists; observer calls are
   try/caught). run.ts persists these as `model.retry` task events (stable
   `error.type` class + sanitized 160-char message - no high-cardinality
   provider text in telemetry) and stamps `wall_ms` + `retries` on `model.call`
   so `wall_ms - latency_ms` exposes any future invisible stall in one SQL
   query. One console line per failed attempt - a retry storm can never be
   silent again.
5. **`DELTA_CACHE_TTL=1h`** (opt-in, default off, wire-identical when unset -
   tested): 1h Anthropic cache retention on the STABLE prefix breakpoint only
   (system spine + tools); rolling tail keeps default TTL. For a lane serving
   several runs an hour the ~13k-token prefix stays a cache READ across the
   5-minute TTL gaps. 1h writes bill 2x base vs 1.25x - hence opt-in. Same lever
   Pi ships (`PI_CACHE_RETENTION`).

## 3. What was tested, how, and the results

All testing ran on REAL infrastructure: prod aperture.is (app half), a dedicated
`speed-lab` workspace + Fly lane (`aperture-qs-3498560efa0d`, machine
`8747430b6d7118`) provisioned with the production fleet tooling, real Fiber data,
real Opus 5, engine telemetry flowing to the prod collector. **116 engine runs,
101 app-level quick-search runs, 100% success, $244.82.**

| Test | Method | Result |
|---|---|---|
| Unit + integration | `bun test` on the branch | 600 pass, 0 fail (incl. new: first-byte bounds a never-responding socket; idle-0 does not disable first-byte; retry transitions incl. throwing-observer immunity; warmup vs dead origins; cache-TTL wire shapes incl. unset = identical) |
| Stall reproduction (0.2.4) | suspend-hold-resume cycles + fresh-socket discriminator | clean <= 6 min; 251s stall at 13 min vs 1ms probe - root cause nailed |
| Stall kill (0.2.5) | IDENTICAL cycles on the rc image | 2ms stall at the 13-min hold; logs show `heartbeat gap 798s -> refreshing provider wire`, warmup probes 30-51ms |
| A/B battery | 10 fresh searches per arm (5 cold / 5 warm, same prompts) through the real app, per-run waterfalls stitched from app DB + task events | baseline: cold first-tool p90 **298s** (1 stall in 10); 0.2.5: p90 **5.7s**, zero stalls, healthy-path medians unchanged (no regression) |
| Volume | 16 waves x 3 parallel searches | 48/48 succeeded, worst turn-1 pre-call gap across ALL 99 first-turn calls on 0.2.5: **9ms** |
| Follow-ups + revisions | chat follow-ups, dock revise-artifact (xhigh), incl. one organic COLD follow-up after a 28-min suspend | work-start 13.4s cold, thread memory intact, zero stale-head/reset events; 27 continuation runs, all succeeded |
| Load management | 3 rounds of 10 SIMULTANEOUS mixed jobs; round 1 cap 8, round 2 cap 20 on shared-1x/512MB, round 3 cap 20 on shared-2x/1GB | 30/30 succeeded; engine overhead 4-6ms max per call under load; zero OOM / event-loop stalls / errors; per-output-token 17/14/13 ms - **the VM is not the constraint**; queueing at cap 8 was honest and drained cleanly |
| Quality gate | codex, blind, fixed rubric, both A/B arms | 7.15 baseline vs 7.95 on 0.2.5 - preserved within noise, no new failure modes |
| Revert drill | rc3 -> published 0.2.4 image -> rc3, healthz + smoke each way, same volume/DB | PASSED both directions (no migrations in this batch, downgrade-safe) |
| Codex reviews | 2 adversarial rounds + a release gate | 2 P1s found and fixed (warmupWire unhandled rejection; onRetry transition semantics); release gate: **GO** |

## 4. Where the data lives

- **Raw datasets + the lab rig**: `~/ai-recruiter/archive/speed-lab-2026-07-30/`
  (local-only archive dir, per house rule). Contents: per-run battery JSONLs +
  stitched waterfalls (`battery-*.jsonl`, `*-waterfalls.json`), both soak result
  files (`stall-soak-results.jsonl` = 0.2.4, `stall-soak-v025.jsonl` = 0.2.5),
  the three load curves (`parallel*-curve.json`), quality material
  (`quality-material.json` - contains real-people names, keep local), and
  `rig/` with every driver script (lab.ts, stitch.ts, stall-soak.ts,
  parallel-mix.ts, set-env.ts, revert-drill.ts, ...) so any experiment is
  re-runnable in minutes. `report.html` is the full visual report.
- **Engine telemetry (queryable forever)**: prod `agent_events`,
  `workspace_slug = 'speed-lab'`. The money query - invisible stall census:
  ```sql
  select count(*), max((attributes->>'wall_ms')::numeric - (attributes->>'latency_ms')::numeric)
  from agent_events
  where event_name = 'model.call' and workspace_slug = 'speed-lab' and turn = 1;
  ```
- **The lab lane itself** (kept as a canary bench): app `aperture-qs-3498560efa0d`,
  machine `8747430b6d7118`, currently SUSPENDED on rc3 with
  `DELTA_MAX_CONCURRENCY=20`, guest shared-1x/512MB (the recommended prod shape).
  Wake it and re-run anything via the rig.

## 5. Your review checklist - philosophy, benefit, non-breaking

**Philosophy fit** (lean, error-as-value, never crash, budgets-not-timers):
- Net diff is ~350 lines of src across 4 files, zero new dependencies, zero new
  background loops (warmup piggybacks the EXISTING lease heartbeat; boot warmup
  is one fire-and-forget call).
- Everything fails open: warmup never rejects, observer callbacks are guarded,
  the first-byte deadline produces a retriable error-as-value, wire-suspect just
  changes a fetch option.
- Scope was CUT by measurement, not added by ambition: parallel fresh-run prep
  and spine caching were dropped after the lab measured prep at 20-60ms - worth
  checking you agree those stay out.
- Judgment calls to scrutinize: DEFAULT_FIRST_BYTE_MS=30s (generous vs Opus
  cache-write TTFB, tight vs the 600s cap), WIRE_STALE_MS=5min (matches
  Anthropic cache TTL + observed NAT boundary), suspect window 120s, warmup
  max 8 probes / 2-fast-successes stop.

**Non-breaking:**
- Wire-identical for every existing deployment: all new envs default sensibly,
  `DELTA_CACHE_TTL` unset produces byte-identical requests (tested), model.retry
  is an additive event name (collector schemas are loose text), `model.call`
  attributes only GAIN fields.
- 0.2.4 bundles run unmodified; the image swap drill passed BOTH directions on a
  live volume.
- One behavior change worth blessing: failed provider attempts now log one
  console line each (they were silent). Cardinality is bounded (per attempt, not
  per token) and messages are whitespace-collapsed + truncated.

**Scale-to-zero stays sacred** (the dead-cheap-agents contract):
- `/v1/busy` untouched; `restVerb` semantics unchanged (>= 0.2.4 suspends).
- NOTHING in this batch runs while suspended or prevents idleness: no keep-alive
  pings, no new timers beyond the pre-existing heartbeat, warmup fires once at
  boot/resume and completes in < ~6s worst case.
- The suspect window's `keepalive: false` CLOSES sockets rather than holding
  them - it makes the daemon MORE suspend-friendly, not less.
- Proven empirically: the lab machine suspend-resumed dozens of times across
  the night (soaks, batteries, volume waves) with the app's normal busy-gated
  rest flow; every resume was ~1s and every first call clean. hosting.md gained
  a paragraph documenting the self-healing wire so hosts change nothing.
- Cost check: a suspended 0.2.5 lane costs exactly what a suspended 0.2.4 lane
  costs. The only new marginal cost is one TLS handshake after long idle, and
  the (opt-in, off) 1h cache premium.

## 6. If aligned - ship it

1. Merge `speedlab/0.2.5` to `main` (version.ts + package.json already say 0.2.5,
   CHANGELOG written, guide + hosting docs updated).
2. Release ceremony per the runbook: push tag `v0.2.5` (auto-publishes npm +
   ghcr), then the site guide/changelog deploy.
3. Tell the consumers: Aperture's fleet bump is staged on their side - manifests
   to `:0.2.5` PLUS `DELTA_MAX_CONCURRENCY: "20"` (load-proven headroom; cap 8's
   queueing was honest but 20 removes the wait at current scale), keep
   shared-1x/512MB guests (the load rounds proved bigger VMs buy ~7% per token -
   noise). Their bump sequence: Carrara canary first, soak, then anthropic
   lanes + intake, using their proven busy-gate + image-update + healthz-verify
   flow. Rollback = the drilled image swap to 0.2.4.
4. Backlog seeds from the competitor teardown (NOT this release): long-vs-short
   429 window split for smarter failover (OpenClaw), a CI cache-hit-rate floor
   (OpenClaw), coarse pre-first-token lifecycle states are already covered by
   our task events.

Questions, pushback, or a different call on any default: the full visual report
with every table and curve is `report.html` in the archive dir, and every number
in it regenerates from the rig scripts against the lab lane.
