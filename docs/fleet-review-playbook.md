# Fleet review playbook

How to audit every Delta agent we run: where each one lives, how to reach it, what version it is on,
and the exact queries that produce the economics. Written 2026-08-03 during the first full pass.

Re-run this end to end before any performance or cost work. It takes about 30 minutes and it is the
only way to know what is actually deployed, because **three separate deployment paths exist and none
of them tells the others what it is running.**

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

### The control-plane telemetry (all agents that export)

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

| Agent | Version | Behind by | Health |
| --- | --- | --- | --- |
| Ferni | Harness **0.2.10** + Connect **0.5.0** | current | Runs fine. Cache read/write 19.1%, below break-even. 26 of 26 compactions failed to get under budget. |
| Aperture QS + Intake | **0.2.6** | 4 releases | No engine telemetry reaching the collector. |
| Meeting Processor | image `delta-2026.7.14` | **predates v0.1.1** | Highest traffic we have: 437 runs, ~$397, 36,654 events. Compaction thrash up to 29x in one run. |
| Delta 1/4, Trevor, harness-1/2, probes | `delta-2026.7.8` … `7.13` | predates v0.1.1 | Idle. |

**Known problems, ranked** (detail in the 3 August review):

1. Compaction does not reduce the prompt. Fleet-wide the call after a compaction averaged 143% of
   the call before it, and on Ferni's current build 26 of 26 compactions still exceeded the budget.
2. Prompt caching is a net cost on chat-paced agents. 83% of Ferni's input tokens were cache writes.
3. 80% of compactions lose at least one identifier (4,620 of 27,923 audited, 16.5%).
4. Budget caps overshoot: a `$10` cap produced `$12.02`.
5. Latency: Opus 5 averaged 40.9s per model call, p95 172.6s.

---

## 5. Traps

- **Telemetry is dark.** `TELEMETRY_URL` is unset on Ferni, so the agent we dogfood hardest exports
  nothing to the collector. The newest event in `agent_events` is 2026-07-30 and 97% of the corpus
  comes from one agent. Check this first, or you will analyse an empty rail.
- **Old builds emit fewer attributes.** 2,761 of 4,981 `model.call` rows carry no usage fields at
  all. Filter with `attributes ? 'gen_ai.usage.input_tokens'` rather than assuming they are there.
- **Date tags are not versions.** `delta-2026.7.14` sounds recent and predates the first release.
- **Never trust remembered numbers.** Every figure here came from a live query; several
  contradicted what was in the notes.
- Agents are `suspended`, not stopped. `flyctl ssh console` wakes them, which itself costs a boot.

Related: [[reference_delta_telemetry]], [[project_delta_cache_decay]], [[project_delta_connect]].
