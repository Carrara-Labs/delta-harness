# Spec: rolling cache breakpoints must land on persisted transcript

Status: **fix built, live verification pending**. Written 2026-08-03 from field data.

## The observation

Ferni (Harness 0.2.10, native Anthropic, Opus 5), round 1 of a controlled two-round protocol:

| time | turn | input | cached | hit |
| --- | --- | --- | --- | --- |
| 07:49:13 | 1 | 8,096 | 6,507 | 80% |
| 07:49:22 | 2 | 18,871 | 6,507 | 34% |
| 07:49:38 | 3 | 35,052 | 6,507 | 19% |
| 07:49:55 | 5 | 48,897 | 6,507 | 13% |
| 07:50:33 | 7 | 59,246 | 6,507 | 11% |

**Cache reads are pinned at exactly 6,507 tokens** — the system + tools prefix — while the request
grows to 59,246. Consecutive calls are **9 seconds apart**, so the 5-minute TTL cannot explain it.
Across the whole agent: 13.75M tokens written to cache, 2.63M read back (19.1%), against a
**27.8% break-even** (writes bill 1.25x, reads 0.1x). Prompt caching was a net cost.

## The cause

`DELTA_CAPTURE_CALLS=1` captured a real request. Replaying the engine's own breakpoint scan against
it put both rolling marks here:

| idx | role | derived | content |
| --- | --- | --- | --- |
| 16 | tool | no | 20,179 bytes of fetched page |
| 20 | user | no | the actual user message |
| **21** | user | **yes** | `# Context\nCurrent model: claude-opus-5 · now: 2026-08-03T08:…` |
| **22** | user | **yes** | `[Relevant skills — untrusted directory data…]` |

`run.ts` appends derived per-turn blocks (context, retrieval, plan, budget) **after** the transcript.
They are `role: "user"` with string content, so the scan marked them. A cache read requires the
prefix to match byte-for-byte up to the breakpoint, and one of those blocks **carries a clock**. So
every turn wrote a large cache that was structurally impossible to read back.

The code intended otherwise. Its comment says "last two **PERSISTED** user/tool indices", and a
prior fix had already excluded the *array-content* image block for exactly this reason. String
content walked through the guard.

### Why this hid for so long

Aperture QS gets **88.9%** cache hit on the same engine. It emits neither derived block: no
`DELTA_SKILLS`, no `PROMPT_CONTEXT.md` with dynamic vars. **The bug only fires on richly-configured
agents**, so the fleet average looked healthy while the dogfood agent burned money.

## The fix

`run.ts` passes `ephemeralCount` (how many trailing messages are derived). Both wire serializers
exclude that suffix from the **rolling** scan only — the system mark still scans everything, so a
bad count can never cost us the stable prefix too.

Shared helper `rollingScanFrom(length, ephemeralCount)`, because the first cut of this fix threaded
the exclusion into one serializer and codex proved the other still reproduced the bug in full (P1
below). Hostile counts are clamped: `NaN` would silently disable the exclusion, `Infinity` would
silently disable rolling caching.

Native also now skips any message carrying an image block — derived, rebuilt every turn, and the
compat path already excluded it.

## Adversarial review (codex, round 1: DO-NOT-SHIP)

- **P1 — native Anthropic ignored the fix entirely.** The count reached `withPromptCache` (the
  OpenAI-compatible serializer) but `toAnthropic` has its own marker loop and was never given it.
  That is the path Ferni actually runs, so the fix would have shipped as a **no-op on the one agent
  it was written for**, and the live test would have "disproved" a correct diagnosis. Fixed, and
  both serializers now share the eligibility helper.
- **P2 — the two-mark lookback claim is weaker than the comment says.** Anthropic scans ~20 blocks
  back per breakpoint, and the two marks are usually adjacent, so their windows overlap and a turn
  with ~11 parallel tool calls can push both past the previous cached tail. **Pre-existing, not
  introduced here, not fixed here.** Logged for the compaction/spill batch.
- **P3 — a positional count is a fragile contract.** Accepted for now with clamping and a shared
  helper; the stronger design is tagging each message `stable | transcript | volatile` and letting
  only `transcript` be eligible. That is the right shape if a third serializer ever appears.

## Competitive check

**OpenClaw marks the system/developer prefix only** and explicitly strips `cache_control` from
thinking blocks (`packages/ai/src/transports/anthropic-payload-policy.ts:294`). It places **no**
rolling breakpoints on the transcript. So its cache cannot decay the way ours did — and it also
cannot win what ours wins when correct (Aperture reads 382M of 422M input tokens from cache).

The rolling-breakpoint design stays. It is a real differentiator. The lesson is that eligibility has
to be enforced in code and guarded by a test, not asserted in a comment.

## Tests

Three regression tests, each verified to **fail without the fix and pass with it**:

- compat path: rolling marks skip trailing derived blocks and land on the transcript
- native path: same (the P1 case)
- native path: a message carrying an image is never a rolling mark

Plus an over-large `ephemeralCount` still marking the system prefix. 823 tests green, tsc and biome
clean.

## Coverage across all three wires

Vendor docs read 2026-08-03. The three paths cache by **different mechanisms**, which is why one
bug hit only one of them.

| Wire | Mechanism | What Delta sends | State |
| --- | --- | --- | --- |
| **anthropic-native** (`/v1/messages`) | explicit `cache_control`, max 4 breakpoints | 1 system (1h when `DELTA_CACHE_TTL=1h`) + 2 rolling = 3 of 4 | **fixed here** |
| **openai-native** (`/responses`) | automatic prefix caching + `prompt_cache_key` routing | `prompt_cache_key` (session id, 64-char clamp) | already correct |
| **openai-compatible** (OpenRouter, chat-completions) | Anthropic models → `cache_control`; OpenAI/Gemini → automatic + routing key | `cache_control` for Anthropic models (**fixed here**) + `prompt_cache_key` on documented hosts (**added here**) | fixed here |

Two facts drove the compatible-wire change:

- `prompt_cache_key` is a **Chat Completions** field, not Responses-only, and OpenAI states it is
  **required for reliable matching on GPT-5.6+**. OpenRouter forwards it as its sticky routing key.
  Delta sent it on the Responses wire only.
- The fleet had already paid for this: the same model family averaged **56.7%** cache hit natively
  (1,237 calls) against **24.6%** over the compatible wire (184 calls).

**Gated by host, not sent blindly.** An unknown top-level field is a legitimate 400 on a strict
OpenAI-compatible server, and a plain 4xx is *not* failover-worthy in this codebase — so guessing
would turn an arbitrary `MODEL_BASE_URL` from "uncached" into "unusable", and would block reaching
an OpenRouter fallback (codex P1). `acceptsPromptCacheKey` matches the parsed **hostname** against
`openrouter.ai` and `openai.com` only, so a lookalike host cannot opt itself in, with an explicit
`promptCacheKey` provider override for a custom proxy someone has actually verified.

Deliberately unchanged:

- **Gemini via OpenRouter gets no `cache_control`.** Gemini 2.5 caches implicitly with no
  breakpoints, and where explicit markers are used only the last one applies. The routing key is
  the useful part and it now gets that.
- **Anthropic via OpenRouter now receives both** `cache_control` and `prompt_cache_key`. The key is
  top-level routing metadata, orthogonal to breakpoints, and does not consume the 4-breakpoint
  budget.
- Minimum cacheable prefix is **1,024 tokens** on GPT-5.6+, so short turns will not cache at all on
  those models regardless of what we send. Not a bug.

## Live verification — four arms against real provider APIs

A local daemon, real APIs, real conversations, cache numbers read from the daemon's own DB. The
workspace reproduces the failure condition: a `PROMPT_CONTEXT.md` carrying `{{now.iso}}` plus a
local skill, so two derived blocks are appended every turn.

| Arm | Wire | Auth | Result |
| --- | --- | --- | --- |
| OpenRouter + Sonnet 5 | compat, `cache_control` | static key | **100%** (28,768 / 28,856) |
| OpenRouter + GPT-5.5 | compat, `prompt_cache_key` | static key | 97/96% once warm, no 400 |
| Anthropic direct | native, `cache_control` | static key | cold, then **100 / 100 / 99%** |
| **chatgpt.com/backend-api/codex + gpt-5.6-sol** | **native Responses** | **Codex sign-in via CP broker** | 11 calls, tools, **56%** |

The Codex arm minted a real subscription token from the control-plane broker
(`/api/broker/openai-token`) with no static key configured, and every call reported
`provider: primary` — so it genuinely ran the subscription, not the OpenRouter fallback. 56% matches
the fleet's independently-measured 56.7% for `gpt-5.6-sol`. The broker token was held only in
process env and deleted afterwards; it was never written to a transcript.

### What the lab could NOT reproduce

Pre-fix code with the same two derived blocks still cached at **98%** on a text-only conversation.
The failure needs more than the derived blocks:

- with **one** derived block only one of the two rolling marks is wasted, and the survivor still
  lands on real transcript;
- without **tool calls** the transcript grows too gently for the marks to drift out of Anthropic's
  ~20-block lookback.

Adding large tool results reproduced degradation, and the fix removed it:

| | calls | overall |
| --- | --- | --- |
| pre-fix, tool-heavy | 95, 94, **18**, 99, **71**, 99, **77**, 100 | 81% |
| fixed, same script | 97, 89, 18, 99, **99, 99, 98, 99** | 86% |

The post-tool-result dips are gone. Total input differed between the two runs (204k vs 151k)
because the model made different tool calls, so that pair is **not** a clean cost comparison.

**Honest limit:** the fix is correct and measurably helps in both the lab and on Ferni, but the
*severity* on Ferni (reads pinned at 6,507 while input reached 59k) was never reproduced in the lab.
Something about its scale — 20-27KB tool results, Opus 5, more blocks per turn — amplifies it.
Codex's P2 (the ~20-block lookback being blown past by parallel tool calls) is the leading candidate
and remains unfixed.

## Live verification

The measurement to beat is the table at the top: cache reads pinned at 6,507 while input grows. A
correct fix makes `cached` track input across a multi-step run. Re-run on the same agent, same
model, same wire.

Related: [[fleet-review-playbook]], [[project_delta_cache_decay]].
