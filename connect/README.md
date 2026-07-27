# @carrara-labs/delta-connect

The thin channel edge that plugs a Delta agent into chat channels. Telegram first,
DM-only, zero runtime deps (Bun + `bun:sqlite` + raw fetch). The agent scales to zero;
this edge is the only always-on part. See `../docs/delta-connect/SPEC.md` for the design.

## Layout

- `src/types.ts` - the neutral contract (Inbound envelope, codec/ingress/supervisor/agent interfaces).
- `src/store.ts` - the durable spine: inbox (dedup), sessions (threading), outbox (ordered, grouped, at-least-once delivery with retry backoff + dead-lettering). The per-turn writes commit atomically (`commitTurn`).
- `src/telegram.ts` - Telegram codec + long-poll ingress (durable insert before offset advance).
- `src/agent.ts` - one turn against the Delta seam (`POST /v1/responses`).
- `src/supervisor.ts` - local keep-alive; Fly start/suspend swaps in behind the same interface.
- `src/core.ts` - the dispatch loop (durable-write-before-deliver).
- `src/index.ts` - wiring + entrypoint.

## Run

Secrets live in `connect/.env` (gitignored):

```
TELEGRAM_BOT_TOKEN=...        # from @BotFather
DELTA_BASE_URL=http://127.0.0.1:8080
DELTA_AGENT_NAME=Ferni
ALLOWED_TELEGRAM_USER_IDS=    # comma-separated; empty = open (dev). Get yours by messaging /id
```

```sh
bun test            # durable-spine unit tests
bun start           # run the connector against a live Delta daemon
```

Point it at a running daemon (`GET /healthz` returns `{ok:true}`), message the bot on
Telegram, and the round trip is: long-poll -> inbox -> agent -> outbox -> reply.
