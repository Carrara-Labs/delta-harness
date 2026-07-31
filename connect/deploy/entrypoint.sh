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

# Delta Connect is PID 1 and the sole process owner; never start a sibling
# daemon here or the two owners will race for the DB and port.
export CONNECT_DAEMON_ENTRY="${CONNECT_DAEMON_ENTRY:-/app/src/index.ts}"
cd /app/connect
exec bun src/index.ts
