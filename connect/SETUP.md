# Setup: a self-learning Delta agent on Telegram

The proven, reproducible recipe for running a Delta agent behind Delta Connect - the same
whether you dogfood it locally or deploy it on Fly with a fresh bot. Two processes:

- **The Delta daemon** - the agent (its brain, memory, tools). Scales to zero.
- **Delta Connect** - the always-on Telegram edge in front of it.

## Prerequisites

- Bun >= 1.3
- A model provider key (this recipe uses OpenRouter) or a subscription backend
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## 1. The agent bundle

Scaffold and configure the agent:

```sh
delta init myagent          # writes delta.env, DELTA.md, POLICY.md, vocab.json, PROMPT_CONTEXT.md
```

Edit `myagent/DELTA.md` (persona + mission) and `myagent/delta.env`:

```sh
# --- provider ---
OPENROUTER_API_KEY=sk-or-v1-...
MODEL_BASE_URL=https://openrouter.ai/api/v1     # REQUIRED: routes via OpenRouter, not direct Anthropic
DELTA_MODEL_PRIMARY=anthropic/claude-sonnet-5

# --- identity ---
DELTA_AGENT_ID=myagent                          # scopes this agent's memory

# --- a safe chat agent that LEARNS (the Delta Connect recipe) ---
DELTA_PROFILE=chat                              # safe budget + read-only tools (no code/delegation)
DELTA_ALLOW_SELF_WRITE=1                         # grant `remember` behind a trusted gateway (default off)
DELTA_REFLECT=1                                 # turn on the learning loop

# --- where the daemon reads the bundle + writes its living self-file ---
DELTA_WORKSPACE=/abs/path/to/myagent            # point at the bundle dir (see gotcha below)
PORT=8321
```

### Two gotchas that will bite you (learned the hard way)

1. **Bare `delta` does NOT load `delta.env`.** Only `delta dev` does. In production the env is
   injected by the container (Fly secrets / `docker --env-file`). Locally you must `source` it:
   ```sh
   cd myagent && set -a && . ./delta.env && set +a && delta
   ```
2. **Bare `delta` reads the bundle from `$DELTA_WORKSPACE` (default `./workspace`), not the
   project root.** `delta init` writes `DELTA.md`/`POLICY.md`/`vocab.json` at the root, so unless
   you set `DELTA_WORKSPACE` to the bundle dir, the daemon reads a *different* (empty) workspace
   copy and your persona is ignored. Set `DELTA_WORKSPACE` to the bundle dir. The agent's living
   self-file (`DELTA.md`, where `remember` writes) then lives there and persists.

Verify the agent works before wiring the bot:

```sh
curl -s localhost:8321/healthz
curl -s localhost:8321/v1/responses -H 'content-type: application/json' \
  -d '{"input":"who are you?","metadata":{"user_id":"tg:123"}}'
```

## 2. Delta Connect

In `connect/.env` (gitignored - never commit):

```sh
TELEGRAM_BOT_TOKEN=...                           # from @BotFather
DELTA_BASE_URL=http://127.0.0.1:8321             # the daemon
DELTA_AGENT_NAME=Myagent
ALLOWED_TELEGRAM_USER_IDS=                        # empty = open (dev). Get yours by messaging /id
```

Run it:

```sh
cd connect && bun start
```

Message your bot: `/id` (grab your id, add it to the allowlist), then chat normally. The round
trip is: Telegram -> long-poll -> durable inbox -> agent turn -> durable outbox -> reply.

## 3. Self-learning: what `DELTA_ALLOW_SELF_WRITE` does

The `chat` profile deliberately withholds the `remember` self-write, because raw inbound chat is
untrusted. Delta Connect changes that: it authenticates and allowlists the caller before anything
reaches the agent. So `DELTA_ALLOW_SELF_WRITE=1` is the operator vouching that a trusted gateway
fronts the daemon - it grants (and pins) `remember` on the safe chat profile. The agent then
persists lessons to `DELTA.md`'s `## Learned` on a plain "remember this," surviving restarts.
Leave it off (the default) for any daemon exposed to untrusted inbound.

## 4. Fly deployment notes

- Inject `delta.env` values as **Fly secrets**; no need to source a file.
- Put `DELTA_WORKSPACE` on a **persistent volume** so memory + the self-file survive suspend/resume.
- Run the **connector always-on** (`min_machines_running = 1`) - it must never miss a message.
- Let the **agent scale to zero**; the connector's supervisor wakes it per message.
