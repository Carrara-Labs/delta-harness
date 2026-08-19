# Spec: compaction must pin the request it is compacting

Status: **spec v1, pre-implementation.** D-1 of `docs/backlog-delos-field-report.md`, re-scoped after
fleet measurement. Batch: `harness-0.2.15-plan.md`, item 1.

The smallest diff in the release and the most damaging defect in it.

## 1. The defect

`compaction.ts:161-171`:

```ts
function originalAsk(db: Database, sessionId: string): string {
  const row = db
    .query("SELECT request FROM runs WHERE session_id = ? ORDER BY seq LIMIT 1")
    .get(sessionId) as { request: string } | null;
  ...
}
```

rendered at `compaction.ts:577-581` as:

```
Continue following the original session request:
<original_request>…</original_request>
```

That block is **trusted task semantics** by construction — the surrounding comment says so, it is
separated from the untrusted historical summary on purpose, and `POLICY.md` renders after it as the
non-overridable contract. When it holds the wrong task, the agent obeys the wrong task.

`ORDER BY seq LIMIT 1` is correct for exactly one case: a session whose first run *is* its only
request. It is wrong for every session that holds more than one.

## 2. What the fleet says

The report filed this as a Connect/chat problem: a Telegram history threads into one session via
`previous_response_id`, so seq 1 is merely the oldest thing anyone ever said. **That framing is too
narrow.** The firing condition is only "a run that is not first in its session, which also compacted",
and nothing about it is chat-specific.

Measured — a run at `seq > 1` with a `compaction` event, comparing the pinned text to the run's own:

| lane | exposed runs | pin was a different task | harmless | stale pin longer than the real request |
|---|---:|---:|---:|---:|
| `aperture-qs-69598a208017` (carrara, paid) | 27 | 27 | 0 | 23 |
| `aperture-qs-agent` | 2 | 2 | 0 | 0 |
| `ferni` (live) | 13 | 13 | 0 | 0 |
| `aperture-intake-69598a208017` | 0 | — | — | — |

**42 exposures, none harmless.** A meaningful benign share was the expected result — a lane sending the
same standing prompt every run would pin the right text by accident — and there were none. On the
busiest client lane 23 of 27 stale pins were *longer* than the request they outranked, which is the
Delos shape exactly: a large stale instruction dominating a short live one. 23 of 71 sessions on that
lane hold more than one run; the longest holds 16. Ferni's longest holds 19.

Delos's own observation, for the record: compaction at turn 8 (`compacted_turns: 96, kept: 16,
summary_tokens: 1090`) demoted a live 110-character question to `active=0` and left a 4,713-character
summary instructing the agent to *"assess the shared digital brain"*, asked 40 minutes earlier. The
agent answered the wrong question twice, with no error anywhere.

## 3. The fix

The current run's id is **already threaded to the call site**. `maybeCompact` takes
`opts.anchorRunId` (`compaction.ts:350`), added in 0.2.13/S5 for the atomic anchor reset, and both
call sites pass `run.id` — `run.ts:928` on the proactive path and `run.ts:1073` on the
overflow-recovery path. Nothing new needs plumbing.

```ts
/** The ask this compaction is serving: the CURRENT run's request input, bounded. Read FRESH from
 * `runs` — never from a prior model summary — so an injected instruction can't rewrite the task.
 * Only `input` is read; the full request is never placed in context (metadata can carry creds). */
function currentAsk(db: Database, runId: string): string {
  try {
    const row = db
      .query("SELECT request FROM runs WHERE id = ?")
      .get(runId) as { request: string } | null;
    const input = row ? (JSON.parse(row.request) as { input?: unknown }).input : "";
    return typeof input === "string" ? elide(input, ASK_CAP) : "";
  } catch {
    return "";
  }
}
```

Call site (`compaction.ts:577`):

```ts
const ask = opts.anchorRunId ? currentAsk(db, opts.anchorRunId) : "";
```

For a single-request session the two queries return the same row, so a task run's rendered summary is
**byte-identical** before and after. That is the property that makes this shippable as a patch.

### 3.1 Delete the fallback. Do not reproduce the defect as a safety net.

`opts.anchorRunId` is optional in the type but no call site omits it. The tempting move is
`opts.anchorRunId ? currentAsk(...) : originalAsk(db, sessionId)`. **Do not.** 42 of 42 measured pins
under that query were the wrong task. A fallback whose behaviour is the bug is not a fallback.

When `anchorRunId` is absent, emit **no ask block at all** — `askBlock` is already conditional on a
non-empty `ask` (`compaction.ts:578-581`), so the empty string is a supported state today. A summary
with no pinned ask loses task continuity; a summary with the wrong pinned ask actively redirects the
agent. The first degrades, the second corrupts.

Better still, tighten the type: make `anchorRunId` required on the opts object. Both call sites already
pass it, the compiler proves the third caller does not exist, and the `""` branch becomes unreachable
rather than untested. This is the reviewer's call — see §6.

## 4. What must not change

1. **The trust boundary.** The block stays *trusted* task semantics, read fresh from `runs`, never from
   a model-written summary. Reading a different row of the same table preserves that exactly. `defang`
   and `elide(…, ASK_CAP)` are unchanged, and the `<original_request>` delimiters stay.
2. **The wording.** "Continue following the original session request" is now inaccurate for a
   multi-request session — it is the *current* request. Change it to
   `Continue following the request you are working on:` and keep the `<original_request>` tag name, so
   nothing that greps the wire format breaks. A model that has learned the old sentence is not relying
   on the word "original".
3. **Byte-identical output for single-request sessions.** Assert it in the test, do not assume it.
4. **No new query per turn.** `currentAsk` runs once per compaction, exactly as `originalAsk` did.

## 5. The test that fails without the fix

`test/compaction.test.ts`:

1. Create a session. Insert run A (`seq 1`, input `"AAAA…"`, distinctive), then run B (`seq 2`, input
   `"BBBB…"`, distinctive and shorter than A — the measured majority shape).
2. Fill the session with enough active messages to cross `recentBudgetTokens`.
3. `maybeCompact(db, events, stubChat, sessionId, spine, { recentBudgetTokens: small, anchorRunId: B })`.
4. Assert the committed summary message **contains B's input** and **does not contain A's**.
5. Second case: a session with only run A; assert the summary bytes are identical to the pre-fix
   golden.

Pre-fix, step 4 fails on both halves. Verify that before keeping the test.

**Fixture note.** Delos has offered its database and we have accepted for this and D-9. A synthesised
two-request session proves the query; a real one proves the shape (a long stale ask against a short
live one, which is where the harm is). Use the synthetic one in CI and the real one once, by hand.

## 6. For the reviewer

1. **Required or optional `anchorRunId`?** The spec prefers required. Argument against: `maybeCompact`
   is exported and a future caller (a maintenance sweep, a test) might legitimately compact without a
   run in flight. Argument for: that caller does not exist, and the optional path is precisely the one
   with 42 recorded failures.
2. **Is "no pin" genuinely safer than "first-run pin"?** Stated as a principle in §3.1 with the
   measurement behind it. If you think an ask block is load-bearing enough that a stale one beats none,
   say so — it inverts the fix.
3. **Should a multi-request session carry both?** Rejected as scope: a "standing goal for this session"
   is a real feature and the report says it correctly — it should be *named and set explicitly*, not
   inferred from row order. Do not let this spec grow it.
4. **Does anything else read the first run of a session?** Grep returned only this call site. Confirm
   independently.
