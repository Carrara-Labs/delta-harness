# Spec: Connect 0.5.0 — Rich streaming

Status: **built**. Written 2026-08-02. Supersedes slices S3 + S4 of
[spec-connect-async-streaming.md](spec-connect-async-streaming.md) (S1 async dispatch and S2 typing
shipped in Connect 0.3.2). Engine change: **none**.

Roadmap named this 0.3.3; the security track took 0.4.x first, so it ships as **0.5.0**.

## Why

1. **The reply is downgraded on the way out.** Connect renders the agent's markdown to a small
   Telegram HTML subset (`markdownToHtml`): tables flatten to text, task lists lose their boxes,
   headings become bold lines, math is literal.
2. **No live feedback while the agent works.** A typing dot for two minutes, then a wall of text.
   The user cannot tell a thinking agent from a wedged one.

## Verified API facts

Read from core.telegram.org/bots/api and /bots/api-changelog on **2026-08-02**, then every claim
below that mattered was re-checked against the live API from inside the Ferni container.

- **Bot API 10.1** (2026-06-11) added Rich Messages: `sendRichMessage`, `sendRichMessageDraft`,
  `InputRichMessage`, `rich_message` on `editMessageText` and on `Message`.
- **Bot API 10.2** (2026-07-14) added `blocks` and the `InputRichBlock*` classes, including
  `InputRichBlockThinking`.
- **`InputRichMessage`** — *exactly one* of `html`, `markdown`, or `blocks`.
- **`sendRichMessageDraft(chat_id, draft_id, rich_message)`** → `True`. `chat_id` is an **Integer,
  private chats only**; `draft_id` is a **non-zero Integer** and successive drafts under the same id
  are **animated**. The draft is **ephemeral: a 30-second preview**, and the finished output must be
  sent separately with `sendRichMessage` to persist.
- **`InputRichBlockThinking`** — `{type: "thinking", text}`, a "Thinking…" placeholder, valid **only
  in a draft**. `RichText` accepts a plain string.
- **Limits:** 32768 characters, 500 blocks, 16 nesting levels, 50 media, 20 table columns.
- **Rich Markdown** is a GFM superset: headings, fenced code with a language, tables with
  alignment, task lists, block quotes, footnotes, `$math$`, `<details>`, `---`, links, media.

### Measured against the live API, not assumed

The earlier spec listed the parser's behaviour as "needs confirming". `sendRichMessage` returns the
message it parsed, which makes it its own oracle. What came back:

| Input | Result |
| --- | --- |
| `EXA_API_KEY` | literal — single underscores are safe |
| `mcp__brain__auth` | **bold "brain"** — a `__` run emphasises even inside a word |
| `a**b**c`, `foo*bar*baz`, `a~~b~~c`, `a==b==c`, `a\|\|b\|\|c` | all emphasise intra-word |
| `costs $5 to $10` | literal; `the value $x^2$` becomes real math |
| fenced block, inline `` `code` `` | fully literal, including `__` and `<u>` |
| `\_`, `\*`, `\[` | escaping works |
| `\<u\>` | **does not** escape — the backslash stays visible |
| `<u>x</u>`, `<details>` in prose | parsed as formatting; `<script>…</script>` is silently dropped |
| `[x](javascript:…)` | stripped by Telegram |
| `[x](tg://user?id=777000)` | renders a real mention of that user |
| `![](https://…png)` | Telegram fetches the URL and attaches it as a photo |
| 60 `---` dividers | rejected (`RICH_MESSAGE_EMPTY`) — a structural limit surfaces as a 400 |
| draft with a `thinking` block | accepted |
| draft with an unterminated ``` fence | accepted |
| `draft_id: 0` | rejected (`RANDOM_ID_INVALID`) |
| empty markdown | rejected (`RICH_MESSAGE_MARKDOWN_INVALID`) |

## Competitive reality — two corrections

Our shipping list said "neither OpenClaw nor Hermes uses Rich Messages — a clear lead". **Both
halves were wrong.**

- **OpenClaw ships Rich Messages.** `rich-message.ts` (263 lines), `rich-blocks.ts` (675),
  `rich-block-split.ts`, `draft-stream.ts` (1011) — about 2400 lines. It compiles markdown to
  `blocks` itself and streams by editing a live message (`DEFAULT_THROTTLE_MS = 1000`,
  `MIN_PREVIEW_DWELL_MS = 4000`, flood suspension capped at 60s). It never calls
  `sendRichMessageDraft`.
- **Hermes ships both** `sendRichMessage` and `sendRichMessageDraft` (DM-only), each opt-in and
  **default off** (`plugins/platforms/telegram/adapter.py:694-708, 1824-1868, 2030-2055`).

So there is no leapfrog to claim. What is left is narrower and true: we get the same native
rendering by letting Telegram's own parser read the agent's markdown, which is roughly 2400 lines
we do not write, and we have it **on by default** rather than behind an off switch.

## Design

### Rich send — the persisted reply

`TelegramCodec.send()` tries `sendRichMessage` with `{markdown}` first, and falls back to the
existing HTML funnel. The fallback ladder is the whole feature:

- delivered, or a **429/5xx** → return as-is, so the outbox backs off rather than silently sending
  a downgraded copy of a message Telegram never refused;
- **404** → this Bot API server predates Rich Messages: latch rich off for the process, so an old
  server costs one wasted round trip in total, not one per message;
- any other **4xx** → about *this* content (unparseable markdown, a structural limit), so fall
  through to HTML and keep rich on for the next message.

That ladder is also what handles the 500-block and 20-column limits: they arrive as a 400 and the
reply goes out the old way. No structural pre-flight gate is needed.

**Chunking stays at ~3900 characters.** Raising it to the 32768 rich limit was tempting and is
wrong: one outbox row must remain one Telegram call, or a rich failure would have to fan out into
several `sendMessage` calls, and a partial failure mid-fan-out would either lose or duplicate
chunks on retry. Deferred until the outbox can durably represent sub-chunks.

**One escaper, one rule.** `escapeRichMarkdown` backslash-escapes an underscore run that sits
inside a word, outside code. That is the same rule Connect 0.4.3 established for our own renderer,
now applied to a parser we do not own, because `mcp__brain__authenticate` is exactly the shape our
own tool names take. Code is skipped: Telegram already treats it as literal, so escaping there
would put visible backslashes into the user's code.

### Live progress — the ephemeral draft

`GET /v1/tasks/:id/events?since=N` is a **bounded JSON poll** of the daemon's persisted events
(turn and tool lifecycle). It folds into the task tick that already runs every 2.5s, so the preview
needs no stream, no detached loop, no reader to cancel, and no durable cursor. The last `tool.call`
in a batch becomes a line of English ("Searching the web"), sent as a `thinking` draft.

**Why not stream the reply text.** The daemon streams the model's narration for every step, and
only the last step — one with no tool calls — becomes the answer (`src/run.ts:678`). Previewing
that narration would show "I've deleted it" while the delete is still running, and a claim that
never gets sent is worse than no preview. Per-token deltas are also never persisted, so showing
them would mean a live SSE connection per task with its own abort, quiesce, restart and
arbitration story. What the agent is *doing* is honest at every instant, cheap to obtain, and for a
working agent the more useful thing to watch. Reply-text streaming stays open as a follow-up.

Four invariants, each with a test:

1. **Never for an unaccepted task.** A placeholder id is not a daemon run; it is skipped entirely.
2. **Never after "stopping".** Cancel intent suppresses the preview immediately.
3. **Never after the real reply.** Previews are awaited inside the same tick, and a terminal task is
   not in the still-running set, so a stale draft cannot land after the message it previewed.
4. **Never outliving its turn.** The draft id is derived from the **inbox event id**, not the task
   id, so a placeholder re-key mid-turn does not strand one preview and start another.

## Deliberately not built

- No markdown → blocks compiler. Telegram parses it.
- No `editMessageText` streaming path. It would be a second streaming implementation to keep
  correct, and the draft primitive exists for this.
- No durable preview state. The preview is disposable; the answer is already durable in the outbox.
- No client-capability probe. The Bot API exposes none and Telegram degrades on old clients itself.

## Accepted trades

- **Raw HTML in prose is now interpreted.** `<u>`, `<b>` and `<details>` render, and `<script>…`
  is dropped. `\<` does not escape, so there is no cheap fix, and inside code — where an agent
  almost always puts markup — everything stays literal. Fenced output is unaffected.
- **Images and `tg://` links now render** where the HTML path dropped them. That widens what an
  agent can put on screen, including when it is echoing a page it fetched.

## Reality checks

`bun test` (146 connect + 811 harness, green) plus a live Ferni turn covering a table, a task list,
a fenced block, an intra-word underscore, a dollar amount, and a run long enough to show several
progress frames.

Related: [[project_delta_connect]], [[reference_telegram_assistant_recipe]],
[[project_ferni_field_report]].
