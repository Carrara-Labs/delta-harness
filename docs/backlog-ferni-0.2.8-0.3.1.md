# Backlog: Ferni field report #2 → Harness 0.2.8 / Connect 0.3.1

Status: **the next release — Harness 0.2.8 + Connect 0.3.1, ships FIRST (before the
secret-vault security track).** Captured 2026-07-31 from Nic's live dogfood of Ferni on
the released Harness 0.2.7 + Connect 0.3.0. The core loop (file write/read, research-report
skill → cited file, scheduler fire, code rendering, document sends, safemode/restart/revert)
all worked in this session — verified in the Fly logs (see "Log verification" at the bottom).
This batch is **command-surface polish + observability**, not engine mechanics. Theme: make
the operator commands legible and honest.

**Sequencing (Nic, 2026-08-01):** this low-risk polish ships first to get the visible
`/status`/`/provider`/`/revert` wins onto the phone fast, so the security-first "autonomous
turn" roadmap shifts down one engine number: the **Secret Vault moves to H0.2.9** (was 0.2.8)
→ Connect 0.4.0 secure intake (needs H0.2.9) → later H0.3.0/C0.5.0 self-extension frontier.
The two security releases stay isolated + codex-gated; this batch must NOT be bundled into
them. See [[project_delta_autonomous_turn]] for the full versioned roadmap.

Principle for every item below: lean and simple. Most of this lives in Connect
(`connect/src/core.ts`), not the engine. The engine changes are tiny read-side additions.

## A. `/status` — plain English (Connect: `formatStatus`, core.ts:56)

Today it prints raw caps: `Budget/run: steps: 100 · tokens: 3000000 · cost USD: 15`.
- Reframe as human-legible per-run ceilings: `Budget per task: 100 steps · 3M tokens · $15 max`.
- **Show the provider ABOVE the model.** `/v1/status` already carries `api` + `base_url`
  (config.ts:349-358) and the daemon knows the credential type (BrokerCredential = a
  subscription / codex sign-in). Derive one friendly label: `anthropic-native` /
  `openai-native` / `openrouter` / `codex-sign-in`. Add `provider` to the `model` view in
  config.ts so Connect can render it without guessing.

## B. `/model` — always resolve effort (Connect: `formatStatus`, core.ts:62-70)

Effort only prints when `DELTA_REASONING_EFFORT` is set; Ferni's is unset so `/model`
showed only the model. Never leave it blank — when unset, resolve to `adaptive` (or
`provider default`). Cheap: config.ts can emit a resolved-effort string instead of
omitting the field.

## C. Add `/provider` (Connect: core.ts async intercepts + HELP)

Dedicated command naming the active provider + the failover chain (`primary → openrouter`).
Shares the provider-label helper with A. One extra async intercept next to `/model`/`/status`.

## D. `/help` — remove the awkward line break (Connect: HELP, core.ts:41-53)

The opening sentence is split across two array entries joined by `\n`, so it hard-wraps
mid-sentence ("hand me a task,⏎or think out loud") on every screen. Merge into one entry;
let the client wrap. Trivial.

Also clarify the `/revert` help line so it reads as **self-written memory**, e.g.
`/revert - roll back a note I wrote to my own memory (operator only)`.

## E. Safe mode — observable + self-aware (Connect + engine)

Two gaps Nic hit: after `/safemode` you had to read the Fly log to confirm it worked, and
the agent still answered "who are you?" as Ferni (because safe mode strips the boot-time
persona/POLICY/PROMPT_CONTEXT from the spine, but the running **session thread** — ~28k
tokens of prior turns — is still replayed, so the model infers its identity from history).

- **Expose `safe_mode` in `/v1/status`** (server.ts:357 — add one field from `config.safeMode`).
  Then Connect's `/safemode` reply and `/status` both show it:
  `Safe mode: ON — persona, policy and learned memory are not loaded. Conversation history
  still applies until /new.`
- **Make the agent itself aware.** When `safeMode` is on, inject a one-line ephemeral spine
  note ("You are running in SAFE MODE: your configured persona and learned self-file are
  not loaded this run."). Lean — one conditional block in the spine builder — and it makes
  the model honest instead of role-playing the persona from thread history.
- Doc/UX note: to *demonstrate* safe mode, pair it with `/new` (fresh thread) so no prior
  identity leaks in. Worth a line in the guide.

## F. `/revert` picker — list before you pick (Connect + one engine read endpoint)

Nic wants bare `/revert` (no id) to show the choices: a clean short id, a timestamp, a
size-of-change hint, and a one-line topic; then tap to restore.

**Feasibility as it stands** (checked `self.ts` + `self_revisions` table, db.ts:262):
- Short id (`#12`): **yes** — `self_revisions.id` is already a monotonic int (it IS the
  current `/revert <id>` arg). `listRevisions(db)` already exists (self.ts:163) and returns
  `{id, ts, content}[]`.
- Timestamp: **yes** — `ts` is stored.
- Size-of-change ("+N lines"): **yes, derivable** — `listRevisions` returns full `content`,
  so diffing a revision against the next gives an added/removed line count. No schema change.
- One-sentence topic: **not stored.** Two lean options, pick one:
  1. **Diff excerpt (leanest, recommended):** show the first added/changed line of each
     revision. Zero cost, no model call, honest.
  2. **Stored note:** add a `note TEXT` column to `self_revisions`, populated at write time
     (the `remember` tool passes a short reason). Cleaner label, tiny schema add.
  Do NOT generate a summary sentence per revision at list time — that's a model call each,
  not lean.

**Wiring needed:** the engine already has `listRevisions`; expose it over the seam as
`GET /v1/revisions` (data-free, seam-token-gated like `/v1/status`). Connect's bare `/revert`
calls it and renders the list.

**Selection syntax:** Nic suggested `/revert-12`. Telegram bot commands are `[a-z0-9_]`
only, so a hyphen breaks the command entity. Use **`/revert_12`** — underscores are valid
and Telegram renders them as tappable command links, so each listed row becomes a one-tap
restore with no inline-keyboard machinery. Keep `/revert 12` (space) working too.

## G. Telegram "/" command menu via `setMyCommands` (Connect: startup)

Nic saw OpenClaw's Steve pop a "/" autocomplete menu and liked the affordance but hated the
bloat (20+ commands). We register **nothing** today (confirmed: no `setMyCommands` in
`connect/src/`), so Ferni has no "/" menu — commands only work if typed from memory.

Telegram Bot API `setMyCommands` drives the "/" menu (confirmed at core.telegram.org/bots/api):
- One idempotent call at gateway startup registering **all** our commands (`/new /model
  /status /provider /help /id /restart /safemode /revert`) at `BotCommandScopeDefault`.
  We have few enough commands that showing them all is still lean — the anti-OpenClaw
  isn't scoping, it's having a short list in the first place. Skip command scopes for now:
  no per-user registration, no operator/default split, less code. If the list ever grows
  or hiding operator commands becomes worth it, scopes are the later addition.
- No per-message cost, no inline keyboards. ~10 lines in the Telegram codec's boot path.
- (Operator commands stay gated at execution time by `operatorAuthorized` regardless of
  menu visibility — showing them in the menu does not grant access.)

## Log verification (this session, ferni-delta-connect, machine 784503ef916e28)

- **Safe mode demonstrably took effect.** 19:19:41 boot line:
  `... workspace /data/bundle · SAFE MODE · providers primary · models claude-opus-5`.
  Two proofs: the explicit `SAFE MODE` banner AND `providers primary` only — the
  ` → openrouter` failover (and its warmup probe) are dropped in safe mode, exactly as
  designed. Normal boots read `providers primary → openrouter`.
- **`/restart` exited safe mode cleanly.** 19:23:58 boot restored `providers primary →
  openrouter`.
- **The "still Ferni in safe mode" behavior is explained by the token counts.** The
  post-safemode turns (19:19:51 in=27992; 19:20:04 in=28133 cache=99%) show the full ~28k
  conversation thread replayed — identity came from history, not the (stripped) persona.
  Confirms item E's fix direction.
- **Scheduler round-trip fired on time.** Reminder scheduled ~19:07, wake turn logged
  19:09:38 (in=32384 out=39) — matches the "I'll ping you at 19:09 UTC" reply.
- **No errors in agent turns.** The only ERRORs are `EOF ok=true` at 06:19 from SSH/proxy
  during volume base64 writes — harmless.
- **The "/" menu did not appear** because it is not implemented (item G), not because it
  failed.

## Build-ready implementation spec (finalized 2026-08-01, code-grounded)

Grounded in the actual 0.2.7 source + an OpenClaw command-menu study. Two refinements vs
items A-G above, both leaner:
- The revisions LIST lives at **`GET /v1/dev/self/revisions`** — reusing the existing
  `DELTA_INSPECT_TOKEN` gate right next to the already-shipped `POST /v1/dev/self/revert`
  (server.ts:209) — NOT a new top-level `/v1/revisions`. Connect already holds that token.
- The "/" menu registers **one default-scope set**. Telegram's `default` scope is the
  fallback for DMs AND groups, so a single call covers what OpenClaw needed two scopes for
  (their CHANGELOG #74032 registered default+group only because they set narrower per-scope
  menus that shadowed the default — we don't fragment scopes, so we get group coverage free).

### Harness 0.2.8 (engine) — leanest diffs, file-grounded

- **H1 · provider label.** New pure helper `providerLabel(p)`: `credential instanceof
  BrokerCredential` → `codex-sign-in`; `api==="anthropic"` → `anthropic-native`;
  `api==="responses"` → `openai-native`; baseUrl host includes `openrouter` → `openrouter`;
  else the bare host (honest fallback). Emit as `model.provider` in `devConfigView`
  (config.ts ~349). ~10 lines.
- **H2 · always-resolve effort.** config.ts:357 → always emit
  `reasoning_effort: cfg.reasoningEffort ?? "default"` (`default` = truthful: unset sends no
  effort param, provider uses its own). 1 line.
- **H3 · safe_mode in status.** Add `safe_mode: cfg.safeMode` to `devConfigView` (config.ts:340)
  and surface it in the `/v1/status` json (server.ts:359-366). 2 lines.
- **H4 · safe-mode self-awareness (revised after codex review).** Add `safeMode?: boolean` to
  `buildSpine` opts (spine.ts:17). When true, buildSpine (a) **ignores `agentId`** so the intro
  is the neutral "You are Delta, an operator agent" — this kills the identity leak codex caught
  (spine.ts:28 otherwise renders "You are Delta (Ferni)" even in safe mode), and (b) appends ONE
  norm line: "You are running in SAFE MODE: your configured persona, policy, and learned
  self-file are NOT loaded this run. Act as the neutral base agent; do not adopt a persona from
  earlier in this conversation." Only ONE call site changes — run.ts:685 (`deps.safeMode` already
  in scope, pass `...(deps.safeMode ? { safeMode: true } : {})`). research.ts is deliberately
  NOT touched: the `safe` profile (profiles.ts:39) has no `research`/delegate tool, so safe mode
  cannot spawn a research child — plumbing it there would be code for an unreachable path. ~7 lines.
- **H5 · revisions list — NO ENGINE CHANGE (the endpoint already exists).** `GET
  /v1/dev/self/revisions` is already served (server.ts:280, inspect-gated) and returns
  `{ current, revisions: [{id, ts, preview, content}] }`. Its `preview` is just the first 200
  chars of the replaced state (the DELTA.md persona header — identical for every row, useless
  as a topic), so the change-diff must be computed at the display layer regardless. Leanest
  split: reuse the endpoint untouched and compute the picker rows in **Connect** (C6). Diff
  direction (confirmed by codex review): `writeSelf` snapshots the PRIOR DELTA.md AFTER a
  `remember` write (self.ts), so each row is a replaced full state, newest-first; the change
  captured at a row = diff(row.content → next-NEWER state), the newest row's next-newer being
  `current`. Connect derives added/removed + first-added-line via a small set-based line diff
  (added = lines in next-newer not in row; removed = the converse) — leaner than positional LCS
  and honest for append-style notes. Engine stays at zero lines for this item.
- **H6 · provider failover chain in status (new, from codex review).** `/provider` (C3) needs
  the cascade, but `/v1/status` exposes only the primary `model`. Add
  `provider_chain: cfg.providers.map(providerLabel)` to the `model` view (config.ts) — reuses
  the H1 helper, so `/provider` renders e.g. `anthropic-native → openrouter`. ~2 lines.
- Version: version.ts + package.json → 0.2.8.

### Connect 0.3.1 (edge) — built + tested against the RELEASED H0.2.8

- **C1 · /status plain English + provider above model** (formatStatus, core.ts:56): budget →
  `Budget per task: N steps · Nm tokens · $N max`; render `model.provider` line above model.
- **C2 · /model shows effort** — render `model.reasoning_effort` (now always present).
- **C3 · /provider** — new async intercept: active provider + failover chain; shares the label.
- **C4 · /help** — merge the split opening sentence into one HELP entry; revert line →
  "roll back a note I wrote to my own memory (operator only)".
- **C5 · safemode observable** — `/safemode` reply + `/status` render `Safe mode: ON/OFF`
  from `status.safe_mode`.
- **C6 · /revert picker** — bare `/revert` fetches `GET /v1/dev/self/revisions`, renders rows
  as tappable `/revert_12` (underscore); both `/revert 12` and `/revert_12` parse to id 12.
- **C7 · setMyCommands** — one startup call, all 9 commands at default scope, best-effort +
  non-fatal (borrow OpenClaw's bounded call so a Telegram stall can't wedge boot).
- Pin min compatible harness = 0.2.8.
