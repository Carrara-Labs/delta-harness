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

## Which code Ferni runs

By default, the **published packages**, pinned exactly in `connect/deploy/package.json`:

```json
"@carrara-labs/delta-harness": "0.2.10",
"@carrara-labs/delta-connect":  "0.5.0"
```

So the deployed agent is what anyone else installs, upgrading is a version edit plus a
redeploy, and rolling back is the same edit in reverse. The boot log says
`[ferni] running the published packages`.

For the pre-release test loop, deploy this worktree instead:

```sh
sh connect/deploy/deploy.sh --from-source
```

That is what the release gate needs: prove a fix on a real agent **before** it reaches npm,
which is impossible if the only way to reach Ferni is to publish first. The boot log says
`running FROM SOURCE` so an unpublished agent is never mistaken for a released one. When the
fix is published, bump the pins above and redeploy **without** the flag - an agent left on a
worktree is running something nobody can reproduce.

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
