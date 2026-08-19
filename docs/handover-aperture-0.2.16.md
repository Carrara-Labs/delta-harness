# To the Aperture engineer: 0.2.16 — the OpenAI-native release, and how to configure QS on it

2026-08-19, from the Delta Harness maintainer. `@carrara-labs/delta-harness@0.2.16` is on npm
(CI-built, provenance-signed, tag `v0.2.16`). This is the release that makes the OpenAI API a
first-class lane, and it exists for one reason: the Quick Search demo on `gpt-5.6-sol`. Every
capability below was proven on the live wire before shipping — all three 5.6 models, seven
configurations, real tool chains (full matrix: `docs/harness-0.2.16-plan.md`; changelog §0.2.16).

**The one-sentence risk statement:** on your current Claude lanes this release is a no-op —
the Anthropic and OpenRouter wires emit byte-identical requests, pinned by full-body-equality
tests — so it can roll everywhere without waiting for the OpenAI work.

## 1. What shipped, in QS terms

| change | what it means for a QS run on gpt-5.6 |
|---|---|
| **Reasoning carry** | The model's encrypted reasoning items now survive turn boundaries and replay per OpenAI's own guidance. QS's exact shape — ~19 calls, long consecutive tool chains — is the documented beneficiary: the model keeps its working between steps instead of re-deriving intent from bare actions. |
| **`phase` carry** | GPT-5.5+ marks messages `intermediate`/`commentary`/`final_answer`; dropping it (as 0.2.15 did) makes the model treat progress updates as final answers. For QS that is the premature-termination failure mode, now closed. |
| **Explicit cache breakpoints** | The same placement discipline your Claude lanes have: one stable mark (instructions + tools + first user message) + two rolling, alongside the provider's implicit mark. Measured: turn 1 writes the prefix, turn 2 reads 100% of it back — a consistent **~7.7× cost drop on warm turns**, every 5.6 model. |
| **True 5.6 pricing** | sol/terra/luna real prices + `cache_write_tokens` metering (writes bill 1.25× on 5.6). ⚠️ See W1 below — your cost dashboards will move. |
| **`DELTA_REASONING_SUMMARY=auto`** | The backend streams reasoning summaries (observability into *why* the model acted — 469 chars observed live on a sol high-effort run). Worth having on for the bench and the demo debrief. |
| **Unmapped-control reporting** | Any knob the lane's wire/host can't render is named at boot and in `/v1/status → model.controls.unmapped`. Read each lane's first boot line, same drill as 0.2.15's tools line. |
| **Visible child failures** | A research/eval child's provider error now emits `model.call` with `is_error` + the classified enum, plus one stderr line — the mechanism that let 24/24 child failures hide in clean logs is closed. Baseline it in telemetry. |

## 2. The QS-on-OpenAI lane config — the API-key path, not codex sign-in

The demo route is the **metered API**. The codex sign-in backend receives none of the new
capabilities (its surface is unprobed; it gets byte-identical 0.2.15 requests), so the metered
path is not just more reliable — it is the only path with the reasoning and caching wins.

```dotenv
# ── model ────────────────────────────────────────────────────────────────────
MODEL_API=responses
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=<metered OpenAI key>
DELTA_MODEL_PRIMARY=gpt-5.6-sol
# terra/luna are the same wire at lower cost if a tier doesn't need sol:
# DELTA_MODEL_FALLBACKS=gpt-5.6-terra

# ── utility lane (compaction, reflection, eval_n) ───────────────────────────
# Keep it on the same wire; luna is the haiku-equivalent of this family.
DELTA_UTILITY_MODEL=gpt-5.6-luna

# ── reasoning ────────────────────────────────────────────────────────────────
# OpenAI's own latency guidance for 5.6: medium balanced, low for latency-sensitive.
# QS simple tier: low. Hard tier: medium. Do NOT set high for the demo untested.
DELTA_REASONING_EFFORT=low
# Summaries for the debrief — observability only, never blocks a turn:
DELTA_REASONING_SUMMARY=auto

# ── caching ──────────────────────────────────────────────────────────────────
# NOTHING to set. Explicit breakpoints are automatic on gpt-5.6+ via this host;
# prompt_cache_key is sent per session automatically. Do NOT carry these over:
# DELTA_CACHE_TTL=1h   ← Anthropic-only; unmapped on this wire (boot will say so)
# DELTA_SPEED=fast     ← Anthropic-only; unmapped on this wire (boot will say so)

# ── output ───────────────────────────────────────────────────────────────────
# DELTA_TEXT_VERBOSITY=low is a plausible latency/output win for QS, but per your
# own findings rule (§4.4): do not set it for the demo untested. Bench it first.
```

Everything else (budgets, profile, vocab, DELTA.md/POLICY.md) is unchanged from your Claude
lanes — that is the point of the harness.

## 3. First-boot verification (five minutes, per lane)

1. **Boot line**: expect nothing unmapped with the config above. If you carried
   `DELTA_CACHE_TTL`/`DELTA_SPEED` over, expect exactly:
   `delta: not mapped on the 'responses' wire: …` — remove them and the line goes away.
2. **`GET /v1/status`**: `model.controls` shows your knobs and `unmapped: []`;
   `tools` shows the 0.2.15 three-state report.
3. **One two-turn tool task**, then check telemetry/model.call: `cache_write_tokens` > 0 on
   turn 1, `cached_tokens` ≈ the full prefix on turn 2, and turn-2 `cost_usd` roughly 7× lower.
4. **Reasoning carry sanity**: on a task that requires planning (hard tier), the assistant rows
   in the DB carry `reasoningItems`; on trivial one-hop tasks sol legitimately emits none
   (adaptive reasoning, reasoning_tokens=0) — that is the model's choice, not a capture failure.

## 4. What to measure, 0.2.15 → 0.2.16, on the OpenAI bench lane

| metric | 0.2.16 expected | how |
|---|---|---|
| warm-turn cost | ~7× drop vs cold (we measured 7.7× on all three models) | `cost_usd` per model.call, turn 1 vs 2+ |
| cache visibility | `cache_write_tokens` + `cached_tokens` both nonzero and consistent | usage details on model.call |
| tool-chain coherence (hard tier) | fewer re-derivations/retries mid-chain — the reasoning-carry effect | your artifact-quality check + calls per completed search |
| premature finals | intermediate updates no longer end runs — the phase effect | count runs ending on an intermediate-shaped answer |
| child failures | zero invisible — any child provider error now appears in telemetry | `model.call` where `is_error=true`, `tier=utility` |
| **cost baseline (W1)** | sol lanes ~4× HIGHER reported cost | see below — correction, not regression |

A falsified expectation is as valuable as a confirmed one — same standard as your last three
reports.

## 5. Warnings

- **W1 — the cost numbers jump, and that is the fix.** 0.2.15 priced `gpt-5.6-sol` off the old
  `gpt-5` entry ($1.25/$10 vs the real $5/$30) and never billed cache writes. Any sol lane's
  reported `cost_usd` will rise ~4× on upgrade day with identical behavior. Annotate dashboards
  before rolling or someone will read it as a regression. (Terra/luna were never mispriced —
  they had no prefix match — so only sol moves.)
- **W2 — adaptive reasoning means empty carries are normal.** Sol at low/medium effort on easy
  tasks emits no reasoning items (0 reasoning tokens on the wire). Don't write a check that
  demands reasoningItems on every turn; check the hard tier.
- **W3 — compaction strips carried reasoning from retained rows, by design.** Reasoning
  generated against a history compaction rewrote is not replayed (vendor-undefined). Post-
  compaction turns start a fresh reasoning epoch. If your W1-shape (continuation-session)
  scenario shows degradation specifically after compactions on the OpenAI lane, that is exactly
  the data we asked for — report it, don't tune around it.
- **W4 — long-context pricing is not modeled.** Prompts >272K input bill 2×/1.5× on 5.6; the
  meter uses base rates. QS compaction ceilings keep you far from this band, but a lane that
  raises `DELTA_COMPACT_AT_TOKENS` into it will under-report cost.
- **W5 — effort values are not Claude-equivalent.** 5.6 supports none/low/medium/high/xhigh/max
  with model-dependent defaults; your Claude-tuned tier→effort mapping needs its own bench pass,
  not a copy.
- **W6 — new telemetry shape.** `model.call` can now arrive with `is_error=true` and no usage
  (failed utility/child calls). If your ingest assumes usage fields exist, patch it first.

## 6. Sequencing

1. Finish whatever 0.2.15 battery is in flight (unchanged rule: never upgrade mid-battery).
2. Roll 0.2.16 to the Claude lanes whenever convenient — byte-identical wire, zero risk, and
   you get C1/C2 and the controls block everywhere.
3. Stand up the OpenAI bench lane with §2's config, run §3, then the pinned three-tier battery.
4. Its results steer the demo config (effort per tier, verbosity on/off) — and only then does
   the client-visible OpenAI workspace get created, on the stabilized configuration.

## 7. What comes back to me

1. First-boot lines + `/v1/status` controls/tools per lane.
2. The three-tier battery on the OpenAI bench lane, same report shape as always.
3. Cache warmth (`cache_write_tokens`/`cached_tokens`/shortfall) and cost per tier.
4. Anything W3-shaped (post-compaction degradation on the OpenAI lane) — it gates a 0.2.17
   candidate (`reasoning.context:"current_turn"` after compaction).
5. Still open: the 0.2.15 acceptance rerun results and your `tool.rejected` baselines.

— Delta Harness
