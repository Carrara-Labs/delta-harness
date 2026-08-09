<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosting Delta: the lifecycle contract

Delta is a long-lived daemon that costs almost nothing at rest. On a platform with
suspend/resume (Fly Machines, Cloud Run with min-instances 0, a hibernating VM), an agent
can sleep at storage-pennies and wake in about a second to take a task. This is one of the
most valuable properties of running Delta, and it is the part an embedding product has to
implement itself, because it lives in **your** control plane, not in the daemon.

This guide is the contract. Implement the three hooks below and your host gets true
scale-to-zero without ever losing in-flight work.

## The one rule: own the lifecycle yourself

Do **not** delegate suspend/resume to a connection-counting proxy (for example Fly's
`fly-proxy` autostop/autostart). Two independent reasons:

1. **It suspends work that is still running.** A Delta task is fire-and-forget:
   `POST /v1/tasks` returns `202` immediately with a task id, and the agent then works
   *outbound* - calling models and tools - with no inbound connection held open. A
   connection-based idle detector sees zero open connections and suspends the machine
   **mid-run**. The work is not lost (see the safety guarantee below), but it is stalled
   until something happens to wake the machine again.
2. **It can wedge the gateway.** Proxy-driven stop/start has been observed to drive a
   SIGINT loop against a long-lived gateway process rather than a clean suspend.

The correct pattern is **control-plane-owned lifecycle**: your control plane decides when to
wake the machine and when it is safe to suspend it, using signals the daemon gives you.

## The three hooks

Implement these three transitions in your control plane. Together they are the whole
contract.

### 1. Wake before dispatch

Before you push a task to a suspended machine, start it and wait until it is live.

```
POST  <machines-api>/apps/<app>/machines/<id>/start     # or your platform's resume call
GET   http://<machine>:<port>/healthz    → poll until 200 { ok, version }
POST  http://<machine>:<port>/v1/tasks   { input: ... }  # only now dispatch
```

`/healthz` is the wake probe: open, data-free, and it returns the running binary version so
your fleet manager knows which release answered. Poll it until `200` before you send the
task. A cold resume is about a second of machine boot; with `DELTA_MCP_SERVERS` configured,
add ~2s of MCP discovery before the daemon binds its port (an engine follow-up will move
discovery after bind).

**Probe through a routing proxy with one long timeout, not many short ones.** Platform
proxies (Fly's edge, Cloud Run's frontend) HOLD a pending request until the machine becomes
routable and answer it the moment the daemon binds. A probe loop with a short per-request
timeout and a long sleep kills every request just before the proxy could complete it, then
waits out the sleep - measured on a production Fly machine, that pattern took 13.3s to see
the first `200` where a single 10s-timeout probe fired right after the start call took 4.7s.
The fast shape:

```
start machine
loop until deadline (~45s):
  GET /healthz, timeout 10s     # the proxy holds it until routable
  200 → dispatch
  refused/dropped → sleep 250ms, retry
```

**After a resume, the daemon heals its own provider wire (0.2.5).** A VM frozen for more
than a few minutes comes back with dead keep-alive sockets in its HTTP pool - the NAT path
behind them expired while it slept - and on earlier engines the first model call could ride
one for minutes (measured: a 251s silent first-turn stall whose parallel fresh-socket probe
answered in 1ms). 0.2.5 closes this daemon-side: a first-byte deadline bounds any dead
socket (`DELTA_FIRST_BYTE_MS`, default 30s), calls after a detected resume or >5 minutes of
wire silence bypass the connection pool entirely, and the origin is re-probed in the
background. Hosts need no changes - but if your UI polls `/v1/tasks/:id/events`, fold the
new `model.retry` events into an honest "provider is retrying" state instead of a generic
spinner.

### 2. Busy check before suspend

Never suspend a machine that still owes work. Ask the daemon:

```
GET http://<machine>:<port>/v1/busy   → { "busy": true|false, "running": N, "queued": N,
                                          "last_event_ms_ago": N }   // only while running
```

`busy` is the durable truth: it is `true` when **anything** is queued *or* running, read
straight from the daemon's run table (not an in-memory flag). A queued-but-not-yet-dispatched
run keeps `busy` true, so you will never suspend a machine with a task waiting to start.
Suspend only when `busy` is `false`.

`last_event_ms_ago` (0.2.13) is present only while something is running: how long the daemon has
been **silent**, meaning the age of the newest event across every running run. It answers "is this
stuck?", which is the question a reconciler is really asking - turn age would card a healthy turn
that has been emitting tool calls every 20 seconds for four minutes. Long turns are normal; one
lane measured a 227s turn on a healthy 12-hour run. Pick a threshold from this rather than from
wall-clock turn duration, and note it is **daemon-wide**: on a daemon serving several runs a busy
one masks a quiet one, so use `/v1/tasks/:id/events` for a per-run decision.

`/v1/busy` is behind the `/v1/` gate, so it takes the same `DELTA_CONTROL_TOKEN` bearer your
control plane already sends on every daemon call. It is deliberately *not* folded into
`/healthz`, which stays open and data-free.

`busy` covers **task work** (queued or running runs). It does not count opt-in post-run
reflection (the background self-learning pass), which is best-effort and expendable: the
run's result is delivered before reflection starts, so a suspend that interrupts a
reflection loses only that background pass, never a task or its answer.

### 3. Suspend after a task reaches a terminal state

When a task finishes, fails, or is cancelled, re-check `/v1/busy` and suspend if idle:

```
on task terminal (done | failed | cancelled):
  GET /v1/busy
  if not busy:  POST <machines-api>/apps/<app>/machines/<id>/suspend
```

Re-checking rather than suspending unconditionally handles the race where a second task
arrived while the first was finishing. This is the "renewable busy-lease": the machine stays
awake exactly as long as there is work, and suspends the moment there is none.

## Why you can suspend aggressively: the safety guarantee

Every turn checkpoints to the local SQLite WAL before it advances. The runs table and the
per-turn journal **are** the checkpoint: on resume, the daemon reloads the active run and
continues from the last completed turn. A suspend in the middle of a run is therefore a
**continuation, not a loss** - the machine freezes, and when it wakes the agent picks up
where it left off.

This is what makes the pattern safe: you do not need to drain the machine or wait for a
quiet point. If `/v1/busy` ever races (you suspend a machine that took a task a millisecond
later), the worst case is that the task waits, frozen and intact, until the next wake - no
work is dropped. Suspend on idle and trust the WAL.

### Upgrades are one-way. Snapshot before you roll.

**A database migrated by a newer binary cannot be opened by an older one.** The daemon refuses,
fail-closed, rather than operating a schema it does not recognise - that refusal is deliberate and
protects you from silent corruption. But the consequences are sharper than they look:

1. The refusal happens at boot, so a rolled-back machine **crash-loops to its restart cap**. It does
   not degrade, it goes down.
2. The obvious recovery, destroying the volume, **also destroys the agent's learned `DELTA.md`**,
   which is a workspace file and not in the database. That loss is permanent.

#### The snapshot, and the verify that has to go with it

```sh
# 1. Wake the machine. Lanes autosuspend, and `fly ssh` against a stopped machine fails with
#    "app has no started VMs, it may be unhealthy or not have been deployed yet" - which reads
#    like a broken lane rather than a sleeping one.
fly machine start <machine-id> -a <app>

# 2. Take the WHOLE volume, not named files and not an assumed path. DELTA_WORKSPACE is NOT the
#    same on every deployment: the image default is /data/workspace, but a product can point it
#    anywhere (Ferni uses /data/bundle). Taking the volume also catches notes/, vocab.json and
#    PROMPT_CONTEXT.md, and cannot silently miss a file someone renamed.
fly ssh console -a <app> -C "printenv DELTA_WORKSPACE"     # know what you are protecting
fly ssh console -a <app> -C "tar cf - -C /data ." > <app>-data-$(date +%Y%m%d).tar

# 3. VERIFY BEFORE UPGRADING. Not optional.
tar tf <app>-data-*.tar | head
tar tf <app>-data-*.tar | grep DELTA.md    # the self-file must actually be in there
```

**Step 3 matters as much as step 2.** Every failure mode here - a sleeping machine, a workspace
path that is not where you assumed - produces a file that exists and looks fine. An operator who skips `tar tf` learns nothing is wrong
until after the volume is gone, and by then the agent's learned state is unrecoverable. This is the
one backup where being wrong cannot be undone, and it runs in the ninety seconds before an
irreversible action.

**Roll forward, not back.** If an upgrade misbehaves, the recovery is a newer image or a restored
snapshot, never an older image against the same volume. If you are already stuck: copy the workspace
off the volume *before* recreating it. The boot error names what is salvageable.

Schema changes are called out per release in the CHANGELOG. If a release notes a migration, treat
the upgrade as one-way for every lane it touches.

### What survives a suspend, and what does not

The guarantee above is about the *run*, not about process memory. A suspend/resume normally restores
memory intact, but a **wake failure degrades into a cold boot** - the machines API times out, the
platform starts a fresh process, and anything that lived only in RAM is gone. Aperture hit this
mid-engagement in August 2026. Plan for it rather than assuming resume always means resume.

| | survives | why |
| --- | --- | --- |
| Run position, turn history, tool results | **yes** | checkpointed to the SQLite WAL every turn |
| The workspace, spill files, artifacts | **yes** | on the mounted volume |
| `DELTA.md` self-file edits | **yes** | committed to disk the instant `remember` succeeds |
| The run's activated tool set | **yes** | persisted to `runs.tools` and reloaded |
| Queued and running task rows | **yes** | the queue recovers them at boot |
| The A4 tool-breaker tally | **no, by design** | a quarantine is re-armed on resume, so a tool disabled by repeated failure becomes callable again |
| In-flight provider connections | **no** | the wire is refreshed on a detected heartbeat gap; a dead pooled socket is evicted in seconds |
| Anything else held only in process memory | **no** | assume a cold boot is possible on any wake |

**What this means for a host.** Nothing needs draining before a suspend. But do not treat a resumed
daemon as a process that never stopped: re-read state from the seam (`/v1/status`, `/v1/busy`,
`/v1/tasks/:id`) rather than from anything you cached across the gap, and expect a re-armed breaker
to retry a tool that had been quarantined.

## Stable contracts you can build on

A host's reconciler and lifecycle code end up depending on more than the three hooks. The
four behaviors below are now **documented guarantees**, not incidental implementation
details - they do not change semantics without a major-version note. Each is pinned by a
named guard test in [`test/contracts.test.ts`](../test/contracts.test.ts); if a change
would break one, that test fails before it ever reaches you.

1. **Idempotency keys are freed on terminal runs (by default).** `POST /v1/tasks` with an
   `idempotency_key` dedupes only against runs still `queued` or `running`. Once a run
   reaches a terminal state, the key is free and a later dispatch starts fresh. This is
   what makes a resume-is-the-dispatch pattern - re-POSTing the same key with a resume
   preamble - safe rather than a silent no-op. **Opt-in exception:** a request that sets
   `idempotency_terminal: true` (with a durable run, i.e. not `store:false`) also dedupes
   against its own *terminal* run, so a re-POST after a lost `202` re-attaches to the
   accepted run instead of starting a second - exactly-once for a key that is unique per
   intent. The default is unchanged; only a caller that sets the flag gets this behavior,
   and the dedupe stays scoped to the run's owner.

2. **`recover()` resumes mid-flight runs on daemon boot.** A run left `running` when the
   process stopped is picked up and continued from its last checkpointed turn when the
   daemon comes back. So a staleness detector can treat a machine that never returns as the
   zombie case. (One caveat: a tool that blocks the event loop *synchronously* can still wedge a
   live daemon - a documented runtime limit, not a recovery gap.)

3. **`/v1/busy` tells the durable truth.** `busy` is `true` whenever a run is `queued` OR
   `running` in the table, not merely when a session is in flight in memory. It is the
   don't-suspend gate: durable work is owed, so keep the machine awake. (It reports durable
   status, not live progress - a host's stuck-run detector watches for the *mismatch*,
   `busy:false` while its own record still says a run is live.)

4. **Seeding never touches an existing `DELTA.md`.** Bundle seeding is write-if-absent: it
   creates missing bundle files but never overwrites a `DELTA.md` that already exists,
   protecting the agent's learned state. Re-seeding `POLICY.md` / `vocab.json` on a live
   machine leaves `DELTA.md` byte-for-byte intact.

   To *update* the fixed operator files (not just seed missing ones), run
   **`delta bundle apply`** (also run automatically on every container boot). It re-seeds
   `POLICY.md` / `vocab.json` / `PROMPT_CONTEXT.md` from their base64 env vars and never
   touches `DELTA.md` - the write set is the bundle manifest's fixed entries, which exclude
   the self-file by construction. It validates every payload first (a bad `vocab.json` or an
   over-budget `POLICY.md` is refused and *nothing* is written), so you can change a Fly
   secret and redeploy - or `fly ssh console -C "delta bundle apply"` on a live machine -
   instead of the old hand-edit dance.

## Boot gotchas

Three things that are easy to get wrong when you first stand up a production daemon.

### The bare daemon does not read `delta.env`

`delta dev <dir>` loads a project's `delta.env` for local development. The bare production
daemon (`delta`) does **not** - it reads its configuration from the process environment only.
In production, inject `DELTA_*` (model keys, budgets, `DELTA_CONTROL_TOKEN`, `DELTA_MCP_SERVERS`,
…) as real environment variables from your platform's secret store, not a file in the
workspace.

### `DELTA_MCP_SERVERS`: be explicit about `transport`

Each entry is one backend. Give it an explicit `transport`:

```json
[
  { "name": "myproduct", "transport": "http",  "url": "https://mcp.example/rpc",
    "headers": { "authorization": "Bearer …" } },
  { "name": "local",     "transport": "stdio", "command": ["node", "server.js"] }
]
```

If you omit `transport`, Delta infers it from the entry shape (`url` → `http`,
`command` → `stdio`) and logs that it did so. Being explicit is still clearer, and it is the
only way to be unambiguous when an entry carries both fields.

### A malformed `DELTA_MCP_SERVERS` boots the agent tool-less - but says so

If `DELTA_MCP_SERVERS` is not valid JSON, or an individual entry is unusable (no `name`, an
`http` entry with no `url`, a `stdio` entry with no `command`), Delta drops it and continues
- an agent that fails open to *fewer tools* beats a daemon that refuses to boot. Every drop
is logged loudly at startup:

```
delta: DELTA_MCP_SERVERS is not valid JSON - IGNORED, booting with no MCP backends: …
delta: DELTA_MCP_SERVERS[0] (myproduct) is transport:http but has no "url" - skipped.
```

Watch your boot logs. A silent tool-less agent will otherwise burn a full model run before
you notice it has no backends.

## A minimal reference implementation

The whole contract, in pseudocode, against a Machines-style API:

```ts
async function dispatch(machine, task) {
  await machines.start(machine.id);              // 1. wake
  await poll(() => http.get(machine, "/healthz").ok);
  await http.post(machine, "/v1/tasks", task, { bearer: CONTROL_TOKEN });
}

async function onTaskTerminal(machine) {
  const { busy } = await http.get(machine, "/v1/busy", { bearer: CONTROL_TOKEN });
  if (!busy) await machines.suspend(machine.id);  // 2 + 3. suspend only when idle
}
```

That is the entire integration. The daemon does the durable, resumable work; your control
plane does the wake-on-demand and suspend-on-idle. The result is an agent that rests at
storage cost and is ready in a second.
