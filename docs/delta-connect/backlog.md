# Delta Connect backlog (from the Ferni field report)

Captured 2026-07-28 from a live Telegram dogfood session with Ferni. Connect is the thin
channel edge; the engine (`../..`, harness) stays channel-free by charter. These are the
edge-owned items. Full ranked detail + the engine-side backlog:

- Ferni roadmap (ship-map): https://claude.ai/code/artifact/85908367-3658-4fc2-88d4-4170e048ebba
- Where Delta lands (competitor teardown): https://claude.ai/code/artifact/0d1330fc-c519-42ed-aea5-864c04656a33

## Ship next in Connect (so we can battle-test Ferni on Telegram)

- **`/new` command (item 9).** Today only `/help` and `/id` exist; a session is
  permanently 1:1 with the chat and can never be reset by the user. Add a `/new`
  intercept in `connect/src/core.ts` that clears `prev_response_id` for the chat (start a
  fresh thread from chat). Ends the "let's do this in a fresh thread" handoff that today
  needs a human in the middle. Small, Connect-owned.
- **File receipt (item 8).** `connect/src/telegram.ts` drops any non-text message at the
  `typeof text !== "string"` guard, so inbound documents/images are silently ignored. The
  designed path (`attachmentRefs[]` in the SPEC) routes inbound files to the daemon file
  seam (`/v1/files`). Build inbound-attachment ingestion so Ferni can actually receive a
  file. Medium (needs the Connect side + the daemon file endpoint).

## Deferred (stored, not next)
- Second channel adapter (Slack / email).
- Streaming / draft-in-place replies (deferred until the engine exposes a final-answer
  phase).
- Scheduler bridge (`schedule_self` -> timed sends).
- Group chat (needs the `session_principal` / `actor_id` split).
- Out-of-band cancellation (`DELETE /v1/tasks/:id`).

## Borrow from OpenClaw's channel layer (edge, not engine)
- **Shared `message` tool + `describeMessageTool` adapter** - one message capability with
  per-channel action adapters instead of N send-tools. Clean multi-channel send primitive
  that keeps the engine headless.
- **Throttled single-flight draft streaming** back to chat.

## Current ship/deploy state (as of 2026-07-28)
- Branch `feat/delta-connect` is **27 commits behind `main`** (harness 0.2.1 vs 0.2.4).
  "Update Connect to latest" = bring this branch up to 0.2.4 first.
- Package `@carrara-labs/delta-connect` is at **0.1.0** under `connect/`.
- Ferni runs as one Fly machine `ferni-delta-connect` (harness daemon + connector built
  together from `connect/deploy/`). Redeploy = `sh connect/deploy/deploy.sh` (Fly authed
  as nic@carrara.is; secrets staged on the app). npm publish goes via the git-tag CI
  ceremony, not local (npm not logged in here).
