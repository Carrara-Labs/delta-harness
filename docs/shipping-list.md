# Delta shipping list (as of 2026-08-01)

Prioritized across both packages. Two security releases stay isolated + codex-gated; everything
else is low-risk and sequences freely. Shipped items at the bottom for context.

## P0 — none open

The security track (the vault + secure intake) shipped 2026-08-01. Next work is P1 below.

## P1 — leapfrog + robustness fast-follows

- **Connect S4 — Rich Messages (native rich blocks).** Telegram Bot API 10.1/10.2 (2026) added
  Rich Messages + `sendRichMessageDraft` for streaming AI replies: tables, task lists, LaTeX,
  collapsible details, media rendered NATIVELY instead of the current Markdown downgrade. Neither
  OpenClaw nor Hermes uses it — a clear lead. Opt-in + client-support-gated.
- **Harness — spill demotion / compact sooner.** Demote re-billed `web_fetch` spill bodies to disk
  on later turns (the mechanical cause of Ferni's context ballooning to 155k). Cuts context growth
  at the source.
- **Harness — subagent reliability.** `spawn_subagent` returned "(no output)" on a big extraction
  task, which pushed Ferni onto the costly direct-`web_fetch` path.
- **Ferni upgrade to 0.2.10 + 0.4.0.** Prepared, not applied: `connect/deploy/UPGRADE-0.4.0.md`.
  Step 2 adds Connect's first public listener to a live personal agent — an operator decision.

## P2 — self-extension frontier (earn-it, deferred)

- **Harness 0.3.0 — self-extension.** Gated self-wiring MCP (curated registry + name-referenced key
  + runtime commit) + skill authoring (`create_skill` validated write-rail). The vault's
  name-referenced credentials are the prerequisite this was waiting on.
- **Connect 0.5.0 — self-extension edge.** One-time-link secret fallback + a self-wiring
  approve/confirm surface. Needs H0.3.0.

## Cross-cutting

- **Cookbook — autonomous agent setup (Ferni-style).** Update
  `reference_telegram_assistant_recipe` + the cookbook doc so a new Ferni-style agent is configured
  to survive heavy loads from day one (async delivery, utility model, heavy-run POLICY, compaction
  tuning, the subagent caveat), and now the vault + intake wiring.
- **Semver drift.** `src/version.ts` documents additive = MINOR, but 0.2.7 through 0.2.10 all
  shipped additive work as third-digit bumps. Either the doc or the practice should move; the
  release counter is currently the de-facto convention.

## Recently shipped (context)

- **Harness 0.2.10 + Connect 0.4.0** (2026-08-01) — the security track. Final combined battery
  passed 16/16 on a fresh agent running BOTH published artifacts. Encrypted secret vault
  (values never reach model-readable state; `{{vault:NAME}}` resolved at egress; exact-value
  redaction) and in-chat secure intake (Telegram Mini App form POSTing straight to Connect,
  initData-authenticated, single-use). On npm + ghcr; site live.

- **Harness 0.2.8 + Connect 0.3.1** (2026-08-01) — command-surface polish: `/status` plain English