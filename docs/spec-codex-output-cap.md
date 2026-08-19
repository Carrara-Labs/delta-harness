# Spec: the Codex subscription backend rejects `max_output_tokens`

Status: **spec v1, pre-implementation.** D-12 of `docs/backlog-delos-field-report.md`, confirmed in
source. Batch: `harness-0.2.15-plan.md`, item 4. The smallest fix in the release; it is specced because
the *second* decision in it — whether an uncappable child should run — is not obvious.

## 1. The defect

`research`, `spawn_subagent` and `eval_n` fail **100% of the time** when the active provider is
`codex-sign-in`. Not degraded. Every child, every call.

It reproduces **without Delta in the path** — two requests to the Codex endpoint differing by one
field:

```
POST https://chatgpt.com/backend-api/codex/responses
  {"model":"gpt-5.6-sol","input":[…],"stream":true,"store":false}
  -> HTTP 200, streams response.created normally

  …same body plus "max_output_tokens": 4000
  -> HTTP 400 {"detail":"Unsupported parameter: max_output_tokens"}
```

The parameter is rejected **at any value**. No setting of `DELTA_STEP_MAX_TOKENS` affects it; see §5.

### 1.1 The chain

| step | site | behaviour |
|---|---|---|
| 1 | `research.ts:210` | every child call passes `maxTokens: Math.max(256, Math.min(OUTPUT_CAP, remaining))` — **unconditionally** |
| 2 | `provider.ts:1600` | `if (req.maxTokens) body.max_output_tokens = req.maxTokens` |
| 3 | Codex backend | 400, `Unsupported parameter: max_output_tokens` |
| 4 | `provider.ts` `ProviderErrorClass` | 400 classifies as `request`, not `transient` → the `anthropic-native` link in the chain is **never tried** |

**Why the parent survives and only children die.** Parent turns never pass `req.maxTokens` — the main
loop relies on `STEP_MAX_TOKENS`, which the Responses path never reads (it appears only in the
Anthropic branch, `provider.ts:1294/1318/1329`). So the identical connection works for the parent and
fails for every child, and nothing in config can show you the difference.

Observed: one `deep-research` run made **24 child starts and got 24 failures**, producing zero
verification votes, and the agent paid for every attempt:

```
[research failed: {"detail":"Unsupported parameter: max_output_tokens"}]
[tool error] subagent exited 1:
DELTA_USAGE {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0,"costUsd":0}
```

### 1.2 Fleet impact is zero, and that is not a reason to defer

No Aperture lane and not Ferni has ever recorded an `Unsupported parameter` error — they run
`anthropic-native` or OpenRouter. Checked, not assumed.

It ships anyway because **`config/ferni-codex-sol` is held on it.** That branch moves Ferni onto this
exact backend. Landing it first would silently delete Ferni's entire delegation surface on migration
day, with no error and no fallback. This fix is a prerequisite, not a fire.

## 2. The fix

`provider.ts:748-761` already holds three functions of exactly the required shape, built for exactly
this class of per-backend wire difference:

```ts
function hostMatches(baseUrl: string, domains: string[]): boolean
export function acceptsPromptCacheKey(cfg: { baseUrl: string; promptCacheKey?: boolean }): boolean
export function usesMaxCompletionTokens(baseUrl: string): boolean
```

Add a fourth sibling beside them:

```ts
/** The ChatGPT/Codex subscription backend rejects `max_output_tokens` outright, at any value
 * ("Unsupported parameter"), which 400s every child call — parent turns never send one, so the same
 * connection works for the parent and fails for every subagent. OpenAI proper DOES accept it, so this
 * is a denylist of the subscription host, not an allowlist of openai.com. Same host as
 * `subscriptionBaseAllowed`'s default (config.ts:580) — keep the two in step. */
export function acceptsMaxOutputTokens(baseUrl: string): boolean {
  return !hostMatches(baseUrl, ["chatgpt.com"]);
}
```

And gate the one line, `provider.ts:1600`:

```ts
if (req.maxTokens && acceptsMaxOutputTokens(cfg.baseUrl)) body.max_output_tokens = req.maxTokens;
```

There is direct precedent four lines above: `store: false` is special-cased for this same backend with
a comment saying so (`provider.ts:1593-1596`).

### 2.1 Denylist, not allowlist — the one trap

`usesMaxCompletionTokens` matches `["openai.com"]`, and `chatgpt.com` is a different host, so it is
tempting to mirror that as `hostMatches(baseUrl, ["openai.com"])` → "only OpenAI accepts it". **That is
wrong**: it would strip `max_output_tokens` from every third-party OpenAI-compatible Responses endpoint
that does support it, silently uncapping children on backends that were working. Deny the one host we
have proof about; leave everything else alone.

`hostMatches` already normalises one trailing dot and matches exactly rather than by subdomain suffix
(`provider.ts:737-747`), so `evil.chatgpt.com` does not inherit the exemption. Reuse it; do not write a
new comparison.

## 3. The second decision: run uncapped, or refuse loudly?

A child that cannot honour an output cap could either run without one or refuse. **Run uncapped.**

- The parent's budget already bounds it. `research.ts:190` computes `remaining` from the run's own
  usage, `reserveBudget` holds a live reservation for in-flight children, and the run-level guard at
  `run.ts:780` fires on the accumulated total regardless of what any child was told. The cap is a
  courtesy, not the safety property.
- The current behaviour is the worst of the three options: it **neither caps nor runs**, and it bills
  for the attempt.
- Refusing loudly would keep an agent's whole delegation surface dead on a supported provider for the
  sake of a bound that another mechanism already enforces.

`research.ts:210` keeps computing `maxTokens` — the value still feeds the budget claim and the
reservation. Only the wire field is suppressed. Do not delete the computation.

## 4. What must not change

1. **The Anthropic branch.** `provider.ts:1294/1318/1329` are untouched. Its `max_tokens` +
   `THINKING_BUDGET` headroom behaviour is a separate concern and a separate finding (§5).
2. **Error classification.** Do not reclassify 400 as transient to make the fallback catch this. It
   would mask genuine bad requests and burn a retry slot on every one of them. Fix the request instead.
3. **`store: false`** stays unconditional — it is required by this backend and correct everywhere else.
4. **OpenRouter and `api.openai.com`** keep sending `max_output_tokens`. Assert both in the test.

## 5. Adjacent, and deliberately out of scope

The report records its own misdiagnosis and it earns a note here: the team first read this as a *size*
problem, blamed `DELTA_STEP_MAX_TOKENS=16384` against `xhigh` reasoning, and raised it. Nothing changed,
because the parameter is rejected at any value.

The reason that reading was plausible is that **the codebase contains exactly that hazard.** The
Anthropic branch deliberately adds `THINKING_BUDGET` headroom (`provider.ts:1310-1330`) with a comment
explaining that a small `max_tokens` would otherwise truncate the answer after the model thinks. The
Responses branch takes reasoning effort natively and adds no headroom at all.

**That asymmetry is real and it is firing.** The carrara Aperture lane, running
`DELTA_STEP_MAX_TOKENS=16384` at `medium` effort, recorded **9** `output cap (max_tokens) may have
truncated` tool errors. It belongs in 0.2.16, while `provider.ts` is open — not here, because bundling
it would put a behavioural change to the Anthropic path inside a one-line Codex fix and make the review
harder than either change deserves.

## 6. The test that fails without the fix

`test/provider.responses.test.ts` — body assembly only, no network:

1. `acceptsMaxOutputTokens("https://chatgpt.com/backend-api/codex")` → `false`.
2. `acceptsMaxOutputTokens("https://api.openai.com/v1")` → `true`.
3. `acceptsMaxOutputTokens("https://openrouter.ai/api/v1")` → `true`.
4. `acceptsMaxOutputTokens("https://evil.chatgpt.com/v1")` → `true` (exact-host, not suffix).
5. Assemble a Responses body with `maxTokens: 4000` against a `chatgpt.com` base: **no**
   `max_output_tokens` key present (assert key absence, not a falsy value — `store: false` shows the
   difference matters on this wire).
6. Same against `api.openai.com`: `max_output_tokens === 4000`.
7. Both bodies still carry `store: false` and, where applicable, `reasoning.effort`.

Pre-fix, 1 and 5 fail. Verify that before keeping the test.

**Live confirmation, before release.** Unit tests cannot prove the backend's behaviour. Delos has the
only lane with this provider, and the reproduction is already written — one `/v1/responses` call asking
for a single `research` with three tasks, reporting verbatim whether each child succeeded. Run it on a
`--from-source` deploy and require **3/3 children succeeded** before publishing. This is the
human-in-the-loop step the release gate demands; a fix to a wire format nobody exercised is a fix we do
not have.

## 7. For the reviewer

1. **Is `chatgpt.com` the complete host list?** `config.ts:580` defaults
   `DELTA_BROKER_ALLOWED_HOSTS` to the same single host, so the two agree today. If an operator widens
   the broker allowlist, the two lists silently diverge and a new subscription host would 400 again.
   Should `acceptsMaxOutputTokens` read the same env, or is a hardcoded proof-backed host correct?
   The spec prefers hardcoded — we have wire proof for exactly one host and inventing coverage for
   others is how the original bug shipped.
2. **Any other unconditional `req.maxTokens` producers?** `research.ts:210` and `research.ts:364` both
   pass it, and `builtins.ts:986` passes `maxTokens: 400`. Confirm all three are covered by gating at
   the wire rather than at each caller — gating at the wire is the point, but say if a caller needs to
   know it was ignored.
3. **Does anything depend on children being capped?** Grep for `OUTPUT_CAP`. If a downstream assertion
   assumes a bounded child response size, uncapping needs a bound elsewhere.
