#!/usr/bin/env bash
# Delta end-to-end demo — the morning money shot. Boots a real daemon and shows,
# live on the configured model:
#   1. a quick sync ask (/v1/responses)
#   2. a long async task with streamed progress (/v1/tasks + SSE)
#   3. kill -9 mid-task → restart → autonomous resume from the SQLite journal
#   4. (optional) a skill loaded from the skill registry over MCP, applied to real work
#
# Usage:  source .env && bash scripts/demo.sh
#   Optional: SKILL_REGISTRY_MCP_URL=http://localhost:8787/mcp to include step 4.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${DEMO_PORT:-8484}"
BASE="http://localhost:$PORT"
DIR="$(mktemp -d)"
if [ -n "${SKILL_REGISTRY_MCP_URL:-}" ]; then
  export DELTA_MCP_SERVERS="[{\"name\":\"skills\",\"transport\":\"http\",\"url\":\"$SKILL_REGISTRY_MCP_URL\"}]"
fi

hr(){ printf '\n\033[1;36m── %s ──\033[0m\n' "$1"; }
jqget(){ python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))"; }

boot(){
  DELTA_DB="$DIR/d.db" DELTA_WORKSPACE="$DIR/ws" PORT="$PORT" DELTA_TEST_TOOLS=1 \
    ./dist/delta >"$DIR/daemon.log" 2>&1 &
  DAEMON=$!
  for _ in $(seq 1 100); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && return; sleep 0.1; done
  echo "daemon never came up"; cat "$DIR/daemon.log"; exit 1
}

[ -x ./dist/delta ] || { echo "building binary…"; bun run build >/dev/null; }

hr "boot"
boot
echo "delta up on :$PORT (db + workspace under $DIR)"

hr "1 · quick ask (sync /v1/responses)"
curl -sf "$BASE/v1/responses" -H 'content-type: application/json' \
  -d '{"input":"In one sentence, what is Delta (an operator agent harness)? Then say READY."}' \
  | jqget output_text

hr "2 · long async task with streamed progress (/v1/tasks + SSE)"
TASK=$(curl -sf "$BASE/v1/tasks" -H 'content-type: application/json' \
  -d '{"input":"Use the add tool one call at a time: 2+2, then add 4, then add 8, then add 16, then add 32. Show the running total each step, then report the final."}' \
  | jqget id)
echo "task: $TASK — streaming progress:"
curl -sfN --max-time 90 "$BASE/v1/tasks/$TASK/events" | grep --line-buffered -E "^event:" | sed 's/^/   /' &
STREAM=$!
# Let a couple of tool turns happen, then kill -9 mid-flight. Bounded so a failing
# task (bad key, model skips the tool) ends the demo instead of hanging forever.
armed=0
for _ in $(seq 1 60); do
  n=$(sqlite3 -readonly "$DIR/d.db" "SELECT COUNT(*) FROM journal WHERE run_id='$TASK'" 2>/dev/null || echo 0)
  [ "$n" -ge 2 ] && { armed=1; break; }
  st=$(sqlite3 -readonly "$DIR/d.db" "SELECT status FROM runs WHERE id='$TASK'" 2>/dev/null || echo "")
  [ "$st" = "failed" ] && break
  sleep 0.5
done
if [ "$armed" != 1 ]; then
  echo "task did not reach a mid-flight tool state (status: ${st:-unknown}) — check $DIR/daemon.log"
  kill "$STREAM" 2>/dev/null || true; kill -9 "$DAEMON" 2>/dev/null || true; exit 1
fi

hr "3 · kill -9 mid-task → restart → resume"
kill -9 "$DAEMON" 2>/dev/null; wait "$DAEMON" 2>/dev/null || true; kill "$STREAM" 2>/dev/null || true
echo "daemon killed mid-task. status in the DB: $(sqlite3 -readonly "$DIR/d.db" "SELECT status FROM runs WHERE id='$TASK'")"
echo "restarting…"
boot
echo "resuming; waiting for completion…"
for _ in $(seq 1 90); do
  S=$(sqlite3 -readonly "$DIR/d.db" "SELECT status FROM runs WHERE id='$TASK'")
  [ "$S" != "running" ] && [ "$S" != "queued" ] && break; sleep 1
done
echo "resumed → $S"
sqlite3 -readonly "$DIR/d.db" "SELECT '   answer: '||substr(json_extract(result,'\$.output_text'),1,160) FROM runs WHERE id='$TASK'"
echo "   compactions/turns journaled: $(sqlite3 -readonly "$DIR/d.db" "SELECT COUNT(*) FROM journal WHERE run_id='$TASK'")"

if [ -n "${SKILL_REGISTRY_MCP_URL:-}" ]; then
  hr "4 · skill loaded from the skill registry (MCP progressive disclosure)"
  echo "   mcp servers: $(grep -o 'mcp: [^\\n]*' "$DIR/daemon.log" | head -1)"
  curl -sf "$BASE/v1/responses" -H 'content-type: application/json' \
    -d '{"input":"Find the weekly-update skill in the skill registry (skills__skill_search then skills__skill_get) and use it to write a weekly update from: shipped the core run loop; in progress: none; next: write the launch note. Name the skill+version."}' \
    | jqget output_text
fi

hr "spend + cleanup"
echo "per-turn cost log:"; grep "\[turn" "$DIR/daemon.log" | tail -6 | sed 's/^/   /'
kill -9 "$DAEMON" 2>/dev/null || true
rm -rf "$DIR"
echo "done."
