# Changelog — @carrara-labs/delta-connect

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package follows [Semantic Versioning](https://semver.org/). It versions
independently of the Delta harness engine.

## [0.3.2] — 2026-08-01

Long turns no longer time out. A research or multi-step turn used to run over the daemon's
synchronous seam, which held one HTTP request open for the whole turn and gave up at 180 seconds:
a heavy turn then surfaced a generic failure while the agent kept working and billing. Turns now
run on the async task surface, so a turn is bounded by the agent's own budget, not a wall clock.
Pairs with Harness 0.2.9 (exactly-once task idempotency + schedule identity), which makes the
retry, cancel, and scheduling paths correct under loss and concurrency.

### Added

- **`/cancel`.** Stops the in-flight turn for your conversation and ends the run on the daemon, so
  an abandoned turn stops billing.

### Changed

- **Turns run asynchronously.** Each turn is a durable task (`POST /v1/tasks`, then poll for the
  result) recorded in a local `tasks` table, so a Connect restart re-attaches to an in-flight turn
  and delivers it rather than dropping it. The typing indicator stays alive for the whole turn.
- **Per-conversation serialization, fair across conversations.** A second message waits behind that
  conversation's active turn while other conversations run concurrently; one conversation's backlog
  never starves another, and messages keep their arrival order. Local commands (`/status`,
  `/cancel`, `/restart`, …) always flow — found instantly however deep the queue — even while that
  conversation has a turn in flight.
- **A lost dispatch can't orphan or duplicate a turn.** If the daemon accepts a turn but its
  acknowledgement is lost, the turn is tracked as a durable placeholder and re-attached to the same
  run (via the daemon's exactly-once idempotency) rather than restarted; a `/cancel` or `/new` in
  that window still applies once it re-attaches.

## [0.3.1] — 2026-08-01

A legible, tappable command surface. Needs Harness 0.2.8 for the provider label, resolved effort,
and safe-mode fields; older daemons degrade gracefully (the new lines are simply omitted).

### Added

- **`/provider`.** Names the active provider and the failover chain.
- **`/` command menu.** A single `setMyCommands` registration at startup lists the nine commands
  in Telegram's "/" autocomplete. One default-scope call covers DMs and groups; best-effort and
  non-fatal, so a network stall never wedges boot.
- **`/revert` picker.** Bare `/revert` lists the self-file revisions newest-first, each with a
  relative time, a `+added/-removed` line delta, and the first changed line as the topic, rendered
  as a tappable `/revert_<id>`. `/revert <id>` still works.

### Changed

- **`/status` is plain English.** The provider is named above the model (`anthropic-native`,
  `openai-native`, `openrouter`, `codex-sign-in`), the budget reads `Budget per task: 100 steps ·
  3M tokens · $15 max`, and safe mode shows as a line when it is on.
- **`/model` always shows the effort**, resolving to `default` when the daemon leaves it unset.
- **`/help`** wording is tightened; the `/revert` line now says it restores a note the agent wrote
  to its own memory.

## [0.3.0] — 2026-07-31

Reach, operability, and safe-ops. Validated live on Ferni (Telegram). Needs Harness 0.2.7.

### Added

- **Formatted replies.** A small Markdown-to-Telegram-HTML converter renders the agent's Markdown
  and splits safely at Telegram's 4096-character limit, with a plain-text retry on a parse error.
- **Document send.** A trailing `[[send: path]]` marker on a reply uploads that workspace file via
  `sendDocument`, confined by realpath to the shared workspace.
- **Scheduler bridge.** A loopback, constant-time-token control server lights up the engine's
  `schedule_self` tool: a ticker admits due once and interval schedules (cron is rejected).
- **Operator commands.** `/restart`, `/safemode`, and `/revert <id>` over an actor-id-gated
  allowlist, plus `/model` and `/status` reads. `/safemode` auto-falls-back on a boot failure or
  crash loop, so a wedged agent recovers instead of staying down.

## [0.2.0] — 2026-07-28

Two channel affordances, validated live on Ferni (Telegram).

### Added

- **`/new` command.** Clears the chat's `prev_response_id` in the same atomic commit
  that answers it, so the next message starts a fresh thread. Answered locally with no
  agent turn (like `/help`, `/id`).
- **File receipt.** Inbound Telegram photos and documents are parsed into a durable
  attachment ref on the inbox row. At dispatch (daemon awake), the connector downloads
  the bytes and hands them to the daemon workspace via `POST /v1/files`; the turn input
  references the saved path so the agent opens it with `read_file`. File bytes never
  enter the durable inbox or a prompt. Any download or upload failure degrades to a note
  instead of crashing the turn (error-as-value).

### Notes

- File receipt requires a Delta harness daemon exposing `POST /v1/files` (harness ≥ 0.2.4).

## [0.1.0] — 2026-07-27

Initial release. Telegram DM connector: durable inbox/outbox, dedup,
`previous_response_id` threading, ordered chunked delivery with retry backoff and
dead-lettering, `/help` and `/id` intercepts. Zero runtime deps (Bun + `bun:sqlite` +
raw `fetch`).
