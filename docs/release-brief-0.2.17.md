# Release brief - Harness 0.2.17 "the long run"

Status: **STAGED 2026-09-02, final battery running.** Six review rounds with codex (every P1
fixed), 1037 tests green, three twin-lane batteries on Aperture Quick Search plus an offline
recall eval on production compactions. The study behind it: `docs/study-long-horizon-synthesis.md`
(sections 9.1 to 9.12 are the measurements, in order).

## What it is

One theme: a run that has to keep working after its context is cut. Four mechanisms and one set
of instruments, each shipped as its own slice and measured before the next was added.

## What it is worth, and to whom

Every number below is from the batteries or the recall eval, not estimated.

| defect | measured | fix | who |
| --- | --- | --- | --- |
| `recall` could not find what it was asked for | phrase search hit the answer in 7% of searches; recovery arm 21% correct | FTS5 index, any-word, bm25: recovery arm 52% (72% on facts the agent wrote itself) | every long run |
| summaries dropped the payload | 30 of 30 audited identifiers lost per compaction (battery 0); 35% on the August fleet report | class-budgeted anchor index + defanged appendix: summarizer drops 30%, appendix restores 97% | Aperture QS accuracy, Ferni |
| agents re-ran searches after a cut | 0.2.16 at a tight ceiling: 62 turns, 25 compactions, $9.29 on a 5-person shortlist | calls ledger + recovery footer: same prompt 11 turns, $0.85; recall calls 0 to 12 per 23 runs | every tool-heavy run |
| a compaction's cost was invisible | 30.6% of one lane's spend with no attribute naming it | `turns_since_compaction` + unsuppressed reload shortfall: 20-30k tokens per cut at 200k, 117-217k per hard run at 60k | operators sizing ceilings |
| "we mutate history" was an untested theory | none | history digest: byte-stable on 574 of 574 turns; provider diagnosis agrees | the open cache defect |

**What the batteries killed:** a retained tail proportional to the ceiling (reverted: a 12k tail
at 60k thrashed a heavy run 92 turns / 55 compactions where the flat tail took 18 / 11), and the
idea that a longer or smarter summary fixes recall (anchors, a stronger summarizer model and an
entity-table prompt all replayed to the same 20 to 25% closed-book: capacity, not prompt).

**Who sees change on upgrade day:** every deployment gets migration v16 (one-way, snapshot first)
and a longer compaction summary (appendix, two ledgers, one footer, all bounded). Nothing on the
wire changes unless `DELTA_CACHE_DIAGNOSIS=1` is set. The retained tail, the trigger and the
budgets are byte-identical to 0.2.16.

## Batteries (Aperture Quick Search, Opus 5 medium, real MCP tools, 23 pinned prompts per battery)

| battery | ceiling | control | candidate | result |
| --- | --- | --- | --- | --- |
| 0 | 200k | 0.2.16 | slice 1 (telemetry only) | A/A noise floor: up to 25% per tier at n=5-10; 45/45 succeeded |
| 1 | 60k | 0.2.16 | slices 1-4 | control ran away (stopped early at the spend flag); candidate 23/23, within 12% of its 200k cost |
| 2 | 60k | (same lane, sequential) | slices 1-6 | ledger works (12 recall calls), reload halved; proportional tail thrashed M6, reverted |
| 3 | 60k | (same lane, sequential) | final (slices 1-4, 6, FTS5) | TBD |

## Still open, honestly

- Agents call `recall` when the summary tells them what they already ran, not otherwise; the
  cue is the ledger, and it is one line. A spine-level norm was not tested.
- The stationary-prefix cache miss did not reproduce on either lane in three batteries; the
  instruments are now in the fleet's events for the day it does on a client lane.
- Research children (H7) wait on the host-side read-only annotation; the child contract is not in
  this release.
