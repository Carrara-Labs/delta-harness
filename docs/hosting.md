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
   *outbound* — calling models and tools — with no inbound connection held open. A
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
task; a cold resume is typically about a second.

### 2. Busy check before suspend

Never suspend a machine that still owes work. Ask the daemon:

```
GET http://<machine>:<port>/v1/busy   → { "busy": true|false, "running": N, "queued": N }
```

`busy` is the durable truth: it is `true` when **anything** is queued *or* running, read
straight from the daemon's run table (not an in-memory flag). A queued-but-not-yet-dispatched
run keeps `busy` true, so you will never suspend a machine with a task waiting to start.
Suspend only when `busy` is `false`.

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
**continuation, not a loss** — the machine freezes, and when it wakes the agent picks up
where it left off.

This is what makes the pattern safe: you do not need to drain the machine or wait for a
quiet point. If `/v1/busy` ever races (you suspend a machine that took a task a millisecond
later), the worst case is that the task waits, frozen and intact, until the next wake — no
work is dropped. Suspend on idle and trust the WAL.

## Boot gotchas

Three things that are easy to get wrong when you first stand up a production daemon.

### The bare daemon does not read `delta.env`

`delta dev <dir>` loads a project's `delta.env` for local development. The bare production
daemon (`delta`) does **not** — it reads its configuration from the process environment only.
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

### A malformed `DELTA_MCP_SERVERS` boots the agent tool-less — but says so

If `DELTA_MCP_SERVERS` is not valid JSON, or an individual entry is unusable (no `name`, an
`http` entry with no `url`, a `stdio` entry with no `command`), Delta drops it and continues
— an agent that fails open to *fewer tools* beats a daemon that refuses to boot. Every drop
is logged loudly at startup:

```
delta: DELTA_MCP_SERVERS is not valid JSON — IGNORED, booting with no MCP backends: …
delta: DELTA_MCP_SERVERS[0] (myproduct) is transport:http but has no "url" — skipped.
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
