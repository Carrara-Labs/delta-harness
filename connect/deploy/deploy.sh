#!/bin/sh
# Deploy Ferni (a Delta agent + Delta Connect) to Fly from a MINIMAL staged
# context, so node_modules / .git / site never reach the remote builder.
#
# Usage (from the repo root):
#   sh connect/deploy/deploy.sh                 # the PUBLISHED packages (default)
#   sh connect/deploy/deploy.sh --from-source   # this worktree, unpublished
#
# Default is the published path: Ferni runs exactly what anyone else installs,
# pinned in connect/deploy/package.json, and a rollback is a version edit.
#
# --from-source exists for the release gate. Proving a fix on a real agent BEFORE
# publishing is what keeps unverified versions off npm, and that is impossible if
# the only way to reach Ferni is to publish first. Use it during the test loop,
# then publish, then redeploy without the flag so the agent is back on a released
# version rather than sitting on a worktree nobody can reproduce.
#
# Secrets are read from the environment and pushed as Fly secrets; they are never
# written to disk or into the image.
set -eu

FROM_SOURCE=0
if [ "${1:-}" = "--from-source" ]; then FROM_SOURCE=1; fi

APP="ferni-delta-connect"
REGION="${FLY_REGION:-iad}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # repo root (the harness worktree)
DEPLOY="$ROOT/connect/deploy"
STAGE="$(mktemp -d)/ferni-deploy"

mkdir -p "$STAGE"
if [ "$FROM_SOURCE" -eq 1 ]; then
  echo "[deploy] staging THIS WORKTREE at $STAGE (unpublished - pre-release test loop)"
  mkdir -p "$STAGE/connect"
  # A package.json with no dependencies, so the image's `bun install` is a no-op.
  cp "$ROOT/package.json" "$ROOT/tsconfig.json" "$STAGE/"
  cp -r "$ROOT/src" "$STAGE/src"
  cp -r "$ROOT/assets" "$STAGE/assets"
  cp -r "$ROOT/connect/src" "$STAGE/connect/src"
  cp "$ROOT/connect/package.json" "$STAGE/connect/package.json"
else
  echo "[deploy] staging the PUBLISHED packages at $STAGE"
  cp "$DEPLOY/package.json" "$STAGE/package.json"
  grep '"@carrara-labs/' "$DEPLOY/package.json" | sed 's/^/[deploy]   /'
fi
cp -r "$DEPLOY/bundle" "$STAGE/bundle-seed"
cp "$DEPLOY/entrypoint.sh" "$STAGE/entrypoint.sh"
cp "$DEPLOY/Dockerfile" "$STAGE/Dockerfile"
cp "$DEPLOY/fly.toml" "$STAGE/fly.toml"

cd "$STAGE"

NEW=0
if ! flyctl status --app "$APP" >/dev/null 2>&1; then
  NEW=1
  echo "[deploy] creating app $APP (no public services)"
  flyctl apps create "$APP" --org personal
  flyctl volumes create ferni_data --app "$APP" --region "$REGION" --size 1 --yes
fi

# Secrets from the environment, imported via STDIN (never in argv / ps output).
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "[deploy] importing secrets (stdin)"
  printf 'OPENROUTER_API_KEY=%s\nTELEGRAM_BOT_TOKEN=%s\n' \
    "$OPENROUTER_API_KEY" "$TELEGRAM_BOT_TOKEN" | flyctl secrets import --app "$APP" --stage
elif [ "$NEW" -eq 1 ]; then
  echo "[deploy] ERROR: first deploy needs OPENROUTER_API_KEY and TELEGRAM_BOT_TOKEN in the environment" >&2
  exit 1
fi

echo "[deploy] deploying"
flyctl deploy --app "$APP" --ha=false
echo "[deploy] done. logs: flyctl logs --app $APP"
