# Fleet review playbook

How to audit every Delta agent we run: where each one lives, how to reach it, what version it is on,
and the exact queries that produce the economics. Written 2026-08-03 during the first full pass.

Re-run this end to end before any performance or cost work. It takes about 30 minutes and it is the
only way to know what is actually deployed, because **three separate deployment paths exist and none
of them tells the others what it is running.**

> **Read section 2.4 first.** There are **two independent telemetry collectors**, not one. Querying
> only the control-plane collector makes the live fleet look dead; it is where the first pass of this
> review went wrong.

---

## 1. The map — what is what

| Agent | Where | Deployed by | Version source of truth |
| --- | --- | --- | --- |
| **Ferni** (Telegram assistant) | Fly app `ferni-delta-connect` | `sh connect/deploy/deploy.sh` from this repo | `connect/deploy/package.json` npm pins |
| **Aperture QS / Intake** | Fly apps `aperture-qs-agent`, `aperture-intake-agent`, plus per-workspace `aperture-qs-<id>` | the Aperture app (`~/ai-recruiter`) | Fly image tag `carrara-labs/delta-harness:<ver>` |
| **Control-plane fleet** (Meeting Processor, Delta 1/4, Trevor, harness-1/2, probes) | Fly apps `delta-agent-*` | `~/delta-agents` provisioner | `delta_machines.image_ref`, tag `delta-YYYY.M.D` |

Three paths, three version schemes. Ferni pins npm versions, Aperture pins a ghcr semver tag, the
control plane pins a **date-tagged** image that does not name a harness version at all. Map a date
tag to a release with `git for-each-ref --sort=creatordate --format='%(refname:short) %(creatordate:short)' refs/tags`.

Deprecated: `~/delta` is the old monorepo. Harness work happens in `~/delta-harness` only.

**Roles when testing a harness change** (Nic, 2026-08-03):

- **Ferni = the testbed.** The autonomous-agent archetype, built to dogfood. Break things here first.
- **Quick Search = the volume rig.** An agentic feature, in production, but easy to observe on long
  runs, and lab/test Aperture workspaces can be spun up and run **in parallel** to build a sample
  fast, inheriting all the QS wiring and telemetry.
- **Meeting Processor = monitor only.** Production, awkward to iterate on. Watch it for regressions;
  do not tune on it. Upgrade it as a beneficiary of a proven fix, never as an experiment.

---

## 2. Access recipes

### Fly inventory

```sh
flyctl apps list
flyctl machines list -a <app>            # the IMAGE column is the version
flyctl status -a <app>
flyctl logs -a <app>
```

### Into an agent VM

```sh
flyctl ssh console -a <app> -C "sh -c '<command>'"
```

The agent images are `debian-slim` plus the binary: **no `curl`, `wget`, `python3`, `sqlite3` or
`node`.** There IS `bun` at `/usr/local/bin/bun`. So query the agent's SQLite with a bun script,
shipped in base64 to survive the SSH argument mangling:

```sh
B64=$(base64 -i ./query.js | tr -d '\n')
flyctl ssh console -a <app> -C "sh -c 'echo $B64 | base64 -d > /tmp/q.js && bun /tmp/q.js && rm -f /tmp/q.js'"
```

`query.js` opens the live DB **read-only** so a review can never corrupt a running agent:

```js
import { Database } from "bun:sqlite";
const db = new Database("/data/delta.db", { readonly: true });
```

### The daemon DB

`/data/delta.db` (WAL). Tables that matter: `runs` (with a `usage` JSON blob carrying
`input`/`output`/`cacheRead`/`cacheWrite`/`costUsd`), `messages` (`active=1` is the live context),
`events` (local telemetry, `ts`/`type`/`data`), `sessions`, `memory`, `self_revisions`, `vault`.

### 2.4 The two telemetry collectors

Engine telemetry is turned on by `TELEMETRY_URL`, and **different fleets point at different
collectors.** Check both, always.

| Collector | Receives from | Endpoint | Credentials |
| --- | --- | --- | --- |
| **Control plane** | `delta-agent-*` (Meeting Processor, probes) **and Ferni** | `https://delta-control-plane.fly.dev/api/telemetry/ingest` | `DATABASE_URL` in `~/delta-agents/.env` |
| **Aperture** | `aperture-qs-*`, `aperture-intake-*`, all 8 lanes | `https://aperture.is/api/telemetry` | `PROD_DATABASE_MIGRATION_URL` in `~/ai-recruiter/app/.env` |

Ferni was wired to the control-plane rail on 2026-08-03 (`agent_id = "ferni"`). It is not a
provisioned machine, so it authenticates with an **operator token** in `TELEMETRY_TOKEN` rather than
a gateway token: the ingest route dual-auths for exactly this case (`apps/api/src/routes.ts`, the
`/api/telemetry/ingest` branch). To wire any other unprovisioned daemon, do the same three things:

```
TELEMETRY_URL = https://delta-control-plane.fly.dev/api/telemetry/ingest
TELEMETRY_TOKEN = <DELTA_API_TOKEN, staged via `flyctl secrets import --stage` on stdin>
DELTA_CAPTURE_PAYLOADS = 1
```

The exporter drains its whole backlog on the first successful tick, so history is not lost by wiring
late: Ferni's 1,979 events going back to 27 July landed on the first pass, with usage attributes
intact on all 246 `model.call` rows.

The Aperture rail is the bigger and fresher corpus: 50,678 events, 22 July onward, still live. Its
`agent_events` adds `workspace_slug` and `agent_type` for lane attribution. Ingest is bearer-auth'd
with `TELEMETRY_INGEST_TOKEN`; the exporter fails open so a dead collector never breaks an agent.
Aperture's own runbook section is `~/ai-recruiter/docs/fleet-runbook.md` under "Telemetry", and note
`DELTA_CAPTURE_PAYLOADS=1` is required or `model.call` exports without model, latency, token or cost
attributes.

**Always verify against the deployed env, not the repo file.** `connect/deploy/fly.toml` does not
show Fly secrets or provisioner-injected vars, and `/proc/1/environ` is the init process, not the
daemon. Use `flyctl ssh console -a <app> -C "sh -c 'env | grep TELEMETRY'"` plus
`flyctl secrets list`. The definitive test of whether an agent has *ever* exported is its own
`events` table: `select exported, count(*) from events group by exported`.

Read the Aperture collector with:

```js
const env = await Bun.file(process.env.HOME + "/ai-recruiter/app/.env").text();
const url = env.split("\n").find((l) => l.startsWith("PROD_DATABASE_MIGRATION_URL="))
  ?.slice("PROD_DATABASE_MIGRATION_URL=".length).replace(/^["']|["']$/g, "").trim();
```

Run it from `~/ai-recruiter/app` so the driver resolves. Lane breakdown:

```sql
select workspace_slug, agent_type, count(distinct run_id) runs,
       round(sum((attributes->>'gen_ai.usage.cost_usd')::numeric),2) cost,
       round(avg((attributes->>'cache_hit_pct')::numeric),1) cache_pct,
       percentile_disc(0.95) within group (order by (attributes->>'latency_ms')::int) p95_ms
from agent_events where event_name='model.call' and attributes ? 'gen_ai.usage.cost_usd'
group by 1,2 order by cost desc;
```

### The control-plane collector

Postgres on Railway. Connection string is `DATABASE_URL` in `~/delta-agents/.env` — never echo it.
No `psql` on this machine; use the repo's own driver:

```js
import postgres from "postgres";
const url = (await Bun.file(process.env.HOME + "/delta-agents/.env").text())
  .split("\n").find((l) => l.startsWith("DATABASE_URL="))?.slice(13).replace(/^["']|["']$/g, "");
const sql = postgres(url, { max: 1, ssl: "prefer" });
```

Run it with `cd ~/delta-agents && bun script.js` so the driver resolves.

Table `agent_events`: `event_name`, `event_time_ms`, `agent_id`, `run_id`, `turn`, `attributes` jsonb.
Join names via `app_agents` and machines via `delta_machines`.

---

## 3. The queries that matter

**Fleet version inventory.**

```sql
select a.name, a.harness, a.status, m.fly_app_name, m.state, m.image_ref,
       (select max(to_timestamp(e.event_time_ms/1000))::date
          from agent_events e where e.agent_id = a.id::text) last_event
from app_agents a left join delta_machines m on m.agent_id = a.id
order by a.harness, m.image_ref;
```

**Cost, cache and latency by model.** `attributes` keys on `model.call`: `latency_ms`,
`cache_hit_pct`, `gen_ai.request.model`, `gen_ai.usage.{cost_usd,input_tokens,cached_tokens,output_tokens}`.

```sql
select attributes->>'gen_ai.request.model' model, count(*) calls,
       round(avg((attributes->>'cache_hit_pct')::numeric),1) avg_cache_pct,
       sum((attributes->>'gen_ai.usage.input_tokens')::bigint) input,
       round(sum((attributes->>'gen_ai.usage.cost_usd')::numeric),2) cost,
       percentile_disc(0.95) within group (order by (attributes->>'latency_ms')::int) p95_ms
from agent_events where event_name='model.call' group by 1 order by cost desc;
```

**Does compaction actually shrink the prompt?** The one query that found the real problem: input
tokens on the model call immediately before each compaction versus immediately after.

```sql
with calls as (
  select run_id, event_time_ms t, (attributes->>'gen_ai.usage.input_tokens')::bigint inp
  from agent_events where event_name='model.call' and attributes ? 'gen_ai.usage.input_tokens'),
comps as (select run_id, event_time_ms t from agent_events where event_name='compaction')
select count(*) n, round(avg(before_inp)) avg_before, round(avg(after_inp)) avg_after
from (select c.run_id,
        (select inp from calls k where k.run_id=c.run_id and k.t < c.t order by k.t desc limit 1) before_inp,
        (select inp from calls k where k.run_id=c.run_id and k.t > c.t order by k.t asc limit 1) after_inp
      from comps c) z
where before_inp is not null and after_inp is not null;
```

**Compaction thrash and information loss.** `compaction` attributes: `kept`, `merged`,
`summary_tokens`, `compacted_turns`, `summary_cost_usd`, `identifiers_audited`, `identifiers_missing`.

```sql
select n_comp, count(*) runs from (
  select run_id, count(*) n_comp from agent_events where event_name='compaction' group by run_id) t
group by n_comp order by n_comp desc;
```

**Cache economics on one agent** (from inside the VM, `runs.usage`):

```sql
select date(created_at/1000,'unixepoch') d, count(*) n,
       round(sum(json_extract(usage,'$.costUsd')),2) cost,
       sum(json_extract(usage,'$.cacheWrite')) written,
       sum(json_extract(usage,'$.cacheRead')) read
from runs where usage is not null group by d order by d;
```

Read/write is the number to watch. **Writes bill 1.25x input, reads bill 0.1x, so reads must be
worth at least 27.8% of writes before the cache pays for itself at all.** Below that, prompt caching
is costing money.

---

## 4. State as of 2026-08-03

| Agent | Version | Behind by | Traffic | Health |
| --- | --- | --- | --- | --- |
| Aperture QS + Intake (8 lanes) | **0.2.6** | 4 releases | 342 runs, **$727**, 50,678 events, live | Cache excellent (88.9%). 68 of 68 compactions failed to get under budget. |
| Ferni | Harness **0.2.10** + Connect **0.5.0** | current | 78 runs, $94.76, now exporting | Cache read/write 19.1%, below break-even. 26 of 26 compactions failed. |
| Meeting Processor | image `delta-2026.7.14` | **predates v0.1.1** | 437 runs, ~$397 | Compaction thrash up to 29x in one run. |
| Delta 1/4, Trevor, harness-1/2, probes | `delta-2026.7.8` … `7.13` | predates v0.1.1 | idle | — |

**Known problems, ranked** (detail in the 3 August review):

1. **Compaction never reduces the prompt.** Confirmed on three independent corpora and three harness
   versions: pre-0.1.1 (call after a compaction averaged 143% of the call before), 0.2.6 (100.4%,
   and 68 of 68 compactions still over budget), 0.2.10 (26 of 26). Cause is in current source:
   `elide` is applied to the summarized transcript, the pinned ask and the summary, but never to the
   **kept tail**, while `MIN_TAIL=2` and the orphan-snap let that tail exceed its budget.
2. **Compaction loses facts.** 16.5% of audited identifiers on the control-plane corpus, 28.7% on
   Aperture's.
3. **Prompt caching inverts on chat-paced agents only.** Aperture, running dense back-to-back runs,
   gets 88.9%. Ferni, on human-paced Telegram gaps, writes 83% of its input tokens to a cache it
   reads back 19% of. The 5-minute default TTL is the suspect; `DELTA_CACHE_TTL=1h` is unset.
4. Budget caps overshoot: a `$10` cap produced `$12.02`.
5. Latency improves sharply with version: Opus 5 p95 was 172.6s on the pre-0.1.1 build and 58.0s on
   0.2.6. Still slow in absolute terms.

**Unit economics:** a Quick Search run costs **$1.69 to $3.09** depending on lane.

---

## 5. Traps

- **There are two collectors.** Concluding "the fleet does not export telemetry" from the
  control-plane rail alone is wrong, and the first pass of this review made exactly that mistake:
  that rail was near-dead (97% from one obsolete agent) while the Aperture rail was live and five
  times larger. Query both, every time.
- **Check the deployed env, not the repo file.** `connect/deploy/fly.toml` does not show Fly
  secrets or provisioner-injected vars. Confirm with
  `flyctl ssh console -a <app> -C "sh -c 'env | cut -d= -f1 | sort'"` and `flyctl secrets list`.
- **Old builds emit fewer attributes.** 2,761 of 4,981 `model.call` rows carry no usage fields at
  all. Filter with `attributes ? 'gen_ai.usage.input_tokens'` rather than assuming they are there.
- **Date tags are not versions.** `delta-2026.7.14` sounds recent and predates the first release.
- **Never trust remembered numbers.** Every figure here came from a live query; several
  contradicted what was in the notes.
- Agents are `suspended`, not stopped. `flyctl ssh console` wakes them, which itself costs a boot.

Related: [[reference_delta_telemetry]], [[project_delta_cache_decay]], [[project_delta_connect]].
