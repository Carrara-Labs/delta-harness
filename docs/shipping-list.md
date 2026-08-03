# Delta shipping list (as of 2026-08-03, after 0.2.11)

Prioritized across both packages. Two security releases stay isolated + codex-gated; everything
else is low-risk and sequences freely. Shipped items at the bottom for context.

## P0 — none open

The security track (the vault + secure intake) shipped 2026-08-01. Next work is P1 below.

## Observing (NOT scheduled) — Ferni field report #2

`docs/backlog-ferni-field-report-2.md`, captured 2026-08-01. Dogfooding continues; we want more
data before shipping any of it.

- ~~Prompt caching collapses on long threads.~~ **FIXED in 0.2.11.** The rolling breakpoints were
  landing on derived per-turn blocks, one carrying a clock, so the cached prefix could never be
  matched. Ferni measured 11% before, 91% after.
- ~~Compaction cannot get under the budget.~~ **FIXED in 0.2.11.** It was 94 of 94 fleet-wide, not
  "every turn" as this list once said; the tail it keeps was never re-bounded.
- **`list_secrets` / `vault.declared` conflate "in the vault" with "available to the agent".**
  Found by Ferni itself while self-diagnosing. One coherent fix covers both.
- **Operator actions are invisible to the agent** — a credential removed behind its back produced
  a confident wrong diagnosis. The arrival case is now handled; removal is not.
- Smaller: `spawn_subagent` running 300s, the `code` CLI missing from the Ferni image.

## Shipped — Harness 0.2.11 "Context economics" (2026-08-03)

The cache-breakpoint fix, the compaction-tail fix, `prompt_cache_key` on the OpenAI-compatible wire,
and the `max_tokens` deprecation. Published to npm + ghcr; Ferni is on it and the site is deployed.
Specs: `spec-cache-breakpoints.md`, `spec-compaction-tail.md`.

## Next — fleet upgrade, then what 0.2.11 deliberately left

1. **Aperture QS lab lane to 0.2.11**, then the rest of QS, then Intake. Beneficiary and volume rig
   in one.
2. **Meeting Processor last**, as a beneficiary of a proven fix, never as a testbed.
3. **Anthropic's block-count cache lookback.** Demotion shrinks a tool result's size, not its block
   count, so a turn with many parallel tool calls can still miss the previous cached tail.
4. **Budget pre-flight headroom.** A `$10` cap produced `$12.02`.
5. **Idle compaction** (Hermes' `_should_idle_compact`) — compact while idle rather than only under
   pressure. Needs a scheduler hook and has its own failure modes.

## P1 — leapfrog + robustness fast-follows

- **Connect — stream the reply text itself.** 0.5.0 ships rich rendering and a live "what I am
  doing" line, but deliberately not the answer as it is written: only a step with no tool calls
  becomes the answer, so the model's narration can claim things that are never sent, and the token
  deltas are not persisted so it needs a live SSE per task with its own abort and restart story.
  Worth doing on its own terms, not folded into a rendering release.
- ~~Harness — spill demotion.~~ **SHIPPED in 0.2.11**, at the compaction commit rather than per
  turn, so it costs no extra prefix-cache churn.
- **Harness — subagent reliability.** `spawn_subagent` returned "(no output)" on a big extraction
  task, which pushed Ferni onto the costly direct-`web_fetch` path.
- **Connect — the intake 409 durability gap.** If the vault write commits but its response is
  lost, the retry hits the create-only 409 and neither the confirmation nor the agent note fires,
  so a stored credential looks like a failure. Codex found it during the 0.4.3 review. Deliberately
  NOT fixed there: the cheap fix (treat 409 as success) would tell someone their value was saved
  when a different value is in the vault. Wants a real answer, so it waits for a batch.

## P2 — self-extension frontier (earn-it, deferred)

- **Harness 0.3.0 — self-extension.** Gated self-wiring MCP (curated registry + name-referenced key
  + runtime commit) + skill authoring (`create_skill` validated write-rail). The vault's
  name-referenced credentials are the prerequisite this was waiting on.
- **Connect 0.6.0 — self-extension edge.** One-time-link secret fallback + a self-wiring
  approve/confirm surface. Needs H0.3.0.

## Cross-cutting

- **Cookbook — autonomous agent setup (Ferni-style).** Update
  `reference_telegram_assistant_recipe` + the cookbook doc so a new Ferni-style agent is configured
  to survive heavy loads from day one (async delivery, utility model, heavy-run POLICY, compaction
  tuning, the subagent caveat), and now the vault + intake wiring.
- **Semver drift.** `src/version.ts` documents additive = MINOR, but 0.2.7 through 0.2.10 all
  shipped additive work as third-digit bumps. Connect has since gone the other way, taking 0.5.0
  for an additive release, so the two packages now disagree with each other as well as with the
  doc. Either the doc or the practice should move.
- **`npm deprecate` @carrara-labs/delta-connect@0.4.0 and @0.4.1.** Needs Nic's npm auth. Never
  `unpublish`.
- **Struck as stale:** "harness v4 live smoke, never run against a live daemon." That lineage
  landed - `retrieval.ts`, `research.ts` and `compaction.ts` are in `main` and Ferni has exercised
  them in production since 0.2.10.

## Recently shipped (context)

- **Connect 0.5.0** (2026-08-02) — rich streaming: replies render as Telegram Rich Messages
  (native tables, task lists, headings, code, math) by handing the agent's markdown to Telegram's
  own parser rather than our renderer, plus an ephemeral progress line naming the tool in flight,
  driven by the daemon's existing `?since=` event poll. Four codex passes (the first two returned
  DO-NOT-RELEASE) and live-verified on Ferni against the real Bot API. Corrects a claim this list
  carried: OpenClaw ships Rich Messages already, and Hermes ships rich drafts too, so this is
  parity done in far less code rather than a leapfrog.
- **Connect 0.4.3** (2026-08-02) — what Ferni was already running: the agent is told when a
  credential lands (no restart, and no more routing around a tool that started working),
  intra-word underscores stay literal so a credential name is never renamed by the renderer, an
  outcome-first confirmation, and the note attributed to the actual submitter. Ferni ran all four
  in production before the release; codex then found a double-underscore case
  (`mcp__brain__authenticate`) and a Unicode word-boundary case that live use had not hit.

- **Harness 0.2.10 + Connect 0.4.0** (2026-08-01) — the security track. Final combined battery
  passed 16/16 on a fresh agent running BOTH published artifacts. Encrypted secret vault
  (values never reach model-readable state; `{{vault:NAME}}` resolved at egress; exact-value
  redaction) and in-chat secure intake (Telegram Mini App form POSTing straight to Connect,
  initData-authenticated, single-use). On npm + ghcr; site live.

- **Harness 0.2.8 + Connect 0.3.1** (2026-08-01) — command-surface polish: `/status` plain English