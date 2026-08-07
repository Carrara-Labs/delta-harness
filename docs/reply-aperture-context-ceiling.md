# Reply to Aperture: context ceiling and compaction

Sent 2026-08-07, answering `docs/ask-context-ceiling-and-compaction.md`.

---

Thank you for this one. It is the best field report we have had, and the 27/27 correlation is a
thing we would not have gone looking for. I have read the whole ask against the source. Most of it
holds, one load-bearing part does not, and that changes what we ship. Details below, then three
questions I need answered before we spend a release.

## What checks out

- **No model to context-window catalogue anywhere in `src/`.** Confirmed. The engine has no idea
  how big the model's window is. You read that correctly.
- **`compactAtTokens` is a single hand-set knob defaulting to 120k** (`config.ts:314`), with nothing
  reconciling it against the model in use. Confirmed.
- **The pre-send gate at `run.ts:866`** is what you think it is.
- **Compaction lands just under the ceiling and re-fires.** Confirmed, and the reason is worse than
  you guessed. See the next section.

One correction, in your favour: **`cache_hit_pct` already ships.** It is emitted on every
`model.call` at `run.ts:1054` and it is on the export allowlist, and it has been there since 0.2.11.
If it is not reaching your `agent_events` table, the gap is on the collector side rather than ours,
and it is worth ten minutes of your time because it is the field that makes the rest of this
self-service for you.

## The structural bug, straight from source

`run.ts:872`:

```
recentBudget = compactAtTokens - fixed - SUMMARY_RESERVE_TOKENS
```

**The retained-tail budget is derived from the ceiling itself.** On your lane that is
200,000 - ~16,000 - 4,000 = **180,000 tokens of tail**. Compaction is being told to compact a 207k
context down to about 198k. It lands at 99% of budget and the next turn's tool results push it
straight back over.

There is no low-water mark because the low-water mark *is* the high-water mark. That is
`spec-compaction-tail`'s 94-out-of-94 explained in one line. Your hysteresis request is not a
nice-to-have, it is the fix, and it is the first thing we are shipping.

Second-order, and you have not been billed for it visibly: `compaction.ts:538` returns early when
the shrink is not material, **before** the event is emitted. So an attempt that runs, calls the
utility model to summarize roughly 60k of transcript, and produces a non-material result **emits
nothing at all**. On a lane sitting permanently above its threshold that is a silent extra model
call, and its latency, in front of nearly every turn. I suspect some of your 227s max turn is this.
We are making it visible.

## The part that does not survive the arithmetic

Your stated mechanism is that compaction fires nearly every turn and every rewrite kills the prefix.
Compaction is only permitted to alter history when it shrinks the active set by at least 5%
(`MATERIAL = 0.95`, `compaction.ts:29`, enforced at `:400` and `:537`).

Against your own clean 9-turn trace:

| step | as % of context | above the 5% bar? |
| ---: | ---: | --- |
| -1,592 | 0.7% | no |
| -5,138 | 2.3% | no |
| -4,130 | 1.9% | no |
| -4,070 | 1.8% | no |
| -11,672 | 5.3% | marginal |

Four of five are below the threshold at which compaction is allowed to touch history at all. And
the magnitudes point the other way too: with a 180k tail budget, a compaction that genuinely fired
on a 207k context would drop roughly **-27,000** tokens, not -1,592.

Your earlier speed-lab run says the same thing from the other side: 275 rows, **5 compaction
events**, 78% cache. Five history rewrites cannot produce 27 misses.

So: the correlation is real, the 5.7x is real, the money is real. But on most of those turns
**something other than compaction is shrinking the context**, because history is otherwise
append-only. The candidates are the per-turn derived blocks, the sliding image-marker window, or a
mid-history rewrite by `demoteSpilled`.

This matters commercially, not academically. If compaction is not the mechanism, **raising the
ceiling to 700-800k recovers none of the 72%.** It would remove compaction from a 39-turn run and
leave the misses exactly where they are, and we would both believe we had fixed it.

## What we are shipping, in order

1. **Decouple the tail budget from the ceiling.** Compact down to a real low-water mark, so one
   compaction does not guarantee the next. Correct at any ceiling, and provable from source without
   waiting on your data.
2. **Emit the non-shrinking compaction attempt**, so the silent per-turn utility call above stops
   being invisible to both of us.
3. **A `window` column on the existing model table in `pricing.ts`**, with the ceiling derived as
   `window - max_output - reserve` and `DELTA_COMPACT_AT_TOKENS` demoted from the only input to an
   override. Plus the guard you asked for on the inverse error: a knob set above the known window
   gets clamped and logged rather than silently converting compaction into overflow. The table, the
   env-override pattern and the resolver all already exist, so this is about fifteen lines and no
   new file.
4. **A turn clock on `/v1/busy`.** We are adding `last_event_ms_ago` rather than turn age, because
   "how long has it been silent" is the question your reconciler was actually asking. Your consumers
   should not each be guessing this constant.
5. **What survives a suspend**, written down in `hosting.md`, for your P2.

Cache-safe rewriting (`spec-cache-breakpoints`) stays queued until question 1 below is answered. We
would be aiming it by inference right now, and this report is the reason we know better than to do
that.

**0.2.12** we are cutting as-is: built, 873 tests green, and its compaction telemetry is the
instrument for all of the above. The only reason we would reopen it is item 2. We are deliberately
**not** adding `context_delta`, because you derived it from `input_tokens`, which we already export,
so the ask is already satisfied and a second field would just be a second thing to keep true.

## Three questions, in priority order

**1. The decisive one. Count `compaction` events per turn against `cache_hit_pct` on the sphere
run.** This works on 0.2.11 today, no upgrade and no capture flag: `compaction` is not a
payload-bearing event, so its attributes bypass the consent filter and are already in your table.

If misses substantially outnumber compaction events, compaction is not the mechanism, and the
ceiling change is a deferral rather than a fix. Everything else on this list depends on that answer.

**2. What is the real window, and on which model id?** You flagged the "comfortably above 245k"
deduction as inferred rather than verified, which was the right call, and here is why it matters:
Anthropic's 1M context is a beta header and is tier-gated, and **we do not send that header today**.
The only beta our native wire sets is fast mode. So if that lane is on the standard window, a
700-800k ceiling turns compaction into overflow, which is your own question 3 pointed back at you.
This decides whether the catalogue entry for `claude-opus-5` reads 200k or 1M, and it is the one
number I am not willing to guess.

**3. One capture pair.** With `DELTA_CAPTURE_PAYLOADS=1`, the assembled request for a miss turn and
the hit turn immediately before it. Byte-diffing two consecutive prompts finds the first divergent
block in minutes and settles question 1 directly, rather than by elimination.

## Last thing

Recorded, as you asked: the suspend/resume wire refresh evicting a dead pooled socket in three
seconds with no turn impact is the 0.2.5 stall batch doing exactly its job on a lane that suspends
daily. Noted on our side too.

And the agent side of that engagement is worth saying out loud. Refusing the premise with numbers,
stopping to ask before spending, catching eight name-traps, reporting its own burned credits
unprompted, and then finding the 428-credit path where the naive one was 824. That is the use case,
and you are right that what stands between you and it is engine economics rather than reasoning.
That is our problem to fix and we are on it.
