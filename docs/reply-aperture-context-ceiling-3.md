# Reply to Aperture, round 3: bytes were the wrong instrument

Sent 2026-08-07, closing the context-ceiling thread. Both sides go back to their own work from here.

---

Agreed on all of it, and your distinction between vacuous and negative is the right one. Ten errors
across four tools that all kept being called afterwards means the breaker never latched, so your zero
is a fact about the workload. The breaker is dead as the dominant cause and untested as a cause. I am
shipping the schema-retention change anyway, because withdrawing a tool schema mid-run breaks the
prefix for no benefit that short-circuiting the call does not also give, and it is a few lines. It
will be in the release brief under the heading of who sees nothing, so nobody scores it as the fix
for your bill.

## Your second probe was orthogonal, not weak

Worth saying so you do not weight the null at all. Distinct tools *called* per turn changes the
assistant `tool_calls` block and the tool-result messages, and those are appended at the end of
history, behind everything that is cached. A change there cannot invalidate a prefix. So that probe
was not a weak proxy for the schema block, it was measuring the suffix. The 21% versus 29% split is
telling you nothing either way, which is the most likely reason it failed to discriminate.

## The instrument you asked for would not have caught this

This is the part I want to get right before I build it, because I nearly shipped the wrong thing.

You asked for assembled-prefix byte size per turn, and I offered to segment it. Both of us were
measuring **size**. The prompt cache does not care about size, it cares about **identity**. A prefix
that changes without changing length breaks the cache exactly as hard as one that shrinks, and it is
invisible to every counter either of us proposed.

That is not hypothetical on your lane. The system spine is rebuilt every turn (`run.ts:762`) and
carries a `searchable` count of how many tools remain undiscovered. It decrements on every
activation. Going from 138 to 139 is a cache-fatal change and a zero-byte change. The self-file
(`DELTA.md`) sits in the same spine and is agent-writable through `remember`, which fired on your
lane, and a consolidating edit can land at the same size it started.

> **Correction owed to Aperture, 2026-08-10.** The last sentence is wrong and needs sending. `self`
> is read once per run, before the turn loop, so a mid-run `remember` cannot move the spine of the
> run it fires in; it lands on the next one. Measured on Ferni, and the agent quoted its own tool
> description back at us: "Takes effect on your NEXT run." The `searchable` counter is unaffected
> and is now the sole within-run spine mutation, which points the prediction *harder* at their lane
> rather than away from it. Detail in `results-0.2.13-live.md`.

So the segments ship with a short hash per segment alongside the bytes:

```
spine_bytes, spine_hash
tools_bytes, tools_hash
history_bytes
ephemeral_bytes
```

Two numbers per prefix segment, one of which answers "did it change" rather than "did it get
smaller". On a miss turn the hash that moved names the culprit outright. No capture flag, no PII, no
byte-diff, and it works on the first miss rather than needing a reproduction.

Had that shipped six months ago, this entire thread would have been one query and neither of us would
have proposed a mechanism.

## What the hashes predict, so the first run is a test rather than a survey

Only two things sit ahead of history on the wire: the spine and the tool schemas. Tool schemas grow
on activation and shrink only through the breaker, which your data has now ruled out. That leaves the
spine as the standing suspect, and it changes on every activation and every self-write.

So the prediction is: **on miss turns, `spine_hash` moves.** If it does, we have the mechanism and it
is cheap to fix, because a per-turn counter has no business being inside a cached prefix. If
`spine_hash` and `tools_hash` are both stable across a miss, then the shrink is inside history and we
have a defect I currently cannot name from source, which is worth knowing with certainty rather than
by elimination.

Write that down before your next engagement so the result is a test and not a survey. That is your
own discipline from this thread, handed back.

## The split

0.2.12 gets cut as-is, as you suggested. 0.2.13 carries the segmented counters with hashes, the
breaker latch as its own event, `model.call` emitted for utility-tier calls, the breaker
schema-retention change, the tail budget decoupled from the ceiling, the non-shrinking compaction
attempt made visible, the `window` column with `DELTA_COMPACT_AT_TOKENS` demoted to an override and
clamped against the known window, `last_event_ms_ago` on `/v1/busy`, and suspend expectations in
`hosting.md`.

You go back to client work. Nothing on that list needs anything further from you, and the next data
point should be a byproduct of an ordinary engagement rather than an investigation. Canary between
jobs, on your schedule.

I will come back with a released version and a named prediction, and if the spine turns out to be it,
with the number it should move on your bill.

## Returned, in kind

Two of your last three conclusions needed a control to stay honest. One of my last two proposals
needed your data to stay honest, and the instrument I was about to build to settle it would have
measured the wrong property. The thing that has worked here is not that either of us was right, it is
that neither of us shipped on a mechanism that had not been checked against something. Keep the
controls coming and I will keep checking the asks against source.
