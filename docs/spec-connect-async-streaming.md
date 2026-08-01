# Spec: Connect async turns + typing + streaming replies

Status: **draft spec for the next Connect release** (proposed 0.3.2, sequence relative to the
security track — see [[project_delta_autonomous_turn]]). Written 2026-08-01 after the Ferni
timeout bug ([[bug_connect_sync_timeout]]) and an Aperture QS / OpenClaw / Hermes / Telegram-API
study. Engine change: **none** — everything below rides surfaces the harness already ships.

## Why

Two problems, one root:
1. **Long turns die and freeze the bot.** Connect calls the SYNCHRONOUS `POST /v1/responses` and
   blocks the strictly-serial dispatch loop for the whole turn, under a fixed `AbortSignal.timeout(180000)`.
   A long Opus turn (Ferni hit 155k context, 75-108s steps) exceeds 180s → the user gets a generic
   failure while the daemon keeps running the orphan and billing. Raising the wall only makes it
   worse: the serial loop means a 30-min turn freezes EVERY later message including the `/restart`
   and `/status` that could rescue it (codex-confirmed: head-of-line blocking is the decisive
   objection). The 180s wall is also a **timer**, which violates our own "budgets, not timers".
2. **No live feedback.** One typing ping fires before the turn, then silence until the answer.

## The unifying insight

The harness already exposes the async surface, and Aperture QS uses it to run 30-min turns fine:
- `POST /v1/tasks` → `202 + { id }` (same body Connect already builds). The run is durable and
  cancellable; `/v1/responses` and `/v1/tasks` share the SAME daemon queue, so the turn already
  executes durably either way — `/v1/tasks` just exposes the run id UP FRONT for tracking + re-attach.
- `GET /v1/tasks/:id/events` (SSE) carries, in ONE stream: `output_text.delta` (reply text as it
  is written), structural events (steps, tools), and a terminal `done` frame with the full response.
  `?coarse=1` drops the per-token deltas for a pure structural heartbeat.
- `DELETE /v1/tasks/:id` cancels (kills the orphaned-billing).

So the async migration AND typing AND streaming are ONE coherent feature on ONE existing surface.
This keeps our thin-edge philosophy intact (engine owns durable execution/recovery/budgets; Connect
owns reach + clock + delivery) and removes the timer.

## Competitive position (from the study)

- **Typing:** OpenClaw re-sends a typing action on an interval (`heartbeat-runner-config.ts`,
  `typingMode`, `typingIntervalSeconds`). Hermes: none (CLI-first). Ours: a single pre-turn ping.
  → S2 brings us to parity with OpenClaw.
- **Streaming reply:** OpenClaw exposes message `edit` as an AGENT tool (agent-driven, not automatic
  token streaming). Hermes: none. Ours: none. → S3 (automatic reply streaming) puts us AHEAD of both.
- **Rich blocks:** neither incumbent uses Telegram's new Rich Messages. Ours today downgrades
  Markdown (tables → text). → S4 (native Rich Messages) is a leapfrog.

## Telegram Bot API facts (verified 2026-08-01, core.telegram.org)

- **Typing:** `sendChatAction` with `action: "typing"`. The indicator lasts ~5s or until a message
  arrives, so it must be RE-SENT on an interval (~4s) for a long op. (Connect already has
  `codec.typing()` calling this; today it fires once.)
- **Streaming via edit (universal):** `editMessageText` — edit one message repeatedly to grow the
  text. Telegram flood-limits edits (treat as ~1 edit/sec; coalesce deltas between edits). Works on
  every client. Text cap stays 4096 (chunk overflow into new messages).
- **Rich Messages (Bot API 10.1 June 2026 / 10.2 July 2026):** native structured + AI-streaming
  support. `sendRichMessage` (send), `sendRichMessageDraft` (stream partial rich messages),
  `editMessageText(rich_message=...)`, `InputRichMessage`. Blocks: headings, paragraphs, dividers,
  lists + TASK LISTS, TABLES (alignment/borders/striped), media (photo/video/audio), block quotes,
  COLLAPSIBLE DETAILS, footnotes, LaTeX. Exact method signatures need confirming from the full API
  reference, and older clients may not render — so S4 is capability-gated with an S3 fallback.

## Codex review (2026-08-01) — MUST-FIX invariants baked into the build

Verdict: build-ready once these are explicit. Also a design sharpening: **`GET /v1/tasks/:id`
(JSON) is authoritative for completion; the SSE is best-effort live UX only** (it has NO replay,
and the persisted `events` table never holds the ephemeral text deltas — server.ts:507-508). So
completion runs on the poll (exactly what QS does — proven at 30 min), and SSE is layered on ONLY
for the live token deltas in S3. The four invariants:
1. **Schema:** durably persist `task_id, conversation_id, state/result, stream_message_ids`, and
   enforce a single-active-task-per-conversation invariant. Store the task id BEFORE tracking begins.
2. **Dequeue:** atomically claim the oldest pending message **whose conversation has no non-terminal
   task** (skip busy conversations — do not block the global inbox). A stuck task blocks only its
   own conversation. Add a stale-task timeout / reconcile so a conversation is not blocked forever.
3. **Recovery:** reconcile active tasks via the authoritative `GET /v1/tasks/:id` after SSE loss,
   restart, or suspend; assume no SSE replay. Missed text-deltas are fine — the terminal
   `done`/result carries the complete final text.
4. **Throttle/overflow:** cap each message at 4096, FREEZE a full message and start a new one for
   overflow (never edit a frozen chunk again), coalesce deltas, ~1 edit/sec **per active output
   message**, and back off on a flood-control (429) response.
Suspend note: suspension closes the SSE but keeps the durable task rows; on resume, reconcile every
active task via GET and reconnect SSE only for still-running ones. `/v1/busy` stays advisory.

## Slices

### S1 — Async dispatch core (the fix)
- **DeltaAgent**: add `startTask(input, opts) → { id }` (`POST /v1/tasks`, ~8s timeout — it only
  starts), `cancelTask(id)` (`DELETE`). The turn body is unchanged (input, previous_response_id,
  metadata, idempotency_key = event id so a retry can't double-run).
- **Store**: a small durable `tasks` table — `task_id, conversation_id, chat_id, event_id, status,
  stream_message_id, created_at`. Durable so a Connect restart re-attaches to an in-flight run
  (a resilience WIN over sync, which loses the turn on any restart).
- **Dispatch**: `runOnce` starts a task and records it instead of blocking, then returns so the loop
  keeps pumping — operator commands (`/status`, `/restart`, `/cancel`) and other conversations flow
  while a long task runs. **Per-conversation serialization**: do not start a second task for a
  conversation that already has one active (the inbox is oldest-first; gate on "no active task for
  this conversation") so two turns never race `previous_response_id`.
- **Task tracker (poll-based, authoritative)**: for each active task, poll `GET /v1/tasks/:id` every
  ~2-3s (like QS — no SSE dependency for the fix). On terminal `done`: render + enqueue the final
  reply to the existing durable outbox, advance the `sessions` row (`prev_response_id` = response.id),
  mark the task done. On `failed`/`cancelled`: a clear note. Reconciles cleanly after any restart.
  (SSE token-streaming is layered on ONLY in S3, best-effort.)
- **Suspend gate**: hold suspend while any task is active (extend the existing busy gate to count
  active tasks).
- **Cancellation**: `/cancel` (and `/restart`) call `DELETE /v1/tasks/:id` — ends the orphaned-billing.

### S2 — Typing while working
- While a task is active and no reply text has started streaming, send `sendChatAction typing` every
  ~4s (best-effort, non-fatal). Stop on the first `output_text.delta` or on `done`. Reuses
  `codec.typing()`; the tracker just adds the interval. (Matches OpenClaw's heartbeat typing.)

### S3 — Streaming reply via editMessageText (Tier 1, universal)
- On the first `output_text.delta`: send a placeholder message, store its `message_id` on the task.
- As deltas arrive: coalesce and `editMessageText` the placeholder with the running text
  (Markdown → Telegram HTML via the existing `markdownToHtml`), **throttled to ~1 edit/sec**.
- On `done`: final edit with the complete formatted text; if > 4096, edit the last chunk and send
  overflow as new messages (reuse `chunkText`). Turn typing off once text starts.
- New codec method `editText(chatId, messageId, text)`; `send()` must return the `message_id`
  (Telegram already returns it). Throttle + coalesce is the discipline that avoids an edit-flood ban.

### S4 — Rich blocks via Telegram Rich Messages (Tier 2, opt-in leapfrog)
- Behind a capability flag (e.g. `DELTA_CONNECT_RICH=1`) + a client-support check, render the agent's
  structured output natively: tables, task lists, collapsible details, LaTeX, media — instead of the
  current downgrade. Stream with `sendRichMessageDraft`; fall back to S3 `editMessageText` when rich
  is unsupported. Build AFTER S1-S3 ship, once the exact `sendRichMessageDraft`/`InputRichMessage`
  signatures are confirmed from the full API reference and client adoption is checked.

## Sequencing + open items
- Ship S1-S3 as one Connect release (the fix + universal streaming). S4 is a fast-follow.
- Zero harness change for S1-S3. (S4 may want the daemon to emit structured blocks, not just text
  deltas — TBD; the plain-text path works without it.)
- Sequence relative to the security vault (C0.4.0): this is a separate, orthogonal Connect release;
  keep the vault isolated + codex-gated.
- Confirm before S4: exact Rich Message method signatures; Telegram client version coverage;
  editMessageText flood-limit numbers (use ~1/s conservatively).

Related: [[bug_connect_sync_timeout]], [[project_aperture_quick_search]], [[project_delta_connect]],
[[project_delta_autonomous_turn]], [[reference_telegram_assistant_recipe]].
