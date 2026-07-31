# Roadmap — Delta Harness

What ships next, and where each item comes from. This is the forward-looking companion to
[`CHANGELOG.md`](./CHANGELOG.md): the changelog records what shipped, this file records what is
queued and why. Every item cites its origin so the reasoning is auditable, not folklore.

**Current state:** engine is stable at **0.2.4** (npm `latest`, tag `v0.2.4`, ghcr image). We are
deliberately **holding** the engine here while Quarry Brain, Aperture, and Ferni consume it. Nothing
below is in flight; this is the staged backlog, ordered.

**Visual version:** [interactive roadmap](https://claude.ai/code/artifact/c9b829f9-ab9a-419f-801b-01567f9a7c45)
— the same content with a three-level zoom (Overview → Builder → Metal), a source cited on every card.

## How to read this

- Items are grounded in real dogfood sessions and file-cited source audits, not speculation.
- Each item names its **source** (the report, session, or competitor source it came from).
- SemVer holds: everything queued is additive (MINOR) unless explicitly marked breaking.
- The engine charter still governs. Anything that would add channels, devices, an MCP server, a
  plugin catalog, a coding toolset, or a local vector store is out of scope by construction (see
  [`CLAUDE.md`](./CLAUDE.md) "What Delta is (and isn't)").

## Sources (provenance)

| Tag | What it is | Where it lives | Date |
|-----|-----------|----------------|------|
| **Ferni** | Live Telegram dogfood of a Delta agent (Ferni) via Delta Connect; 11 ranked signals + ship-map | [`docs/backlog-ferni-field-report.md`](./docs/backlog-ferni-field-report.md) + [ship-map artifact](https://claude.ai/code/artifact/85908367-3658-4fc2-88d4-4170e048ebba) | 2026-07-28 |
| **Teardown** | Feature-by-feature comparison vs the real Pi / OpenClaw / Hermes source | [teardown artifact](https://claude.ai/code/artifact/0d1330fc-c519-42ed-aea5-864c04656a33), grounded in `~/delta/.refs/{pi,openclaw,hermes-agent}` | 2026-07-28 |
| **Aperture** | Structured field report from the ai-recruiter (Aperture) integration, A1-A13 | `~/ai-recruiter/docs/research/harness-field-report.md` | 2026-07-27 |
| **Connect** | Channel-edge backlog from the same Ferni session (separate package) | [`docs/delta-connect/backlog.md`](./docs/delta-connect/backlog.md) | 2026-07-28 |

The two Ferni/Teardown artifacts are the source of truth for the ranked visual detail; the markdown
files are the durable summary.

---

## Next release: "the self-aware turn"

Theme: the turn becomes honest about its own budget. Four small, engine-wide items. The plumbing for
most of this already exists; it is a surfacing and correctness pass, not new machinery.
**Source: Ferni** (`docs/backlog-ferni-field-report.md`, "the quick wins").

### 1. Budget self-awareness (Ferni item 4) - highest leverage
A coarse, ephemeral "near the cap, wrap up now" signal (~85% of any budget axis) that rides a user
message. Deliberately **not** a raw counter: a raw number is gameable and no rival ships one either
(Teardown). The plumbing is already here (`ctx.remainingBudget()`, the live `usage` object); today it
is only used to split sub-agent budgets, never surfaced to the model.
**Source: Ferni item 4.** Rank: highest leverage on the list.

### 2. Turn-failure integrity (Ferni item 2)
On a budget-fail, `finalize` drops the run rows and returns bare text - but a committed `remember`
write to `DELTA.md` lands silently anyway. That violates our own error-as-value contract (the turn
reports failure while a side effect persisted). Flush the todo state and signal the committed write.
**Source: Ferni item 2** (observed live). Correctness, not cosmetics.

### 3. Cost pre-flight + headroom (Ferni item 1)
The cap is a between-steps check with no pre-flight estimate, so a turn overshoots (measured $0.35 on
a $0.25 cap). Reserve headroom proportional to context before firing the next call, instead of
discovering the overrun after it happens.
**Source: Ferni item 1** (measured overshoot).

### 4. Spill demotion (Ferni item 3)
The retained ~20KB spill head+tail stays resident and is re-billed every step - the mechanical cause
of item 3's overshoot. Demote it to the path on later turns. Folds into the queued compaction pass, so
it is cheap to land alongside items 1-3.
**Source: Ferni item 3.** Bundles with the compaction work.

---

## The release after: hands + procedures

Bigger, contained additions. Each expands what an agent can *do* without widening the untrusted-inbound
blast radius. **Source: Ferni** (`docs/backlog-ferni-field-report.md`, "hands + procedures") unless noted.

### 5. Assistant profile (Ferni items 6, 7)
A new contained profile sitting between `chat` and `work`: chat + workspace-scoped `write_file` +
`grep` + skills, with delegation and destructive ops still gated. Fixes two observed gaps at once - "no
durable work product" (item 6) and "read-only trim" (item 7) - without opening the blast radius that
`work` carries. **Source: Ferni items 6 + 7.**

### 6. Skills, selectable backend (Ferni item 11)
One `CapabilityAdapter`, three modes, none mandatory:
- **`mcp`** - the skill registry (Skillia). First-class for cross-agent and human collaboration; the
  right default for the fleet (Brain).
- **`local`** - a zero-infra `agentskills.io` `SKILL.md` folder in the bundle, for a standalone agent.
  All three competitors (Pi, OpenClaw, Hermes) converged on this file format, which is the evidence
  that first-class skills need no service (Teardown).
- **`off`** - hard-invisible. No retrieval block, no `skill_*` tools, no mention; the agent cannot see
  or infer a disabled skill system. This is a change from today, where an unbound registry silently
  degrades to a `DELTA.md` `[skill-candidate]` learning.
- **Invariant across all three:** writes route through the existing reflection pass (never free-write);
  add a per-skill read-count so unused skills prune out.

**Source: Ferni item 11**, reinforced by **Teardown** (competitor convergence on `SKILL.md`).

### 7. Reasoning-effort control at the profile level (Ferni item 5b)
The one honest gap vs OpenClaw on an Opus task. Note: the *wire* half of reasoning-effort already
shipped (native adaptive thinking, 0.2.3, Aperture A8) - this item is the remaining
per-profile/per-task control surface on top of it. **Source: Ferni item 5b.**

---

## Competitor borrows worth folding in later

All small and additive. Delta is at parity-or-ahead on all 14 dimensions in ~1.8% of OpenClaw's code
with zero runtime deps; these are the specific things worth taking. **Source: Teardown**, grounded in
`~/delta/.refs/{pi,openclaw,hermes-agent}`.

1. **Skills cluster** - the selectable backend above + OpenClaw's requires-gating (never surface a
   skill whose backing tool is absent) + Hermes's patch-preference ladder (prompt-only, stops
   near-duplicates).
2. **Resilience trio** - Pi's truncated-tool-call guard + OpenClaw's bounded tool-call-repair for weak
   models + Hermes's error classification (moderation terminal, quota fail-over-now). All
   error-as-value, a few lines each.
3. **Supply-chain + audit** - SHA-pin GitHub Actions, min-release-age on devDeps, a CI audit step (Pi);
   metadata-only-by-default local events table (OpenClaw).
4. **Ops semantics** - at-most-once cron (advance-before-dispatch) in the control-plane ticker;
   non-restart exit code for a supervised duplicate daemon.

---

## Delta Connect (channel edge)

`@carrara-labs/delta-connect` versions independently of the engine; the engine stays channel-free by
charter. **Source: Connect** (`docs/delta-connect/backlog.md`).

**Deferred (stored, not next):**
- Second channel adapter (Slack / email).
- Streaming / draft-in-place replies - deferred until the engine exposes a final-answer phase.
- Scheduler bridge (`schedule_self` -> timed sends).
- Group chat - needs the `session_principal` / `actor_id` split.
- Out-of-band cancellation (`DELETE /v1/tasks/:id`).

**Borrow from OpenClaw's channel layer (edge, not engine):**
- Shared `message` tool + `describeMessageTool` adapter - one message capability with per-channel
  action adapters instead of N send-tools.
- Throttled single-flight draft streaming back to chat.

---

## Shipped recently (context for the above)

Not a roadmap item - recorded here so nobody re-files something that already landed. Full detail in
[`CHANGELOG.md`](./CHANGELOG.md).

### Aperture field report (A1-A13) - fully cleared across 0.2.2-0.2.4
The entire Aperture ask list shipped. **Source: Aperture** (`~/ai-recruiter/docs/research/harness-field-report.md`).

| Ask | Shipped in | What |
|-----|-----------|------|
| A7 | 0.2.2 | `DELTA_STEP_MAX_TOKENS` per-tool-call output cap with honest truncation |
| A4 | 0.2.3 | Categorical-failure breaker (kills the retry loop) |
| A5 | 0.2.3 | `code` tool self-disables on boot probe |
| A6 | 0.2.3 | `error` field on `GET /v1/tasks/:id` |
| A3 | 0.2.3 | Lifecycle timestamps (created/started/finished) |
| A8 | 0.2.3 | Native adaptive thinking wire |
| A9 | 0.2.3 | Model-id normalization (primary + fallbacks) |
| A10 | 0.2.3 | Opus 5 in the price table |
| Part 2 | 0.2.3 | Four lifecycle contracts documented + guard-tested |
| A1 | 0.2.4 | Pollable per-task event feed + `cache_hit_pct` |
| A2 | 0.2.4 | Suspend-safe resume (cold start 4.7s -> 1.1s) |
| A12 | 0.2.4 | `delta bundle apply` (re-seed fixed files, never DELTA.md) |
| A13 | 0.2.4 (partial) | Scoped memory: deterministic recall, isolation, widening auth-gate. Open thread: is the `audience` taxonomy host-extensible, or is org-unit a separate app-side scope dimension? (recommendation: keep audience a fixed trust axis) |

### Ferni Connect quick wins - shipped in delta-connect 0.2.0
`/new` (Ferni item 9) and inbound file receipt (Ferni item 8) both shipped. **Source: Connect**
(now in the delta-connect 0.2.0 changelog). File receipt requires harness >= 0.2.4 (`POST /v1/files`).

---

## Deliberately not shipping (the leanness dividend)

Recorded so the "why not" is durable and nobody re-opens it without new evidence.

- **`compact_self` as a raw lever (Ferni item 10).** Against "engine owns mechanism, agent owns
  meaning." Covered more cheaply by item 4 (spill demotion) + item 1 (budget signal) + Connect's
  `/new`. **Source: Ferni item 10.**
- **Full per-complexity model router (Ferni item 5c).** Greenfield for the whole field but a real
  build; the cheap half (re-pin off Opus + reasoning-effort) is pulled forward instead. **Source:
  Ferni item 5c.**
- **Standing refusals (Teardown).** No local vector store, no plugin catalog/registry, no
  channels/devices in the engine, no MCP server (client only), no 4-layer permission matrix (the VM is
  the boundary), no autonomous self-patching learning loop, no 26k bootstrap spine. Each is a
  per-dimension choice documented in the teardown artifact.

---

*This file is hand-maintained. When an item ships, move it to `CHANGELOG.md` and strike it from the
queue above (or drop it into "Shipped recently" with its version). Keep the source citation attached
so the provenance survives the move.*
