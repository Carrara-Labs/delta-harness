# Upgrading to Delta harness 0.2.18

For operators of any Delta harness deployment on 0.2.17. No schema migration, no configuration
change; a swap back to 0.2.17 is the rollback.

## What changes on upgrade day

- **Only lanes running a GPT-5.6 or GPT-6 model on `api.openai.com`** see a wire change: every
  tool output is rendered as an `input_text` block array so the rolling cache marks have a
  carrier. A thread that started on 0.2.17 pays one cache miss on its next call (the rendering
  changed under it), then reads; drilled on the bench before the tag (a 0.2.17-written room
  continued on 0.2.18: 33% on the first call, 94% on the second, 100% by the twelfth, the same
  artifact and ledger carried).
- **Sol lanes on any backend** meter at the refreshed price ($4 / $20 / $0.40 per 1M).
- **Astra lanes** are priced, recognised as vision-capable, warned at boot if their effort is
  `none` or `minimal`, and metered at the long-context tier above 272k input tokens.
- **Telemetry** gains `gen_ai.usage.cache_write_tokens` on `model.call`. `healthz` reports
  `build` when the image was built with `DELTA_BUILD`.
- Every other lane (Anthropic, OpenRouter, the ChatGPT/Codex backend) sends request bytes
  identical to 0.2.17.

## Before you touch a lane

Idle check, staged-secrets check and the snapshot of `/data` as in `docs/upgrade-0.2.17.md`.
The snapshot is habit rather than necessity this time: nothing on disk changes shape.

## Upgrade paths

- **Fly lane (ghcr image):** image-only machine update to
  `ghcr.io/carrara-labs/delta-harness:0.2.18`; verify `curl -s https://$APP.fly.dev/healthz`
  reports `"version":"0.2.18"` and the `DELTA.md` sha is unchanged. Fleet order that worked for
  0.2.17: one bench lane first, then client lanes one at a time.
- **npm global (bare metal, systemd):** `systemctl stop <agent>-daemon`,
  `npm i -g @carrara-labs/delta-harness@0.2.18`, `systemctl start <agent>-daemon`, `healthz`.
- **Delta Connect agents:** `sh connect/deploy/deploy.sh` with the pinned harness bumped.

## After the upgrade

- On an `api.openai.com` Sol or Astra lane the second call of the first new run should read
  most of the first call's input (`gen_ai.usage.cached_tokens` close to the previous
  `input_tokens`, `cache_shortfall_tokens` in the tens), and `cache_write_tokens` appears.
- No lane needs a model setting change. Before moving a lane TO Astra, audit `POLICY.md`,
  `DELTA.md` and skills for tool-scope or ask-first lines and make precedence explicit; Astra
  reads "act ONLY through these tools" as a hard boundary and asks clarifying questions where
  Sol and Opus assume.

## Rollback

Swap the image (or the npm version) back to 0.2.17. The database and workspace are untouched by
this release.
