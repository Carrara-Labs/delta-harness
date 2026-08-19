# Reply to the Delos field report

2026-08-17, from the Delta Harness engineer. Answers `docs/backlog-delos-field-report.md` (639d053).
Triage artifact: `docs/harness-0.2.15-triage.html`.

## Short version

Nine of your twelve are in 0.2.15. Two of them we ranked **above** where you put them, because they
are already costing another consumer real money. Four changed on us: one is measurably false, one has
stale evidence and a fix that would break a feature we shipped in June, and two reach only your
deployment. **D-12 is confirmed exactly as you wrote it** and ships first among the tool items.

Two things you can fix today without waiting for us — see "Do these now".

| # | your finding | where it lands |
|---|---|---|
| D-12 | `max_output_tokens` kills every child on the Codex backend | **0.2.15**, one conditional, as you specced |
| D-1 | compaction re-pins the session's oldest request | **0.2.15, promoted to first** |
| D-9 | budget exhaustion discards completed work | **0.2.15 (minimum)** + 0.2.16 (full) |
| D-10 | the user-facing failure message | **0.2.15**, with D-9 |
| D-3 | no way to see which tools registered | **0.2.15**, and it absorbs D-2 |
| D-2 | credential-gated tool fails expensively | **0.2.15, fix changed** — warning, never de-registration |
| D-7 | per-run scratch inside the workspace | **0.2.15**, `DELTA_SCRATCH_DIR` |
| D-8 | delegation inherits the account connector surface | **0.2.15** as a shipped default, not a doc note |
| D-11 | `maxSteps` has no operator override | **0.2.15**, but as a ride-along — see below |
| D-6 | cost budgets inert on subscription auth | **no change shipped.** The mechanism is false |
| D-4 | regex frontmatter kills retrieval | 0.2.15 if the release stays small |
| D-5 | skill index built once in the constructor | 0.2.15 if the release stays small |

## First, what this report earned

The wire-level reproduction is why D-12 is a one-line decision instead of a three-week argument. Two
curls differing by one field, and the whole causal chain collapses to `if (req.maxTokens)`. We have
had four releases where a defect resisted explanation because nobody isolated it below our own stack.
This did.

Recording the misdiagnosis was the other thing worth more than it looks. You were right that the size
reading is plausible *because the codebase contains exactly that hazard* — and while we were in
`provider.ts` we found live evidence for it that you could not have seen. See "Three things you could
not have found".

Naming every workaround so we know what to delete is now house practice. We are adopting it.

## What we did before scoping the release

A field report from one deployment is a hypothesis about the engine. Before committing engine work we
re-tested each of your findings somewhere else:

- **Twelve Aperture lane databases** from the 2026-08-10 pre-0.2.14 fleet snapshot — real paid client
  work on 0.2.11, queried offline, aggregates only.
- **Ferni's live database**, read-only: 174 runs, 488 model calls.
- **Every lane's Machines config**, to separate engine behaviour from per-lane env drift.

Both directions moved. Two of your findings are worse than you filed them. Four are narrower or wrong.

## Your D-1 is the most serious thing in this report

You filed it as a chat-surface problem: correct for `/v1/tasks`, wrong for Connect because a Telegram
history threads into one session. That framing is too narrow. **The firing condition is only "a run
that is not first in its session, which also compacted"** — nothing about it is chat-specific.

Tested across lanes:

| lane | exposed runs | pin was a different task | harmless | stale pin longer than the real request |
|---|---:|---:|---:|---:|
| `aperture-qs-69598a208017` (carrara, paid) | 27 | 27 | 0 | 23 |
| `aperture-qs-agent` | 2 | 2 | 0 | 0 |
| `ferni` (live) | 13 | 13 | 0 | 0 |
| `aperture-intake-69598a208017` | 0 | — | — | — |

**42 exposures, none harmless.** We expected a meaningful share to be benign — a lane that sends the
same standing prompt every run would pin the right text by accident. Zero did. And on the busiest
client lane, 23 of 27 stale pins were *longer* than the request they outranked, which is your exact
shape: a large stale instruction dominating a short live one.

23 of 71 sessions on that lane hold more than one run; the longest holds 16. Yours holds a Telegram
history. Same bug, and it has been silently changing what a billed agent works on for weeks.

Your fix is the one we are shipping: pin the current run's request. Identical for a task run, correct
for everything else. We are not building the "standing goal for this session" feature; you were right
that it should be named and set explicitly if anyone ever wants it.

## Your D-9 is not a future design problem

We were going to defer this to 0.2.16 as "the only real behaviour change, needs its own design pass".
Then we counted what it has already destroyed on lanes we ship to:

| lane | runs lost | tool calls | model spend | wall time | worst single run |
|---|---:|---:|---:|---:|---|
| `aperture-qs-69598a208017` | 5 | 525 | $84.05 | 98 min | 295 calls / $14.82 |
| `aperture-qs-agent` | 6 | 246 | $56.93 | 60 min | 106 calls / $11.51 |
| **total** | **11** | **771** | **$140.98** | **158 min** | |

Eleven runs, $141, two hours forty minutes of paid client work, each returning one sentence of
counters. Your 33-minute run is not an outlier of an unattended deployment; it is the same defect that
has been quietly billing our largest consumer.

So we are splitting it, and the near half ships now:

- **0.2.15** — on exhaustion, return the artifact ledger that compaction already maintains, so the
  spill files and child summaries are recoverable instead of orphaned. Plus D-10: the operator
  diagnostic and the user sentence become different strings, and the user's says *narrow the question*
  rather than *try again in a moment*.
- **0.2.16** — the cheap final call for a partial answer from context. That is the part that deserves
  a design pass, and your framing of it ("a run that spent 3M tokens should never return zero bytes of
  substance") is the acceptance criterion we will write against.

Your point that the 85% nudge cannot help when one `research` call exceeds the remaining headroom is
correct and is why we are not just raising the reserve.

## D-12: confirmed, and it matters to us more than you knew

Reproduced in source exactly as you traced it. `research.ts:210` → `provider.ts:1600` → 400, and the
`request` classification is why the `anthropic-native` link never gets tried.

Shipping your fix, in the shape you pointed at — there are already three functions of exactly that
form together at `provider.ts:748-761` (`hostMatches`, `acceptsPromptCacheKey`,
`usesMaxCompletionTokens`), so this is a fourth sibling rather than a special case. And we are taking
your recommendation that a child which cannot honour an output cap should **run uncapped**: the parent
budget bounds it anyway, and the current behaviour neither caps nor runs.

Two things worth telling you back:

**Fleet impact today is zero.** No Aperture lane and not Ferni has ever recorded an
`Unsupported parameter` error — they all run `anthropic-native` or OpenRouter. So this is not a live
fire anywhere but your box.

**It is still near the top, because it blocks us.** We have a branch waiting to move Ferni onto the
same Codex subscription. Landing that before your fix would silently delete Ferni's entire delegation
surface on migration day, with no error. Your report is the reason that will not happen.

## Four findings that changed

### D-6 — the mechanism is false, and the fix you proposed would have buried a real bug

You concluded that dollar budgets can never bind on subscription auth because the provider reports no
cost, and proposed annotating `/v1/status` as `inert`. `pricing.ts` exists precisely to solve that: it
derives a metered-equivalent cost from token counts on every non-OpenRouter path, and the Responses
path calls it at `provider.ts:1756`.

```
resolvePrice("gpt-5.6-sol") -> { in: 1.25, out: 10, cacheRead: 0.125 }   // prefix-matches "gpt-5"
priceUsd(3,000,000 in / 100,000 out) -> $4.75

ferni, live:  488 of 488 model calls priced > $0;  0 turns with tokens but no cost
aperture-qs:  cost_usd 0.058 on a 75,113-token turn at 99% cache hit
```

So your `$0.0000/$5` is not a design limitation to document — it is a Delos-local anomaly, and had we
shipped the annotation we would have painted over it. **The likeliest cause is configuration:**
`parsePrices` accepts `{"in":0,"out":0,"cacheRead":0}` as a perfectly valid override and will silently
zero that model's price.

Your flip-side note is right and we are keeping the knob: on a `codex-sign-in -> anthropic-native`
chain, a cost cap that cannot bind on the primary is still the only guard on the metered fallback. We
will report its state honestly once we know what its state actually is.

### D-2 — the Ferni evidence does not hold, and the engine fix is unsafe

Your scale claim is *"a sibling deployment (Ferni) had 48 recorded `no EXA_API_KEY` errors and zero
successful Exa calls, live and undetected since deployment."* Ferni's database:

| outcome | first seen | last seen |
|---|---|---|
| missing-credential error | 2026-07-28 | 2026-08-01 |
| successful search | 2026-07-30 | 2026-08-13 |

`EXA_API_KEY` is in Ferni's **encrypted vault** — the single entry in it — placed through the secure
intake we shipped in Connect 0.4.3. The errors stopped the day it landed and searches have worked
since. (Raw counts differ by counting method; the date windows are the reliable signal.)

**And this is why the fix has to change.** `credentialFor` resolves the key from the environment *or
the vault*, per call, deliberately — the comment at `builtins.ts:282` says a key handed to a running
agent must work immediately, with no restart. If we stop registering a credential-gated tool whose
credential is absent at boot, we break exactly that: an agent handed a key mid-session could not use
it until someone restarted the daemon.

So we are taking the other option you offered, and only that one: **a loud startup warning naming
every registered-but-currently-unusable tool, plus live usability in `/v1/status`.** Never
de-registration. Your general principle survives — *a tool that cannot work should not be silently
offered* — but "should not be registered" is too strong for a runtime-credential world.

Everything you observed about the cost is unchallenged: one absent variable, 74 tool calls and 724,804
input tokens for a single message against 8 steps / 37 calls / 350k with the key. That is the argument
for the warning.

### D-11 — real, but not the urgency you gave it

`profiles.ts` reads `DELTA_MAX_TOKENS` and `DELTA_MAX_COST_USD` and never `maxSteps`; your reading of
the code is exact, and there genuinely is no workaround. The part that did not survive is the argument
that steps have replaced tokens as the binding constraint:

```
aperture-qs-69598a208017   140 runs · max steps reached 62 · runs >= 90 steps: 0
aperture-qs-agent           64 runs · max steps reached 51 · runs >= 90 steps: 0
```

All eleven budget failures above hit the **token** ceiling. Your 96/100 is a deep-research-at-`xhigh`
shape, not a fleet shape. We are shipping `DELTA_MAX_STEPS` because it is two lines beside the two
overrides that already exist, but as a ride-along rather than a headline.

### D-4 and D-5 — correct, and yours alone

Both hold in source. Reach does not: **zero of the twelve Aperture lanes ship a `workspace/skills`
directory**, and Ferni's two skills carry single-line descriptions the regex parses correctly (76 and
105 characters). D-4 needs folded YAML to bite; D-5 needs skills to change while the daemon runs. You
author skills at runtime, so you are the only deployment exposed to either.

They are still cheap and still real, and your point that *Claude Code parses real YAML so the same
file works on a laptop and is invisible on the server* is the kind of defect that stays hidden for
months. In if the release stays small. Your 40-line restart timer is the thing we most want to delete.

## A link we tried to draw and dropped

We tried to connect your D-2 fetch storm to the open prompt-cache defect: 19 compactions in 33
minutes, and the cache defect's worse family is post-compaction collapse where the cache read freezes
and every later turn pays full price. It would have made your P1 papercut and our most expensive open
item the same leak.

It does not reproduce. On the longest compacting run of the busiest client lane, across the 30 turns
after the first compaction, `cached_tokens` ranged **19,362 → 247,122 across 16 distinct values** — no
plateau, no freeze. That frozen signature belongs to a specific pre-0.2.13 dataset and was fixed in
0.2.13; you are on 0.2.14.

What survives is smaller and now measured rather than inferred: compaction costs summary calls and
re-billed context, and **every compaction is an opportunity for D-1 to fire.** That is how the storm
actually hurt you, and it is the second reason D-1 moved to the front.

## Three things you could not have found

From the fleet queries, not from any report:

| observation | count | owner |
|---|---:|---|
| self-file writes refused for exceeding the cap | 233 | Aperture config — `DELTA_SELF_MAX_TOKENS` drift, 1600/2400/4000 across lanes |
| self-file write collisions between concurrent runs | 48 | ours, small — worth a retry rather than a returned error |
| `output cap (max_tokens) may have truncated` | 9 | **ours — your appendix was right** |

That third row is your misdiagnosis note paying off. You wrote that the Anthropic branch deliberately
adds `THINKING_BUDGET` headroom while the Responses branch adds none, that the asymmetry *"may be a
real latent bug on the Anthropic-fallback path with a small cap and high effort"*, and that it just is
not the bug you were chasing. It is real, it is firing nine times on a lane running
`DELTA_STEP_MAX_TOKENS=16384`, and we would not have looked without that paragraph. It goes in 0.2.16.

## Do these now — do not wait for 0.2.15

1. **Set `EXA_API_KEY`**, or hand it to the agent through the vault. This is the single largest cost
   win available to you today and it needs no release: your own numbers put it at roughly 2x the
   tokens and the correctness of the reply. Our warning fix only makes the omission visible; it does
   not search the web for you.
2. **Put `--disable apps --disable plugins` in `DELTA_CODE_CLI`.** We are making it the shipped
   default, but your box is reachable to a personal ChatGPT account's Gmail plugin with write scope
   until you do. You proved the hop yourself; do not leave it open for a release cycle.

## What we need from you

1. **`DELTA_MODEL_PRICES` from the Delos environment, verbatim.** If it zeroes `gpt-5.6-sol`, D-6
   closes as configuration and we ship nothing for it. If it does not, we have a live cost-truth bug
   and it outranks most of this list.
2. **This query against `/var/lib/delos/steve/delta.db`**, on the failed run:

   ```sql
   SELECT turn,
          json_extract(data,'$."gen_ai.request.model"')      model,
          json_extract(data,'$."gen_ai.usage.input_tokens"') inp,
          json_extract(data,'$."gen_ai.usage.cost_usd"')     cost
     FROM events WHERE type='model.call' AND run_id = ? ORDER BY turn LIMIT 20;
   ```

   Per-turn `cost_usd` of 0 against non-zero `inp` is the confirmation. Anything non-zero and the
   `$0.0000` is an aggregation question instead.
3. **Yes to the DB offer** — we will take it for the D-1 and D-9 regression fixtures. Both need a real
   multi-request session and a real exhausted run, and synthesising those is how we shipped a
   regression test that passed without its fix once already.
4. **Confirm the workaround list** so we know what 0.2.15 lets you delete: `/new` for D-1, the 2-minute
   restart timer for D-5, and whether `research`/`spawn_subagent` stay in the allowlist until D-12
   lands.

## What stays open, and why

- **The prompt-cache defect** is untouched by this report and stays first in 0.2.16: a history digest,
  because "prefix intact" is a claim our telemetry cannot currently make. Related prerequisite we
  found while checking your findings — `DELTA_CAPTURE_CALLS` is deliberately off across the fleet and
  Ferni's `calls` table holds zero rows, so that investigation now starts with a targeted one-session
  capture rather than a replay.
- **Spill lifetime.** D-7 relocates scratch; it does not bound it. A TTL is the wrong shape and was
  built and reverted in one day for reasons in the shipping list. Yours is the deployment that makes
  the relocation urgent, and you identified the coupling correctly (`queue.ts:438,444` only wipe
  ephemeral runs because durable sessions reconstruct those paths from the ledger).
- **`spawn_subagent` "(no output)"** — we thought we had 47 occurrences on Ferni and it turned out to
  be one; a loose text match was hitting the agent's own persona file. Still open, still a single
  anecdote, and worth revisiting once D-12 makes delegation work at all.

## The principle we are adopting

Yours, nearly verbatim, with one word changed:

> A tool that cannot function in the current configuration should not be **silently** offered, and if
> that cannot be determined at boot, the daemon should say so loudly at startup.

"Registered" became "silently offered" because of the vault. Every P0 and P1 in your report is a
variation on the engine knowing something the operator could not see, and that framing is what made
this report worth a release rather than a patch.

— Nic, Delta Harness
