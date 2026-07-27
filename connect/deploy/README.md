# Deploy: Ferni on Fly

One always-on Fly machine running a Delta agent + Delta Connect. No public port
(Telegram long-poll is outbound-only). All durable state on a 1GB volume.

## One-time

```sh
# from the repo root, with the two secrets in your environment:
OPENROUTER_API_KEY=sk-or-... TELEGRAM_BOT_TOKEN=123:abc sh connect/deploy/deploy.sh
```

`deploy.sh` creates the app (`ferni-delta-connect`), a volume (`ferni_data` at
`/data`), stages the two secrets, builds from a minimal context, and deploys.

## Redeploy

```sh
sh connect/deploy/deploy.sh          # secrets already set; re-stages + deploys
```

The volume persists across deploys, so the agent's learned self-file, memory, and
the connector's inbox/outbox survive.

## Operate

```sh
flyctl logs   --app ferni-delta-connect
flyctl status --app ferni-delta-connect
flyctl ssh console --app ferni-delta-connect   # inspect /data
```

## Notes / v1 limits

- One machine runs both processes; if either exits the entrypoint stops the
  machine and Fly restarts it clean. A future split (connector always-on,
  agent scale-to-zero via a Fly supervisor) is the next step.
- Region defaults to `iad`; override with `FLY_REGION=... sh connect/deploy/deploy.sh`.
- Only the allowlisted Telegram id may talk to the bot (`ALLOWED_TELEGRAM_USER_IDS`).
