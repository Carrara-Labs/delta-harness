# Spec: the OpenAI Responses wire as a first-class citizen

Status: **audit + spec candidates, 2026-08-19.** Written ahead of a Quick Search demo to an OpenAI
co-founder, where the lane will run `gpt-5.6-sol`. Sources: `src/provider.ts` at `da6622b`, the
OpenAI latest-model and prompt-caching guides (fetched 2026-08-19), and the reasoning guide.
Related: `spec-codex-output-cap.md` (D-12), `aperture-qs-tuning-findings.md`.

## 0. The verdict in one paragraph

The Responses wire **works** — Delos has run it for weeks — but it is a *ported* integration, not a
native one: we send 7 of the ~15 parameters that matter, we **silently drop the model's reasoning
items every turn** (OpenAI's own guidance says to replay them between consecutive tool calls), and
our entire explicit prompt-caching system — the thing we spent three releases perfecting — is
**Anthropic-only**, while GPT-5.6 now exposes an almost isomorphic breakpoint API we use none of.
The good news: the two gaps that matter most are cheap, because the hard halves (breakpoint
placement, message persistence) already exist and only need a second renderer.

## 1. Two different backends answer to "OpenAI", and the demo must pick one

| | `codex-sign-in` (chatgpt.com) | metered API (api.openai.com) |
|---|---|---|
| auth | broker-minted subscription token | `MODEL_API_KEY` |
| cost | ~$0 marginal (subscription) | metered |
| parameter surface | **restricted and undocumented** — rejects `max_output_tokens` outright (D-12, wire-proven) | full documented surface |
| delegation (`research`/`spawn_subagent`) | **dead until D-12 ships** | works today |
| our support | works (Delos) | works — `MODEL_API=responses` + any base URL, `provider.ts:610-612`, plain `apiKey` at `:1615` |

**Recommendation for the demo: the metered API.** Reliability beats subscription economics in front
of a founder: the codex backend 400s on parameters it does not recognise (that is how D-12
happened), its parameter surface is unversioned and undocumented, and delegation is broken on it
until 0.2.15 lands. Everything in this spec is *verified against the documented API*; on the codex
backend every parameter must be re-proven by wire probe first (§6).

**The standing lesson from D-12, promoted to a rule:** the Codex subscription surface is not the
OpenAI API. No new parameter is sent to `chatgpt.com` without a two-curl wire proof, and every new
parameter gets a backend predicate beside the four that already exist at `provider.ts:748-761`.

## 2. Audit: what we send today vs the GPT-5.6 surface

What `streamResponses` (`provider.ts:1596-1611`) puts on the wire today:

| parameter | status | note |
|---|---|---|
| `model`, `input`, `stream`, `store:false` | ✅ | store:false is required by codex and right for us everywhere |
| `instructions` | ✅ | system messages joined |
| `prompt_cache_key` | ✅ | session id, sliced to 64 — correct per docs ("reuse for shared prefixes") |
| `max_output_tokens` | ⚠️ | D-12: must be gated off `chatgpt.com` (specced) |
| `reasoning.effort` | ✅ | passes through; new `none`/`max` levels pass because effort is an open string by design |
| `tools` | ✅ | flat Responses shape |
| **`reasoning` item replay** | ❌ **dropped** | §3 — the quality gap |
| `include`/`encrypted_content` handling | ❌ | §3 |
| `prompt_cache_breakpoint` (explicit caching) | ❌ | §4 — the cache gap |
| `prompt_cache_options` (`mode`, `ttl`) | ❌ | §4 |
| `reasoning.summary` | ❌ | §5.1 — we built the SSE consumer and never ask for the data |
| `text.verbosity` | ❌ | §5.2 |
| `reasoning.context` (`auto`/`all_turns`/`current_turn`) | ➖ | default `all_turns` is right for us; do not send |
| `reasoning.mode: "pro"` | ➖ | wrong latency profile for QS; do not send |
| `usage.cache_write_tokens` parsing | ❌ | §5.3 — 5.6+ bills cache writes at 1.25×; we read `cached_tokens` only |

## 3. P0-quality · We throw away the model's reasoning every turn

**Plain English.** On every turn, GPT-5.6 does private reasoning, acts, and hands us that reasoning
in a sealed envelope. We throw the envelope away. Next turn the model gets its own past actions back
with the thinking that produced them missing — like solving a maths problem where you may see your
previous answers but never your working. OpenAI's guidance is explicit: *"If the model calls
multiple functions consecutively, you should pass back all reasoning items, function call items,
and function call output items, since the last `user` message."* Quick Search is exactly that shape
— 19 model calls per run, long consecutive tool chains.

**Mechanism.** Two half-gaps that are one defect:

1. **Capture** — the SSE handler (`provider.ts:1701-1712`) keeps only `function_call` items from
   `response.output_item.added`. A `reasoning` output item (which under `store:false` carries
   `encrypted_content` by default) is ignored.
2. **Replay** — `toResponses` (`provider.ts:1536`) rebuilds `input` from `ChatMsg` roles; there is
   nowhere a reasoning item could even live.

**Fix shape.**

- Capture `{type:"reasoning", id, encrypted_content}` items in the stream handler.
- Carry them on the assistant message as a new optional field (`reasoningItems?: unknown[]` on
  `AssistantMsg`). Persistence is free — messages are stored as JSON.
- `toResponses` replays them verbatim, **positionally before the same assistant turn's
  `function_call` items**, per the guide.
- **Compaction interplay, which is where the bugs will live:** a reasoning item must live and die
  with its turn. When compaction deactivates the assistant row, the reasoning item goes with it —
  never into the summary, never orphaned. Encrypted content is opaque and unreadable, so nothing
  else can be done with it anyway. `elideRowArgs` and `demoteSpilled` must leave the field alone.
- Anthropic path: unaffected (the field is absent — that wire has its own thinking mechanism).

**Sizing:** the capture is ~15 lines, the replay ~10, the type change ~5. The test is the work:
a two-turn tool loop asserting the second request's `input` carries the first turn's reasoning item
between the assistant text and its function_call.

**This is also a cache win, not just a quality win:** replayed reasoning items are part of the
prefix, so *not* replaying them is a same-position content change... it is the *only* option that
keeps the prefix byte-stable AND follows the vendor's quality guidance.

## 4. P0-cache · Our breakpoint engine is Anthropic-only; GPT-5.6's API is nearly isomorphic

**Plain English.** We spent three releases building precise cache checkpointing for Claude — where
to put the markers, how to keep them stable, how to space them past tool bursts. On OpenAI models
we use none of it: we rely on the provider guessing. GPT-5.6 just shipped the same explicit-marker
system Claude has, and our placement engine can drive it almost unchanged.

**What GPT-5.6 offers** (prompt-caching guide, fetched today):

- `prompt_cache_breakpoint: {mode:"explicit"}` on individual content blocks — the direct analogue
  of Anthropic's `cache_control: {type:"ephemeral"}`.
- Up to **4 new cache writes** per request, reads match against the **latest 50** breakpoints,
  **1,024-token minimum** through the breakpoint. (Anthropic: 4 markers, 20-block lookback — our
  `rollingMarks` already reasons about exactly this.)
- `prompt_cache_options.mode: "explicit"` disables the implicit breakpoint entirely; **implicit
  default already respects explicit breakpoints**, so we can add markers without taking over.
- `prompt_cache_options.ttl: "30m"` — the only value on 5.6+, default, refreshes on reuse. (No 1h;
  `prompt_cache_retention:"24h"` is the *older*-model parameter. `DELTA_CACHE_TTL=1h` must NOT be
  forwarded to this wire.)
- Cached reads 0.1×; **cache writes billed at 1.25× into `cache_write_tokens`** — new on 5.6+.

**Fix shape.** A Responses renderer for the existing placement engine:

- `rollingMarks` / `rollingScanFrom` (`provider.ts:770-887`) compute *positions*; they are
  wire-agnostic already (exported, deterministic). Reuse them verbatim.
- In `toResponses`, attach `prompt_cache_breakpoint` to the last content block of the marked items:
  one stable mark after instructions/spine equivalent, two rolling marks on the transcript tail —
  the same 3-of-4 discipline as the Anthropic wire, under the 4-write cap.
- Keep **implicit mode** (do not send `prompt_cache_options.mode:"explicit"`) for the first cycle:
  our markers add read anchors while the provider's implicit latest-message breakpoint keeps
  working. Strictly additive, so the failure mode is "no better", not "worse".
- **Do not send any of this to `chatgpt.com` without the §6 wire probe.** The codex backend
  auto-caches and may 400 on the field — this is exactly a D-12-shaped parameter.

**Why bother when the backend auto-caches:** the QS finding (`aperture-qs-tuning-findings.md` §2)
is that the expensive moment is the post-compaction reload and the 1–5-minute-gap band. Explicit
breakpoints are how we control *what survives* a suffix change; implicit-only means every
latest-message change is the only anchor. Same argument that earned the Anthropic work.

## 5. P1 · Three small ones

### 5.1 `reasoning.summary: "auto"` — we built the consumer and never request the data
`provider.ts:1697-1699` already forwards `response.reasoning_summary_text.delta` to
`onReasoningDelta`. Without requesting summaries the backend has nothing to emit, so the code is
dead. One line beside the effort: `body.reasoning = { effort, summary: "auto" }`. Gate behind
`DELTA_REASONING_SUMMARY` if we want it opt-in; visibility into *why* the model did something is
worth having in a demo debrief.

### 5.2 `text.verbosity` — a knob we simply don't expose
`DELTA_TEXT_VERBOSITY` → `body.text = { verbosity }`, values `low`/`medium`/`high`, unset = omit
(provider default `medium`). For QS, `low` is a plausible output-token/latency win but **do not set
it for the demo untested** — same rule as the effort dial in the QS findings §4.4.

### 5.3 Parse `cache_write_tokens`, and stop mispricing 5.6
- Usage parsing (`provider.ts:1724-1729`) reads `input_tokens_details.cached_tokens` and nothing
  for writes. Add `cache_write_tokens` → `usage.cacheWrite`; `computeCost` already bills writes at
  1.25×, so pricing becomes correct the moment the field is read.
- `pricing.ts` has no `gpt-5.6` entry — `gpt-5.6-sol` prefix-matches `gpt-5` ($1.25/$10). That is a
  guess wearing a match. Add a real entry once the list price is confirmed; on the metered demo
  lane this number is real money, not metered-equivalent.

## 6. The wire-probe battery — before anything ships

Per the D-12 rule, every new parameter is proven on both backends with the two-curl pattern
(identical bodies ± one field), recorded in this doc:

| parameter | api.openai.com | chatgpt.com (codex) |
|---|---|---|
| `reasoning.summary:"auto"` | expect 200 | **unknown — probe** |
| `text.verbosity` | expect 200 | **unknown — probe** |
| `prompt_cache_breakpoint` on a content block | expect 200 | **unknown — probe** |
| `prompt_cache_options.ttl:"30m"` | expect 200 | **unknown — probe** |
| `include`/reasoning `encrypted_content` replay | expect 200 | **unknown — probe** |
| `max_output_tokens` | 200 (proven) | **400 (proven — D-12)** |

Delos owns the codex lane and has the probe pattern from the D-12 report; ask for the right-hand
column in one session. Anything that 400s on codex gets a backend predicate, same shape as
`acceptsMaxOutputTokens`.

## 7. What must not change

1. **`store:false` stays unconditional** — required by codex, correct everywhere (we resend full
   transcripts; `previous_response_id` server-side state is the road not taken, deliberately:
   compaction rewrites history, which server-side state cannot represent).
2. **Effort stays an open string.** `none`/`max`/whatever ships next passes through untouched;
   the model is the authority (`provider.ts:299-304`).
3. **The Anthropic wire is untouched by all of this.** Every change lands in `toResponses` /
   `streamResponses` / the type layer. Aperture-on-Claude and Ferni must see byte-identical
   requests — that is the regression gate.
4. **Error-as-value.** A 400 from a probe-missed parameter must fail the turn cleanly, never the
   daemon.

## 8. Recommended order, against the demo clock

| # | item | size | risk | why this order |
|---|---|---|---|---|
| 1 | Demo lane on **metered** `api.openai.com`, `MODEL_API=responses` | config | none | full surface, no codex 400 roulette, delegation works pre-0.2.15 |
| 2 | §3 reasoning replay | ~30 lines + test | low, additive field | the vendor-documented quality gap for exactly QS's shape |
| 3 | §5.3 `cache_write_tokens` + a real 5.6 price | ~5 lines | none | cost truth on a metered lane |
| 4 | §5.1 summary + §5.2 verbosity knobs | ~5 lines | none (opt-in) | observability for the debrief |
| 5 | §4 explicit breakpoints | ~40 lines + test | medium | biggest cache win; additive under implicit mode; needs the probe on codex only |
| 6 | D-12 conditional (already specced) | 1 line | low | only blocking if the demo insists on the subscription backend |

Items 2–5 are one focused day plus the test battery. Item 5 can miss the demo without harming it —
implicit caching still works; it is the one to cut if time is short.
