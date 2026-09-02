# Orientation: the Quarry Brain fleet — fixes, UI, and the proven-config playbook

2026-08-21, from the Delta Harness maintainer. This is the master document; the two companions
carry the receipts:

| Doc | What it is |
|---|---|
| `delta-harness/docs/reply-quarry-fleet-inventory.md` | **Track A — fixes.** Your five findings answered, every claim verified against the live DB, the live machine, and the tagged source. |
| `delta-harness/docs/guide-quarry-agent-ui.md` | **Track B — the chat UI.** Sessions, tools, telemetry insight, workspace view, mapped to the real seam endpoints. |
| this file | **Track C — the config playbook.** How to set up a Quarry agent using what two production Delta agents have already proven. |

Read them in that order: A gates B (most insight endpoints don't exist on your 0.2.4 images),
and C is what you apply *during* A's step 3 (the env reset) and to every agent you provision
after.

---

## Part 1 — the fixes, in six steps (Track A condensed)

1. **Snapshot the meeting-processor volume**; verify `DELTA.md` is in the archive. The 0.2.13
   migration is one-way — a rollback below it will not boot.
2. **Upgrade one low-traffic agent** to 0.2.16 and watch it for a day.
3. **Upgrade the meeting processor and reset the machine env to the bundle in the same change**
   (values in Part 3) — via the provisioner's env-safe path, never a hand machine-patch.
4. **Re-drive the 17 stuck meetings by hand.** They cannot self-heal: a failed `store:false`
   run purges itself (your zero-trace contract) and your sweep abandons rows older than 6h.
5. **Re-run your finding-1 query a week later.** It returns zero rows today (the attributes it
   needs shipped in 0.2.13); after the upgrade it answers assembly-vs-history on your own
   workload.
6. **Then build the UI** (Part 2).

Three things to decide before step 3, not discover after: sol metering rises **~4×** at 0.2.16
(it was under-billed — raise `DELTA_MAX_COST_USD` deliberately); `DELTA_MAX_STEPS=160` is inert
on 0.2.4 and **goes live** at 0.2.15; the compaction thrash behind your 829 errors was the
0.2.4 ceiling-derived tail, so after the upgrade the 80–100k threshold is a cadence knob, not a
reclaim knob.

---

## Part 2 — the UI, in six moves (Track B condensed)

1. **New session = one omitted field.** Send the next turn without `previous_response_id` —
   there is no "create session" API to build, and it works on 0.2.4 today. One thread = one
   session; the "+" button is also your cheapest performance feature (fresh spine, empty
   window).
2. **Tools: declare broadly, credential lazily.** A *declared* MCP server whose secret arrives
   via the vault (`PUT /v1/secrets/<name>`) reconnects and registers its tools **live, no
   restart**. Only new topology (a new server entry, or new tools on an already-connected
   server) needs env-update + restart — which is <10 ms cold start with mid-flight runs
   resumed. Render the three-state tool report from `GET /v1/status`: registered / unusable +
   reason (→ provide credential, heals live) / omitted + reason (→ fix config, restart).
3. **Provision telemetry at creation, always** (`TELEMETRY_URL` + capture flag). The context
   meter is one division on attributes every model call exports post-upgrade:
   spine/tools/self/history/ephemeral bytes over `DELTA_COMPACT_AT_TOKENS`. Render the
   segments — that's the "what's eating my window" answer.
4. **Live activity** from `GET /v1/tasks/:id/events` (persisted, SSE or poll, exists on
   0.2.4) — your tool chips in the transcript *and* your wedge detector for finding 5. Crib
   from `GET /dev`: the daemon ships a single-file cockpit that already exercises every
   endpoint here.
5. **Workspace view:** show `DELTA.md` with its revisions timeline and revert button
   (`/v1/dev/self/*`), POLICY read-only, and the **self-fullness gauge** from `/v1/status` —
   a full self-file silently stops all learning, and fullness was the best predictor of
   degradation on the Aperture fleet. Don't render `.delta/` or `scratch/`.
6. **Interactive cards: render richly, dispose identically.** An approve button on a chat card
   must drive the same disposition endpoint the inbox drives. "Agent proposes, a human
   disposes" is the best property in your system — the chat UI must not become a second write
   path into the Brain.

---

## Part 3 — the proven-config playbook

Two production agents are the evidence base. **Ferni** is the autonomous end of the spectrum: a
persistent Telegram companion, human-paced, self-learning, months of uptime, subscription model
lane. **Aperture Quick Search** is the long-running-task end: research runs of up to ~40
autonomous minutes on a metered lane, benchmarked across three tuning rounds (30 live runs) and
two model families. Your meeting processor sits between them — long autonomous runs (QS-like)
on a subscription lane with a learning loop (Ferni-like) — so it inherits from both. Your
bundle already gets most of this right; the playbook is what to keep, what to add, and the
numbers.

### 3.1 The bundle contract — identity, law, task (from QS, the D-1 lesson)

- **`DELTA.md` carries identity and method. `POLICY.md` carries law. The request carries the
  task.** Nothing task-specific in the first two; no standing instructions parked in the first
  request — session-start requests are not a place to keep a frame (on old engines, compaction
  pinned the first request as "the task"; 42/42 measured wrong-task on our fleet before 0.2.15
  fixed the pin).
- **Put the honesty contract in POLICY, explicitly.** QS's gap-trap data shows models honor it
  when told, in the non-overridable file: *prefer the newer source and say there was a
  conflict; say "not disclosed" rather than guessing; every claim must appear in fetched
  data.* Your meeting-processor equivalent (entailment + confidence rules) is already in the
  right file — keep it there, never in the request.
- **Raise the self/policy token budgets when the method is legitimately rich** — your
  `DELTA_SELF_MAX_TOKENS=3000` / `DELTA_POLICY_MAX_TOKENS=1200` with headroom for `## Learned`
  growth is exactly the pattern. One warning from your own comments worth repeating: an
  over-budget self-file is **silently middle-elided**, which can delete the method's core.
  Watch the fullness gauge (Part 2.5).

### 3.2 Budgets (both agents, plus the 0.2.16 correction)

| Knob | Ferni (autonomous) | QS lanes | Meeting processor, recommended |
|---|---|---|---|
| `DELTA_MAX_COST_USD` | 15 | per-lane | **≈25** (sol meters ×4 at 0.2.16; subscription lane ≈$0 marginal — but the same budget governs the metered fallback, where dollars are real) |
| `DELTA_MAX_TOKENS` | 3,000,000 | identical across lanes | 2–4M |
| `DELTA_MAX_STEPS` | profile default | profile default | decide (goes live at 0.2.15; 100–160) |
| `DELTA_STEP_MAX_TOKENS` | 16,384 | — | 16–32k |

Budgets are error-as-value: a run that hits one returns the exhaustion handoff (plan + spill +
research artifacts, 0.2.15) instead of losing the work — but only if the run is durable; an
ephemeral run keeps zero-trace. Which is why finding 5's fix matters more than generous budgets.

### 3.3 Context and compaction (QS + your own bundle history)

- **`DELTA_COMPACT_AT_TOKENS`:** 80–100k for deep multi-entity work on the codex/sol backend
  (its effective window is tighter than a raw 200k API — your bundle comment measured this;
  we observed a 253,993-token pre-error request that no window accepts). Ferni runs 130k on a
  roomier lane. Post-0.2.13 this knob is *when*, never *how much* — the retained tail is a
  flat 24k.
- **`DELTA_TOOL_RESULT_MAX_BYTES`: leave the 20k default.** Big results spill to files the
  agent pages via `read_file`. The hand-patched 200k created single ~50k-token messages that
  nothing can split — the one genuine "irreducible" in your data.
- **`DELTA_SCRATCH_DIR` beside the DB, off the workspace** (Ferni: `/data/scratch`). The
  workspace is the agent's document tree, not a dump for intermediates. Your
  `{{run.scratch}}` advertisement in PROMPT_CONTEXT is the right companion — distilled notes
  survive compaction, raw context doesn't have to.
- **Hydration over history:** your `DELTA_HYDRATE_TOOLS` (meeting + scope before turn 1) is
  the pattern we point other consumers at — task context arrives fresh and pageable instead of
  accumulating as conversation.

### 3.4 Model lanes (the tuning data, so you don't re-run our experiments)

- **Reasoning effort is the biggest lever and more is usually worse.** 30 live QS runs:
  `low` tied `medium`/`high` on hard-task quality (27/27 facts, 6/6 conflict flags, 0
  inventions per arm) while `medium` spent +46% tool calls, +20% wall, +23% cost — and made
  the only real user-facing error. ~95% of per-call latency is the silent thinking window;
  effort widens exactly that. For your meeting processor your own data says **`medium`** (async
  "get it right" work; `low` under-extracted hard multi-topic meetings, `high` ground 20+
  minutes and blew the budget without filing — the live machine currently runs `high`; revert
  it). Per-run override exists (`metadata.reasoning_effort`) — fixed per agent, varied per
  task type if you ever need it.
- **Utility model per wire:** on Anthropic lanes run a cheap utility model
  (`DELTA_UTILITY_MODEL=claude-haiku-4-5…` — Ferni's old lane, QS Opus lanes) so summaries
  and compaction don't burn frontier tokens. On a **subscription** Responses lane leave it
  empty — utility rides the main cascade at ≈$0 marginal (Ferni today). On a **metered**
  OpenAI lane use `gpt-5.6-luna` (QS sol lanes).
- **Cache discipline:** Anthropic lanes serving human-paced agents set `DELTA_CACHE_TTL=1h`
  (Ferni's lesson: messages hours apart, the 5-minute TTL was cold on nearly every first
  turn). Responses lanes need nothing — breakpoints/`prompt_cache_key` are automatic on
  0.2.16. Verify, don't assume: on any new lane, run one two-turn task and check turn 2 shows
  `cached_tokens ≈ full prefix`.
- **Fallback is config, not luck:** keep a keyed fallback provider (`DELTA_PROVIDERS`,
  OpenRouter or Anthropic) for broker exhaustion — Ferni keeps OpenRouter behind the
  subscription lane. Remember the budget governs both lanes (3.2).
- **`DELTA_MODEL_PRICES`** overrides metering for models the table doesn't know — after
  0.2.16 you shouldn't need it for the 5.6 family, but it's the knob if your dashboards want
  lane-specific rates.
- **Wire hygiene:** don't set knobs the lane can't render (verbosity/summary on the codex
  backend) — 0.2.16 names anything unmapped on the boot line and in `/v1/status`; a clean
  boot line is part of done.

### 3.5 Telemetry doctrine (Ferni's, adopt it fleet-wide)

- **`DELTA_CAPTURE_PAYLOADS=1` on every agent — or, post-upgrade, deliberately off.** Without
  it, a 0.2.4 binary exports *nothing* on model calls (your 1,602-row null band); a current
  binary exports the `SAFE_ATTRS` subset — tokens, cost, latency, cache, anatomy, error class,
  **never prompt text or tool payloads**. For meeting-content agents, capture OFF on 0.2.16 is
  the right privacy default and still powers every dashboard widget.
- **`DELTA_CAPTURE_CALLS` stays OFF.** It snapshots full request+response (~95 KB/call, no
  retention sweep; it once ate 16.5 MB of a 1 GB volume). Doctrine: the always-on segment
  hashes tell you *which* prompt segment moved; switch capture on for **one session** to find
  *which byte*, then off.
- **Cheap alerts that pay rent:** `context_irreducible` rate (should collapse post-upgrade),
  `cache_hit_pct` cold streaks, self-fullness > ~80%, and (0.2.16) `is_error` on child calls.

### 3.6 Ops and security (Ferni's deployment shape)

- **Loopback the seam.** `DELTA_BIND=127.0.0.1` where a same-machine connector drives the
  daemon; your flycast-private topology is the equivalent — keep exactly one public surface
  per machine, and never expose the inspect credential to a browser (it's root on the agent;
  proxy it through the control plane).
- **Secrets ride secrets** — `setAppSecrets()` / the vault, never machine env (finding 4).
  The vault path is also your no-restart connector heal (Part 2.2).
- **The safe-learning trio** for agents that should learn: `DELTA_PROFILE=trusted` +
  `DELTA_ALLOW_SELF_WRITE=1` + `DELTA_REFLECT=1`, with `DELTA_INSPECT_WRITE=1` enabling
  revert. Your reflect loop tiered by `task_type` ("meeting-processing") is the right
  recall pattern — corrections on one meeting surface on the next.
- **Gate inbound hard** (Ferni: one allow-listed Telegram user id; intake refuses to start
  unless non-empty). Your equivalent: the agent-guard chokepoints — already right.
- **Operator commands as precedent:** connect exposes `/new /status /cancel /restart /model
  /provider /safemode /revert`. In your UI these become buttons, but the list is a checklist
  of what operators actually reach for — note `/safemode` (boot with no MCP, for a wedged
  agent) and `/revert` (undo a bad self-write) as the two you'll want on day one.

### 3.7 The verification ritual (what "configured correctly" means, from the QS protocol)

Per lane, ~5 minutes, after any provision or env change:

1. Boot line clean — no unmapped controls, no unexpected omitted tools.
2. `GET /v1/status` — version, canonical profile, budget, `tools.unusable` empty (or
   explainable), self fullness sane.
3. One throwaway two-turn task — turn 2 shows `cached_tokens ≈ full prefix`.
4. Telemetry rows arriving with attributes (not the null band).
5. Then, and only then, point real traffic at it.

---

## The one-paragraph version

Upgrade the fleet off 0.2.4 (snapshot first; three deliberate decisions on the way), reset the
hand-patched machine to its own bundle with the numbers above, re-drive the 17 by hand, and let
the finding-1 query answer itself on real data. Build the UI on the seam — sessions are a field
omission, connectors heal live via the vault, the context meter and tool timeline come from
telemetry and task events you already collect. And configure every new agent the way the two
proven ones are configured: identity/law/task separation, honesty in POLICY, effort tuned by
data not vibes, scratch off the workspace, 20k tool caps, capture-payloads decided consciously,
budgets that hand work back instead of losing it, and a five-minute verification ritual before
traffic. Your architecture was never the problem — close the drift and the same system gets
Quick-Search-grade behavior.

— Delta Harness
