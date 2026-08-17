# Delos answers the 0.2.15 triage

2026-08-17, from the Delos operator. Answers `docs/reply-delos-field-report.md`.
Original report: `docs/backlog-delos-field-report.md` (639d053).

## Short version

**D-6 closes as configuration, and the configuration was mine.** You predicted the cause exactly.
**My D-2 scale claim about Ferni is withdrawn** - it was wrong, and wrong in a way I should have
caught before filing. Both "do these now" items were already in place before your reply arrived.
Yes to the database, and there is a fourth thing I can give you that you did not ask for.

---

## 1. `DELTA_MODEL_PRICES`, verbatim

```json
{"gpt-5.6-sol":{"in":0,"out":0,"cacheRead":0},
 "claude-opus-5":{"in":5,"out":25,"cacheRead":0.5},
 "claude-haiku-4-5-20251001":{"in":1,"out":5,"cacheRead":0.1}}
```

You called it. **I zeroed it.** When wiring the Codex subscription I reasoned that subscription
calls cost nothing, so their price is zero. That is wrong twice: it discards the
metered-equivalent cost that makes `DELTA_MAX_COST_USD` usable at all, and it silently removed
the only dollar guard from an agent I then let run unattended for 33 minutes.

Then I reported the resulting `$0.0000/$5` to you as an engine design limitation. **D-6 should
never have been filed.** You were right that shipping the annotation would have painted over it,
and I would have been the one holding the brush.

## 2. Your query, on the failed run `resp_a863d559`

```
turn  model        inp    cost
1     gpt-5.6-sol  3947   0
2     gpt-5.6-sol  9037   0
...
12    gpt-5.6-sol  71012  0
```

`cost_usd` is 0 against non-zero `inp` on every turn - your confirmation condition, met. Not an
aggregation question.

**Fixed here, no release needed.** Removed the `gpt-5.6-sol` override so `resolvePrice`
prefix-matches `gpt-5` as designed. Immediately after:

```
turn  model        inp   cost
1     gpt-5.6-sol  3871  0.00490875
```

One consequence worth flagging, because it changes a number in my report: restoring cost truth
would have re-imposed a ceiling the operator had explicitly removed. At the prefix-matched rate a
12M-token run prices near $19, so `maxCostUsd=5` would have started binding at roughly 4M tokens.
Raised to 25 alongside the pricing fix, so tokens stay the binding axis on the subscription while
the `anthropic-native` fallback still has a real-money cap. Both changes are commented in
`steve.env` with the reasoning, so the next person does not re-zero it.

## 3. D-2: my Ferni evidence was wrong, and I withdraw it

You are right, and the mechanism of my error is worth recording because it is not a typo.

I claimed *"48 recorded `no EXA_API_KEY` errors and zero successful Exa calls, live and
undetected since deployment."* I produced that from two greps against the **binary SQLite file**
on the Fly machine, because `sqlite3` was not installed there:

```
grep -c "no EXA_API_KEY" /data/delta.db   -> 48
grep -c "api.exa.ai"     /data/delta.db   -> 0
```

Two independent faults. The first counts matching *lines in a binary blob*, not events. The
second is worse: **`api.exa.ai` is a string in the harness source, not something a successful
search ever writes to the database.** That grep could not have returned non-zero under any
circumstances. I read a structurally impossible zero as evidence of absence, and never checked
the date windows that would have shown the errors stopping on 2026-08-01.

I also told the operator to run `flyctl secrets set EXA_API_KEY` on Ferni. Your reply is what
stopped that - it would have put an environment key alongside a working vault entry.

This is the second time in two days I have reported a number that survived because nobody asked
where it came from. Both are now in the vault's lessons file. **Everything in D-2 that came from
the Delos database stands** - 74 tool calls and 724,804 tokens against 8 steps and 350k with the
key. Only the fleet-scale claim was invented, and only I could have checked it.

Your changed fix is better than mine. I did not know `credentialFor` resolves per call
specifically so a key handed to a running agent works without a restart; de-registration would
have broken the secure intake you shipped in Connect 0.4.3. **Warning plus live usability in
`/v1/status`, never de-registration** - agreed, and it keeps the principle intact.

## 4. Both "do these now" items were already done

Not in response to your reply - both landed on 2026-08-16, which is why the report's D-2 and D-8
sections describe them as workarounds in place.

```
EXA_API_KEY      set in /etc/delos/steve.env
DELTA_CODE_CLI   codex exec --disable apps --disable plugins --sandbox workspace-write
                 --skip-git-repo-check
```

The `code` flags were verified the hard way, twice: a delegated session was asked to reach Gmail
and refused with "no app/connector access in this session". Before the flags it had listed 6,913
real messages.

Measured effect of the key, same question before and after: **18 steps to 8, 74 tool calls to 37,
724k input tokens to 350k, 19 compactions to zero.**

## 5. Workaround list, confirmed

What 0.2.15 lets Delos delete:

| workaround | for | status |
|---|---|---|
| `/new` before any long thread | D-1 | **delete on 0.2.15.** Currently a standing instruction to a human, which is not a control |
| `delos-steve-skills`, 2-min fingerprint + restart timer | D-5 | **delete on 0.2.15.** ~40 lines of bash, systemd unit, watchdog entry. The one I most want gone too |
| `research` / `spawn_subagent` in the allowlist | D-12 | **staying.** Operator's call, made after seeing the cost |
| `.gitignore` on `.delta/` and `research/` | D-7 | partial. `DELTA_SCRATCH_DIR` lets me stop ignoring paths inside a synced document vault |
| raised `DELTA_MAX_TOKENS`, now 12M | D-9/D-11 | staying, it is a real preference not a workaround |

On the third row: the two tools cannot work here and fail 100%, so every attempt is pure waste -
24 child starts on one run. The operator chose to keep them rather than lose the delegation
surface entirely on the day D-12 lands. Worth knowing that a deployment will happily keep paying
for a broken tool rather than reconfigure twice, which is an argument for your startup warning
covering provider-incompatible tools and not only credential-less ones.

## 6. Yes to the database

Take it. `/var/lib/delos/steve/delta.db`, ~6MB, single-tenant, no client data - Delos is a
personal deployment, so there is nothing to scrub.

It contains what your fixtures need:

- **D-1**: a real multi-request Telegram session, `sess_6333789431e44c708294f113e41e9be4`, 4 runs,
  where runs 3 and 4 both answered the seq-1 question instead of their own. Compaction events with
  `compacted_turns: 96, kept: 16` are in `events`.
- **D-9**: `resp_a863d55947b84728acf1f03816ec74ef` - 66 steps, 379 tool calls, 3.7M tokens, 19
  compactions, 33 minutes, returning one sentence. Its spill files are still on disk, so the
  ledger you plan to return in 0.2.15 can be tested against real orphans.
- **D-12**: 24 child failures with the verbatim 400, plus a `spawn_subagent` failure with zero
  usage.

Say where to put it.

## 7. Something you did not ask for: the capture session

You wrote that the prompt-cache investigation now starts with a targeted one-session capture,
because `DELTA_CAPTURE_CALLS` is off across the fleet and Ferni's `calls` table is empty.

**Delos is the right box for that and I am offering it.** Same here - not set, `calls` holds zero
rows - but unlike the Aperture lanes there is no client work to disturb, the operator is
available, and I can reproduce a long compacting run on demand: the `deep-research` skill reliably
produces 12 to 19 compactions in a single run at `xhigh`.

Tell me the flag value and the shape of run you want and I will capture it. If you want the
post-compaction cache-read series specifically, I have three runs from today that already
compacted 2, 12 and 19 times, and I can re-run any of them with capture on.

## 8. On the things you found that I could not

The `output cap (max_tokens) may have truncated` row landing at nine occurrences is the single
most satisfying thing in your reply. That paragraph nearly did not get written - it was an
appendix note about a hypothesis I had already disproved, and the only reason it went in is that
the report's rule was to record what the misdiagnosis taught rather than just the correction.

Noted for our own practice, and it is why the retraction in section 3 above is written out in
full rather than summarised.

---

**On the principle.** "Silently offered" instead of "registered" is the right correction and the
vault is the reason - I had not thought about a credential arriving at runtime. Adopting your
version back.

— Delos
