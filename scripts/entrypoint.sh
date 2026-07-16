#!/bin/sh
# Delta container entrypoint (F0.4). Wraps the daemon in Litestream continuous backup
# when a replica is configured; runs the daemon directly otherwise. The local SQLite
# rail is (post-v3.1) the sole staging area for all learning, so recovery FAILS CLOSED:
# a missing/misconfigured replica crash-loops loudly rather than silently booting a
# blank production database. A genuine first boot opts in with DELTA_BOOTSTRAP=1.
set -eu

config=${LITESTREAM_CONFIG:-/etc/litestream.yml}
db=$DELTA_DB

# Explicit backup intent that can't be honored must fail, not silently run un-backed-up
# (codex P1 #4): a set-but-missing LITESTREAM_CONFIG is an operator error, not "no backup".
if [ -n "${LITESTREAM_CONFIG:-}" ] && [ ! -f "$config" ]; then
  echo "delta: LITESTREAM_CONFIG=$config is set but no such file — refusing to start without the intended backup" >&2
  exit 1
fi

# Restore the DB from the replica when it's missing. Fails closed by design.
restore() { # $@ = the litestream restore invocation (writes to $db)
  [ -e "$db" ] && return 0 # local primary present — keep its own WAL/shm (real state)
  # Orphaned sidecars with no matching db would replay stale WAL into the restored
  # file and corrupt it (codex P1 #3) — safe to drop only because $db is absent.
  rm -f "$db-wal" "$db-shm"
  if [ "${DELTA_BOOTSTRAP:-}" = "1" ]; then
    echo "delta: DELTA_BOOTSTRAP=1 — starting a fresh database without restore (first boot only)" >&2
    return 0
  fi
  # No local db and not bootstrapping → the replica MUST provide it. Plain restore (NOT
  # -if-replica-exists) errors on an empty/unreachable replica, so set -e crash-loops
  # instead of masquerading a lost replica as a fresh install (codex P1 #1).
  echo "delta: restoring the database from the replica…" >&2
  "$@"
}

# Bundle seeding (first boot). One neutral image serves any product: the bundle files
# (DELTA.md / POLICY.md / PROMPT_CONTEXT.md / vocab.json) are injected as base64 env by the
# control plane, never baked — "agent = engine + bundle + state". Write-if-absent so the
# agent's own self-edits (DELTA.md via `remember`) survive reboots and an image-config change
# never clobbers evolved state (an idempotent seed). Best-effort and
# fail-open: a malformed payload is skipped with a warning, never crash-loops the daemon (the
# daemon itself fail-opens on any absent bundle file).
seed_ws_file() { # $1 = filename under DELTA_WORKSPACE, $2 = base64 payload (empty ⇒ skip)
  [ -n "$2" ] || return 0
  target="$DELTA_WORKSPACE/$1"
  # Skip if a file OR a symlink already sits there: a dangling symlink is -L but not -e, and the
  # root-run redirect below would follow it and write outside the workspace. -L rejects that.
  if [ -e "$target" ] || [ -L "$target" ]; then return 0; fi
  mkdir -p "$DELTA_WORKSPACE"
  # Decode to a temp file and rename into place only on success (atomic), so a crash mid-decode
  # never leaves a partial file that the write-if-absent check would then preserve forever.
  tmp="$target.seed.$$"
  if printf '%s' "$2" | base64 -d > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$target"
    echo "delta: seeded $1 from env (first boot)" >&2
  else
    rm -f "$tmp"
    echo "delta: WARN could not decode $1 seed — skipping" >&2
  fi
  return 0
}
seed_ws_file DELTA.md "${DELTA_SELF_MD_B64:-}"
seed_ws_file POLICY.md "${DELTA_POLICY_MD_B64:-}"
seed_ws_file PROMPT_CONTEXT.md "${DELTA_CONTEXT_MD_B64:-}"
seed_ws_file vocab.json "${DELTA_VOCAB_JSON_B64:-}"

if [ -f "$config" ]; then
  echo "delta: backup ON — litestream config $config" >&2
  restore litestream restore -config "$config" "$db"
  exec litestream replicate -config "$config" -exec delta
fi

if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  echo "delta: backup ON — litestream replica $LITESTREAM_REPLICA_URL" >&2
  restore litestream restore -o "$db" "$LITESTREAM_REPLICA_URL"
  exec litestream replicate -exec delta "$db" "$LITESTREAM_REPLICA_URL"
fi

echo "delta: backup OFF — no LITESTREAM_CONFIG or LITESTREAM_REPLICA_URL configured" >&2
exec delta
