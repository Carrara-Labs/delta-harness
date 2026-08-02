# Backlog: Ferni field report #2 → cache economics + vault polish

Status: **observations, not a work order.** Captured 2026-08-01 from the live Ferni agent
(Harness 0.2.10 + Connect 0.4.x on Fly) during and after the secret-vault dogfood. We are
deliberately **collecting more data before shipping any of this** — one day of telemetry on one
agent is a hypothesis, not a mandate. Nothing here is scheduled.

The first field report (`backlog-ferni-field-report.md`, 2026-07-28) is unrelated and already shipped.

---

## 1. Prompt caching collapses on long threads (the expensive one)

### What the telemetry says

One day, one agent:

| Day | Runs | Cost | Avg input / run |
|---|---|---|---|
| 2026-08-01 | 21 | **$49.26** | 373k |
| 2026-07-31 | 16 | $4.12 | 49k |
| 2026-07-30 | 12 | $12.40 | 255k |

2026-08-01 totals: **7,845,119 input tokens · 706,146 cache reads · 211,149 output · 9% overall
cache hit.** Worst single run `$7.96` (1.25M input, 12% hit); three runs over `$4`.

Per-run hit rates cluster at 3-15%, and `cacheRead` stays roughly CONSTANT per run (13k-65k —
about the size of the spine) while `input` climbs into the millions. Within a run the log shows
turn 1 at 0%, turn 2 at 93%, then decay to ~12%: not caching degrading, but a fixed-size cached
prefix becoming a shrinking fraction of a growing prompt.

### The mechanism (code reading, NOT yet experimentally confirmed)

`run.ts:862` assembles the wire messages as:

```ts
const messages = [{ role: "system", content: system }, ...withImages, ...ephemeral];
```

The `ephemeral` blocks are rebuilt EVERY turn (`run.ts:720-780`): the per-turn context (which
interpolates `{{now.iso}}` — different every single turn), task instructions, the retrieval
block, and the W3 todo recitation. They are string-content **user** messages appended AFTER
history.

Both rolling cache breakpoints mark "the last two user-role messages", so on every turn they land
on blocks that can never recur:

- `provider.ts:707` `withPromptCache` (chat-completions path) skips PARTS-ARRAY messages (the
  Sprint-8 image attachment) but not string-content ephemerals.
- `provider.ts:~1065` `toAnthropic` (the NATIVE path, which Ferni uses) has no exclusion at all —
  it marks the last block of the final two user-role messages unconditionally.

Net effect: each turn writes a cache entry ending at a prefix the next request never matches, so
only the system spine is ever re-read and the transcript is billed fresh every turn.

### Candidate fix (do not ship on this evidence alone)

Place the rolling marks on the last two **persisted** messages, skipping ephemerals, on both
paths. The ephemeral blocks then sit after the final breakpoint, where they belong.

### What would actually prove it

A controlled A/B on a lab agent, not on Ferni: same thread, same prompts, same model, native wire.
Measure `cacheRead / input` per turn across a 10-turn run with and without the change. The
prediction is that `cacheRead` should grow with the transcript instead of staying spine-sized.
Watch for a regression in correctness too: moving a breakpoint changes what is cached, and
Anthropic allows only 4.

### Why it is worth doing properly

If the diagnosis holds, most of that 7.85M input moves from $5/M to $0.50/M. Rough order: a
$49 day becomes a $10-15 day. That is the single largest cost lever observed anywhere in the fleet.

---

## 2. `list_secrets` and `vault.declared` conflate "in the vault" with "available"

**Ferni found this one itself**, while trying to self-diagnose a search failure:

> "whether `list_secrets` is meant to report env-provided credentials. Right now it says 'no
> credentials configured' during a window when a credential demonstrably worked, which is a
> misleading signal for any agent trying to self-diagnose."

It is right, and the same confusion appears twice:

- **`list_secrets`** lists only vault rows. An agent whose credential comes from the environment
  sees "no credentials configured" while the tool using it works fine.
- **`vault.declared`** (`index.ts:373`) subtracts a name when it is already satisfied by env:
  `declaredNames(cfg.mcpServers, cfg.exaKey ? [] : ["EXA_API_KEY"])`. So a fully-configured agent
  can request nothing, and adopting the vault for an existing credential requires deleting the
  working config first (break-then-fix migration). MCP-referenced names have no such subtraction,
  so the rule is also inconsistent.

Both come from treating "stored in the vault" and "available to the agent" as the same question.
They are not: `declared` should answer "is this a credential this agent has a use for", and
availability is a separate, per-call precedence question (env wins, vault is the fallback).

Candidate fix, as one change: declare a builtin's credential because the TOOL exists, not because
the key is absent; have `list_secrets` distinguish held-in-vault from provided-by-environment; and
surface `shadowed` on `/v1/status` so a vault entry that env is overriding is visible rather than a
silent no-op. Add `DELTA_VAULT_REQUESTABLE` for names nothing references yet (onboarding a new
integration is a chicken-and-egg the current inference cannot express).

---

## 3. Operator actions are invisible to the agent

When a credential was deleted out from under Ferni mid-conversation, it produced a confident,
well-argued and **wrong** diagnosis: that the key had come from the environment and vanished on a
restart. Sound reasoning from what it could see; it had no way to know an operator had removed it.

It did self-correct unprompted ("I said the key works — that was too confident; what I observed was
one tool call succeeding, and I generalised"), which is the behaviour we want.

Connect 0.4.x now notifies the agent when a credential ARRIVES (the capability note). Nothing
notifies it when one is removed or rotated. Worth considering the symmetric case before an
operator's cleanup turns into a plausible fiction in a client-facing thread.

---

## 4. Smaller observations

- **`spawn_subagent` runs long**: 307s and 269s on separate occasions. Fine for batch work,
  questionable for a chat agent where the user is watching. Relates to the known
  "(no output)" subagent reliability item.
- **`code` tool absent**: every boot logs `code CLI 'codex' not found`. Ferni has no code
  delegation at all. Either install a CLI in the image or stop advertising the capability.
- **`api.github.com` contents API returns 403** for the harness repo; raw.githubusercontent.com
  works. Ferni discovered this and wrote it into its own skill.
- **Stale failed runs**: the only 3 failures in 67 runs are all "budget exhausted" against a
  `$0.25` cap, from 07-28 and 07-30 — a config since raised to `$15`. Not a live problem.
- **The learning loop is healthy**: 45 reflections, 45 memory rows, 35 retrievals, 8 recalls,
  5 self-file revisions across 67 runs.

---

## 5. What the vault dogfood proved (for the record)

- Secure intake works end to end on a real phone: Telegram renders the form natively, the
  credential reaches the vault, and nothing leaks to any database, log, or workspace file.
- **No restart is needed.** Stored 15:50:28 → agent notified → `list_secrets` 15:50:32 →
  `web_search` succeeded 15:50:33. Five seconds, no restart, and the agent drove the retry itself.
- The earlier appearance of a restart requirement was a stale tool error in the thread making the
  model route around a tool that had started working. Fixed by telling the agent, not by
  documenting a restart.
