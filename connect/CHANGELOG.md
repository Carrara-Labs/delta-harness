# Changelog — @carrara-labs/delta-connect

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package follows [Semantic Versioning](https://semver.org/). It versions
independently of the Delta harness engine.

## [0.5.0] — 2026-08-02

Replies render as Telegram Rich Messages, and a long turn shows what the agent is doing while it
works. Proven on a live agent before release, against the real Bot API.

### Added
- **Rich replies.** The agent's markdown goes to Telegram as a rich message, so tables, task lists
  with real checkboxes, headings, fenced code with its language, block quotes and math render
  natively instead of being flattened into a small HTML subset. Telegram's own parser reads the
  markdown, so there is no renderer of ours in between.
- **A live progress line.** While a turn runs, an ephemeral draft says what the agent is doing
  ("Searching the web", "Reading a file"), refreshed from the daemon's event feed and cleared when
  the answer arrives. It shows the work, not the reply being typed: only a step with no tool calls
  becomes the answer, so streaming the model's narration would show claims that are never sent.
- `DELTA_CONNECT_RICH=off` turns both off. A Bot API server without Rich Messages is detected on
  the first call and never asked again.

### Changed
- A reply that Telegram refuses as rich falls back to the previous HTML path, so no reply is lost
  to a rendering problem. A 429, a 5xx, a timeout or an unreadable response is retried by the
  outbox instead, rather than being re-sent in the downgraded form.
- Messages are still split at ~3900 characters rather than the 32768 a rich message allows. One
  queued reply must stay one API call, or a failure part-way through a split would drop or
  duplicate pieces of it.

### Fixed
- **`mcp__brain__authenticate` no longer renders as bold.** Telegram's rich parser reads a double
  underscore as emphasis even inside a word, which is the same mangling 0.4.3 fixed in our own
  renderer. Underscore runs inside a word are escaped now; code is left alone, because Telegram
  already treats it as literal.

### Known gaps
- A progress line already in flight when the answer arrives can appear just after it, and then
  disappears on its own within 30 seconds. Cancelling the preview rather than waiting for it is
  deliberate: a durable reply is never queued behind cosmetic UI.
- Raw HTML written outside a code block is now interpreted by Telegram rather than shown literally.
  Inside code, which is where an agent almost always puts markup, nothing changes.
- Images and `tg://` links in agent markdown now render, where the HTML path dropped them.
- A code span broken across lines gets visible backslashes, as does a fenced block whose info
  string contains a backtick. Both are rare, and both fail toward a stray backslash rather than a
  mangled identifier.
- The intake 409 durability gap from 0.4.3 is unchanged.

## [0.4.3] — 2026-08-02

Everything a credential needs to be usable the moment it lands. Proven on a live agent before
release: a real phone, a real credential, a search that was failing and then worked.

### Added
- **The agent is told when a credential arrives**, as an ordinary queued turn. The engine
  resolves a new credential on the very next call with no restart, but a tool error already sitting
  in the thread makes the model route around that tool for the rest of the conversation, which
  looks exactly like a restart requirement. The note carries the name and never the value.

### Fixed
- **Underscores inside a word are literal, not emphasis.** `EXA_API_KEY` rendered as
  EXA*API*KEY, so the one message whose job is to name a credential misnamed it. Both single and
  double runs are covered (`mcp__brain__authenticate` survives intact), and the word test reads
  whole characters, so a combining mark or an astral letter is no longer mistaken for a word
  boundary. Real emphasis (`_italic_`, `__bold__`) and all asterisk emphasis are unchanged.
- **The confirmation leads with the outcome.** Someone who has just handed over a credential
  wants to know it landed, not to read a caveat first.
- **The capability note is attributed to whoever actually submitted**, rather than to the first
  entry in the allowlist, which named the wrong person on a multi-user deployment.

### Known gap
- If the vault write commits but its response is lost, the retry hits the create-only 409 and
  neither the confirmation nor the agent note is sent, so a stored credential can look like a
  failure. This predates 0.4.3 and is not fixed here: treating 409 as success would tell someone
  their value was saved when a different value is actually in the vault. Tracked for the next
  batch.

## [0.4.2] — 2026-08-01

### Fixed
- **Secure intake rejected every real submission.** The bot-token HMAC check string is built
  from *all* received fields except `hash`; only Telegram's third-party Ed25519 algorithm also
  removes `signature`. We removed `signature` from both, so any modern client — which sends it —
  failed with "this link is no longer valid" after the user had already pasted their credential.
  Unit tests missed it because the fixture signed the same way the verifier verified; the tests
  now sign the way Telegram actually does. A client that signs the Ed25519 way is still accepted
  (both forms are HMACs under the bot token, so neither is forgeable without it), and a hash
  mismatch now logs the field names present so the next failure is diagnosable in one tap.

## [0.4.1] — 2026-08-01

### Added
- **`/secret NAME`** — an operator can hand the agent a credential directly, without the agent
  having to ask for it first. Previously the only route was the agent emitting a
  `[[secret-request: …]]` marker, which meant provisioning depended on talking the model into
  requesting something. Optional trailing text becomes the purpose.
- **`/secrets`** — the credentials the agent holds, by name and purpose, plus the names it can
  still be given. Never a value.

Both are operator-only (the vault is agent-wide, so a second allowlisted user must not be able
to provision or enumerate credentials), classified as local commands at ingest so they are not
queued behind an in-flight turn, and registered in the Telegram "/" menu.

## [0.4.0] — 2026-08-01

Secure secret intake. A credential can be handed to an agent **in the chat** without the value
ever crossing Telegram's message transport. Requires Harness 0.2.10 (the secret vault). Entirely
opt-in: with no public URL configured, Connect runs exactly as 0.3.2.

### Added
- **Secure intake, rendered inside Telegram.** The agent (or an operator) offers a `web_app`
  button; tapping it opens a form served by Connect over TLS, and the form POSTs the value
  **directly back to Connect** — deliberately not `sendData()`, which would route it through
  Telegram's servers as a service message. Connect writes it straight to the harness vault and
  never stores it. The narrow, honest guarantee: the value never crosses the bot-message
  transport and never appears in Connect's chat records.
- **`[[secret-request: NAME | why]]`**, the agent's way to ask for a credential — the same
  terminal-marker family as `[[send: path]]`. The name is charset-validated and the request is
  refused unless the harness reports that name in `vault.declared`, so an injected agent cannot
  invent a credential name and talk a human into providing one nothing is configured to use.
  Nothing model-authored is rendered into the form.
- **A single public route pair** (`GET`/`POST /intake/:session`) on its own listener; every other
  path is an empty 404. Requests are authenticated with the Mini App's `initData`
  (HMAC-SHA256 keyed by `HMAC(bot_token, "WebAppData")`), with strict field, hash, and
  `auth_date` freshness checks, and the submitting user must match both the session and the
  allowlist.
- **Single-use by construction.** A session is claimed with an atomic `pending → submitting →
  used` transition, so concurrent submissions cannot both write; a failed vault write releases it
  for a retry. The Telegram authorization itself is consumed globally, so one valid `initData`
  cannot be replayed against a second live session.
- **A self-contained form page**: no third-party script in the origin that holds the credential
  (the launch data is parsed from the URL fragment), a strict CSP, `no-store`, `no-referrer`, a
  password field with autocomplete off, and the input cleared the moment the request settles.

### Security notes
- Intake refuses to start unless `ALLOWED_TELEGRAM_USER_IDS` is non-empty, `CONNECT_PUBLIC_URL`
  is `https`, and a control token is configured. "Anyone with the link" is not an authorization
  rule for a credential drop box, even where the chat surface tolerates an open allowlist.
- Vault writes are loopback-only and refuse redirects, so a misconfigured `DELTA_BASE_URL` can
  never ship a credential to a remote host.
- Intake creates; it never replaces. Rotating or deleting a credential is an operator act on the
  harness's inspect-gated surface.

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
