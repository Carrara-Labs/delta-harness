# Pi (earendil-works/pi) long-horizon teardown

Source-level study of how Pi handles long-running tasks, compaction, context management, and multiple tasks. Read against `~/delta/.refs/pi` at main `23842b1` (2026-09-02). All paths below are relative to that checkout. Line numbers are from that commit.

Scope note: Pi is two things at once right now. The shipping coding agent (`packages/coding-agent` on top of `packages/agent/src/agent-loop.ts`) is what users run. In parallel, `packages/agent/src/harness/**` plus a 2,941-line design doc (`packages/agent/docs/harness.md`) is a durable-runtime rewrite ("harness v2/v3") that is NOT wired into the coding agent. Sections below say which of the two they describe. Anything labelled "spec" is design, not behaviour you can observe today.

---

## A. Long-running loop

### A1. Loop shape, step caps

The core loop is `runLoop` in `packages/agent/src/agent-loop.ts:156-273`. There is no turn cap, step cap, or wall-clock cap anywhere in core or docs (`grep maxTurns|maxSteps` over `packages/*/docs` and `packages/agent` returns nothing).

```ts
// agent-loop.ts:170-175
// Outer loop: continues when queued follow-up messages arrive after agent would stop
while (true) {
    let hasMoreToolCalls = true;
    // Inner loop: process tool calls and steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
```

The loop exits only on: a `stopReason` of `error` or `aborted` (`:215-219`), the host's `shouldStopAfterTurn` hook returning true (`:252-255`), or no tool calls and an empty follow-up queue (`:260-269`). The hooks the host can install are typed at `packages/agent/src/types.ts:200-293`: `transformContext`, `shouldStopAfterTurn`, `prepareNextTurn`, `getSteeringMessages`, `getFollowUpMessages`, `beforeToolCall`, `afterToolCall`, `toolExecution`.

### A2. Steering and follow-up queues

Two queues live on the `Agent` (`packages/agent/src/agent.ts:125-135`, `:176-177`, `:282-310`). `steer()` injects after the current assistant turn's tool calls finish; `followUp()` runs only when the agent would otherwise stop. Each queue has a `QueueMode` of `"all" | "one-at-a-time"`, default `one-at-a-time` (`agent.ts:231-232`, `docs/settings.md:173-174`). The loop polls steering at start (`agent-loop.ts:168`), after each turn (`:257`), and again after `prepareNextTurn` because preparation "can be long-running (for example, compaction)" (`:191-196`). Follow-ups are polled once per outer iteration (`:261-266`). RPC mode exposes `set_steering_mode` / `set_follow_up_mode` (`docs/rpc.md:359-393`) and queue clearing (commit `a79b373`, 2026-08-25).

### A3. Post-run continuation loop (where retry and compaction actually happen)

`AgentSession._runAgentPrompt` (`packages/coding-agent/src/core/agent-session.ts:1106-1118`):

```ts
await this.agent.prompt(messages);
while (await this._handlePostAgentRun()) {
    await this.agent.continue();
}
```

`_handlePostAgentRun` (`:1120-1146`) decides in a fixed order: (1) retryable error, prepare retry and continue; (2) `_checkCompaction`, compact and maybe continue; (3) messages queued by `agent_end` extension handlers. `agent_settled` (`:151`, `:630-635`) fires only when no run, retry, compaction, or queued continuation remains; `isIdle` (`:925-926`) is the same predicate.

### A4. Retry policy on provider errors

Two layers:

- Provider/SDK layer: `retry.provider.maxRetries` defaults to `0` and the docs explicitly say to keep it there because SDK retries can swallow quota errors before Pi sees them (`docs/settings.md:147-152`). Server-requested `retry-after` delays above `retry.provider.maxRetryDelayMs` (default 60000) fail fast with an informative error instead of sleeping (`packages/ai/src/utils/provider-retry.ts:1`, `:40-49`).
- Agent layer: `retry.enabled=true`, `maxRetries=3`, `baseDelayMs=2000`, exponential `baseDelayMs * 2^(attempt-1)` (`settings-manager.ts:882-888`, `agent-session.ts:2887-2937`). Classification is regex-based in `packages/ai/src/utils/retry.ts`: a retryable pattern list (`:26-90`, covers overloaded, 429/5xx, socket drops, "stream ended before message_stop", "terminated", gRPC `ResourceExhausted`) and a non-retryable list for quota/billing exhaustion (`:7-24`, `insufficient_quota`, `out of budget`, `billing`).

Overflow errors are deliberately excluded from retry: `_isRetryableError` (`agent-session.ts:2846-2850`) returns false when `isContextOverflow` matches, "handled by compaction, not retry". On retry the failed assistant message is removed from agent state but kept in the session file (`:2910-2914`). The same policy is reused for compaction and branch-summary LLM calls via `retryAssistantCall` (`compaction.ts:579-599`, `retry.ts:163-212`), with dedicated `summarization_retry_*` events (`agent-session.ts:2858-2881`).

### A5. Timeouts and watchdogs

- No per-request wall-clock timeout. The only knob is `httpIdleTimeoutMs`, default 300000 ms, an HTTP header/body idle timeout also used by providers with explicit stream idle timeouts (`packages/coding-agent/src/core/http-dispatcher.ts:4`, `docs/settings.md:176`). Idle stream drops surface as errors matched by the retry regexes.
- Bash tool: `timeout` is optional with "no default timeout" (`packages/coding-agent/src/core/tools/bash.ts:44`); max is 2^31-1 ms (`:26-27`).
- No idle watchdog on the agent itself.

### A6. Overflow handling (context-length error)

Detection is in `packages/ai/src/utils/overflow.ts:134-163`, three cases: (1) regex over `errorMessage` for about 25 providers (`:37-63`) minus a non-overflow exclusion list for throttling text (`:74-78`); (2) silent overflow, `stopReason=stop` but `usage.input + usage.cacheRead > contextWindow` (z.ai style); (3) `stopReason=length` with `output === 0` and input at >= 99% of the window (Xiaomi MiMo style). A separate `isRecoverableLength` (`:171-173`) flags a length stop that ended below the model's intended output limit, added 2026-08-03 (`32850ef`) for OpenAI reasoning models that return `incomplete` before any visible output.

Recovery is `_checkCompaction` (`agent-session.ts:2126-2230`):

- Case 1, overflow or recoverable length with a non-`stop` reason: drop the failed assistant message from agent state, compact with reason `"overflow"`, `willRetry=true`, `agent.continue()` once. Guarded by a single `_overflowRecoveryAttempted` flag (`:2166-2195`), reset on the next user prompt (`:648`, `:700`). Second failure emits "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model." (`:2167-2169`).
- Case 2, response completed but usage exceeded the window: compact, no retry (`:2160-2164`).
- Case 3, threshold: see B1.
- Messages from a different model than the current one are skipped so switching from a small-context model does not trigger a spurious overflow (`:2135-2141`).

### A7. Streaming guards

- Partial assistant message is pushed into context on `start` and replaced in place on every delta and on `done`/`error` (`agent-loop.ts:317-357`); partial streams are never persisted (`harness.md:208`).
- A `length` stop fails every tool call in that message with a canned tool result rather than executing possibly truncated arguments (`agent-loop.ts:226-235`, `:379-404`): "Tool call ... was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments."
- Stream drops (`terminated`, `stream ended before message_stop`, `http2 request did not get a response`) are retry-classified (`retry.ts:64`, `:73-76`).

### A8. Crash recovery and resume (shipping coding agent)

- Session is a JSONL tree; every entry is `appendFileSync`'d as it happens (`session-manager.ts:1022`, `:1041`). An unterminated final line is repaired on load by appending a newline (commit `0b5ee5d`, 2026-08-26, `session-manager.ts:555`).
- Resume is `pi -c` / `pi -r` / `/resume` (`docs/sessions.md:8-16`). It reloads the tree and rebuilds context; it does not resume an in-flight assistant turn or tool call. There is no durable record of "a request was in flight".
- Interactive-mode progress is restored when the same run resumes after mid-run compaction (`56700d4`).

### A9. Crash recovery (harness v3 spec, not shipping)

`packages/agent/docs/harness.md` designs a durable "program counter": after every step the harness overwrites one register `op.state/{operationId}` with the complete operation state (`harness.md:121-123`). Every provider request and tool call is wrapped in an "effect sandwich" (`:128-137`):

```
commit:  "about to do X; its output will use ids R and U"     <- intent
         do X                                                  <- the uncertain part
commit:  output + usage + next state                           <- settlement
```

Worked crash-mid-tool example (`:180-205`): a tool declared `replay: "never"` that was `effect_pending` at crash is not re-run; a synthetic "interrupted" error result is inserted under the pre-reserved result id and execution continues to the next call. Tools declared `replay: "safe"` are re-executed. Restore is five register point-lookups, no journal replay (`:1805-1858`). The one uncertain interval is "intent durable, settlement absent" (`:1907-1916`): generation retries under the captured policy or synthesizes an error under the reserved id; tools replay only if both captured and current declarations say safe. Abort is a `control` flag, not a phase (`:1918-1935`); `close()` is a "controlled crash" that writes nothing (`:1937-1952`).

Status: `packages/agent/src/harness/agent-harness.ts` throws `HarnessNotImplemented` for public operations (`:233`, `:351`, `:356`), and the spec's build order says the current `packages/agent/src/harness/**` is "deletable outright" in slice 1 (`harness.md:2810`). The coding agent does not import it. Treat as intent.

### A10. Background / detached execution

- `pi --mode json` streams `AgentSessionEvent`s as JSON lines (`docs/json.md:1-8`); `pi --mode rpc` is a stdin/stdout command protocol (`docs/rpc.md`). Both are the basis for the subagent example (D3).
- `packages/server` (experimental, `README.md:3`) and `packages/client` provide a CBOR-over-socket session server with exclusive/shared session leases and reconnect (`packages/client/README.md:27-33`). No CLI; the application supplies the service.
- OpenAI background responses: `pi-ai` has `deferred?: boolean | { window?: "15m" | "1h" | "24h" }` on stream options (`packages/ai/src/types.ts:319`), a `"deferred"` stop reason (`:405`), and `Models.fetchDeferred/cancelDeferred` (`packages/ai/src/models.ts:706-731`). Landed as a DRAFT on 2026-08-04 (`382aa64`). Neither `agent-loop.ts` nor `agent-session.ts` handles a `deferred` stop reason (grep empty); only the harness spec does (`harness.md:1089-1115`, one poll per `resume()`, no polling loop).
- No scheduler/cron in this repo. Slack automation lives in the separate `earendil-works/pi-chat` (`README.md:31`).

---

## B. Compaction

Two mechanisms share one summary format: auto/manual compaction and branch summarization (`docs/compaction.md:12-19`). Everything in this section is the shipping `packages/coding-agent/src/core/compaction/` unless marked spec.

### B1. Trigger

```ts
// compaction.ts:235-238
export function shouldCompact(contextTokens, contextWindow, settings) {
    if (!settings.enabled) return false;
    return contextTokens > contextWindow - settings.reserveTokens;
}
```

Defaults: `reserveTokens=16384`, `keepRecentTokens=20000` (`compaction.ts:132-136`, `docs/settings.md:118-120`). Compaction is skipped entirely when `model.contextWindow <= 0` (`agent-session.ts:549`).

Token count is gross of cache: `calculateContextTokens` uses `usage.totalTokens || input + output + cacheRead + cacheWrite` (`:146-148`). The source is the last valid assistant usage on the branch (aborted, error, and all-zero usage messages are skipped, `:154-167`) plus a chars/4 estimate for any messages appended after it (`estimateContextTokens`, `:202-230`; `estimateTokens`, `:266-306`; images count as 4800 chars, `:244`). So the decision is made from the provider's reported usage of the previous request, before the next send, not from a pre-send tokenizer pass. When the last message has no usable usage (persistent 529s, zero-usage responses) the pure estimate is used, with a guard so a stale pre-compaction usage cannot retrigger compaction right after one finished (`agent-session.ts:2143-2150`, `:2202-2222`; commit `4495469`, 2026-08-19).

Three check points:

1. After `agent_end`, in `_handlePostAgentRun` (`agent-session.ts:1142`).
2. Between turns inside a run, before the next provider request, via `prepareNextTurnWithContext` -> `_compactBeforeNextAssistantResponse` (`:543-560`). NEW 2026-08-28 (`56700d4`, closes #6879): `prepareNextTurn` now runs only when the loop will actually continue, after `shouldStopAfterTurn`, so a tool-heavy turn can compact mid-run instead of overflowing on the next call.
3. Before a new user prompt, including aborted responses (`:1252-1256`).

### B2. Cut point and what is kept verbatim

`findCutPoint` (`compaction.ts:403-461`): walk backwards from the newest entry accumulating estimated tokens; once `>= keepRecentTokens`, cut at the nearest valid cut point at or after that entry. Valid cut points are user, assistant, bashExecution, custom, branchSummary, compactionSummary; never a toolResult (`isCutPointMessage`, `:308-321`), so tool results always travel with their call. If the cut lands inside a turn (at an assistant message), it is a "split turn" (`:451-459`): the turn prefix gets its own summary with a smaller budget and the two are merged (`:887-926`).

Kept verbatim: roughly the last 20k estimated tokens of messages, unchanged, including their tool results. Nothing is done to shrink the kept tail (no tool-result pruning inside it).

### B3. What is summarized, iterative merge

`prepareCompaction` (`:750-829`): the span to summarize starts at the previous compaction's `firstKeptEntryId` (fallback: entry after the previous compaction), not at the compaction entry itself (`:766-773`). This means messages that survived the last compaction are summarized again on the next pass, together with the previous summary passed as `<previous-summary>`. The update prompt is the merge step:

```
// compaction.ts:500-535 (verbatim)
Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it
```

followed by the same section skeleton as the initial prompt. There is no cap on how many times the summary is re-merged, and no separate "long-term" summary tier.

### B4. Prompts (verbatim)

System prompt (`compaction/utils.ts:156-158`):

```
You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.
```

Initial prompt (`compaction.ts:467-498`):

```
The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

Split-turn prefix prompt (`compaction.ts:835-848`):

```
This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.
```

Request shape: `<conversation>...</conversation>` then optional `<previous-summary>...</previous-summary>` then the prompt, all in one user message (`:689-693`); custom `/compact <instructions>` appends `Additional focus: ...` (`:679-681`).

### B5. Serialization and tool-result truncation for the summarizer

`serializeConversation` (`utils.ts:109-150`) flattens to `[User]:`, `[Assistant thinking]:`, `[Assistant]:`, `[Assistant tool calls]: name(k=v; ...)`, `[Tool result]:`. Thinking blocks ARE included. Each tool result is cut to 2000 characters with a `[... N more characters truncated]` marker (`:89-99`). Rationale in docs: tool results "are typically the largest contributors to context size" (`docs/compaction.md:283-285`).

### B6. Identifier and fact preservation

Beyond the prompt instruction, file operations are extracted deterministically from `read`/`write`/`edit` tool-call arguments (`utils.ts:29-56`), accumulated across prior compactions from `details.readFiles/modifiedFiles` (`compaction.ts:42-70`), and appended to the summary text as `<read-files>` / `<modified-files>` blocks (`utils.ts:72-82`, `compaction.ts:949-951`) plus stored on the entry as `details` (`:962`). This is the only structured (non-LLM) fact carried across compactions.

### B7. Summary budget and validation

Summary `maxTokens = min(0.8 * reserveTokens, model.maxTokens)` (`:672-675`); turn-prefix summary `0.5 * reserveTokens` (`:983-986`). NEW 2026-08-24 (`97fa14e`, #7048): a summary that stopped on `length` is rejected rather than persisted as a checkpoint (`getSummarizationFailure`, `:545-553`). A summary that attempted a tool call is rejected (`:719-721`); tools were disabled for summarization on 2026-08-17 (`90305d9`) and the explicit tool choice removed on 2026-08-26 (`6b36eb5`). Summary LLM usage is stored on the entry and counted in session totals (`docs/compaction.md:200`).

### B8. Storage and recoverability

`appendCompaction` writes a `CompactionEntry { summary, firstKeptEntryId, tokensBefore, usage?, details?, fromHook? }` as a normal tree node (`session-manager.ts:1098-1112`, `docs/session-format.md:210-236`). Context rebuild (`buildContextEntries`, `session-manager.ts:418-455`): compaction entry first, then entries from `firstKeptEntryId` up to the compaction, then everything after it. Old entries stay in the JSONL and remain reachable through `/tree`; compaction "changes provider context, not storage" (`harness.md:212`). After compaction `agent.state.messages` is rebuilt from the session (`agent-session.ts:2349-2353`).

Spec/harness variant: the `packages/agent/src/harness` compaction materializes `retainedTail: AgentMessage[]` on the entry so context can be rebuilt without walking older entries (`harness/compaction/compaction.ts:596-690`; `docs/session-format.md:220-228`), and the next compaction treats that tail as virtual entries (`:637-647`). The coding agent's `session-manager.ts` has no `retainedTail` references; it still uses `firstKeptEntryId`.

### B9. Cache-prefix implications

- Summarization requests are one-offs: `cacheRetention: "none"` and a fresh `uuidv7()` routing `sessionId` unless the caller supplies one (`compaction.ts:586-593`; commit `58302d3`, 2026-08-17).
- Compaction necessarily invalidates the main prefix cache. The spec is explicit: "Across the requests of one lane, provider context must only grow at the tail. An insertion before the previous request's tail invalidates the provider's KV cache and multiplies cost. This is why mid-run writes defer to checkpoints ... Compaction is the one deliberate cache invalidation" (`harness.md:756-758`).
- Attempted mitigation, then reverted: `cff1cf5` (2026-08-18) "cache-friendly compaction primitives" appended the summarization instruction as one more user message on top of the exact live provider context (`sourceContext`), with `cacheRetention: "short"`, so the summarization request would hit the already-cached prefix instead of re-sending a serialized transcript; it fell back to standalone serialization when the prefix plus summary budget plus a 4096-token safety margin would not fit. Reverted the next day (`8dab702`) with no stated reason. The idea is sound and worth watching.
- Instrumentation: `cache-stats.ts:55-88` computes per-response `missedTokens = min(prev.promptTokens, promptTokens) - cacheRead` and the extra cost at the paid-vs-read rate; `showCacheMissNotices` (default false) surfaces significant misses and compaction usage in the transcript (`settings.md:35`, commit `836aee6`).
- Anthropic placement: `cache_control` on the system blocks, the last tool definition, and the last user-message block (`packages/ai/src/api/anthropic-messages.ts:1015-1031`, `:1295-1315`, `:1360`); `ttl: "1h"` only when `cacheRetention === "long"` and the model supports it (`:69-72`).

### B10. Branch summarization

On `/tree` navigation away from a branch, Pi offers a summary of the abandoned path up to the common ancestor (`docs/compaction.md:214-240`). Budget is `contextWindow - reserveTokens`, filled newest-first (`branch-summarization.ts:183-240`, `:311-313`); file ops are collected from all entries even those outside the budget (`:200`). Prompt at `:258-290` is the same skeleton minus "Critical Context". Result is a `BranchSummaryEntry` appended at the target position.

### B11. Extension surface

`session_before_compact` can cancel or supply the whole compaction (`docs/compaction.md:300-345`); `session_compact_failed` reports failures with `reason`, `willRetry`, `fromExtension` (`:378-388`). `examples/extensions/custom-compaction.ts` swaps in Gemini Flash and summarizes everything rather than keeping a tail. `examples/extensions/handoff.ts` is the anti-compaction: it generates a self-contained prompt ("Instead of compacting (which is lossy), handoff extracts what matters for your next task", `:1-12`) and opens a new session linked via `parentSession` (`:177-185`).

---

## C. Context management

### C1. Tool-output truncation and spill to disk

- Built-in limits: `DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 * 1024`, `GREP_MAX_LINE_LENGTH = 500` (`packages/coding-agent/src/core/tools/truncate.ts:11-13`).
- `read` uses `truncateHead` and tells the model how to continue: "Use offset=N to continue" (`read.ts:295-310`); description says "When you need the full file, continue with offset until complete" (`:218`).
- `bash` uses tail truncation and spills the complete output to a temp file, returning `Full output: <path>` (`bash.ts:350`, `:437-446`, `fullOutputPath` in details `:56`).
- Extension authors are told "Tools MUST truncate their output" with the same helpers and the temp-file pattern (`docs/extensions.md:2168-2215`).

### C2. Pruning of old tool results

None in core. Old tool results stay verbatim until compaction moves them into the summarized span (where they are cut to 2000 chars for the summarizer). Two hooks let an extension prune: the `context` event ("Fired before each LLM call. Modify messages non-destructively", `docs/extensions.md:675-685`) and `AgentLoopConfig.transformContext` (`agent-loop.ts:286-290`, `types.ts:200`). `!!`-prefixed user bash commands are excluded from context via `excludeFromContext` (`docs/session-format.md:106-116`).

### C3. File-as-context, system prompt budgeting

- System prompt (`packages/coding-agent/src/core/system-prompt.ts:128-166`) is short: tools list with one-line snippets, guidelines, docs paths, then `<project_context>` with every `AGENTS.md`/`CLAUDE.md` found in ancestors plus the global one (`resource-loader.ts:72`, `:126-156`). No byte budget on context files was found.
- Skills use progressive disclosure: only `name`, `description`, `location` go in the prompt, and the model is told to `read` the SKILL.md when relevant (`skills.ts:355-381`).
- Model window and output cap come from the generated catalog (`model.contextWindow`, `model.maxTokens`; defaults 0 in `agent.ts:57-58`). Overflow regexes are the fallback when metadata is wrong (`overflow.ts:110-117`).

### C4. Images

`read` auto-resizes images to 2000x2000 (`read.ts:65`); compaction estimates images at 4800 chars (`compaction.ts:244`). No image dropping from history.

### C5. Plan / todo recitation, memory

Not in core. Two example extensions show the intended pattern:

- `examples/extensions/todo.ts` keeps state in tool-result `details` and rebuilds it by scanning the branch on `session_start`, "which allows proper branching - when you branch, the todo state is automatically correct for that point in history" (`:8-10`, `:118-132`).
- `examples/extensions/plan-mode/index.ts` injects a custom context message on `before_agent_start` (`:201-242`), tracks `[DONE:n]` markers in assistant text, and persists mode via `pi.appendEntry("plan-mode", ...)` custom entries (`:116-117`, `:340-370`).

There is no memory file, no notes injection, and no mention of "context rot" anywhere in docs or the harness spec (grep empty). `ctx.getContextUsage()` is exposed to extensions (`docs/extensions.md:1066`).

---

## D. Multiple tasks

### D1. Session tree

Every entry has `id`/`parentId`; the leaf is the cursor (`docs/session-format.md:340-355`). `/tree` moves the leaf anywhere and optionally attaches a branch summary; `/fork` and `/clone` create new files with a `parentSession` header; labels bookmark entries; `treeFilterMode` filters the view (`docs/sessions.md:63-128`). Context for the LLM is always the root-to-leaf path with the latest compaction applied (B8).

### D2. Concurrency inside one session

Parallel tool execution is the default unless any tool in the batch declares `executionMode: "sequential"` or the loop is configured sequential (`agent-loop.ts:409-424`, `:487-561`); results are re-ordered to call order. Multiple `pi` processes in one cwd are expected and handled socially, via git rules in `AGENTS.md` ("Multiple pi sessions may be running in this cwd at the same time").

### D3. Subagents

Not core; `examples/extensions/subagent/` (1,038 lines). Each task spawns a separate process `pi --mode json -p --no-session [--model] [--tools]` (`index.ts:300-307`, `:346`), so context isolation is process isolation, and the child's session is not persisted. Limits: `MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4`, `PER_TASK_OUTPUT_CAP = 50 * 1024` per child returned to the parent (`:33-36`). Modes: single, parallel, chain with a `{previous}` placeholder (`README.md:104-110`). Agents are markdown files with frontmatter (`name`, `description`, `tools`, `model`); missing `model` inherits the parent's model and thinking level (`e3798ca`, 2026-08-11). The `scout` agent is the compression pattern: "Your output will be passed to an agent who has NOT seen the files you explored" with a fixed `## Files Retrieved / ## Key Code / ## Architecture / ## Start Here` format (`agents/scout.md`). Workflow prompts chain them (`/implement` = scout -> planner -> worker).

### D4. Lanes (spec)

The harness spec replaces subprocess subagents with "lanes": named cursors into one shared tree, each owning a leaf, model config, queues, and at most one operation (`harness.md:94-96`, `:690-720`). Worked example is a Slack channel with 400 entries of history where each thread is a lane (`:139-178`). Multi-writer is a non-goal; "Lanes cover the workload that looks like multi-writer" (`:209`). Design only.

### D5. Task state persistence and handoff

Persistence primitives are `custom` entries (not in LLM context) and `custom_message` entries (in context) (`docs/session-format.md:238-268`), plus tool-result `details`. Handoff between sessions is the `handoff.ts` example (B11). Remote attach/detach with leases exists in `packages/client` (A10). No scheduled or cron work in this repo.

---

## E. Evals for long runs

`packages/evals` is a `vitest-evals` adapter around a real `AgentSession` in temp dirs (`README.md:3-6`). Per run it records `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens`, `cacheWriteTokens`, and estimated cost from the session stats (`src/pi-harness.ts:189-199`), attaches the native session JSONL, and the reporter computes pass-rate lift (candidate minus baseline, in points) plus paired token/latency/cost deltas (`README.md:127-138`). Suites are `smoke.eval.ts` and `extensions.eval.ts` only. Nothing measures compaction quality, context efficiency over long horizons, or replays a recorded session against a new build. Telemetry does define a `pi.harness.compaction` span with start/end attributes and events (`packages/agent/docs/telemetry-schema.md:89-119`), and the maintainer publishes real work sessions to Hugging Face as a dataset (`README.md:96-108`), which is the closest thing to a long-run corpus.

---

## F. What changed since 2026-08-01 (526 commits)

Directly on the four themes:

- `56700d4` 08-28: compaction can now run between turns inside a run, before the next provider request (was only after `agent_end` and before a prompt).
- `97fa14e` 08-24: length-truncated summaries are rejected instead of becoming checkpoints.
- `6b36eb5` 08-26, `90305d9` 08-17: summarization calls carry no tools and no tool choice.
- `58302d3` 08-17, `ef8dc73` 08-18: summarization requests centralized, fresh routing session id, cache writes disabled.
- `cff1cf5` 08-18 then `8dab702` 08-19: cache-friendly compaction (summarize on top of the cached live prefix) landed and was reverted.
- `4495469` 08-19: compaction works without provider usage (estimate-only path with stale-usage guard).
- `32850ef` 08-03: recoverable `length` stops (OpenAI reasoning `incomplete`) treated as overflow, one compact-and-retry.
- `e56893f` 08-03, `3852cb2` 08-05: manual/auto compaction race fixed; prompts queued during compaction are delivered afterwards.
- `a79b373` 08-25: RPC queue clearing.
- `0b5ee5d` 08-26: unterminated session file repair.
- `382aa64` 08-04: DRAFT OpenAI background/deferred responses in `pi-ai`.
- Harness v2/v3: ~60 commits 08-02 to 08-11 (in-memory harness `1d0c974`, JSONL backend with atomic writes and torn-tail truncation `a838c06`, indexed recovery queries `591f22a`, events subscription `14ad980`, telemetry package `6b461b7`), then the design was rewritten as `harness.md` parts 0-9 on 08-10/11 with a build order that discards the existing harness code. Coding agent gained a configurable Harness factory hook (`6fb2d76`, #7686) but does not run on it.

---

## G. Verdict

### Ideas worth stealing, ranked by expected impact on long-horizon performance

1. Compact between turns, before the next provider request, not only at run end. Pi's #6879 fix means a 40-tool-call turn no longer walks into an overflow error. Our equivalent should hook the same point (post tool results, pre send) and use provider usage from the previous response plus an estimate of what was appended since, gross of cache (`agent-session.ts:543-560`, `compaction.ts:202-230`).
2. Treat overflow as a compaction reason with exactly one compact-and-retry, and never as a retry reason. The split (`_isRetryableError` excludes overflow; `_overflowRecoveryAttempted` single flag reset on next user input) prevents both retry storms and compaction loops. Also copy the three-way detector: error regex, silent overflow via `input + cacheRead > window`, and zero-output length at 99% of window.
3. Never cut at a tool result, and handle the split-turn case with a separate prefix summary. The "one huge turn exceeds the keep budget" case is the common failure in agentic runs; Pi's turn-prefix prompt is small and specific.
4. Carry structured facts across compactions outside the LLM summary: Pi extracts read/modified file paths from tool-call arguments deterministically and appends them as tags, accumulating across compactions. Generalize to any identifiers our tools touch (record ids, URLs, doc titles).
5. Re-summarize from the previous kept boundary, with the previous summary as `<previous-summary>` and a PRESERVE/ADD/UPDATE merge prompt, and reject summaries that stop on `length`. Cheap correctness guard we should have.
6. Materialize the retained tail on the compaction entry (`retainedTail`) so context rebuild is a checkpoint read, not a tree walk, and so a compaction entry is self-contained for export or handoff (harness variant, `session-format.md:220-228`).
7. Handoff as an explicit alternative to compaction: generate a self-contained prompt for a new session with a `parentSession` link. For knowledge work this is often better than lossy compaction at a phase boundary.
8. Cache-miss accounting as a first-class metric: `missedTokens = min(prevPrompt, prompt) - cacheRead` per response, priced at paid-minus-read rate, surfaced as notices. Matches our own conclusion that `cache_hit_pct` is a denominator artifact.
9. Scout-style subagents that return a fixed compressed format ("Files Retrieved with line ranges / Key Code / Start Here") with a hard per-child output cap (50 KB). The cap plus the format is what makes delegation actually save parent context.
10. The harness spec's "append-only context invariant" (`harness.md:756-758`): defer all mid-run context writes (steering, custom messages) to checkpoints so the provider prefix only grows at the tail. Cheap to enforce, directly protects cache.

### Things Pi does worse or does not do (do not cargo-cult)

1. No step, turn, cost, or wall-clock cap in the loop, and no idle watchdog; only a 300 s HTTP idle timeout. A long-horizon runtime needs budgets.
2. No in-tail hygiene: the kept 20k tokens carry full tool results, and old tool results are never pruned or replaced with references before compaction. Compaction is the only pressure valve, and it fires late (window minus 16k).
3. Compaction is a single-tier summary re-merged forever with a fixed section skeleton and a `0.8 * reserveTokens` budget (about 13k tokens). No separate long-term facts store, no memory file, no recitation of the plan; "Next Steps" lives only inside the summary. Task/todo state is left to example extensions.
4. Crash recovery in the shipping agent is "reload the JSONL"; an in-flight tool call or request is simply lost. The durable effect-sandwich design exists only as a spec whose own build order discards the current code. Learn from the spec, do not assume any of it runs.
5. Subagents are subprocesses with `--no-session`: no shared tree, no persistence of the child's work, no resumability, and parallelism is capped at 4. The lanes design that would fix this is unimplemented.
6. Cache-friendly compaction was reverted; today every compaction pays a full re-send of the serialized transcript to the summarizer plus a cold prefix on the next turn. The reverted approach (append the summarization instruction to the live cached context) is the thing to try ourselves, carefully.
7. Evals do not cover long horizons at all: no replay, no compaction-quality judge, no context-efficiency metric. The HF session corpus is the raw material, but nothing in-repo consumes it.
