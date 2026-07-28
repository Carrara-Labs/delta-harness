# Backlog: Ferni field report → engine roadmap

Status: **backlog for the next harness release.** Captured 2026-07-28 from a live
dogfood session with Ferni (a Delta agent on Telegram via Delta Connect). We are
holding the engine at stable **0.2.4** while Quarry Brain and Aperture consume it;
this file is what ships next, not now.

## The two artifacts (source of truth for the visual detail)

- **Ferni field report → engine roadmap** (11 signals ranked, ship-map):
  https://claude.ai/code/artifact/85908367-3658-4fc2-88d4-4170e048ebba
- **Where Delta lands** (feature-by-feature teardown vs Pi / OpenClaw / Hermes):
  https://claude.ai/code/artifact/0d1330fc-c519-42ed-aea5-864c04656a33

Both are grounded in file-cited audits of `~/delta-harness/src`, `~/delta-connect/connect/src`,
and the actual cloned competitor source at `~/delta/.refs/{pi,openclaw,hermes-agent}`.

## What ships where and when

### Today, config only (no release)
- **Re-pin Ferni's chat model** off Opus. It is why a one-word "hey" costs Opus rates.
  Deployment config, not code.

### Next harness release: "the self-aware turn" (the quick wins)
Four small, engine-wide items. Theme: the turn becomes honest about its own budget.
- **Item 4 - budget self-awareness.** A coarse ephemeral "near the cap, wrap up now"
  signal (~85% of any axis) that rides a user message. NOT a raw counter (a raw number
  is gameable and no rival ships one either). Plumbing already exists
  (`ctx.remainingBudget()`, the live `usage` object); today it is only used to split
  sub-agent budgets, never surfaced to the model. Highest leverage on the list.
- **Item 2 - turn-failure integrity.** On budget-fail, `finalize` drops the run rows and
  returns bare text, but a committed `remember` write to DELTA.md landed silently. That
  violates our own error-as-value contract. Flush the todo state + signal the committed
  write.
- **Item 1 - cost pre-flight + headroom.** The cap is a between-steps check with no
  pre-flight estimate, so it overshoots ($0.35 on a $0.25 cap). Reserve headroom
  proportional to context before firing the next call.
- **Item 3 - spill demotion.** The retained ~20KB spill head+tail stays resident and is
  re-billed every step (the mechanical cause of item 1's overshoot). Demote it to the
  path on later turns. Folds into the queued compaction pass.

### The harness release after: hands + procedures
- **Assistant profile (items 6, 7).** A new contained profile between `chat` and `work`:
  chat + workspace-scoped `write_file` + `grep` + skills, with delegation and destructive
  ops still gated. Fixes "no durable work product" and "read-only trim" without opening
  the untrusted-inbound blast radius.
- **Skills, selectable backend (item 11).** One CapabilityAdapter, three modes, none
  mandatory:
  - `mcp` - the skill registry (Skillia). **First-class for cross-agent and human
    collaboration**; the right default for the fleet (Brain).
  - `local` - a zero-infra agentskills.io `SKILL.md` folder in the bundle, for a
    standalone agent. All three competitors (Pi, OpenClaw, Hermes) converged on this
    file format, proving first-class skills need no service.
  - `off` - **hard-invisible.** No retrieval block, no `skill_*` tools, no mention. The
    agent cannot see or infer a disabled skill system. (Change from today, where an
    unbound registry silently degrades to a DELTA.md `[skill-candidate]` learning.)
  - Invariant across all three: writes route through the existing reflection pass
    (never free-write); add a per-skill read-count so unused skills prune out.
- **Reasoning-effort control (item 5b).** The one honest gap vs OpenClaw on an Opus task.

### Ships nowhere (deliberate)
- **compact_self as a raw lever (item 10).** Against "engine owns mechanism, agent owns
  meaning." Covered more cheaply by item 3 + item 4 + Connect's `/new`.
- **Full per-complexity model router (item 5c).** Greenfield for the whole field, but a
  real build. The cheap half (re-pin + reasoning-effort) is pulled forward above.

## Competitor takes worth folding in later (all small, additive)
From the "Where Delta lands" teardown. Delta is at parity-or-ahead on all 14 dimensions,
in ~1.8% of OpenClaw's code with zero runtime deps. The borrows worth making:
1. **Skills cluster** - the selectable backend above + OpenClaw's requires-gating (never
   surface a skill whose backing tool is absent) + Hermes's patch-preference ladder
   (prompt-only, stops near-duplicates).
2. **Resilience trio** - Pi's truncated-tool-call guard + OpenClaw's bounded
   tool-call-repair for weak models + Hermes's error classification (moderation terminal,
   quota fail-over-now). All error-as-value, a few lines each.
3. **Supply-chain + audit** - SHA-pin GitHub Actions, min-release-age on devDeps, a CI
   audit step (Pi); metadata-only-by-default local events table (OpenClaw).
4. **Ops semantics** - at-most-once cron (advance-before-dispatch) in the control-plane
   ticker; non-restart exit code for a supervised duplicate daemon.

## What Delta correctly refuses (the leanness dividend)
No local vector store, no plugin catalog / registry, no channels/devices in the engine,
no MCP server (client only), no 4-layer permission matrix (the VM is the boundary), no
autonomous self-patching learning loop, no 26k bootstrap spine. Each is a per-dimension
choice, documented in the teardown artifact.
