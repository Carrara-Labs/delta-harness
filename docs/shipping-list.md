# Delta shipping list (as of 2026-08-01)

Prioritized across both packages. Two security releases stay isolated + codex-gated; everything
else is low-risk and sequences freely. Shipped items at the bottom for context.

## P0 — the Ferni-break fix (highest user impact, in build now)

- **Connect async + streaming — proposed 0.3.2.** Move Connect off the synchronous `/v1/responses`
  (fixed 180s timeout + serial-loop freeze) onto the async `/v1/tasks` surface, and use the same
  `/v1/tasks/:id/events` SSE stream for typing + streaming replies. Fixes the Ferni timeout, kills
  orphaned billing (cancellable), survives Connect restarts, and gives live feedback. Zero harness
  change. Spec: `docs/spec-connect-async-streaming.md`. Slices S1 (async core) + S2 (typing) + S3
  (streaming edit) ship together.
- **Ferni config/prompt quick wins — config only, no release.** Apply today:
  - `DELTA_UTILITY_MODEL=anthropic/claude-haiku-4.5` (QS has it; Ferni's compaction/reflection
    currently burn Opus).
  - Port QS's heavy-run POLICY lines: never loop a failing call (two failures = change approach),
    confirm before plans that burn serious spend, count before large pulls, never leave the user
    watching silent steps, batch tool calls (every extra turn re-reads the whole conversation).

## P1 — security track (planned, isolated, codex-gated)

- **Harness 0.2.9 — The Secret Vault.** Vault + name-resolution fenced from the file tools; no tool
  returns a secret value; inject-at-boundary; genuinely agent-unreadable.
- **Connect 0.4.0 — Secure secret intake.** Telegram Web App direct-POST to a new public HTTPS
  endpoint; initData auth; single-use TTL; no-log; writes the vault. Needs H0.2.9.

## P2 — leapfrog + robustness fast-follows

- **Connect S4 — Rich Messages (native rich blocks).** Telegram Bot API 10.1/10.2 (2026) added
  Rich Messages + `sendRichMessageDraft` for streaming AI replies: tables, task lists, LaTeX,
  collapsible details, media rendered NATIVELY instead of the current Markdown downgrade. Neither
  OpenClaw nor Hermes uses it — a clear lead. Opt-in + client-support-gated; after S1-S3, once the
  exact method signatures are confirmed from the full API reference.
- **Harness — spill demotion / compact sooner.** Demote re-billed `web_fetch` spill bodies to disk
  on later turns (the mechanical cause of Ferni's context ballooning to 155k). Cuts context growth
  at the source; complements the async fix.
- **Harness — subagent reliability.** `spawn_subagent` returned "(no output)" on a big extraction
  task, which pushed Ferni onto the costly direct-`web_fetch` path. Fixing it removes the pressure.

## P3 — self-extension frontier (earn-it, deferred)

- **Harness 0.3.0 — self-extension.** Gated self-wiring MCP (curated registry + name-referenced key
  + runtime commit) + skill authoring (`create_skill` validated write-rail).
- **Connect 0.5.0 — self-extension edge.** One-time-link secret fallback + a self-wiring
  approve/confirm surface. Needs H0.3.0.

## Cross-cutting

- **Cookbook — autonomous agent setup (Ferni-style).** Update
  `reference_telegram_assistant_recipe` + the cookbook doc so a new Ferni-style agent is configured
  to survive heavy loads from day one (async delivery, utility model, heavy-run POLICY, compaction
  tuning, the subagent caveat).

## Recently shipped (context)

- **Harness 0.2.8 + Connect 0.3.1** (2026-08-01) — command-surface polish: `/status` plain English
  + provider-above-model, `/model` resolved effort, `/provider`, safe-mode observable + self-aware,
  `/revert` tappable picker, `setMyCommands` "/" menu. On npm + ghcr; site live.
