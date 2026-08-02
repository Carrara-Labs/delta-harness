#!/bin/sh
# One machine: Delta Connect owns the Delta daemon child. All durable state
# lives on the mounted volume at /data:
#   DELTA_DB=/data/delta.db          - sessions, memory, self-revisions
#   DELTA_WORKSPACE=/data/bundle     - the living DELTA.md self-file + bundle
#   CONNECT_DB=/data/connect.sqlite  - the connector's inbox/outbox/session-map
set -eu

# Seed the bundle onto the volume on FIRST boot only, so the agent's learned
# self-file and any hand-edits survive redeploys.
mkdir -p /data/bundle
for f in DELTA.md POLICY.md vocab.json PROMPT_CONTEXT.md; do
  if [ -f "/app/bundle-seed/$f" ] && [ ! -f "/data/bundle/$f" ]; then
    cp "/app/bundle-seed/$f" "/data/bundle/$f"
  fi
done
# Seed the skills/ tree (DELTA_SKILLS=local) on first boot only.
if [ -d "/app/bundle-seed/skills" ] && [ ! -d "/data/bundle/skills" ]; then
  cp -r "/app/bundle-seed/skills" "/data/bundle/skills"
fi

# Where the code came from. A default deploy installs the published packages; a
# --from-source deploy stages the worktree at /app instead. Detected rather than
# configured, so the two deploy modes cannot disagree with the image they built.
NM="/app/node_modules/@carrara-labs"
if [ -d "$NM/delta-connect" ]; then
  CONNECT_ENTRY="$NM/delta-connect/src/index.ts"
  DAEMON_ENTRY="$NM/delta-harness/src/index.ts"
  echo "[ferni] running the published packages"
else
  CONNECT_ENTRY="/app/connect/src/index.ts"
  DAEMON_ENTRY="/app/src/index.ts"
  echo "[ferni] running FROM SOURCE (unpublished - for the pre-release test loop)"
fi

# Delta Connect is PID 1 and the sole process owner; never start a sibling
# daemon here or the two owners will race for the DB and port.
export CONNECT_DAEMON_ENTRY="${CONNECT_DAEMON_ENTRY:-$DAEMON_ENTRY}"
exec bun "$CONNECT_ENTRY"
