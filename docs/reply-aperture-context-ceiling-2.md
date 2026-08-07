# Reply to Aperture, round 2: the shrink has a name

Sent 2026-08-07, answering their Q1/Q2/Q3 results.

---

This is the most useful exchange we have had, and the reason is that you ran the query against your
own hypothesis first. I would rather have one consumer who does that than ten who file clean asks.
Please do not read the last round as a scolding: the correlation you found is real, nobody else
found it, and it is the reason I went looking in the right part of the engine.

All three of your corrections land. Then the interesting part: I think I can name the shrink.

## Your corrections, accepted

**`DELTA_CAPTURE_CALLS`.** My slip, and a bad one on a prod lane. Confirmed at `cli.ts:104` and
`index.ts:110`; `DELTA_CAPTURE_PAYLOADS` (`config.ts:307`) governs exported attributes and is a
different thing entirely. Thank you for checking against the spec instead of running what I wrote.

**Utility calls are invisible.** Confirmed, and it is broader than you guessed. `model.call` is
emitted in exactly one place, `run.ts:1044`, on the main-loop call. Every `chatUtility` path bypasses
it: the compaction summary (`run.ts:876`), and two others at `run.ts:484` and `run.ts:983`. Those
calls are charged through `addUsage`, so they are in your cost, and they emit nothing at all. Your
161 compactions is a floor on attempts, exactly as you said, and no consumer can currently see or
price the utility tier. We are fixing the emission, not the accounting.

**The gate under-counts.** Confirmed, and there are two contributions. The byte estimator has a
per-token bias that a large MCP tool surface makes worse, which is the steady-state gap you measured.
On top of that, `run.ts:897-898` deliberately zeroes both `lastInputTokens` and `lastEstimate` after
any compaction that shrank, so the provider-anchored half of the projection is discarded and the gate
falls back to the pure byte estimate until the next call re-establishes it. Your read is right and
it cuts the same way mine did: even less of your bill is compaction's doing.

## Where I think the shrink comes from

Your instinct was correct and you picked the wrong one of the fresh-every-turn parts.

**The ephemeral retrieval block is appended after history, not ahead of it** (`run.ts:773`, assembled
at `run.ts:922`), and the breakpoints are told to skip it. It can shrink freely without re-reading
anything behind it, because there is nothing behind it.

**Tool schemas are the right family.** But `activate()` (`run.ts:363`) only ever adds, so activation
cannot shrink the surface.

**There is exactly one thing in the engine that removes a tool schema mid-run: the A4 breaker.**

`effectiveTools()` (`run.ts:397`) is rebuilt at the top of every turn and drops any quarantined tool
from the advertised schema:

```
for (const n of active) {
  if (breaker.disabled.has(n)) continue;   // A4: quarantined - drop from the advertised schema
  ...
}
```

A tool that returns the same `[tool error]` N times is disabled for the rest of the run
(`run.ts:1348`). Tools sit ahead of the message list on the Anthropic wire, so losing one invalidates
everything behind it. And on that same turn the latch also runs a mid-history `UPDATE`
(`run.ts:1351`) appending a `[norm]` line to a past tool-result row, which is a second, independent
prefix break inside history itself.

Everything you measured falls out of that:

- **Shrink and miss are the same event**, not correlated events. One `aperture__*` MCP schema is
  comfortably 1,500-5,000 tokens. Your steps were -1,592, -4,070, -4,130, -5,138.
- **No compaction event**, because compaction never ran. That is your 68%.
- **Absent from your read-only diagnostic.** Eight turns, monotonic growth, perfect caching, and no
  tool failed. The engagement alternated read-pages with write-notes, which is where tools fail. Your
  own writeup mentions roughly 50 credits burned on a malformed search.
- **It is a one-way ratchet.** The quarantine is permanent for the run, so each latch buys one full
  context re-read and the surface never comes back.

Treat this as a hypothesis with a named mechanism, not a conclusion. Your capture pair settles it in
one look: on a miss turn the `tools` array will be one element shorter than the hit before it.

**And if it holds, the fix is small and slightly embarrassing: the cure costs more than the disease.**
The breaker exists to stop a categorically dead tool from looping the model, and it was worth
building. But it does not need to withdraw the schema to do that. Keeping the tool advertised and
short-circuiting the call to a synthetic refusal gives identical protection, costs one branch, and
leaves the prefix intact. Withdrawing it is what makes a $3.50 retry loop into a full re-read.

## What you can join today, before the capture

The latch emits no event, which is a gap we are closing. But `tool.result` already carries
`gen_ai.tool.name` and `is_error` on the safe allowlist, so the proxy is available now: for each miss
turn, check whether some tool had accumulated repeated `is_error` results in the preceding turns and
then stops appearing in `tool_calls` from that turn onward. If the misses line up with tools going
quiet after failing, that is the same finding without waiting for the diff.

## What we are shipping, updated

Your one-number ask is right, and we are shipping a slightly better version of it:

1. **Segmented prefix bytes on `model.call`**: spine, tool schemas, history, ephemeral, as four
   counters. You asked for the assembled-prefix total, which would have told you *that* something
   shrank; four numbers tell you *which part*, in the same join, with no capture flag and no PII.
   About five lines. Given that today came down to "we had the data and never queried it", the fix
   is to make the next question answerable by a query too.
2. **Emit the breaker latch** as its own event, with the tool name and the schema bytes withdrawn.
3. **Emit `model.call` for utility-tier calls**, so the compaction summary and its friends stop being
   free-looking.
4. **Keep the schema resident when the breaker latches**, pending your capture pair. This is the one
   that would actually recover money, and it is a much smaller change than the ceiling work.
5. The five from the last round, unchanged: decouple the tail budget from the ceiling, emit the
   non-shrinking compaction attempt, the `window` column with the env knob demoted to an override,
   `last_event_ms_ago` on `/v1/busy`, and suspend expectations in `hosting.md`.

Note what moved. Last round item 1 was hysteresis. This round it is instrumentation and the breaker,
because the ceiling work is now a correctness fix with a real but modest payoff, while the breaker
may be most of the 72%. That reordering is entirely a product of your join.

## On the window

249,127 accepted, zero overflow, zero forced-compaction retries, no beta header. That is a hard
floor from the field and it is worth more than a published number, because it is the number that lane
actually survives. We will seed the catalogue conservatively from it rather than from an inference,
and the clamp-and-warn guard means a wrong entry degrades loudly instead of silently.

## The part worth keeping

You wrote that the root cause of the bad report was building an ask on a hypothesis without running
the query. I would put it differently. You produced a specific, falsifiable claim with the exact
commands to check it, which is what made it cheap for me to check and cheap for you to retract. The
failure mode that actually costs releases is the unfalsifiable report, and this was the opposite of
one. Keep sending them in this shape.

I will hold the breaker change until your capture pair lands, for the same reason you held yours.
