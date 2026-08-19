# Harness 0.2.16 — the OpenAI-native batch (plan)

Status: **FINAL, 2026-08-19.** Cut from `docs/spec-responses-first-class.md` +
`docs/spec-provider-controls.md` (M1–M5), revised by the Codex spec review (4 BLOCKERs,
5 SHOULD-FIXes — session `01a0196c…`, full report in the scratchpad JSONL) and a live
re-verification of the OpenAI docs (prompt-caching, reasoning, conversation-state, migrate,
API reference, pricing — all fetched 2026-08-19). Where Codex and the live docs disagreed,
the live docs won; every arbitration is recorded below.

Driver: Aperture Quick Search demo on `gpt-5.6-sol`, metered `api.openai.com`,
`MODEL_API=responses`, in front of an OpenAI co-founder. House rules: least code, one
placement brain per concern, inert-is-reported, error-as-value, test-first.

## The regression gate

The Anthropic wire emits **byte-identical** requests before and after this batch, and the
Chat/OpenRouter wire must never see a new assistant field (Codex BLOCKER 4: a Responses-origin
field leaking through failover is a terminal 400 on a strict endpoint). Body-capture tests pin
both. The mature Anthropic body builder is NOT refactored (Codex: "do not move it to satisfy
an abstraction") — the provider-controls spec's CachePlan/ModelControls types are dropped as
types; their intent ships as per-wire code + honest reporting.

## Review arbitration record (what changed vs the specs)

Codex confirmed, we adopt:
- **Capture from `response.output_item.done`** (finalized items, `added` is in-progress), and
  send `include: ["reasoning.encrypted_content"]` explicitly — the API reference documents it
  as the opt-in; the migrate guide says 5.6 includes it by default under `store:false`; sending
  it is correct on either reading. Denied on `chatgpt.com` until probed (D-12 rule).
- **Chat-wire strip** for new assistant fields (BLOCKER 4) — verified: `withPromptCache`
  returns assistant rows verbatim into the chat body (provider.ts:875→951).
- **Compaction reset** (BLOCKER 2): retained assistant rows carry reasoning generated against
  the prefix compaction just replaced → strip `reasoningItems` from retained rows at the
  compaction commit (which already rewrites them; zero extra cache churn). The "since the last
  user message" boundary hazard (derived user-role blocks at run.ts:~820/~1001) dissolves under
  positional replay: items ride their own assistant row, full-history replay is the pattern
  OpenAI's conversation-state guide itself uses.
- **No cross-wire numeric positions** (BLOCKER 3): the codebase ALREADY has the right pattern —
  `rollingMarks` (the shared walker) invoked twice with wire-specific eligibility/blocksAt over
  each wire's own shape (chat: provider.ts:~897; Anthropic native: ~1263). M2 is the third
  instance, over the rendered `ResponsesInputItem[]`. No CachePlan type, no cross-wire
  position-equality test.
- **`cache_write_tokens` is nested**: `usage.input_tokens_details.cache_write_tokens`
  (caching guide + openai-python `ResponseUsage` type). M3 parses the nested field.
- **Slot budget correction** (SHOULD-FIX 6): `ROLLING_MARKS = 3` since commit 1b0cb70 — the
  Anthropic wire uses 1 stable + up to 3 rolling = all 4 slots; the surrounding comments are
  stale (fixed in this batch). On Responses, implicit mode's own breakpoint consumes a write
  slot (caching guide), so the renderer caps explicit marks at **3**.
- **Identifier-harvest pollution** (SHOULD-FIX 5): `extractIdentifiers` scans raw row JSON
  (compaction.ts:~506) — encrypted blobs would feed digit-runs into the A-1 appendix. Strip
  `reasoningItems` from the harvest input.
- **`/v1/status` honesty** (SHOULD-FIX 9, narrowed): report configured controls once + what the
  configured wire renders vs leaves unmapped. The full per-provider failover matrix is LATER.
- **`DELTA_SPEED` wording** (SHOULD-FIX 7, split): report it as "**not mapped** on the
  responses wire" — true regardless of whether OpenAI's fast/priority service tiers apply to
  5.6 (Codex claims they exist; the flex guide documents only `flex` for 5.6; unresolved).
  Mapping speed→`service_tier` goes to LATER pending verification, and we never ship the
  claim "no equivalent exists".

Codex rejected (its citations failed verification against the live pages):
- sol pricing "$2.50/$15" — the live pricing page says **$5 in / $0.50 cacheRead /
  $6.25 cacheWrite / $30 out**; terra $2/$0.20/$12; luna $0.20/$0.02/$1.20. (Its "80
  breakpoints read" vs the guide's 50 is likewise rejected; irrelevant to the code either way.)
- Its in-response interleave requirement (replay reasoning strictly by `output_index` even when
  reasoning/message/call groups interleave inside ONE response) is acknowledged but not built:
  we replay a turn's reasoning items in arrival order **before** that turn's text/calls — the
  exact order OpenAI's own guidance sentence prescribes. The multi-group edge is a documented
  caveat + a probe question, not 2 extra persisted fields. Least code wins until the wire
  objects.

Live-docs findings the specs missed (both adopted):
- **Assistant `phase` (GPT-5.5+)**: dropping it makes the model "treat an intermediate update
  as the final answer" (conversation-state guide) — a premature-final-answer risk for QS.
  Rides with M1: capture from the message item, replay on the Responses wire, strip elsewhere.
- **Breakpoint carriers are input blocks only** (`input_text`/`input_image`/`input_file` —
  API reference): tool results (`function_call_output`, string output) and assistant
  `output_text` cannot carry marks. M2 eligibility = user message items; a marker on a wrong
  block is a 400, so the body tests carry the weight.

## The cut

| # | item | size | notes |
|---|---|---|---|
| M1 | ReasoningCarry + phase carry: `include` (host-gated), capture from `output_item.done`, `AssistantMsg.reasoningItems?/phase?`, positional replay on Responses, strip on chat wire, compaction strip + harvest strip | ~60 lines + tests | the vendor-documented quality gap, twice over |
| M2 | Responses breakpoint renderer: `rollingMarks` walker + Responses-native eligibility over rendered items, ≤3 explicit marks, implicit kept, gated to 5.6+ models AND off `chatgpt.com` | ~45 lines + tests | additive; cuttable before M1 if the clock says so |
| M3 | Parse nested `cache_write_tokens` → `usage.cacheWrite`; real `gpt-5.6-sol/terra/luna` prices (long-context tier noted as un-modeled; `DELTA_MODEL_PRICES` is the correction path); `max` added to `KNOWN_EFFORTS` | ~12 lines | cost truth: sol under-bills ~4× today via the `gpt-5` prefix match |
| M4 | `DELTA_TEXT_VERBOSITY` → `text.verbosity`; `DELTA_REASONING_SUMMARY=auto` → `reasoning.summary` (both denied on chatgpt.com); boot line + `/v1/status` for unmapped configured controls (`speed` on responses; `verbosity`/`summary` elsewhere) | ~30 lines | no ModelControls type, no Anthropic-builder refactor |
| M5 | Probe request to Delos: include/replay, `phase`, `text.verbosity`, `reasoning.summary`, `prompt_cache_breakpoint`, `prompt_cache_options.ttl` on chatgpt.com. All new params ship default-DENIED there; predicates flip on evidence | doc + predicates | nothing new to chatgpt.com unprobed — M5 does not block the metered demo lane |
| C1 | Child provider 400s: log line + telemetry event (Delos gate finding — 24/24 child failures invisible in stdout) | ~10 lines | shares the release, not the provider diff |
| C2 | Self-file write collision → bounded retry (48 on fleet) | ~10 lines | small, fleet-measured |

Deferred, with reasons: speed→`service_tier` mapping (verify first), `service_tier:"flex"`
for utility/children, `gpt-5.6-luna` utility default, explicit-only cache mode,
`reasoning.context:"current_turn"` post-compaction, A-3 auto-activate (gated on Aperture's
tool.rejected baseline), R5/R3c/R8, D-9-full, history-digest investigation, named session
standing goal (gated on W1), full per-provider effective-controls matrix, in-response
interleaved replay ordering (probe first), Anthropic headroom asymmetry (needs its own
measurement pass).

## Order (test-first, one commit per slice)

1. **M3** — smallest; cost truth unblocks measurement for everything after.
2. **M1** — quality core. Tests: two-turn replay (second request carries turn-1 reasoning
   before its function_call), phase round-trip, chat-wire strip, Anthropic byte-identity,
   compaction strip, harvest strip, done-vs-added capture.
3. **M4** — knobs + honest reporting.
4. **M2** — cache renderer. Tests: marks only on user `input_text`, ≤3, absent off-5.6/on
   chatgpt/host-denied, stable across transcript growth, implicit mode untouched.
5. **C1, C2.**
6. Codex full-diff review → fix round → full battery: `bun test`, `scripts/smoke.sh`,
   `--from-source` deploy, live Responses-wire check (fixture capture against api.openai.com
   if a metered key is available). **Stop before publish — Nic's call.**

M5's probe request goes to Delos early (it runs in parallel and blocks only the codex-lane
upgrade, not the demo lane).

## Post-implementation Codex diff review (same day) — the fix round

1 BLOCKER + 7 SHOULD-FIX, all verified against source before acting; all fixed except two
recorded here: (NIT) an append-append merge whose result exceeds the cap falls back to the
conflict contract rather than the over-cap message — costs one model turn in a rare corner;
(INFO) `DELTA_CAPTURE_CALLS=1` retains full response messages including encrypted reasoning —
intentional for a diagnostic knob that is off by default, but treat capture DBs as sensitive.
Fixed: crash-replay idempotency of the C2 merge (suffix-already-landed detection), landed-content
tracking through the run's writeSelf wrapper, retention accounting on stripped rows (blobs can't
evict visible history), the stable cache mark now respects the ephemeral boundary, all three new
predicates flipped from chatgpt-denylist to openai.com ALLOWLIST (the acceptsPromptCacheKey
precedent — proxies keep the 0.2.15 surface), unmappedControls is host-aware, eligible() cannot
throw on malformed persisted carry, and byte-identity is pinned by full-body-equality tests on
both the Anthropic and chatgpt.com wires.
