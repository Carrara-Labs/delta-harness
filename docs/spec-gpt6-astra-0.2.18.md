# Spec: GPT-6 Astra support (0.2.18)

Status: DRAFT 2026-09-05, for codex review before implementation.

## Why

`gpt-6-astra` is served on both OpenAI surfaces the harness speaks (metered `api.openai.com`
and the ChatGPT/Codex subscription backend). Probed 2026-09-05 through the Codex backend: the
Responses wire the harness sends today (`store:false`, `prompt_cache_key`, `include`,
`reasoning.effort`, flat function tools) round-trips a tool call unchanged. The engine needs no
wire change. Three small gaps remain, all of them silent in production:

1. `pricing.ts` has no entry for the model, so `resolvePrice` returns null and every call meters
   $0: a lane's dollar cap never trips and cost telemetry reads zero.
2. The vision regex in `config.ts` (`gpt-5`) does not match `gpt-6*`, so image markers are sent as
   text placeholders to a model that reads images.
3. `reasoning.effort` `none` and `minimal` are rejected by the model (400 `unsupported_value`,
   "Supported values are: low, medium, high, xhigh, and max"). A 400 is not failover-worthy, so
   the lane fails every call. A boot warning names the misconfiguration before the first run.

Facts from the model page and probes that shape the numbers below: $10 in / $50 out / $1
cached read per 1M; cache writes 1.25x input (already applied by `computeCost` via
`cache_write_tokens`); requests above 272k input tokens bill 2x input and 1.5x output for the
whole request; context 1,050,000; max output 128,000. On the Codex backend
`prompt_cache_breakpoint` answers 400 "not supported on this model" and `prompt_cache_options`
400 "Unsupported parameter"; `text.verbosity`, `reasoning.summary`, `configuration_update` and
`include:["reasoning.encrypted_content"]` are accepted (medium effort returns a reasoning item
with `encrypted_content` and the message `phase: final_answer`).

## Changes

### S1. Price entry (`src/pricing.ts`)

```ts
// GPT-6 Astra — model page 2026-09-05. `window` is deliberately the 272k price-tier boundary,
// NOT the 1.05M context: above 272k input the WHOLE request bills 2x input / 1.5x output, and
// the engine's job is to compact before that cliff (derived ceiling 232k). A lane that wants the
// long context and accepts the price raises it via DELTA_MODEL_PRICES.
"gpt-6-astra": { in: 10, out: 50, cacheRead: 1, window: 272_000 },
```

Effects: `deriveContextCeiling(["gpt-6-astra"])` = 232,000; with an Opus 5 fallback in the
cascade the minimum still wins (209,000, unchanged for Steve). No alias entry: OpenAI documents
no `gpt-6` alias, and the prefix matcher already covers a dated snapshot
(`gpt-6-astra-2026-…`). The >272k tier itself stays unmodeled, as for 5.6.

### S2. Vision regex (`src/config.ts`)

`/claude|gpt-4o|gpt-4\.1|gpt-5|gpt-6|gemini|…/i`. One token added to the family heuristic.

### S3. Boot warning (`src/config.ts`, next to the existing effort warning)

```ts
if (reasoningEffort && /^(none|minimal)$/.test(reasoningEffort) && /(^|\/)gpt-6/i.test(models[0] ?? ""))
  console.error(`delta: DELTA_REASONING_EFFORT='${reasoningEffort}' is rejected by ${models[0]} (GPT-6 supports low, medium, high, xhigh, max) — every call will 400. Use 'low'.`);
```

Warn, never rewrite: the effort still passes through (the model is the authority, and the same
config may serve a fallback that accepts it). Primary model only, matching the vision heuristic.

### S4. Regression guard in tests (`test/provider.responses.test.ts`)

`gpt-6-astra` on `api.openai.com` gets no explicit cache marks: `modelHasExplicitCache` stays a
`gpt-5.6` prefix. Evidence gate, not version arithmetic: the Codex backend rejects the field on
this model and `api.openai.com` is unverified for it. Implicit caching is what the model runs.

### Tests (`bun test`)

- pricing: `gpt-6-astra`, `openai/gpt-6-astra`, `gpt-6-astra-2026-09-01` resolve to the same
  entry including `window`; `computeCost` bills cache writes at 1.25x of $10; `gpt-6` alone is
  unpriced (null, no accidental alias).
- config: `vision` true for `gpt-6-astra` and `openai/gpt-6-astra`; `DELTA_VISION=0` still wins;
  `gpt-5.6-sol` unchanged.
- config: warning emitted for `gpt-6-astra` + `none`, for `minimal`; not for `gpt-6-astra` + `low`;
  not for `gpt-5.6-sol` + `none` (that model accepts it); effort still present on the config.
- provider: S4 above; existing 5.6 mark tests untouched.

### Docs

CHANGELOG `[Unreleased]`: one entry. `site/public/guide.md` OpenAI section: one sentence naming
GPT-6 Astra as supported (implicit caching, efforts low..max). Site changelog at release time.

## Explicitly not changing

- `KNOWN_EFFORTS` (already lists `max`; `none`/`minimal` remain valid for 5.6).
- `acceptsReasoningReplay` and the other `openai.com` allowlists: enabling replay on
  `chatgpt.com` is a separate slice gated on the Delos probe battery, not this one.
- `modelHasExplicitCache`: stays 5.6-only (S4).
- No warning for a Chat Completions wire on GPT-6 (tool calling requires Responses on this model):
  no lane runs that shape, and the provider's 4xx is explicit at call time.
- `configuration_update`, `async: true` tools, WebSocket steering, server-side compaction
  (`context_management`), pro mode: opt-in features the engine does not need.
- Bundle prompting (Astra asks more clarifying questions, pauses on conflicting skill text,
  prefers lists): markdown owns meaning; handled per lane at migration, not in the engine.

## Live test plan (after unit tests + codex diff review)

Same daemon build, three lanes, the same 3-turn tool task each (a search-then-summarize prompt
through `POST /v1/responses` with `previous_response_id`), then `/v1/status`, cost > 0 in the
`model.call` events, and a second run with a second identical prompt to see `cached_tokens`:

1. **Opus 5, Anthropic native**: control for "nothing else moved" (cost, vision, effort map).
2. **gpt-6-astra on the Codex subscription** (local daemon, broker via an ssh tunnel to Delos,
   `DELTA_REASONING_EFFORT=low`): tool round-trip, cost metered at the new prices, `vision:true`
   on status, no marks on the wire, boot warning absent. Then the same lane with `none` to see
   the warning and the 400.
3. **gpt-6-astra on api.openai.com** (metered key): same as 2, plus `cache_write_tokens` billed.
4. Regression twin: lane 2 with `gpt-5.6-sol` on the Codex backend (zero marks there for both
   models, host gate) to confirm its refreshed prices; the positive 5.6 mark control lives on
   `api.openai.com` (unit-tested; live needs the metered key).

## Codex review, round 1 (spec), and what changed

Seven findings, two P1. Resolution, in the order codex gave them:

1. **[P1] `window: 272_000` clamps an operator override** (`maxSafeCeiling`): adding Astra to a
   cascade with `DELTA_COMPACT_AT_TOKENS=300000` would silently cut it to 232k. Accepted: no
   `window` on the entry. The 120k default applies to an Astra-only lane; a lane that wants more
   sets it through `DELTA_MODEL_PRICES`. Test pins both `deriveContextCeiling` (null) and
   `maxSafeCeiling` beside Opus 5 (209k, unchanged).
2. **[P1] >272k tier unmodeled.** Declined for this slice, documented. Without a window the
   ceiling is 120k and the estimator over-counts by about 1.7×, so a request above 272k only
   happens on an irreducible overflow, which the engine already logs. Same stance as 5.6.
3. **[P2] Twin lane on the Codex backend cannot show 5.6 marks** (host gate). Correct; the live
   plan now expects zero marks on `chatgpt.com` for both models and keeps the positive 5.6 mark
   control on `api.openai.com` (unit-tested; live needs a metered key).
4. **[P2] Mixed-cascade ceiling tests.** Moot without a window; the pricing test above covers
   the one case that matters (Astra never lowers a neighbour's ceiling).
5. **[P2] Sol price stale.** Verified on the live pricing page 2026-09-05: sol is $4 / $20 /
   $0.40 (table had $5 / $30 / $0.50); terra and luna unchanged. Refreshed, with its tests.
6. **[P2] Warn for Astra anywhere in the cascade, not only the primary.** Accepted: the check
   runs over every provider's model list after the cascade is built; tests cover a
   `DELTA_MODEL_FALLBACKS` member and a separate `DELTA_PROVIDERS` entry.
7. **[P2] Prove image delivery.** The serializer test for `input_image` on the Responses wire
   is model-agnostic and already exists; the live plan adds an image-marker turn on the Astra
   lane (a PNG in the workspace read through the file tool, then "what colour is it").

## Live results (2026-09-05)

| lane | where | result |
| --- | --- | --- |
| Opus 5, Anthropic native | local daemon | image "red", threaded recall, cost metered; nothing moved |
| gpt-6-astra, Codex subscription, low | local daemon, broker via ssh tunnel to Delos | image "red" (input_image delivered), web search found 0.2.17, recall; $0.075 over 6 calls at the new prices; no boot warning |
| gpt-5.6-sol twin, Codex subscription | local daemon | same task; cost at the refreshed $4/$20/$0.40 |
| gpt-6-astra, effort none | local daemon | boot warning fires; every call 400 `unsupported_value`, error-as-value, no failover |
| gpt-6-astra, api.openai.com, low | bench-sol-a, engineer, rc1 image from 4db400e | 5 turns, 22 s, correct answer; cost reconciles to the cent once cache writes are counted (turn 1: 16,738 tokens written at 12.5 + 384 out at 50 = $0.2284); cached_tokens climb turn over turn (implicit caching); healthz `build` populated |

One gap surfaced by the metered lane and fixed on the branch: the cache-write count fed cost but
was never exported, so `gen_ai.usage.cache_write_tokens` now rides `model.call`.

**Metered image probe (engineer, bench-sol-a, 4 attempts, not exercised).** On the Quick Search
bundle gpt-6-astra refused to call `read_file` under every framing, including a direct
`/v1/responses` turn with an operator preamble ("my governing instructions permit only Aperture
tools with a dispatched run token"). No harness rejection: the model reads the POLICY.md line
"act ONLY through the aperture MCP tools" as a hard boundary, where Sol and Opus read the playbook
through `read_file` on the same bundle. This is the guide's warning in the wild (Astra pauses on
instruction text where earlier models assumed). Image delivery stands on the subscription-backend
result (same serializer); the metered lane stands for cost and cache. For any bundle moving to
Astra: make instruction precedence explicit, and expect refusals as an outcome class.

## Battery finding and fix (2026-09-05, same day)

Two astra-low runs in, cost ran 3× Sol with the hit rate decaying 34% → 18% and the cached prefix
fixed while requests grew. Cause: S4 above was wrong for `api.openai.com`. The evidence gate was
taken from the Codex backend only; without explicit marks OpenAI's implicit mode writes ONE
breakpoint per request at the end of the latest user message, which is the ephemeral tail the
engine re-renders every turn (context clock, task instructions, retrieval, plan), so every turn
writes the history at 1.25× and reads only the oldest stable boundary (the smoke's fixed 12,643).
Sol never hit this because its rolling marks are placed before the ephemeral tail (M2, 0.2.16).
Probe from inside bench-sol-a: `api.openai.com` accepts `prompt_cache_breakpoint` on Astra
(200). Fix: `modelHasExplicitCache` takes `gpt-6`; the host gate still keeps the Codex backend
off. Lesson: a model gate needs a probe per host, not per model.

## rc2 result and the real defect (2026-09-05, evening)

rc2 (70dcbd8) on both bench lanes: the stable mark reads, the rolling marks never do. Smoke:
cached_tokens pinned at 16,695 (system + dispatch message) from turn 2 on, written = input minus
the pin every turn; S1 rerun $2.73 vs rc1 $2.75. Engineer's pre-wire capture (DELTA_CAPTURE_CALLS)
showed the message prefix byte-identical turn to turn (only the 130-byte "# Context ... now"
ephemeral block differs), so the misses were placement. Cause, in the renderer since 0.2.16:
`markResponsesCache` accepted only user messages with a trailing `input_text` as carriers, and
`function_call_output` rendered as a plain string; an agentic run is one user message then tool
calls, so the rolling marks had no carrier and vanished silently. The unit fixture interleaved a
user follow-up after every tool result, which is why the tests never saw it (the proxy, again).
Fix (f80be72 + bb8af91): under the gate every tool output renders as an `input_text` block array
(byte-stable as marks roll) and tool outputs carry the rolling marks; the caching guide's own
multi-turn agent example is this shape ("a breakpoint added after each tool result"), and
api.openai.com accepted it for Astra by probe (200). This fixes Sol on api.openai.com too.
Gate for rc3: turn 3 cached above the pin, last-turn shortfall under 12k on both lanes.
