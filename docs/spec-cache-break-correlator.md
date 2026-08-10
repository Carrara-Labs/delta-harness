# Spec: correlate a prefix change against the provider's own cache-read drop

Status: **specified, not built**. Written 2026-08-10 from a three-way read of competitor source
(`docs/research/competitor-cache-instrumentation-2026-08-10.md`).

## The problem, stated honestly

Roughly one model call in 25 misses the prompt cache and **we cannot say which one, or why**.

0.2.13 shipped S1 to answer this. It did not, and the reason is not that S1 is wrong. S1 emits
`{spine_bytes, spine_hash, tools_bytes, tools_hash, tools_n, self_bytes, history_bytes,
ephemeral_bytes}` on `turn.start` (`run.ts:978-997`). On Ferni's 11-turn reading every one of those
was stationary while `cache_hit_pct` swung 59-97. The instrument said "nothing changed" and it was
telling the truth about what it measures.

Three gaps separate "nothing changed" from "and therefore the cache should not have missed":

1. **Nobody joins the two halves.** S1 says what the prefix looked like. `model.call` says what the
   provider gave back. No code compares them at the moment of a miss, so the join is a human doing
   SQL after the fact, which is how the last three releases went.
2. **The digest sits above the serializer, and we wrote that down.** `run.ts:96-99`: *"this digests
   the ENGINE-ASSEMBLED input, NOT the serialized request body — the provider renames and reshapes
   both segments downstream (`toAnthropic` lifts system into a content block and renames
   `parameters`→`input_schema`; the Responses path flattens both)."* A mutation introduced by
   `toAnthropic` is invisible to `spine_hash` by construction.
3. **There is no control.** We record suspicious turns. We never record the turns where a segment
   moved and the cache did **not** break, so we cannot tell a cause from a coincidence.

## What the field says

All three competitor harnesses were read for this (OpenClaw `b738e25780`, Hermes `6e87d43a5`,
Pi `ac4ac9e`). Findings that bear on the design:

- **Nobody debugs this with a byte-diff tool.** OpenClaw captures literal wire bytes behind
  `OPENCLAW_DEBUG_PROXY_ENABLED` and its cache-trace JSONL is **write-only** — no reader, no
  differ. Hermes and Pi have no wire capture at all. A capture rig is not what solved it for anyone.
- **OpenClaw solved it with correlation**, in `prompt-cache-observability.ts`: snapshot the
  cache-determining inputs per segment, diff consecutive snapshots into typed change codes, then
  fire **only when the provider's own `cacheRead` confirms a real drop**, carrying the suspect.
- **OpenClaw logs the control** (`"state changed without a cache-read break"`), which is our own
  standing rule arriving from outside.
- **OpenClaw's digests are structurally blind to one break class.** They canonicalize through
  `stableStringify`, which sorts object keys, while the emitted JSON preserves insertion order. A
  key-reordering serializer change breaks the cache and leaves their digest identical. Their
  CHANGELOG #101009 is the matching post-mortem: a sanitizer at the serializer changed bytes the
  instrument never saw.

We do not have OpenClaw's specific bug — `tools_hash` digests `JSON.stringify(specs)`, the same
array handed to `deps.chat` (`run.ts:1004-1006`), in insertion order. We have the *general* version
of it: everything `toAnthropic` does afterwards is unmeasured.

## The design

Three parts. Parts 1 and 2 are the release; part 3 is a fallback that only gets built if the first
two fail to name a cause.

### Part 1 — the correlator

Extend the existing S1 snapshot rather than adding a parallel instrument.

**On the way in**, the `prefix` object at `run.ts:978` already is the snapshot. Add the fields that
determine cache identity but currently live elsewhere on the event: `model`, `effort`, `cache_ttl`,
`provider`, `fallback`.

**On the way out**, `model.call` already carries `cacheRead`. Hold the previous turn's
`cacheRead` and gross input in the run loop (in-process, within-run only — the digest salt already
scopes every comparison to one daemon lifetime, so a cross-run comparison was never available).

**Fire condition**, both clauses required:

```
cacheRead < prevCacheRead * 0.95   AND   (prevCacheRead - cacheRead) >= 1000
```

The ratio catches the collapse; the absolute floor stops a small session from alarming on
breakpoint-granularity noise. Thresholds are OpenClaw's and are a starting point, not a result.

**Emit `cache.break`** with a `causes[]` array of typed codes, computed by diffing this turn's
snapshot against the previous one:

| code | condition | reading |
| --- | --- | --- |
| `spine` | `spine_hash` moved | self-file, stable context, or policy |
| `tools` | `tools_hash` moved, `tools_n` same | a description or schema changed under a stable count |
| `tools_n` | `tools_n` moved | activation or breaker withdrawal (S4 says which) |
| `model` / `effort` / `ttl` / `provider` | that field moved | a routing or config change, legitimately re-billing |
| `compaction` | a compaction committed this turn | the one deliberate exception; not a defect |
| `wire` | an emitted-byte hash moved while its assembled digest did not | **the serializer mutated the prefix** |
| `none` | no code fired | the prefix was stationary and the cache broke anyway |

`none` is the important row. It is the only outcome that says the cause is outside everything we
measure, and it is the trigger for part 3.

**Emit the control.** When any code would have fired but the cache did **not** break, emit
`cache.stable` with the same `causes[]`. Without it, a `spine` code on a miss turn is an
association, not a finding. This is cheap and it is the difference between the last three releases
and this one.

### Part 2 — hash the emitted bytes, in emission order

Add to `provider.ts`, at the point the body is handed to `fetch`, after every reshape:

```
wire_system_hash = prefixDigest(JSON.stringify(body.system))
wire_tools_hash  = prefixDigest(JSON.stringify(body.tools))
```

Two segments only. **Do not hash the whole body**: `run.ts:974` already rejected that at ~1MB of
serialization per turn, and the reasoning still holds. System and tools are the segments the
serializer renames and reshapes, they are small (spine under 2k tokens, tools tens of KB), and they
sit ahead of history where a mutation is maximally expensive.

`JSON.stringify` preserves insertion order, so this measures emitted byte order and not a
canonicalized projection of it. That is the whole point, and it is where OpenClaw went wrong.

A `wire` code therefore means: **the assembled input was identical and the bytes we sent were not**.
That is a one-line answer to a question three releases have failed to answer.

Reuse `prefixDigest` and the existing per-process salt. These attributes export without payload
consent and the spine is low-entropy enough to be dictionary-testable unsalted (`run.ts:85-89`).

### Part 3 — request capture, only if part 1 returns `none`

Not in this release. If `cache.break` fires with `causes: ["none"]` at a meaningful rate, the cause
is below both instruments and capture becomes justified by evidence rather than by analogy.

If it is ever built: OpenClaw's capture tables have **no retention bound at all** and their docs
tell operators to purge by hand. We fixed that class this week. Any capture we add is bounded by
`DELTA_RETENTION_MAX_CALL_BYTES` on the same terms as `calls`, from the first commit.

## What this deliberately does not do

- **No byte-diff tool.** None of the three has one, and a `causes[]` code localises to a segment,
  which is the actionable resolution. A `delta cache-diff` CLI would put us ahead of all three; it
  is not worth blocking a release on.
- **No mechanism fix.** Four proposed mechanisms have died, one of them a written prediction that
  measurement falsified. This release instruments; it does not guess a fifth time.
- **No cross-run comparison.** The salt forbids it and rotating to an unsalted digest to gain it
  would trade a real privacy property for a convenience.

## Cost and default

Two extra `JSON.stringify` calls on small segments, one hash each, per turn. The correlator is pure
comparison over values we already compute.

**Default ON.** It is a handful of microseconds and an event that only fires on a real drop. A
diagnostic that has to be remembered will not be — that lesson cost us 45% of Ferni's database this
week, and gating this behind a flag would repeat it. `cache.stable` (the control) rides the same
default so the denominator is always there.

## How we will know it worked

Not "the miss rate fell". This release does not fix anything, so a fall would be noise.

**Success is that a miss is attributable.** On the next Aperture engagement, every `cache.break`
carries a `causes[]` that is not `["none"]`, or the `["none"]` rate is measured and becomes the
justification for part 3. Either outcome ends a three-release run of guessing.

## Honesty ledger

- Thresholds 0.95 and 1000 are borrowed, not derived. They may need tuning against a real lane and
  we should expect the first reading to tell us so.
- `wire` hashing covers system and tools, not messages. A serializer mutation inside message
  content stays invisible. Accepted deliberately for the per-turn cost; stated so nobody reads a
  clean `wire` field as proof the whole body was stable.
- Within-run only. A first turn of a run has no predecessor and emits nothing.
- If the cause turns out to be a provider-side matching rule rather than anything in our bytes, this
  instrument will report `none` forever and be correct to. That is a real possible outcome.
