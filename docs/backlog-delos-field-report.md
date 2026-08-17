# Backlog: Delos field report -> engine roadmap

Status: **open, awaiting a 0.2.15 plan.** Captured 2026-08-16/17 from Delos, a Steve-class
agent running the published `@carrara-labs/delta-harness@0.2.14` unmodified from npm, on a
Hetzner box, with Delta Connect 0.5.0 on Telegram and the workspace pointed at a live Obsidian
vault.

**Nothing here was patched locally.** Every finding is worked around in config or not at all, so
the engine's behaviour in this report is the engine's real behaviour. Each item names its
workaround so you know what to delete when the fix lands.

## Why this one matters more than a single agent

Delos is the first deployment where Delta is expected to run **autonomously and unattended** -
long jobs, self-directed fan-out, a chat surface with no human watching the loop. That is also
the shape we want for agents in other products. Three of the findings below are invisible in a
supervised, single-turn deployment and fatal in an unsupervised one:

- **D-12** silently removes the entire delegation surface, so an agent that thinks it is fanning
  out is doing nothing, at full cost.
- **D-9** throws away 47 minutes of completed work on budget exhaustion and returns a counter
  string.
- **D-1** makes a long-lived chat answer a question the user asked an hour ago.

None of them raise an alarm. All three were found by reading a database, not by an error.

## Environment fingerprint

```
harness      @carrara-labs/delta-harness 0.2.14   (npm, unmodified)
connect      @carrara-labs/delta-connect 0.5.0
runtime      Bun on Ubuntu 24.04, systemd units, workspace = a git-tracked Obsidian vault
profile      trusted
provider     codex-sign-in  ->  anthropic-native      (chain, in that order)
model        gpt-5.6-sol · api "responses" · base https://chatgpt.com · effort xhigh
budget       maxSteps 100 · maxTokens 12_000_000 · maxCostUsd 5
tools        16, explicit DELTA_ALLOWED_TOOLS (read_file list_dir grep write_file move_file
             recall remember todo web_search web_fetch research schedule_self list_schedules
             cancel_schedule spawn_subagent code)
db           /var/lib/delos/steve/delta.db     (every query in this doc runs against it)
```

---

# P0 - blocks autonomous agents

## D-12 · The whole sub-agent surface is dead on the Codex subscription backend

`research`, `spawn_subagent` and `eval_n` fail **100% of the time** when the active provider is
`codex-sign-in`. Not degraded. Every child, every call.

### Wire-level proof

This is the important part: it reproduces **without Delta in the path**. Two identical requests
to the Codex backend, differing by one field.

```bash
# A - no max_output_tokens
curl -s -o /dev/null -w 'HTTP %{http_code}\n' \
  https://chatgpt.com/backend-api/codex/responses \
  -H "authorization: Bearer $TOK" -H "chatgpt-account-id: $ACC" \
  -H 'content-type: application/json' -H 'OpenAI-Beta: responses=experimental' \
  -d '{"model":"gpt-5.6-sol","input":[{"type":"message","role":"user",
       "content":[{"type":"input_text","text":"say PONG"}]}],"stream":true,"store":false}'
# -> HTTP 200, streams response.created normally

# B - identical, plus max_output_tokens
#    ... same body with  ,"max_output_tokens":4000
# -> HTTP 400  {"detail":"Unsupported parameter: max_output_tokens"}
```

The ChatGPT/Codex backend **rejects the parameter outright**, at any value. This is not a size
problem and no value of `DELTA_STEP_MAX_TOKENS` affects it (we tried; see the misdiagnosis note
at the end).

### Mechanism

| Step | Code | Behaviour |
|---|---|---|
| 1 | `research.ts:210` | every child call passes `maxTokens: Math.max(256, Math.min(OUTPUT_CAP, remaining))` - **unconditionally** |
| 2 | `provider.ts:1600` | `if (req.maxTokens) body.max_output_tokens = req.maxTokens` |
| 3 | Codex backend | 400, `Unsupported parameter: max_output_tokens` |

**Why the parent survives and only children die:** parent turns never pass `req.maxTokens`. They
rely on `STEP_MAX_TOKENS`, which the Responses path never reads (it appears only in the Anthropic
branch, `provider.ts:1294/1318/1329`). So the identical connection works for the parent and fails
for every child, and nothing in config can show you the difference.

**Why the fallback never catches it:** a 400 classifies as `request`, not `transient`
(`provider.ts` `ProviderErrorClass`), so the `anthropic-native` link in the chain is never tried.
There is no automatic recovery.

### Observed in production

```
[research failed: {"detail":"Unsupported parameter: max_output_tokens"}]

[tool error] subagent exited 1:
DELTA_USAGE {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0,"costUsd":0}
```

A single `deep-research` run made **24 child starts and got 24 failures**, producing 0 valid
verification votes. The agent still paid for every attempt.

### Reproduce inside Delta

```bash
curl -s -X POST http://127.0.0.1:8321/v1/responses \
  -H "authorization: Bearer $DELTA_CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"input":"Make exactly ONE research call with three tasks, then stop. Report verbatim
       whether each child SUCCEEDED or FAILED and the exact error."}'
```

### Fix

Do not send `max_output_tokens` when the backend is the Codex subscription. There is already
precedent three lines above in the same function - `store:false` is special-cased for exactly
this backend with a comment saying so. Same shape:

```ts
// provider.ts, Responses body assembly
if (req.maxTokens && !isCodexBackend) body.max_output_tokens = req.maxTokens;
```

Worth deciding separately whether a child that cannot honour an output cap should still run
uncapped (it will be bounded by the parent's budget anyway) or refuse loudly. **Running uncapped
is almost certainly right** - the current behaviour is the worst of both, since it neither caps
nor runs.

**Workaround in place: none.** `research` and `spawn_subagent` remain in the allowlist by the
operator's decision, so the agent keeps attempting and keeps paying.

---

## D-1 · Compaction re-pins the session's oldest question as the live instruction

`compaction.ts:164`:

```sql
SELECT request FROM runs WHERE session_id = ? ORDER BY seq LIMIT 1
```

rendered at `compaction.ts:579` as **"Continue following the original session request"**.

Correct for a one-shot `/v1/tasks` run, where seq 1 *is* the task. Wrong for chat: Connect threads
a conversation with `previous_response_id`, so an entire Telegram history is **one session** and
seq 1 is merely the oldest thing ever said in it.

### Observed

Twice consecutively, 2026-08-16. Compaction fired at turn 8
(`compacted_turns: 96, kept: 16, summary_tokens: 1090`). The live 110-character question was
demoted to `active=0`; a 4,713-character summary instructing the agent to *"assess the shared
digital brain"* - asked 40 minutes earlier - stayed active. The agent obeyed the summary and
answered the wrong question, twice, with no error anywhere.

```sql
-- see it happen
SELECT id, seq, substr(request,1,80) FROM runs WHERE session_id = ? ORDER BY seq;
SELECT active, length(json_extract(msg,'$.content')), substr(json_extract(msg,'$.content'),1,120)
  FROM messages WHERE run_id = ? AND json_extract(msg,'$.role') IN ('user','system') ORDER BY id;
```

### Fix

Pin the **current run's** request. Identical for a task run, correct for chat. If a durable
"standing goal for this session" is genuinely wanted, that is a separate feature and should be
named and set explicitly, not inferred from row order.

**Workaround:** `/new`. Costs the user their context, and nothing warns them the pin is armed.

---

## D-9 · Budget exhaustion discards every piece of completed work

`run.ts:781` builds the reason string and calls
`finalize(deps, run, spine, "failed", selfWriteNote(why), model, usage)`. The run returns the
reason **and nothing else**.

### Observed

```
budget exhausted: 66/100 steps, 3004644/3000000 tokens, $0.0000/$5
```

66 steps, 379 tool calls, 137 pages fetched, 19 compactions, **33 minutes**, and the user got one
sentence of counters. Still on disk and never offered: the spill files, the compaction artifact
ledger pointing at all of them, the `todo` state, and the child summaries already returned.

### Credit where due

The 0.2.7 budget nudge (`run.ts:858`) does fire at 85% of any axis with "wrap up now, deliver your
best answer", and the cap held to within 0.15%. It is not sufficient, because **a single
`research` call can consume more than the whole remaining headroom in one step** - the model
cannot wrap up between steps when one step is larger than what is left. Raising the ceiling helps
only because 15% of a bigger number is a bigger absolute reserve.

### Fix

On exhaustion, make one final cheap call for a partial answer from what is in context, or at
minimum return the artifact ledger so the work is recoverable. A run that spent 3M tokens should
never return zero bytes of substance. Related to the "turn-failure integrity" item in the Ferni
backlog, but sharper: that was a silent committed write, this is total loss of output.

---

# P1 - the engine knows and does not say

## D-3 · No way to see which tools actually registered

`DELTA_ALLOWED_TOOLS` is a **ceiling, not a guarantee**, and registration has preconditions that
fail silently:

| Tool | Gate | Citation |
|---|---|---|
| scheduling (3) | `cfg.controlUrl && cfg.controlToken` | `builtins.ts:1012` |
| `code` | `codeAvailable` - env set *and* binary resolvable | `builtins.ts:798` |
| `web_search` | credential checked at call time, not registration | `builtins.ts:284` |
| `research`/`spawn_subagent` | register fine, then fail 100% on this provider | D-12 |

Configured 16, had 13. Nothing warned: not the daemon, not the logs, and **not `/v1/status`**,
which returns version, profile, model, budget, `mcp_servers`, vault and self - and no tool list.

**Fix.** Put the registered tool list in `/v1/status`, ideally with omissions and reasons
(`schedule_self: omitted, no controlUrl`). This one change would have caught three separate
incidents in this report.

## D-2 · A missing credential makes a tool fail expensively, not quietly

`web_search` registers with or without `EXA_API_KEY` and errors only at call time
(`builtins.ts:284`). **The model does not stop when a tool errors - it routes around it.**

With no key, the agent brute-forced `web_fetch` at GitHub's API and raw forum HTML, six to eight
in parallel per turn: **74 tool calls and 724,804 input tokens for one Telegram message**, whole
Discourse threads arriving as unstripped JSON. That flooded context, triggered D-1, and produced
a wrong answer. One absent environment variable cost ~2x the tokens and the correctness of the
reply.

Same question with the key: **8 steps, 37 tool calls, 350k tokens, zero compactions**, right
answer.

For scale: a sibling deployment (Ferni) had **48 recorded `no EXA_API_KEY` errors and zero
successful Exa calls**, live and undetected since deployment.

**Fix.** Either do not register a credential-gated tool whose credential is absent, or emit a
loud startup warning naming every registered-but-unusable tool. Silence is the defect; which of
the two is a design call. D-12 is the same disease with a provider instead of a credential, which
argues for the general form: **a tool that cannot work should not be offered.**

## D-11 · `maxSteps` is the only budget axis with no operator override

`profiles.ts:127` reads `DELTA_MAX_TOKENS` and `DELTA_MAX_COST_USD` from env and lets them
override the profile in either direction. `maxSteps` is not read. It is pinned by the profile
(`trusted` = `{maxSteps: 100, maxTokens: 2_000_000, maxCostUsd: 5.0}`, `profiles.ts:31`), and
profiles are code-defined, so an operator cannot mint one either.

The comment justifying the two existing overrides makes the case for the third:

> a $5-per-run default is right for a chat sidekick and wrong for a deep-research agent

So is 100 steps. After raising tokens to 12M, a research run finished at **96/100 steps** - four
from the wall, on the one axis that cannot be tuned. Tokens are no longer the binding constraint
for this class of agent; steps are.

**Fix.** Read `DELTA_MAX_STEPS` next to the other two. **No workaround exists.**

## D-6 · Cost budgets are inert on subscription auth

Every turn on `codex-sign-in` reports `cost_usd: 0`, so `DELTA_MAX_COST_USD` can never bind, while
`/v1/status` continues to advertise `maxCostUsd: 5`. The D-9 failure string reads `$0.0000/$5` -
the operator's most carefully tuned budget contributed nothing, and only the token ceiling stopped
a 33-minute run. On a metered key the same run would have been cut at two minutes.

**Fix.** When the active provider reports no cost, say so in `/v1/status`
(`maxCostUsd: 5 (inert: provider reports no cost)`) or refuse a cost-only budget at startup.
Advertising a guard that cannot fire is worse than having none.

Note the flip side, which is a genuine feature worth keeping: on a chain like
`codex-sign-in -> anthropic-native`, an inert-on-primary cost cap is still the **only** guard on
the metered fallback. Subscription runs long, failover stops at $5. Do not remove the knob;
report its state honestly.

## D-10 · The user-facing failure message is internal and misleading

The raw budget string reaches the end user through Connect verbatim, wrapped in **"Try again in a
moment."** A retry reproduces the failure exactly. The advice is not merely unhelpful, it is
wrong, and it costs the user another full run to find out.

**Fix.** Separate the operator diagnostic from the user sentence. The user needs: the work was too
large to finish, here is what came back anyway, narrow the question rather than retrying it.

---

# P2 - correctness papercuts with workarounds

## D-4 · Skill frontmatter is regex-parsed, so valid YAML silently disables retrieval

`local-skills.ts:36`:

```js
const description = block.match(/^description:\s*([^\r\n]+)\s*$/m)?.[1]?.trim() ?? "";
```

A YAML **folded block** (`description: >`) captures the literal `>`. Line 37's truthiness check
passes, so the skill registers - but `search()` scores query words against `name + description`
only (`local-skills.ts:81`), so it can never be surfaced.

Two skills were unreachable for months. Nothing reported it, because **Claude Code parses real
YAML**: the identical file worked on the laptop and was invisible on the server.

**Fix.** Parse YAML, or accept folded and literal block scalars. Minimum: warn when a parsed
description is under ~10 characters, since a real one never is.

**Workaround:** single-line quoted descriptions, documented for authors.

## D-5 · The skill index is built once, in the constructor

`LocalSkillsAdapter` scans `workspace/skills` at construction (`local-skills.ts:46`) and caches
`{name, description, location}`. A skill added, renamed or re-described afterwards is invisible to
retrieval until the daemon restarts. It still loads *by name* if the model already knows to ask,
which is what makes it easy to miss.

**Fix.** Re-scan on `search()` behind a directory mtime check, or watch the path. The scan is a
handful of file prefixes.

**Workaround:** a 2-minute external timer that fingerprints the skill set and restarts the daemon
when it changes, deferring while a run is in flight. Roughly 40 lines of bash that should not need
to exist.

## D-7 · Per-run scratch is written inside the workspace

Spill goes to `workspace/.delta/spill/` (`tools.ts:160`), research artifacts to
`workspace/research/<runId>.<seq>/` (`research.ts:275`). Fine for a scratch checkout; wrong when
the workspace is a git-tracked, phone-synced document vault. Raw un-stripped web fetches -
untrusted third-party content, sometimes hundreds of KB - were being committed and delivered to
the operator's phone, and `research/` collided with the vault's own convention for real research
notes.

The coupling that makes this non-trivial: `queue.ts:438,444` only wipe scratch for **ephemeral**
runs, because durable sessions reconstruct those paths from the compaction ledger. The files
cannot simply be deleted, only relocated.

**Fix.** `DELTA_SCRATCH_DIR`, defaulting to the workspace, pointable at machine-local state.

## D-8 · Delegation inherits the whole account connector surface (documentation)

Not an engine bug, but `code` is the delivery vehicle and nothing warns about it.

Asked to prove its Gmail skill was inert, a delegated `codex exec` session **listed the operator's
real inbox** - 6,913 messages, write scope. Nothing on the host granted this: no MCP server, no
config, no credential on disk. The CLI had signed in with `--device-auth` to a personal ChatGPT
account, and that account has a Gmail plugin with Interactive+Write. The connection lives
server-side and rides the auth token.

So an agent deliberately given **no send-capable tool** could send email as its owner in one hop
through `code`.

**Fix (docs, maybe defaults).** State that a subscription-authenticated CLI inherits every
connector on that account, and that `--disable apps --disable plugins` belongs in
`DELTA_CODE_CLI`. Consider shipping that as the default.

---

# Evidence appendix

All of it re-derivable from `/var/lib/delos/steve/delta.db`. Happy to ship the DB.

### The three `deep-research` runs

| run | status | steps | tools | compactions | tokens | mins |
|---|---|---|---:|---:|---:|---:|
| `resp_a863d559…` | **failed** | 66 | 379 | 19 | 3,721,444 | 33 |
| `resp_e957022f…` | done | 36 | 134 | 2 | 1,501,734 | 17 |
| `resp_08313b99…` | done | **96** | 344 | 12 | 4,969,408 | 47 |

The third is the one with 24/24 child failures and zero verification votes.

```sql
-- that table
SELECT substr(id,1,14) run, status, steps,
  (SELECT count(*) FROM events e WHERE e.run_id=r.id AND type='tool.call')   tools,
  (SELECT count(*) FROM events e WHERE e.run_id=r.id AND type='compaction')  compactions,
  (SELECT json_extract(data,'$."gen_ai.usage.total_tokens"') FROM events e
     WHERE e.run_id=r.id AND type='run.finished')                            tokens,
  cast((finished_at-created_at)/60000 AS int)                                mins
FROM runs r ORDER BY created_at DESC LIMIT 10;

-- every child failure, verbatim
SELECT substr(json_extract(msg,'$.content'),1,300) FROM messages
 WHERE json_extract(msg,'$.role')='tool'
   AND json_extract(msg,'$.content') LIKE '%Unsupported parameter%';

-- compaction decisions
SELECT datetime(ts/1000,'unixepoch'), turn, data FROM events
 WHERE type='compaction' ORDER BY ts DESC LIMIT 20;

-- tool mix for one run
SELECT json_extract(data,'$."gen_ai.tool.name"') tool, count(*) n FROM events
 WHERE run_id=? AND type='tool.call' GROUP BY tool ORDER BY n DESC;
```

### A misdiagnosis worth recording

The agent's own log said children "failed on `max_output_tokens`". We first read that as a **size**
problem, blamed `DELTA_STEP_MAX_TOKENS=16384` against `xhigh` reasoning, and raised it. It changed
nothing, because the parameter is rejected at any value.

The reason this is in the report rather than just embarrassing: **the size reading is plausible
because the codebase contains exactly that hazard.** The Anthropic branch deliberately adds
`THINKING_BUDGET` headroom (`provider.ts:1310-1330`) with a comment explaining that a small
`max_tokens` would otherwise truncate the answer after the model thinks. The Responses branch takes
reasoning effort natively and adds no headroom at all. That asymmetry may be a real latent bug on
the Anthropic-fallback path with a small cap and high effort - it just is not this one. Worth a
look while you are in the file.

---

# Suggested shape of 0.2.15

1. **D-12** - one conditional. Restores delegation for every subscription-backed agent. Highest
   value per line in this document.
2. **D-1** - one query change, with a test that a chat session's second question survives
   compaction.
3. **D-3** - tool list in `/v1/status`. Cheap, and it turns a whole class of silent
   misconfiguration into a glance.
4. **D-11** - read `DELTA_MAX_STEPS` next to the two overrides that already exist.
5. **D-9** - partial-answer-on-exhaustion. The largest behaviour change here; worth its own design
   pass.

D-2 and D-12 argue for one shared principle worth adopting explicitly: **a tool that cannot
function in the current configuration should not be registered, and if that cannot be determined
at boot, the daemon should say so loudly at startup.** Every P0 and P1 in this report is a
variation on the engine knowing something the operator could not see.

Contact: Nic (Delos operator). The box, the DB and the reproductions are available on request.
