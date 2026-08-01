# Upgrading Ferni to Harness 0.2.10 + Connect 0.4.0

Two independent steps. The vault (step 1) is useful on its own; the in-chat intake (step 2)
adds Connect's first public listener, so it is deliberately separate and opt-in.

Everything below is prepared but **not applied** — step 2 puts a public HTTPS endpoint on a
live personal agent, which is an operator decision, not a deploy detail.

## Step 1 — the vault (no public surface)

Generate a key and set it as a Fly secret. The file form is preferred in general, but a Fly
secret arrives as an environment variable, so on Fly use `DELTA_VAULT_KEY`:

```sh
flyctl secrets set DELTA_VAULT_KEY="$(openssl rand -base64 32)" --app ferni-delta-connect
```

Deploy from the repo root:

```sh
sh connect/deploy/deploy.sh
```

Verify:

```sh
flyctl ssh console --app ferni-delta-connect -C \
  "curl -s -H 'authorization: Bearer $DELTA_CONTROL_TOKEN' http://127.0.0.1:8321/v1/status"
# expect vault.enabled = true
```

Losing this key makes every stored credential undecryptable — the daemon says so loudly at
boot rather than failing one call at a time mid-task. Back it up where you keep the others.

## Step 2 — in-chat intake (adds a public listener)

Ferni currently has **no** `[http_service]`: the machine has no public port, because Telegram
long-poll is outbound-only. Intake changes that. Add to `connect/deploy/fly.toml`:

```toml
[http_service]
  internal_port = 8323
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
```

and to `[env]`:

```toml
  CONNECT_PUBLIC_URL = "https://ferni-delta-connect.fly.dev"
  CONNECT_PUBLIC_PORT = "8323"
```

The daemon seam stays on `127.0.0.1:8321` and the control server on `8322`; only 8323 is
public, and it serves exactly two routes (`GET`/`POST /intake/:session`). Everything else
returns an empty 404.

Then register the Mini App domain with @BotFather (`/newapp` or `/setdomain` for the bot),
pointing at the same origin. Without this Telegram will refuse to open the `web_app` button.

`ALLOWED_TELEGRAM_USER_IDS` is already set to Nic's id, which intake requires — it refuses to
start on an empty allowlist.

## Step 3 — teach the agent the convention

The bundle seeds only on first boot, so a redeploy does **not** update a live `POLICY.md`.
Write it to the volume directly and restart:

```sh
flyctl ssh console --app ferni-delta-connect -C \
  "sh -c 'cat >> /data/bundle/POLICY.md'" <<'POLICY'

- To receive a credential, end your reply with `[[secret-request: NAME | why you need it]]`.
  Never ask anyone to paste a secret as a chat message.
- You can see credential names with `list_secrets`. You can never read a value, and no tool
  will ever return one — say so plainly if asked.
POLICY
flyctl machine restart --app ferni-delta-connect
```

## Demo, once both steps are applied

Ask Ferni to research something that needs web search. With no `EXA_API_KEY` configured it
asks for one, a button appears, tapping it opens the form inside Telegram, and the next turn
searches successfully — no redeploy, and the value never appears in the chat.
