# Spec: one control plane, per-wire renderers

Status: **design spec v1, pre-implementation, 2026-08-19.** The generalisation layer for
`spec-responses-first-class.md`: how cache management, reasoning carry, and model controls become
**one** harness-level system that renders differently per provider, instead of an Anthropic system
plus OpenAI patches. Split hard into MUST (the 0.2.16 "openai-native" batch) and LATER.

Sources: `src/provider.ts` at `4890c8a`; OpenAI latest-model, prompt-caching, reasoning and
flex-processing guides (fetched 2026-08-19).

## 0. The design position

Delta already has the right instincts scattered across the provider layer: `rollingMarks` computes
*positions* wire-agnostically; four small predicates (`hostMatches`, `acceptsPromptCacheKey`,
`usesMaxCompletionTokens`, `acceptsMaxOutputTokens` once D-12 lands) gate fields per backend; effort
is an open string the model owns. The failure mode to avoid is the one we are in: each new provider
capability lands as an if-branch in one wire function, so Anthropic got a cache discipline and
OpenAI got none, `DELTA_SPEED` works on one wire and is silently inert on another, and nobody can
say what a given lane's knobs actually do without reading `provider.ts`.

**The design:** the run loop produces two small wire-neutral values per request — a **CachePlan**
and a **ModelControls** — and each wire function renders them. A wire that cannot render a control
declares it **inert** rather than dropping it silently, and inert controls surface on `/v1/status`
(the D-3 "effective config" extension, `aperture-qs-tuning-findings.md` §5.3).

This is deliberately NOT a plugin system, a capability matrix DSL, or a per-model config file. Two
plain types, three renderer functions, and a table in the docs. Lean over sprawling.

## 1. The three abstractions

### 1.1 CachePlan — where the breakpoints go, decided once

```ts
/** Wire-neutral cache placement, computed once per request assembly. */
type CachePlan = {
  /** Message indices that get a breakpoint: one stable mark after the spine-adjacent
   * prefix, plus the rolling marks. Computed by the EXISTING rollingMarks/rollingScanFrom —
   * those already reason in positions, not wire syntax. */
  marks: number[];
  /** Retention preference. Renderers clamp to what their wire supports. */
  ttl?: "1h";
};
```

| wire | renders as | notes |
|---|---|---|
| Anthropic Messages | `cache_control: {type:"ephemeral"[, ttl:"1h"]}` | today's behaviour, unchanged — this renderer already exists |
| OpenAI Responses (GPT-5.6+) | `prompt_cache_breakpoint: {mode:"explicit"}` on the marked item's last content block | **implicit mode kept** — our marks are additive read anchors; provider's latest-message breakpoint keeps working. `ttl:"1h"` clamps to the wire's only value (`prompt_cache_options.ttl:"30m"`) — i.e. **omitted**, since 30m is the default |
| Chat Completions / OpenRouter | nothing (implicit caching) + `prompt_cache_key` where accepted | unchanged |
| Codex subscription (chatgpt.com) | **nothing until wire-probed** | the D-12 rule: this surface 400s on unknown fields |

Constraint check, done once here so renderers stay dumb: Anthropic allows 4 markers/20-block
lookback; GPT-5.6 allows 4 writes/50-breakpoint reads/1,024-token minimum. Our 3-of-4 discipline
(one stable + two rolling) fits both. The 1,024-token minimum needs no guard — the spine plus tool
schemas alone clear it on every real lane.

### 1.2 ModelControls — what the operator asked for, mapped or declared inert

```ts
type ModelControls = {
  effort?: string;              // open string — the model is the authority (unchanged)
  verbosity?: "low" | "medium" | "high";   // NEW: DELTA_TEXT_VERBOSITY
  reasoningSummary?: "auto";               // NEW: DELTA_REASONING_SUMMARY=auto
  speed?: "fast";                          // existing DELTA_SPEED
};
```

| control | Anthropic | OpenAI Responses | Chat/OpenRouter |
|---|---|---|---|
| `effort` | thinking budget mapping (exists) | `reasoning.effort` (exists) | `reasoning_effort` / OpenRouter `reasoning.effort` (exists) |
| `verbosity` | **inert** | `text: {verbosity}` | **inert** |
| `reasoningSummary` | **inert** (thinking deltas are native) | `reasoning.summary: "auto"` — the SSE consumer at `provider.ts:1697` already exists and is dead code without this | **inert** |
| `speed` | `speed:"fast"` + beta header (exists) | **inert — there is no OpenAI fast mode; see §3** | **inert** |

**Inert is a first-class outcome.** Each renderer returns what it dropped, one startup line names
it (`delta: DELTA_SPEED=fast is inert on the 'responses' wire — no OpenAI equivalent exists`), and
`/v1/status` reports effective controls. This is the same principle as D-2/D-3: the engine knowing
something the operator cannot see is the defect; silence is never the answer.

### 1.3 ReasoningCarry — the model's reasoning items survive the turn boundary

The `spec-responses-first-class.md` §3 fix, stated here as the neutral abstraction: an optional
`reasoningItems?: unknown[]` on `AssistantMsg`, captured by whichever wire produces such items,
replayed only by wires that consume them, opaque to everything in between.

- OpenAI Responses: capture `{type:"reasoning", id, encrypted_content}` from
  `response.output_item.added`; replay verbatim **before the same turn's `function_call` items**.
- Anthropic: never sets the field (its thinking blocks are a different mechanism, already handled).
- Compaction: the items live and die with their assistant row — never summarised, never orphaned.
  `demoteSpilled` / `elideRowArgs` leave the field untouched (they already only edit other fields,
  but the test must pin it).
- **Cache interplay, which is why this is load-bearing for §1.1:** replayed reasoning items are
  prefix content. Replaying them is the only option that keeps the prefix byte-stable AND follows
  the vendor's quality guidance; dropping them (today) mutates the prefix's meaning without
  changing our bookkeeping.

## 2. MUST — the 0.2.16 "openai-native" batch

Ranked; each lands with a test that fails without it, per house rule.

| # | item | from | size |
|---|---|---|---|
| M1 | ReasoningCarry: capture + replay + compaction pin | §1.3 | ~30 lines + the two-turn test |
| M2 | CachePlan type + Responses breakpoint renderer (implicit mode) | §1.1 | ~40 lines + a body-assembly test asserting mark positions match the Anthropic wire's for the same transcript |
| M3 | Parse `usage.cache_write_tokens` → `cacheWrite`; real `gpt-5.6-sol`/`terra`/`luna` price entries (5.6+ bills writes at 1.25×; the current `gpt-5` prefix-match is a guess) | responses-first-class §5.3 | ~10 lines |
| M4 | ModelControls: `verbosity` + `reasoningSummary` knobs; `speed` declared inert on Responses; inert reporting on stderr + `/v1/status` | §1.2 | ~25 lines |
| M5 | The wire-probe battery on the codex backend (six unknowns in responses-first-class §6), and a predicate per parameter that fails it | D-12 rule | probe session on Delos + small predicates |

Explicitly in scope for the SAME batch because they share the diff: nothing else. D-12 itself is
0.2.15 and already specced.

**The regression gate for all of M1–M4:** the Anthropic wire emits byte-identical requests before
and after. Every change lands in `toResponses`/`streamResponses`/the type layer; Aperture-on-Claude
and Ferni are the proof.

## 3. The fast-mode question, answered

**There is no fast mode on GPT-5.6.** Checked against the latest-model guide, the Responses API
reference, and the flex-processing guide (2026-08-19):

- `gpt-5.6-sol` is not a speed variant — it is the **flagship-capability** variant. The `gpt-5.6`
  alias routes to it. Its siblings are `gpt-5.6-terra` (strong, cheaper) and `gpt-5.6-luna`
  (efficient, high-volume): a capability/cost ladder, not a latency ladder.
- The only `service_tier` documented for 5.6 is **`"flex"`** — the *opposite* of fast: batch-rate
  pricing, slower responses, occasional `429 Resource Unavailable`. No priority/fast tier is
  documented for 5.6.
- OpenAI's own latency guidance for 5.6 is the effort dial: *"`medium` as a balanced starting
  point, `low` for latency-sensitive workloads."*

So the speed levers on the OpenAI wire are **effort** and **model variant**, both of which we
already pass through. `DELTA_SPEED=fast` maps to nothing and must say so (M4) rather than silently
doing nothing, which is what it does today.

## 4. LATER — real, deferred, with the reason

| item | why later |
|---|---|
| `service_tier:"flex"` for the **utility lane and children** (compaction summaries, `eval_n` voters) | a genuine cost lever — batch rates on calls nobody is waiting on — but it introduces a new failure mode (`429 Resource Unavailable`, needs a longer timeout) into paths that must stay boring. After the batch, behind a knob, utility lane first. |
| `gpt-5.6-luna` as the default utility model on OpenAI lanes | same shape as `claude-haiku` on Anthropic lanes; needs one benchmark run, not a spec |
| `prompt_cache_options.mode:"explicit"` (take over placement fully) | only after M2 data shows our marks beat implicit+ours. Taking over placement before measuring is how we'd ship a regression with a straight face |
| `reasoning.context:"current_turn"` on the first call after a compaction | clever and plausible — after a rewrite, prior-turn reasoning references a history that no longer exists — but speculative. Needs one A/B on a compacting run, not a default |
| `prompt_cache_retention:"24h"` | older-model parameter (5.5 and down); not applicable to the 5.6 demo lane |
| programmatic tool calling / `allowed_callers` | a different execution model, not a knob. Watch it; do not chase it |
| `background` mode on Responses | overlaps our own async task surface; revisit if a run shape demands it |

## 5. What must not change

1. **`rollingMarks` stays the single placement authority.** Two renderers, one brain. A second
   placement algorithm is how the two wires drift apart.
2. **Effort stays an open string.** The mapping table maps *fields*, never *values*.
3. **`store:false` unconditional; no `previous_response_id`.** Server-side state cannot represent a
   compacted history. ReasoningCarry is the stateless answer to the same need.
4. **No probe, no parameter** on chatgpt.com. The predicate family grows one sibling per proven
   rejection, exactly as D-12 did it.
5. **Error-as-value.** An inert control is a report; a rejected parameter is a clean failed turn;
   neither is a crash.
