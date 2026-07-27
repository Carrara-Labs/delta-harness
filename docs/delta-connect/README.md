# Delta Connect

The channel-gateway layer that plugs a Delta agent into chat channels (Telegram, Slack,
email, webhooks) in both directions, and lets the agent scale to zero while staying reachable.
Separate package, never in the engine. See `SPEC.md` for the finalized design.

## Contents

- **`SPEC.md`** - the finalized design spec (post codex review). Start here.
- **`01-feasibility.html`** - can we connect a local Delta agent to Telegram? (yes, small lift)
- **`02-concept.html`** - Delta Connect as a reusable tool: use cases, packaging, roadmap.
- **`03-teardown.html`** - Hermes + OpenClaw vs Delta: competitive teardown, steal/delete lists,
  positioning. Good foundation for an "OpenClaw / Hermes vs Delta Harness" comparison page.

## The one-line idea

They are the channel layer welded to the agent and can never sleep. Delta is a pure engine
with an optional thin edge that scales to zero. The gateway is always on and cheap; the agent
sleeps behind it and wakes on message. Same connector from a single-file local bot to a shared
multi-tenant Fly gateway.
