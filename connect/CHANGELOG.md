# Changelog — @carrara-labs/delta-connect

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package follows [Semantic Versioning](https://semver.org/). It versions
independently of the Delta harness engine.

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
