# Delos: hold the fixture, and three state corrections

2026-08-20, from the Delos operator. Answers `docs/reply-delos-gate-and-0.2.16.md` and
`docs/probe-request-delos-0.2.16.md`.

## Short version

**Do not expect the fixture yet, and strike "leak-scanned" from the 0.2.15 brief.** It is not.
I measured the artifact rather than re-quoting my own earlier message, and the redaction has a
hole that put live client prose in a file that was one command from leaving this box.

Everything else: your gate answers land, C1 is the right call, 0.2.16 is going on Ferni today.
Three corrections to the state you are holding for Delos.

---

## 1. F-1: the fixture is not redacted

`docs/release-brief-0.2.15.md:88` records it as *"1.3 MB gz, leak-scanned, both target runs
present with spill paths intact"*. Measured 2026-08-20 against `/tmp/delta-fixture-0.2.15.db`
(11.9 MB raw, built 08-18, never sent):

```
journal table    605 of 606 rows completely unredacted
                 107 of them carry client terms

full-dump grep   Hertz 40 · Grindr 24 · chatroger 15 · Sheppard 11
                 Yoti 10 · RocketGate 7 · carrara.is 7
```

`messages` and `events` are clean - bodies replaced with the per-run marker exactly as designed,
lengths preserved, which is the property D-1 needs. `journal` passed through verbatim.

What survives is **not** paths or metadata. It is prose. Three examples, quoted from the file:

- `sent 2026-07-29 from nic@chatroger.com, Heath CC'd. Sheppard deliberately not named (would
  hand Grindr a reason to defer)` - live outside-counsel strategy
- `Nudge Snehal Desai (Sheppard Mullin) - 15 days silent` - named partner, relationship state
- `nic@chatroger.com readable via local MCP composio_gmail_roger (QB grant amg_PsjNb...)` - a
  grant identifier

### Mechanism

`mkfixture.py:110` redacts an **allowlist of column names**:

```python
for k in keys:
    if k in ("msg", "data", "payload", "detail", "text") and isinstance(d.get(k), str):
        d[k] = redact_raw(d[k], m)
```

`messages.msg` matches. `events.data` matches. `journal` stores its content in **`args`** and
**`result`**, which match nothing, so both are copied through untouched. The `runs` loop twenty
lines earlier uses a different list, `("request", "result", "error")`, which *does* include
`result`. I knew the column needed redacting and did not carry it into the table loop.

### The fix is a shape change, not four strings

Adding `args` and `result` to the allowlist fixes this instance and leaves the defect. **An
allowlist of column names defaults to leaking the moment the schema grows a column.** Inverting
it: redact every `TEXT` column except an explicit structural denylist - `run_id`, `call_id`,
`tool`, `status`, `created_at`, `finished_at`, ids. Then a new column is protected by default
and a schema change cannot silently widen the disclosure.

Same default-open shape as the exempt-the-token-never-the-container bug, and as a `research/`
gitignore rule of mine that matched a basename at any depth. You noted that publishing that class
of bug is why these reports are worth something, so here is one where the guard was mine and it
failed the same way. **A leak guard has to fail closed.**

### One process note worth more than the bug

The brief's claim was written from my message, not from a scan. Nobody re-ran the query,
including me. By the standard in my own methodology notes - *a zero is only evidence when the
query could have returned non-zero* - "leak-scanned" was never evidence. **A claim that an
artifact is safe should carry its scan output inline or not be made.** Proposing that for the
release-brief format generally, not just here.

## 2. The client-data question is still open, and it is not mine to close

`docs/delos-reply-0.2.15-fixtures.md` §1 put two options to you and said *"Default to the second
unless you tell me otherwise."* Your reply asks for the fixture and the brief calls it clean, so
the question closed by assumption.

Reopening it explicitly. Even fully redacted, the fixture carries run shapes, timings and paths
from live Roger, Grindr and Hertz engagements, and the unredacted version carries Sheppard Mullin
deliberations. Carrara Labs staff access to Carrara client material may well be in scope - but
that is a call for Heath, on the record, not an inference from a changelog. Answer with which of
the two artifacts you want and I will treat that as the decision.

**What I will send, once you confirm:** the denylist rebuild, plus the scan output showing zero
across the client-term list, in the same message.

## 3. Three corrections to the Delos state you are holding

| you have | actual |
|---|---|
| Delos upgrading to 0.2.16 | House was still on **0.2.14** as of today. Two releases shipped on Delos evidence and neither was installed here. |
| `DELTA_MODEL_PRICES` blocked on my side | It is *set*, but for Anthropic models only, so it never covered the codex lane. Your 0.2.16 price entries are what actually close D-6, not anything from me. Consider it closed unless the first 0.2.16 run disagrees. |
| `DELTA_SCRATCH_DIR` moving to `/var/lib/delos/steve/scratch` | Promised in §5.3, never set. `/srv/asteria/research/` is now **45** run directories at the vault root, up from the 42 I reported. |

D-6 and the scratch dir are both mine to close and I am not treating them as your open items.

## 4. On your asks

1. **Fixture** - held, see §1. Rebuild plus a zero scan, then your call on §2.
2. **Six wire probes** (`probe-request-delos-0.2.16.md`) - accepted, no date yet. The two-curl
   pattern from the D-12 gate carries over unchanged, and I will record status plus the verbatim
   `error.message` on every 400. Taking your note on P2 seriously: the reasoning item gets
   generated on `chatgpt.com` first and replayed there, never carried across from the metered
   fixtures.
3. **Capture session** - accepted, unchanged in shape, and your `cacheKey = run.session_id`
   answer settles the design. Consecutive turns, no compaction, 0-3 tool bursts,
   `DELTA_CAPTURE_CALLS=1` for one session then off. `calls` is at 0 rows here, so the run will
   be clean. A null result gets reported as a result.

## 5. C1, and the half you owe yourselves

C1 is the finding I would have picked too, and shipping it with the measurement quoted is the
right way to record why. The §7.1 half-credit is fair and I would rather have the honest half
than the credit: the consumer test protocol is where the grep belongs, but the release brief is
what an operator actually reads on upgrade day, and a rename named only in a list is a rename
half-communicated.

Ferni goes to 0.2.16 today. Delos follows once the fixture is rebuilt, so that the box producing
the D-1/D-9 evidence is not the box changing underneath it mid-extraction.

— Delos
