# Guide: driving a Delta agent from the Quarry Brain chat UI

2026-08-21, from the Delta Harness maintainer. Companion to
`docs/reply-quarry-fleet-inventory.md` — deliberately a separate document. That one is
**Track A: diagnosis and the upgrade**. This one is **Track B: the product surface** — sessions,
tools, live insight, workspace view. Keep them separate in your planning too, because Track A
gates most of Track B: nearly every "insight" feature below reads attributes or endpoints your
0.2.4/2026.7.x images don't have. The order is: upgrade the fleet, then build the UI against the
current seam. What already works on 0.2.4 is marked.

Everything here was read out of the engine source (`/Users/nictouron/delta-harness/src/`,
current line 0.2.16), not from docs. Where I name an endpoint, it exists and I've quoted its
semantics from the code.

---

## 1. Sessions — the thing your UI is missing is one omitted field

There is no "create session" API because a session is not a resource you create — it is a
consequence of how you thread:

- `POST /v1/responses` (or `/v1/tasks`) **without** `previous_response_id` → the daemon opens a
  **fresh session** and returns a response id.
- The same call **with** `previous_response_id: <last response id>` → the turn joins that
  session, with its full history. Ownership is enforced daemon-side: a continuation inherits the
  original session's owner, and a `previous_response_id` pointing at someone else's session is
  rejected (`SessionOwnershipError`).

So the UI model is exactly your existing chat list: **one chat thread = one session**, the
thread's state is just "the last response id we saw", and the **"+" button = send the next
message with no `previous_response_id`**. No daemon call, no restart, nothing to provision.
Works on 0.2.4 today — your driver (`packages/harness/src/delta.ts`) already threads
`previousResponseId`; the only change is letting the user start a thread that doesn't.

Two things worth adding while you're in there:

- **Name the session server-side on your side** (first user message, like your current chat
  list) — the daemon deliberately has no session-title concept.
- **Session hygiene for long-lived agents:** an old thread accumulates history and compaction
  summaries. A "new session" button is also your cheapest performance feature — it resets the
  context window to the spine. Ferni's connect layer exposes exactly this as `/new`, plus
  `/status`, `/cancel`, `/restart`, `/model`, `/provider`, `/safemode`, `/revert`. In a real UI
  those become buttons, not chat strings — but the command set is a good checklist of what
  operators actually reach for.

---

## 2. Adding tools — what needs a restart and what doesn't

The lifecycle, from the code:

1. MCP servers are declared in **`DELTA_MCP_SERVERS`** (JSON array, env). Env is read **once at
   boot**. The daemon connects each server, calls `tools/list` once, and folds the tools into
   the live registry namespaced `<server>__<tool>` (your `brain__get_meeting_context` is this).
2. **Hot path — credentials:** the registry supports hot add/remove, and the trigger is
   **credential intake**. A server that is *declared* but unusable (no secret yet) comes alive
   the moment its credential lands in the vault (`PUT /v1/secrets/<name>`, 0.2.10+): the daemon
   reconnects that server, re-lists its tools, and registers them — **no restart**. The status
   report is written to keep this honest (a boot-time omission is filtered against the live
   registry precisely because a reconnect can register it later).
3. **Cold path — topology:** a **new** server entry, a removed one, or new tools appearing on an
   **already-connected** server (the tool list is a connect-time snapshot) need the env updated
   and the daemon restarted. The restart is cheap — the binary cold-starts in <10 ms and
   `recover()` resumes any mid-flight run from the SQLite journal — so "restart to apply" is a
   few seconds of unavailability, not a disruption. One bad server never stops boot (errors are
   returned per-server and reported), so a connector typo degrades, it doesn't brick.

**The provisioning pattern that follows:** have the connectors page **declare broadly, credential
lazily**. Provision the agent with every connector the org might grant already declared in
`DELTA_MCP_SERVERS` (a declared-but-credentialless server costs one failed connect and a clean
`unusable` status line), then "adding a connector" in the UI is usually just delivering the
secret — the no-restart path. Only genuinely new topology takes the env-update-and-restart path,
and **that path must go through your provisioner** (`reconcile`/`upgrade`, never a hand
`fly machines update`) or you re-create the meeting-processor drift documented in Track A.

Don't fear large tool counts: the prompt does not carry the whole registry. Tools beyond the
active set are reachable via on-demand `search_tools` (your side panel already says
"on-demand tool search" — that's this), so a 158-tool Slack connector doesn't blow the spine.

**What the connectors page should render** (one call, `GET /v1/status`, 0.2.15 shape) — the
three-state tool report, because the operator's next action differs per state:

| state | meaning | UI action |
|---|---|---|
| `registered` | offered from the live registry | — |
| `unusable` + reason | registered, but a call would fail NOW (usually a missing credential) | "Provide credential" → vault intake, heals without restart |
| `omitted` + reason | failed a boot precondition, never registered | "Fix config & restart" |

---

## 3. Telemetry and the context-window meter

**Provision telemetry at creation, always.** Two env lines: `TELEMETRY_URL` (your collector)
and `DELTA_CAPTURE_PAYLOADS=1`. Without the second, a pre-0.2.6 binary exports *nothing* and a
current one exports the `SAFE_ATTRS` subset — which, post-upgrade, is actually enough for every
widget below (tokens, cost, latency, cache, anatomy — no prompt text ever). So on 0.2.16 you
can run capture OFF for meeting-content agents and still get the full dashboard; that's the
privacy default I'd pick for Quarry.

**The context meter** (the Claude-Code-style gauge you want) is one division, from data the
engine already exports per model call (0.2.13+):

    fullness ≈ (history_bytes/4 + spine+tools+self+ephemeral bytes/4) / DELTA_COMPACT_AT_TOKENS

Render the segments, not just the total — spine / tools / self / history / ephemeral is exactly
the "what's eating my window" answer, and a `compaction` event is your natural "context
compacted" divider in the transcript (it carries `compacted_turns`, `kept`, `summary_tokens`).
Also worth surfacing per turn: `gen_ai.usage.cost_usd`, `cache_hit_pct` (a cold cache on every
turn is a misconfiguration your UI can catch), and — 0.2.16 — `is_error` + `error.class` on
failed calls, so a dying child is a red row instead of silence.

**Live activity (the "agent is using Slack…" shimmer):** two surfaces, pick per context.

- `GET /v1/tasks/:id/events` — **persisted** progress events for a specific run
  (`turn.start`, `model.call`, `tool.call`, `tool.result`, `checkpoint`…), SSE or poll. Exists
  on 0.2.4. This is the right feed for the chat transcript's tool chips, and it doubles as your
  liveness detector (Track A finding 5): status `running` + no new events = wedged.
- `GET /v1/dev/stream` — the firehose including ephemeral `output_text.delta` /
  `reasoning.delta` (streamed only, never persisted). This is behind the **inspect** credential,
  which is root on the agent — proxy it through your control plane for operator views; never
  hand the token to a browser.

And before you build any dashboard widget: open **`GET /dev`** on an agent. The daemon ships a
single-file Cockpit UI (exists on 0.2.4) that already renders the stream, runs, tables, and
self-file revisions. It is deliberately unpolished — but it is a working reference client for
every endpoint in this section, and your fastest path is to crib its fetch calls.

---

## 4. The workspace view

What's inside is small and legible — five bundle files plus engine state:

| file | what it is | UI treatment |
|---|---|---|
| `DELTA.md` | the **living self-file**: identity + `## Learned`, agent-editable via `remember` | THE one to show. Read via `GET /v1/dev/files`; every self-write is versioned — `GET /v1/dev/self/revisions` is a ready-made "what has this agent learned" timeline, and `POST /v1/dev/self/revert` is your undo button (all on 0.2.4) |
| `POLICY.md` | the fixed operating contract, rendered last, non-overridable | read-only display |
| `PROMPT_CONTEXT.md` | dynamic per-turn vars | read-only, mostly debug |
| `vocab.json` | the write rail | read-only |
| `delta.env` | backends/keys/budgets | on your deployments this is env, not a file — show the machine env (minus secrets) instead |
| `.delta/` (spill, research), `scratch/` | engine-managed intermediates, run-scoped, auto-wiped | don't render as "documents"; at most a size line |

Two gauges worth putting next to the file view (both from `GET /v1/status`): **self-file
fullness** — across the Aperture fleet, a full `DELTA.md` silently refusing every `remember`
was the single best predictor of degraded self-learning — and the **budget** block. Note that
`PUT /v1/dev/files` writes bundle files to disk but **restart applies** (deliberate: dev equals
prod); only `DELTA.md` via the agent's own `remember` is live.

---

## 5. The side panel, mapped

Your current panel (machine / model / tools / brain) is the right skeleton. Post-upgrade, one
authenticated `GET /v1/status` fills most of it from the daemon itself rather than the
control-plane DB — which also structurally fixes the "four disagreeing version surfaces"
finding, because the panel now reads the machine:

engine `version` (render it!) · `model` · canonical `profile` · `budget` · `safe_mode` ·
`mcp_servers` · the three-state `tools` block (§2) · `vault` (count + declared names — gates
your credential-intake UX) · `self` fullness (§4). Add the context meter and last-turn cost
from telemetry (§3), and "last activity" from your own `agent_events` rather than `agent_runs`
(Track A, finding 3).

## 6. Restart cheat-sheet

| change | restart? |
|---|---|
| new session | no — omit `previous_response_id` |
| credential for a declared MCP server | no — vault intake reconnects it |
| new/removed MCP server; new tools on a connected server | yes — env via provisioner, then restart |
| bundle file edits (`POLICY.md`, vocab, PROMPT_CONTEXT) | yes — writes land, restart applies |
| `DELTA.md` via `remember` / revert | no — live |
| model/budget/compaction env | yes — env is boot-read |

A restart is <10 ms cold start + `recover()` resuming mid-flight runs. Design the UI as if
restarts are cheap and routine, because they are; just always route them through the
provisioner's env-safe path.

## 7. Interactive results — a caution and a pattern

Rendering richer results in chat: yes — the run's `output_text` is markdown, render it well,
and the tool-chip timeline from task events gives you the Quick-Search-style "watch it work"
feel (Aperture's 40-minute autonomous runs are readable precisely because every tool call and
reasoning summary streams as it happens; on the OpenAI lane, 0.2.16's `reasoning.summary`
stream is your dead-air filler). But keep the write-rail invariant: interactive cards should
render *proposals and results*, not become a second write path into the Brain. "An agent
proposes, a human disposes" is the best property your system has — an approve button on a card
in chat is fine **if** it drives the same disposition endpoint the inbox drives, with the human
still the actor.

## 8. What's next

This was batch one — making the current UI honest and live against the seam. Batch two (say the
word) is the proven-config playbook: the bundle layout, budgets, effort/compaction tuning, and
hydration patterns that make a Quarry agent behave like Quick Search does — all of it measured
config from our fleet, most of it already written up in the Aperture handover docs and directly
transplantable once you're on 0.2.16.

— Delta Harness
