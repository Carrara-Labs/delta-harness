# Aperture R1–R9: verified verdicts and the final 0.2.15 cut

2026-08-19. Triage of `~/ai-recruiter/docs/research/qs-harness-asks-2026-08-19.md` (169 runs,
$849.44, six workspaces, 0.2.11 → 0.2.14 mid-period). Every verdict below was checked two ways:
the receipt recomputed from the raw JSONL in `qs-review-2026-08-19-data/`, and the engine claim
read at the line in this repo. This is the last input to the 0.2.15 cut — the version boundary is
now closed.

> **Post-Codex revision (same day).** An adversarial Codex pass over this doc and the code demoted
> A-3 and A-5 to 0.2.16 (both honestly MEDIUM), split A-4 (ship the structured-refusal half, defer
> the overflow-path promise into R3d), corrected the R1/R2 ship version to **v0.2.4**, and hardened
> A-1/A-2 (appendix bytes reserved inside `SUMMARY_CAP`; `tool.rejected` added to the exporter's
> payload-event set with a closed reason enum). The final cut and full corrections live in
> `harness-0.2.15-plan.md` §Addendum. Dispositions below that conflict with the addendum are
> superseded by it; the *verdicts* (what is real, what is config, what already shipped) stand.

**Numbers verified against the raw receipts** (my recomputation ≈ their claim in every case):
remember refusals 86/240 full-period, 25/98 post-upgrade, speed-lab 21/32, alpha-school 35/61 ·
identifier loss 34% post-upgrade (n=35) vs 18% pre (n=192), worst rows 30/30, 25/25, 23/23 ·
first-response p50 43 s / p90 152 s / max 579 s (n=103) · cache shortfall 979,147 tokens across
162 rows, all 162 with stationary `spine_hash`+`tools_hash`, worst single row 107,983.

## The one-line headline

**Three of the nine asks are already shipped** — the engine work for R1 and R2 has been on their
fleet since 0.2.5/0.2.10, and R7's proximate failure is most likely a missing `readOnlyHint` on
their own MCP server. The biggest speed wins this week need **no release at all.** What does earn
a slot in 0.2.15 is five small LOW-risk items, led by R4 (the identifier appendix), which is the
only ask on the board that closes a *wrong-artifact* failure mode.

## Verdicts

| Ask | Verdict at the line | Disposition |
|---|---|---|
| R1 suspend | **Engine work already shipped.** Lease renew-or-reacquire landed 0.2.10 (`6e36b99`, changelog credits "Aperture A2"); the post-resume stale-connection stall was fixed in 0.2.5 (first-byte deadline + self-healing wire). Their fleet has run both all period — under stop-mode, unexercised. | **No engine work.** Soak = flip ONE bench lane (speed-lab) to Fly suspend now; watch `lease` + first-turn events for the week. Demo day: keep the machine STARTED (their own 24h plan — correct, and bigger than R1 for one afternoon). |
| R2 heartbeat | **Engine surface already shipped.** `turn.start` emits per turn since 0.1.0 (`run.ts:999`); SSE `GET /v1/tasks/:id/events` with coarse mode + the cursor-paged JSON poll shipped in **0.2.10** (`aee23a9` — literally labeled "A1" in the code). `model.retry` flows on it live. The sync seam also streams (`server.ts:650`). | **Host wiring, zero engine risk, same-day.** The single biggest perceived-speed lever for the demo: first signal 43 s → ~1–2 s. Send them the endpoint guide (§Reply below). |
| R3a inconsistent cap | **Not reproducible in the engine.** `writeSelf` rejects on `Buffer.byteLength > maxBytes` — same check, every path (agent `remember`, Cockpit edit), unchanged since 0.1.0. Telemetry shows each lane's cap constant within the captured window. Six over-cap landings (10,251…9,837 B vs 9,600) require the cap to have been higher at those moments — and "self-cap raises" is on Aperture's own ownership list. | Ask for alpha-school's daemon env history before touching the engine. No change without evidence. |
| R3b disable-after-3 | **Confirmed, and deliberate**: `self_cap` is a STORM_CLASS (`run.ts:1415`), three refusal-turns quarantine `remember` for the run — built after the effort-lab's 100+-refusal, ~$10 grinding storm. The cost they report (rest-of-run lessons lost) is also real. | **0.2.15, message-only**: (1) every `self_cap` refusal carries the CURRENT file + exact byte headroom so one-shot compression can succeed without a re-read; (2) the latch norm names a concrete overflow path ("write lessons to `<file>` now, merge next run") instead of a dead end. No semantic change; the breaker stays. |
| R3c distill-on-refuse | Real ask, rewrites agent-authored text. | 0.2.16 canary (they volunteered lanes). |
| R3d scoped memory rail | The three lanes independently built the identical hot-file + cold-notes design in userspace — the workaround is the spec. | Roadmap; design together with R3c. Include their "learned entries want a re-verify-after-upgrade affordance" note (the `qs_step` stale-superstition case). |
| R4 identifier appendix | **Confirmed** at `compaction.ts:488–535`: extract → summarize → audit → retry once with the misses listed → then **accept whatever remains**, even 30/30 missing. The ≤25% accept gate means a passing summary can still drop a quarter of audited identifiers, and the audit result is telemetry-only. Post-upgrade regression 18%→34% verified. | **SHIP 0.2.15.** After the retry loop, append the still-missing identifiers to the summary as a machine-built appendix — the exact pattern of the W1 artifact ledger ten lines below it (`collectArtifacts`). Deterministic, bounded, summarizer-independent. The one ask that closes a *wrong-artifact* class. |
| R5 sticky provider health | **Confirmed**: the ladder is a stateless per-call loop (`provider.ts:230–255`); a billing-400 primary is re-tried on every call for 5 hours (121 doomed hops on 08-11). | **0.2.16** (failover semantics change; needs the billing-class-only first ship + TTL re-probe design). Today: their alarm can already key on `model.retry kind=next_provider` — it carries the error. Demo day: pre-check credits (their plan). |
| R6 cache-diagnosis pass-through | **Beta verified against Anthropic docs** (2026-08-19): `anthropic-beta: cache-diagnosis-2026-04-07`, request `diagnostics.previous_message_id`, response `cache_miss_reason.type` ∈ model/system/tools/messages_changed + `cache_missed_input_tokens`. Best-effort (never fails the request), streaming-compatible (arrives on `message_start`, which we already parse), Claude-API-only — which the QS lanes are. | **SHIP 0.2.15**, opt-in (`DELTA_CACHE_DIAGNOSIS=1`): send header + field on the Anthropic wire, carry the previous response id per run, copy the diagnosis onto `model.call` telemetry. This makes their 162-row dataset — and OUR open stationary-prefix defect — self-labeling, and largely replaces the manual Ferni capture session we had planned. Their standing dataset offer: accepted. |
| R7 sub-agent tools | **Split verdict.** Children DO inherit the parent's read-only tools, including MCP tools — IF the server sets `readOnlyHint` (`mcp.ts:327`, fail-closed). Their data tools almost certainly don't set it, so children got web-only and guessed. The child error "`is not active — search_tools for it first`" (`research.ts:235`) is the same reject-instead-of-activate defect as R9b. | **Host first, no release**: annotate their read-only MCP tools with `readOnlyHint: true` — likely un-bans parallelism (their largest unquantified latency lever) this week. Engine: R9b's auto-activate applies to the child site too (below). Full credential/parity design: 0.2.16+. Credentials are moot for MCP tools — children call through the parent's live connections in-process. |
| R8 utility-tier cache | Real but the smallest item ($3.29/fortnight) and the summary prompt's prefix is mostly unique per call (the bounded transcript), so marks alone recover little. | **0.2.16** — the CachePlan M-batch applies marks uniformly to the utility lane anyway. |
| R9a `tool.rejected` | **Confirmed**: the `!tool` branch (`run.ts:1587`) returns the error string and emits **nothing** — the class is invisible in telemetry, frequency unknowable. | **SHIP 0.2.15.** One `events.emit("tool.rejected", …)` (name + reason). |
| R9b auto-mount named tool | The machinery exists (`activate`/`persistActive`, `run.ts:391–397`). Policy is unchanged by the fix: the tool must already be in the profile's `allowed` set — only *residency* changes. | **SHIP 0.2.15**, both sites: parent `execCall` and child `research.ts:235`. Model names an allowed-but-unactivated tool → activate + execute instead of reject-search-reissue. Kills the A14 class (~48 s + ~$1 + cache bust per incident) and R7's proximate failure in one fix. |

## The final 0.2.15 cut

Delos batch (unchanged, `harness-0.2.15-plan.md`): D-1 ask-pin first, D-9-min exhaustion handoff,
D-3+D-2 tool usability, D-12 codex output cap, D-7 scratch dir, + one-diffs (D-8, D-4, D-5,
DELTA_MAX_STEPS floor).

**Aperture additions, all LOW risk, each ≤ ~30 lines + a fail-without-fix test:**

| # | Item | Test that fails without it |
|---|---|---|
| A-1 | R4 identifier appendix after the summary retry loop | stub summarizer that drops ids → summary text contains every audited-missing identifier; `identifiers_missing` in the event unchanged (it measures the *summarizer*, not the shipped text) |
| A-2 | R9a `tool.rejected` event | call an unknown tool → exactly one event with name + reason |
| A-3 | R9b auto-activate named allowed tools (parent + child sites) | call an allowed-but-unactivated tool → executes, lands in `runs.tools`; a NOT-allowed tool still rejects (and now emits A-2's event) |
| A-4 | R3b-min: `self_cap` refusal carries current file + headroom; latch norm names an overflow path | refusal message contains the current DELTA.md and the exact byte gap; latch message contains a writable path |
| A-5 | R6 cache-diagnosis pass-through (opt-in `DELTA_CACHE_DIAGNOSIS=1`) | with flag: request carries beta header + previous id, `model.call` event carries `cache_miss_reason` when present; without flag: request byte-identical to today (inert-is-first-class) |

Not in: R5 (0.2.16, semantics), R3c (0.2.16 canary), R8 (0.2.16 CachePlan), R3d/R7-full (design).

## The no-release lane — this week, demo-critical, host-side

1. **R2 wiring** (Aperture): consume `GET /v1/tasks/:id/events?coarse=1` (SSE) or the JSON poll in
   the QS room. First signal 43 s → ~1–2 s. Biggest single demo lever, zero engine risk.
2. **R7 annotation check** (Aperture): set `readOnlyHint: true` on their read-only MCP tools;
   verify with one spawn on a bench lane. Potentially halves long-run wall clock.
3. **R1 soak** (Aperture, config): speed-lab → Fly suspend mode; watch lease + first-turn events.
   Production lanes stay stop-mode until the soak is green. Demo machine stays STARTED regardless.
4. **QS config canary** (ours, from `aperture-qs-tuning-findings.md`): `DELTA_TOOL_ARG_MAX_BYTES=4096`,
   `DELTA_CACHE_TTL=1h`, `DELTA_SELF_MAX_TOKENS` raise — pairs with their own ownership list.
5. **R3 pressure relief** (Aperture): cap raises + executing the agents' own trim ledgers.

## Their calibration items, answered

- The withdrawn cooldown ask and the softened save-refusal complaint both check out in our data
  reading too — the 0.2.14 before/afters they report match the changelog's claims (S5, compaction
  32/32). Their pipeline earns trust.
- The `qs_step` stale-superstition observation is folded into the R3d design brief: learned
  entries need a re-verify-after-upgrade affordance.
- Their 24-hour demo plan (machine started, credits pre-checked, room pre-opened) is correct and
  we endorse it as-is; nothing engine-side should be rushed inside the demo window.
