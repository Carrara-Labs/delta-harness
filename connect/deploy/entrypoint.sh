#!/bin/sh
# One machine, two processes: the Delta daemon (the agent) + Delta Connect (the
# Telegram edge). All durable state lives on the mounted volume at /data:
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

# The Delta daemon (the agent), background.
bun /app/src/index.ts &
DAEMON=$!

# Wait for it to be healthy before the connector starts dispatching (bun, no curl).
i=0
while [ "$i" -lt 60 ]; do
  if bun -e 'const r=await fetch("http://127.0.0.1:'"${PORT:-8321}"'/healthz").catch(()=>null);process.exit(r&&r.ok?0:1)'; then
    echo "[entrypoint] daemon healthy"
    break
  fi
  i=$((i + 1))
  sleep 1
done

# Delta Connect (the Telegram edge), background.
cd /app/connect
bun src/index.ts &
CONNECTOR=$!

# Supervise: if either process exits, stop the machine so Fly restarts it clean.
while kill -0 "$DAEMON" 2>/dev/null && kill -0 "$CONNECTOR" 2>/dev/null; do
  sleep 5
done
echo "[entrypoint] a process exited - shutting down for a clean restart"
exit 1
