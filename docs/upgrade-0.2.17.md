# Upgrading to Delta harness 0.2.17

For operators of any Delta harness deployment on 0.2.13 through 0.2.16. Read the whole page
once; the two traps at the end have each cost a day.

## What changes on upgrade day

- **Schema migration v15 to v16** (the recall index). One-way. Backfilled once at boot, about a
  second per 100 MB of database. Any v15 volume upgrades directly; there is no intermediate step.
  A v16 database will not boot under an older binary.
- **Longer compaction summaries** (anchor appendix, calls and artifacts ledgers, a recovery
  footer), all inside one byte budget. Nothing else on the wire changes unless you opt in to
  `DELTA_CACHE_DIAGNOSIS=1` (Anthropic-native lanes only).
- **No config change is required.** Every 0.2.16 env var keeps its meaning and default.
- Telemetry gains attributes (`turns_since_compaction`, `history_hash`, compaction `generation`,
  `summary_finish_reason`, `summary_chars`, `identifiers_appended`, `loop.repeat` events). A
  collector that stores attributes as JSON needs nothing; a collector with a fixed column list
  needs no change either, it simply will not see the new fields.

## Before you touch a lane

1. **Idle check.** No run queued or running on the lane. Never swap mid-run: a machine
   replacement kills the run in flight, and a product that tracks runs by its own status will
   show that run as running forever until someone fails it by hand.
2. **Staged secrets ship with the replace.** On Fly, `fly secrets list` before the swap; anything
   staged and not yet deployed goes live with the new machine. Apps managed through the Machines
   API show every secret as "Staged" permanently (no release record), so compare the secret NAME
   set against what the lane is supposed to have rather than stopping on the word.
3. **Snapshot the whole state, not the workspace alone.** The database and the workspace are one
   unit; a workspace-only backup misses `delta.db` and cannot be restored.
   - Fly lane: `fly ssh console -a $APP -C "tar cf - -C /data --exclude=lost+found workspace delta.db delta.db-wal delta.db-shm" > archive/$APP-data-$(date +%Y%m%d-%H%M).tar`, then `tar tf` and confirm BOTH `delta.db` and `workspace/DELTA.md` are in it. `fly volumes snapshots create $VOL -a $APP` as a second copy.
   - Bare metal (systemd): stop the daemon, copy the db trio and the workspace together, restart.
4. **Record the release state** you can roll back to: image ref or npm version, `/healthz`
   output, sha256 of `DELTA.md`, `POLICY.md`, `PROMPT_CONTEXT.md`, `vocab.json`, `notes/*`,
   `pragma user_version` (15), and `select seq from sqlite_sequence where name='events'`.

## Upgrade paths

Fleet order that worked: one bench lane first, then client lanes one at a time, watching the
first real run on each before moving to the next. Model settings do not change with this release;
leave `MODEL_*` and the model secrets alone during the swap.

### Fly lane (ghcr image)

Image-only swap. Machines API `POST /v1/apps/$APP/machines/$MID` with the machine's current
config and `image` set to `ghcr.io/carrara-labs/delta-harness:0.2.17`; change nothing else in the
body. Fly replaces the machine, which stops the old daemon before the new one opens the volume
(the write lease lives in the database; two daemons on one volume would see `database schema is
locked` during the rebuild). Poll to `started` or `stopped`; `fly machine start` if stopped.

Verify:

```sh
curl -s https://$APP.fly.dev/healthz            # {"ok":true,"version":"0.2.17"}
fly ssh console -a $APP -C "sha256sum /data/workspace/DELTA.md"   # unchanged
fly ssh console -a $APP -C "sh -c 'dd if=/data/delta.db bs=1 skip=60 count=4 2>/dev/null | od -An -tu1'"   # 0 0 0 16
```

The published 0.2.17 image carries no `build` field (no release image has; the workflow passes
`DELTA_BUILD` from 0.2.18 on). Prove which build a lane runs by the image digest: record
`fly machine status` image ref plus `docker manifest inspect ghcr.io/carrara-labs/delta-harness:0.2.17`.
Then diff the post-swap machine config against the recorded one: the only differing key must be
`image`. A machine replace can drop the first dispatch that arrives while the new machine wakes;
re-dispatch it, do not restore. If the fleet keeps an `engine_version` column per lane (Aperture's `agent_lane` does),
update it by hand; nothing refreshes it.

### npm global install (bare metal, systemd)

```sh
systemctl stop <agent>-daemon
npm i -g @carrara-labs/delta-harness@0.2.17
systemctl start <agent>-daemon
curl -s http://127.0.0.1:$PORT/healthz          # "version":"0.2.17"
sqlite3 -readonly $DELTA_DB "pragma user_version"   # 16
```

Stop the daemon first: the migration runs at boot and the old process must not hold the write
lease. Delta Connect does not need to change for this release.

### Delta Connect agents on Fly (Ferni shape)

`sh connect/deploy/deploy.sh` rebuilds the image from the pinned harness and redeploys. The
bundle seed only copies on first boot, so the live agent's `DELTA.md`, `POLICY.md` and skills on
the volume are untouched. Snapshot the volume first, as above.

## After the upgrade

- The first `compaction` event from the lane carries `generation`, `summary_finish_reason`,
  `summary_chars`, `identifiers_appended`; the first `model.call` after it carries
  `turns_since_compaction=0` and an unsuppressed `cache_shortfall_tokens`. That shortfall is the
  reload cost of a cut, 20k to 30k tokens on Opus at a 200k ceiling. It was always paid; it is
  visible now. Do not read it as a regression.
- If you hash the whole workspace before and after (do: it is the only proof nothing self-learned
  was touched), expect `.delta/trash/` entries older than 7 days to vanish on the first boot. That
  is the startup trash sweep every version runs, not the migration; every other file is
  byte-identical (Carrara: 770 files to 766, the four were superseded `DELTA.md` drafts, all in
  the snapshot).
- Telemetry ids keep increasing past the pre-upgrade high-water. Zero events from a lane whose
  daemon log shows `[turn N]` lines is trap 1 below.
- Expect the same cost and turns per run as before at the production ceiling, and net-zero
  identifier loss across compactions (on the Carrara canary: 43 dropped by the summarizer, 43
  put back by the appendix, across 5 compactions).

## Rollback

Only from the snapshot: rescue shell on the machine, remove `/data/delta.db*` and
`/data/workspace`, untar the archive into `/data`, set the image back to the previous tag, then
**trap 1** before boot.

## Two traps

**Trap 1: a volume restore silently blinds telemetry.** Exported event ids are
`<daemon uuid>:<events row id>` and collectors dedupe on that id. A restored database rewinds the
row counter below what the collector already holds, so every later event is dropped as a
duplicate with no error on either side. Before booting a restored volume:

```sql
UPDATE sqlite_sequence SET seq = <collector max for this daemon + margin> WHERE name = 'events';
```

Roll-forward upgrades do not need this; the sequence continues.

**Trap 2: the product's "finished" is not the engine's.** The agent's last act on a run is often
`remember`, 10 to 15 s after the product-level finish call. Starting the next run on the product
status makes that run's first self-file write conflict (`DELTA.md was updated by another run`),
one wasted turn. Wait for the engine run's `finished_at`, or have the policy write memory before
the finish call.
