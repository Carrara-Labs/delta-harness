# How three competitor harnesses instrument prompt-cache misses

Read 2026-08-10 against local checkouts: OpenClaw `b738e25780` (2026-08-07), Hermes `6e87d43a5`
(2026-07-12), Pi `ac4ac9e` (2026-08-07). One Opus 5 reader per codebase, same six questions, each
required to answer NOT FOUND rather than infer.

This is the evidence base for [`../spec-cache-break-correlator.md`](../spec-cache-break-correlator.md)
and [`../spec-capability-prose-lock.md`](../spec-capability-prose-lock.md). Paths are relative to
each checkout root.

## The headline

**Nobody debugs a cache miss by diffing wire bytes.** OpenClaw is the only one that captures them at
all, and its cache-trace JSONL is **write-only** — exhaustive grep found writers, config schema and
docs, no reader. Hermes and Pi have no wire capture whatsoever.

What OpenClaw actually solved it with is **correlation**, and that reframed our release.

## Q4 — cache instrumentation

### OpenClaw: correlate the change against the provider's own confirmation

`src/agents/embedded-agent-runner/prompt-cache-observability.ts` (352 lines):

- Snapshot per segment, capturing identity not size: `provider, modelId, modelApi, cacheRetention,
  streamStrategy, transport, systemPromptDigest, toolDigest, toolCount, toolNames` (`:39-50`).
- `systemPromptDigest` hashes **only the stable prefix**, split at the cache boundary (`:292-294`).
- `toolDigest` is per-tool `{name, descriptionDigest, schemaDigest}`, canonically sorted. Comment at
  `:164-165`: *"Cache identity includes the exact visible descriptor, not just its name; canonical
  ordering prevents discovery order from looking like a break."*
- Diff into typed change codes (`:178-228`), then fire only on a confirmed drop (`:313-351`):
  `cacheRead < previousCacheRead * 0.95 && tokenDrop >= 1000`.
- Logged with the suspect attached (`run/attempt-result.ts:181-184`).
- **The control is recorded too** (`:194-198`, `note: "state changed without a cache-read break"`).
- Zero cost when off: tool digests are not computed unless enabled (`run/attempt-stream.ts:85-88`).

### OpenClaw's blind spot, and why it matters to us

Their digests canonicalize through `stableStringify`, which **sorts object keys**
(`packages/normalization-core/src/stable-stringify.ts:84-89`). The emitted wire JSON preserves
insertion order. A key-reordering serializer change therefore breaks the cache and leaves the digest
identical. Only their `fetch`-level `data_sha256` catches it.

Their CHANGELOG carries the matching post-mortem, `:1628` (#101009): *"Prompt caching and cache
traces now fingerprint malformed incoming text consistently with the cleaned text providers
receive, avoiding needless cache misses and misleading diagnostics."* A sanitizer at the serializer,
changing bytes the instrument never saw.

**Lesson, one level deeper than ours:** identity must be measured on emitted byte order, not on a
canonicalized projection of it.

We do not have their specific bug — `tools_hash` digests `JSON.stringify(specs)`, the same array
handed to `deps.chat` (`run.ts:1004-1006`), in insertion order. We have the general version:
everything `toAnthropic` does afterwards is unmeasured, and `run.ts:96-99` says so.

### OpenClaw: other findings worth keeping

- **In-band cache boundary marker**: `packages/ai/src/utils/system-prompt-cache-boundary.ts:8`, a
  sentinel string letting the assembler declare the stable/volatile split, which every serializer
  either splits on or strips. `ensureSystemPromptCacheBoundary` auto-appends it when a hook-supplied
  prompt lacks one (#85203).
- **Breakpoint budget is counted, not assumed**: `ANTHROPIC_CACHE_CONTROL_LIMIT = 4`, with markers
  spent on system+tools subtracted before the message walker spends the rest
  (`anthropic-payload-policy.ts:31, 282-289`). **Checked against ours: we emit 3 of 4** (one system
  prefix, up to two rolling message marks), so we cannot silently overflow. Hypothesis closed.
- **Message breakpoint anchors on the deepest stable user turn** with an explicit opt-out set, so a
  volatile trailing runtime-context carrier never becomes the breakpoint (`:146-220`). This is the
  same defect `spec-cache-breakpoints.md` fixed for us in 0.2.11, arrived at independently.
- **Health signal is absolute `cacheRead` floors per lane, never a hit-rate percentage**, with a
  `disabled` control lane (`live-cache-regression-policy.ts:34`). Their doc: *"Comparing the two
  providers against a single cross-provider percentage threshold produces false regressions."*
- **`onPayload` doubles as a network-free test seam**: `packages/ai/src/providers/anthropic.test.ts:2370-2400`
  captures the payload, throws to abort before the network, and asserts wire byte stability across
  input permutations.

### Pi: the cost-denominated miss detector

`packages/coding-agent/src/core/cache-stats.ts` (~165 dependency-free lines):

```ts
const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;  // :70
```

That is **our `cache_shortfall_tokens` formula, derived independently**, with a `min()` guard we do
not have. Refinements worth taking:

- `NOISE_FLOOR_TOKENS = 1024` (`:11`), commented "cache breakpoint granularity noise."
- Reset on compaction and branch summary, **explicitly not on model switch** (`:112-119`): *"Model
  switches are NOT exempt: they re-bill the full prompt and should be counted."*
- Sticky `reportedCache` flag (`:42-47`) distinguishing "provider does not report caching" from
  "total miss."
- Cost computed at the actual paid rate including the write premium (`:77-86`), so the output is
  dollars.

They shipped a footer cache-hit-rate first (`CHANGELOG.md:950-957`) and **later moved to this**. Two
teams retiring the same ratio independently is strong validation of the 0.2.13 thesis.

Pi also has `onPayload` in all 11 provider adapters, fired on the exact object that gets stringified
(`openai-codex-responses.ts:283-287` then `:297`), documented as a debugging seam
(`packages/ai/README.md:982`) and **contractually required of third-party providers**
(`extensions/types.ts:1454`). Their `requestBodiesMatchExceptInput` (`:1393-1426`) is a real
prefix-identity check, used for WebSocket transport reuse rather than diagnosis.

Their `harness-v2.md:143-145` states the append-only-prefix law with compaction as the sole
exception, and specifies an executable test for it. **The test does not exist in their repo.**

### Hermes: make the miss impossible rather than observable

`agent/conversation_loop.py:535-670` persists the assembled system prompt in SQLite and **reuses the
bytes verbatim**, distinguishing four states (`missing`, `null`, `empty`, `present`) and logging
each at WARNING *"so silent prefix-cache misses are visible in agent.log"* (`:544`).

The reuse gate compares only four runtime-identity fields (model, provider, platform, cwd), never
the whole prompt, and the comment records why (`:697-702`): a naive whole-prompt scan once matched a
user's own config line and rejected the stored prompt on every turn, *"destroying the prefix cache
for the whole session, which is far worse than the staleness this function guards against."*

Also: `_content_cache_key` (`agent/transports/codex.py:137-173`) content-addresses the prefix into a
`prompt_cache_key` as `sha256(scope \x00 instructions \x00 sorted_tools_json)[:24]`, with tools
sorted by name and `\x00` separators *"so a scope/instructions/tools boundary can't be forged"*.
Their `_cache_scope_from_session_id` (`:19-28`) strips the per-fire timestamp from cron session IDs,
because **every cron run was cache-cold** (#51395, #52295).

**Checked against ours:** our `cacheKey` is `run.session_id` (`run.ts:1007`), a thread identity
spanning runs, and schedules resolve to an existing origin rather than minting a thread. Traced far
enough to stop chasing, not far enough to certify.

Their shipped health metric is `cached / prompt_tokens * 100`
(`agent/conversation_loop.py:3612-3621`) — the denominator artifact we retired. Their real
engineering metric, `occupancy_pct`, has no cache fields at all.

`tests/gateway/test_prompt_tail_freeze.py` is their best artifact: a 19-entry single-field mutation
matrix asserting *if the rendered bytes change, the cache key must change*, plus a literal two-turn
`sha256` equality test on the composed prompt.

## Q3 — capability drift is universal

All three ship the defect today. Details in
[`../spec-capability-prose-lock.md`](../spec-capability-prose-lock.md).

The one genuinely un-driftable mechanism found anywhere: OpenClaw's
`satisfies Record<SessionVisibilityScope, string>` on a copy table
(`tool-description-presets.ts:27-44`), which makes adding a capability **fail compilation** until
the prose exists.

## Q1 and Q2 — where we are already ahead

- **OpenClaw's raw wire capture has no bound at all.** `capture_*` tables grow until an operator
  types `purge`; their docs say so (`docs/cli/proxy.md:87`). Their *trajectory* capture, by
  contrast, has the right stack: per-event cap, per-session byte window, global byte budget, age
  TTL, swept on the write path, **with the active session exempt from eviction**
  (`trajectory/runtime-store.sqlite.ts:190, 199-202`). Same repo, opposite philosophies.
- **Pi has no capture feature at all**, and its session transcript is append-only and unbounded,
  deletable only one session at a time via a TUI hotkey.
- **Hermes captures full request bodies on API errors with no flag and no cap**; the force-redact
  call reads like a post-incident patch.
- **Spill files are never deleted by any of the three.** Pi and OpenClaw both leak `os.tmpdir()`
  indefinitely; Hermes sweeps two of five spill directories.

Our `calls` byte budget with newest-always-kept, plus `sweepSpill`, put us ahead of all three on
bounded local state. Hermes has the same newest-always-kept shape but only in their TypeScript TUI
(`ui-tui/src/lib/memory.ts:187-221`), not in the Python core.

**The one spill idea worth taking:** Pi converts a missing spill file into a normal
`isError: true` tool result so the model re-runs the command
(`packages/agent/src/agent-loop.ts:701-707`), rather than throwing. OpenClaw checks `existsSync`
before re-advertising a pointer during compaction
(`tool-result-truncation.ts:614-617`). Both are cheap; ours currently does neither.

## Q5 — the `/v1` diagnostic is a genuine gap in all three

- **OpenClaw** has the right sentence written (`provider-transport-fetch.ts:425-433`) and it is
  **unreachable**, short-circuited by `if (!params.response.ok ...) return` at `:395`. Their 404
  maps to `MODEL_NOT_FOUND_USER_TEXT`, which is actively wrong guidance for a base-URL error.
- **Hermes** diagnoses it at setup time only (`hermes_cli/model_setup_flows.py:944-966`); their
  runtime 404 branch explicitly declines to classify.
- **Pi** has no `/v1` hint at all; their only related code goes the other way, avoiding a
  double-append.

We shipped this on `main` on 2026-08-10. It is the one place in this comparison where we are
unambiguously ahead of all three on a user-facing surface.

## Q6 — the three roadmap claims we had been repeating

All three were carried in `shipping-list.md` from the Agent Harness teardown and had not been
re-read against source. All three verified, one materially more precise than we had it.

- **OpenClaw's TTL-gated prune: CONFIRMED and sharper than our note.**
  `tool-result-truncation.ts:170-237`. Gate chain: TTL lapsed → pressure ≥ 0.3 → soft trim (results
  over 4000 chars become head 1500 + tail 1500) → still ≥ 0.5 **and** ≥ 50,000 prunable chars →
  hard clear. Non-destructive `transformContext` projection, so the transcript is never rewritten.
  **The clock resets only when the projection actually changed something.** Auto-enabled for
  Anthropic auth at a 1h TTL. They shipped two bugs where compaction and the TTL marker fought into
  double compaction (#28548, #13514).
- **Hermes' idle compaction: CONFIRMED.** `agent/turn_context.py:280-311`, wall-clock idle gap,
  orthogonal to the token threshold, **off by default**, with a floor gate so a small thread never
  pays. It breaks the prefix cache by design when it fires and nothing in the code reasons about
  that; default-off is doing the load-bearing work.
- **Pi's `cacheRetention: "none"` on summary calls: CONFIRMED and generalised further than we
  guessed.** `packages/agent/src/harness/compaction/compaction.ts:110-115` also rotates the routing
  session ID, so provider-side session-affinity caching is defeated too. It was a one-liner for them
  because **all** breakpoint placement funnels through one `getCacheControl()` that returns no
  `cacheControl` field when retention is none, making every placement site an unconditional spread.

**The free cost lever nobody had told us about:** OpenClaw sets the heartbeat just under the cache
TTL (55m against 1h), converting a full re-cache into a cache read on an idle lane
(`docs/reference/prompt-caching.md:63-72`). Ferni is exactly that shape.
