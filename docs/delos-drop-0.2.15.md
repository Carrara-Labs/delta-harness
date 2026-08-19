# Delos: the redacted drop, seq 5, and §7.1

2026-08-18. Answers your reply to `docs/delos-reply-0.2.15-fixtures.md`.

## The drop

```
delta-fixture-0.2.15.db     11,874,304 bytes   (vacuumed)
sha256  b864e5d1de17522bc25074aab45c1081a443624c7b47fc0a59ae3440c74bbd50
```

Built from the **consistent snapshot**, never the live database. Contents: 6 runs (the five D-1
runs plus the D-9 run), 2 sessions, 1,220 messages, 1,761 events, 606 journal rows. Same schema,
so it opens with the harness's own reader.

**Redaction is byte-preserving and operates on the raw JSON text, not a parsed tree.** Every
string literal is located in the raw bytes; keys are preserved so the JSON stays readable; ids,
enums and tokens of three characters or fewer are preserved; everything else has its contents
replaced 1:1 with a per-run marker letter. Same byte length, no escaping needed, structure intact.

```
A = resp_b3f468eb655d4c179cb4c48d830c505d   D-1 seq 1
B = resp_bffa3cad7b364e2dab54a578d1bbc308   D-1 seq 2
C = resp_b83e8472fa254cdfa9a6ec68b4186871   D-1 seq 3   <- stale
D = resp_2155d706e7424886b86dd5d49e5d82a0   D-1 seq 4   <- stale
E = resp_9416e6aa091d49b0a6cb4e1a94298ba8   D-1 seq 5
F = resp_a863d55947b84728acf1f03816ec74ef   D-9
```

Verified before packaging:

| check | result |
|---|---|
| client/personal terms outside a spill path | **none** |
| D-1 request lengths vs source | 303, 247, 285, 285, 1801 - **all byte-identical** |
| `previous_response_id` chain | intact, 1 -> 2 -> 3 -> 4 -> 5 |
| per-run markers distinguishable | A/B/C/D/E confirmed in `request` |
| spill paths preserved | 103 messages |

**The one exemption, stated so it cannot hide anything else:** `/srv/asteria/.delta/spill/<id>.txt`
paths are preserved verbatim, because D-9 asserts path enumeration. Nothing else is exempt.

**Two redaction bugs I hit, in case they matter for how much you trust the output.** The first
pass exempted any string *containing* a path, so a tool result listing the whole vault was
preserved whole and leaked 21 ways. Exempt the token, never the container. The second pass
re-serialised JSON and drifted lengths by 9-10 bytes on two runs, which would have quietly
destroyed the only property D-1 needs. Both caught by verification, not by reading the code.

And one about the verifier itself: my first leak scan used SQL `LIKE`, which folds ASCII case, so
it reported `Nic` for every preserved JSON key containing `nic` and `Asteria` for all 103
deliberately-preserved spill paths. **A scan that flags its own successes is not a scan.** The
figures above come from case-sensitive matching with the spill paths masked out first.

## seq 5 is NOT stale, and it is worth having

You asked because either answer is useful. It answered its own question correctly - a short
Telegram maintenance report, no vault review.

**So the fixture carries its own negative control.** The assertion is not "runs go stale", it is
this exact pattern:

```
seq 1  correct     seq 2  correct     seq 3  STALE
seq 4  STALE       seq 5  correct
```

A fix that over-corrects and breaks pinning generally fails on 2 and 5. A fix that under-corrects
fails on 3 and 4. There is no way to pass by accident.

One detail with no bearing on the test but worth seeing: **seq 5 diagnoses the bug, and gets the
cause wrong.** In its own words to the operator, *"That is why I answered your two Obsidian
deep-link questions with the vault review."* It attributes that to the missing Exa key, which is
D-2, not to the pin. The agent noticed the symptom, reached for the tooling failure it had just
been told about, and never suspected the harness.

## §7.1: `{{run.scratch}}` is safe here, but a neighbour breaks

Checked on this box. **`PROMPT_CONTEXT.md` does not mention scratch at all**, and nothing anywhere
hardcodes `scratch/` as the model's scratchpad. Renaming it to `.delta/scratch/` breaks nothing on
Delos.

The grep found a different break you did not ask about, same class:

```
skills/deep-research/SKILL.md:214
  "Do not write to the root `research/` folder. That is Delta harness scratch, written..."
```

That is a **model-facing instruction hardcoding the old research path**. When research moves to
`.delta/research/` it becomes actively wrong: it warns the model away from a folder that no longer
exists and says nothing about the one that does. Mine to fix, and I will when the knob lands - but
it generalises. Any deployment that wrote a skill or prompt to work around the collision has
encoded the old path in prose, and prose does not get caught by a compiler. Worth one line in the
release brief telling operators to grep their own skills for `research/`.

## Research paths ARE in the messages, and the fixture keeps them

I nearly sent you the opposite of this, so here is the corrected version with the numbers.

```
source, D-9 run     92 references to research/resp_a863….{0..12}   (799 messages scanned)
fixture             100 references, 15 distinct dirs
contrast, spill     88 source / 132 fixture messages
```

So **the ledger can recover research artifacts from message content** - the rows are there. My §3
point stands unchanged and gets simpler: the ledger under-reported that run by 13 directories
because it enumerates `.delta/spill/` only, not because the data was missing. A message-derived
ledger is sufficient; it just needs the second family added.

The fixture carries 15 distinct research dirs rather than 13: two belong to
`resp_124c1edd5d444743a49cbe880ce630c0`, referenced inside a D-9 message. Harmless, but you will
see an id you were not expecting.

**Why I am telling you I nearly got this backwards.** My first scan broke out of its loop after 8
unique matches, collected only short generic tokens like `research/` and `ai-research/`, and I read
that truncated sample as proof that no run-scoped paths existed. Then a verifier query searched for
`/research/` with a leading slash the paths do not have and returned zero, which agreed with the
wrong conclusion. Two scans, both broken, both pointing the same way. Caught by checking a
load-bearing negative before sending rather than by either scan.

That is the third time this week a number of mine survived because nobody asked where it came
from, and the standing rule from the first two - a zero is only evidence when the query could have
returned non-zero - is the one that caught it. Applies to the redaction too: the "clean" verdict on
this fixture is worth exactly as much as the scan behind it, which is why the one exemption is
named explicitly above rather than left implicit.

## Next

Capture session next, now that I know `cacheKey: run.session_id` is stable across the session and
that `/new` would destroy the very thing being measured. Understood that the Responses path sends
`prompt_cache_key` unconditionally while the chat path gates it behind a predicate that excludes
`chatgpt.com` - so a null result is a finding, and I will report it as one rather than as a failed
run.

— Delos
