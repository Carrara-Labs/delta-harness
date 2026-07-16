#!/usr/bin/env bash
# Real-life smoke against a running server: bash scripts/smoke.sh [base-url]
# Needs a real model key in the daemon's env — these are live turns.
set -euo pipefail
BASE="${1:-http://localhost:8080}"

echo "— healthz —"
curl -sf "$BASE/healthz"
echo

echo "— live turn —"
R1=$(curl -sf "$BASE/v1/responses" \
  -H 'content-type: application/json' \
  -d '{"input":"Reply with exactly: SMOKE OK","store":true}')
echo "$R1" | grep -q '"output_text":"SMOKE OK"' || { echo "FAIL: $R1"; exit 1; }
echo "$R1"

echo "— threaded turn (memory) —"
PREV=$(echo "$R1" | sed -E 's/.*"id":"([^"]+)".*/\1/')
R2=$(curl -sf "$BASE/v1/responses" \
  -H 'content-type: application/json' \
  -d "{\"input\":\"What did you just reply? Exact words only.\",\"previous_response_id\":\"$PREV\"}")
echo "$R2" | grep -q 'SMOKE OK' || { echo "FAIL: $R2"; exit 1; }
echo "$R2"

echo "OK"
