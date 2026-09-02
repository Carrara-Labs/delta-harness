# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.17] - 2026-09-02

Long-horizon work: compaction fidelity, recovery, and the instruments to see both. Built as one
measured slice per hypothesis on a twin-lane battery (Aperture Quick Search, real MCP tools and
model) plus an offline recall eval that re-runs the engine's own compaction on archived
production transcripts. Study and receipts: `docs/study-long-horizon-synthesis.md`.

### Upgrade
Schema migration v15 to v16 (the recall index; backfilled once at boot, a few seconds on a
100 MB database). One-way like v15: snapshot `/data` before upgrading a lane. No wire change unless `DELTA_CACHE_DIAGNOSIS=1`
is set (then the Anthropic-native wire adds the `cache-diagnosis-2026-04-07` beta header and a
`diagnostics.previous_message_id` field). Compaction summaries gain a bounded appendix, two
deterministic ledgers and a one-line recovery footer.

### Added
- **The post-compaction reload is a number.** `model.call` carries `turns_since_compaction`
  (0 = the first call after a cut) and no longer suppresses `cache_shortfall_tokens` on that
  call, so the re-read a compaction costs is one column: 20k to 30k tokens per cut on Opus at a
  200k ceiling, 217k per hard run at a 60k one. Also `tool_calls_n` per call.
- **History digest.** `history_n`, `history_hash` and `history_prefix_hash` (over the first
  `history_n` messages of the previous call) split "we mutated history" from "we placed marks
  badly". Measured: byte-stable on 574 of 574 comparable turns across two batteries.
- **Anthropic cache diagnosis, opt-in.** `DELTA_CACHE_DIAGNOSIS=1` threads the previous response
  id through the main lane; the verdict lands as `cache_miss_reason` (closed enum) and
  `cache_missed_input_tokens`. The only `messages_changed` verdicts in 599 turns were the
  compaction reloads.
- **Anchor index.** The compaction audit harvests by class with a budget each (URLs, emails,
  slugs, recurring proper names from the agent's own text, years, numbers; 60 total) and appends
  what the summarizer dropped, defanged, inside a byte budget. On the battery the summarizer
  dropped 30% of anchors and the appendix carried 97% of those back.
- **Calls ledger.** Each summary lists the tool calls it compacted (builtin arguments deduped
  newest first; MCP tools by name and count) so the agent does not re-run a search it already
  ran. Plus a fixed recovery line naming `recall`.
- **Indexed recall.** `recall` runs on an FTS5 index over the message table (migration v16:
  external-content, insert/update/delete triggers, unicode61 with diacritics folded, bm25).
  Any query word qualifies a row (function words dropped, prefix match), rare words outrank
  common ones, whole-phrase hits first. On identical questions from production compactions the
  recovery arm went from 21% to 52% correct (72% on facts the agent itself surfaced), at index
  cost instead of a scan.
- **Shadow loop guard.** `loop.repeat` is emitted when the same executed tool + arguments +
  result recurs three times in a row. Observation only, never changes execution.
- **Compaction event enrichment.** `generation`, `summary_finish_reason`, `summary_chars`
  (persisted body), `identifiers_appended`. A `length`-stopped summary is retried once and the
  better candidate kept.
- **Bench tooling.** `docs/bench/compaction-recall.ts`: the recall eval, with replay mode
  (`RECALL_REPLAY=1` re-runs this checkout's compaction on each archived cut) and a
  trusted-only question mode.

## [0.2.16] - 2026-08-19

OpenAI as a first-class citizen. The Responses wire worked but was a ported integration: we
dropped the model's own reasoning every turn, dropped the `phase` field that tells GPT-5.5+ apart
an intermediate update from a final answer, used none of our three-release cache-placement
discipline there, mispriced the 5.6 family ~4×, and told the operator none of it. Every change is
gated per backend: `api.openai.com` gets the full surface (each field wire-proven live on
2026-08-19), `chatgpt.com` receives byte-identical requests vs 0.2.15 until the Delos probe
battery (`docs/probe-request-delos-0.2.16.md`) flips each predicate on evidence. The Anthropic
and Chat wires emit byte-identical requests — pinned by test. Plan and review arbitration:
`docs/harness-0.2.16-plan.md`.

### Upgrade
No schema migration; reversible from 0.2.13–0.2.15. No behavior change on Anthropic, Chat, or
chatgpt.com lanes. On `api.openai.com` Responses lanes the upgrade is additive: requests gain
`include: ["reasoning.encrypted_content"]`, replayed reasoning items, `phase`, and (gpt-5.6+)
explicit cache breakpoints. One new boot line appears if a configured control is unmapped on the
lane's wire (e.g. `DELTA_SPEED` on Responses).

### Added
- **Reasoning + phase carry (M1).** Reasoning items are captured from `response.output_item.done`
  (with `include: ["reasoning.encrypted_content"]`), ride the assistant message, and replay
  verbatim ahead of the turn's text and calls — OpenAI's own guidance for consecutive tool
  chains, and the only option that keeps the prompt prefix byte-stable. `phase` round-trips so
  intermediate updates are never re-read as final answers. Contained everywhere else: the chat
  wire strips both fields (a strict endpoint would 400 a failover), `toAnthropic` rebuilds,
  compaction strips reasoning from retained rows (it reasons about the history the rewrite just
  replaced) while the archive keeps originals, and the identifier harvest reads stripped rows.
- **Explicit prompt-cache breakpoints on Responses (M2).** The same placement brain
  (`rollingMarks`), a third wire-specific renderer: one stable mark on the first user message
  (caching instructions + tools + itself) plus two rolling, capped at 3 because implicit mode's
  own breakpoint spends the fourth write slot. Additive under implicit mode; model-gated to
  gpt-5.6+ (older models 400 on the field).
- **`DELTA_TEXT_VERBOSITY`** → `text.verbosity` and **`DELTA_REASONING_SUMMARY=auto`** →
  `reasoning.summary` on the Responses wire (M4). The summary request finally feeds the SSE
  consumer that has been dead code since it was built.
- **Unmapped-control reporting (M4).** A configured control the primary wire cannot render is
  named on one boot stderr line and in a `controls` block on `/v1/status` — same computation,
  they can never disagree.
- **Failed utility calls are visible (C1).** A child/utility model failure now emits `model.call`
  with `is_error` + the classified error enum and one stderr line. Previously the error became
  tool-result text nobody greps — the Delos gate run measured 3 child 400s in tool results, 0 in
  stdout, 0 in telemetry; 24/24 child failures hid that way for two weeks before D-12.
- **Append-append self-file merges (C2).** Two runs both appending learned lines to the same
  DELTA.md base now merge engine-side, losslessly (48 fleet collisions each billed a model turn
  to concatenate two suffixes). Rewrites keep the conflict contract — auto-merge never guesses.

### Fixed
- **gpt-5.6 pricing (M3).** `gpt-5.6-sol/terra/luna` (+ the `gpt-5.6` alias) get real entries;
  sol was prefix-matching `gpt-5` and under-billing the metered lane ~4×. Cache writes are read
  from the nested `input_tokens_details.cache_write_tokens` (5.6+ bills them 1.25×; the existing
  multiplier applies the moment the field is parsed).
- `KNOWN_EFFORTS` learns `max` (docs-only list, not a gate).

## [0.2.15] - 2026-08-19

Stop losing the task and the output. Twelve changes, every one motivated by a number measured on
the live fleet: two fixed defects that were actively costing a paying consumer money and
correctness, and ten closed the visibility and hygiene gaps that let those two hide. The receipts
behind each number: `docs/harness-0.2.15-plan.md` and `docs/aperture-asks-0.2.15-triage.md`.

**The headline pair.** Compaction pinned the session's FIRST request as trusted task instructions —
measured across three lanes, 42 of 42 exposed compactions pinned a different task than the one
being served, zero harmless; it now pins the compacting run's own request. And a budget-exhausted
run returned one sentence of counters while its results sat on disk — eleven runs, 771 tool calls,
$140.98 and 158 minutes of paid work returned as `budget exhausted: …`; it now returns the plan
plus every spill and research artifact the run produced, with the counters kept in `runs.error`
where operators look.

### Upgrade
0.2.15 adds no schema migration, so from 0.2.13 or 0.2.14 it is reversible. From 0.2.11 or earlier
it is not — it carries the one-way step 0.2.13 introduced. Three behavior changes are visible on
upgrade day and are deliberate; read `### Changed` before rolling a fleet:
1. research artifacts move from `research/` to `.delta/research/` (every deployment);
2. the delegated code CLI's default gains `--disable apps --disable plugins` (requires
   codex-cli >= 0.146.0 — verified; anyone deliberately using an account connector through `code`
   must now set `DELTA_CODE_CLI` explicitly, which is used verbatim);
3. a failed run's `output_text` is now a user-facing handoff, not the operator counters — anything
   that parsed `budget exhausted` out of `output_text` must read `runs.error` instead.

### Fixed
- **Compaction pins the request it is compacting, not the session's first.** `ORDER BY seq LIMIT 1`
  was correct only for single-request sessions; on any threaded session the summary re-instructed
  the agent to do old work, and 23 of 27 stale pins on the busiest lane were LONGER than the live
  request they outranked. The pin now reads the anchor run's own request, bound by run AND session
  id, and the first-run fallback — the defect itself — is deleted; the compiler proves no caller
  can reach it. Single-request sessions render identically apart from the lead-in sentence, which
  now says "the request you are working on".
- **A budget-exhausted run hands back what it already has.** `output_text` carries the current
  plan, this run's spill files and research artifacts (enumerated from disk under the run's own
  sanitized-id prefix — run-scoped by construction, nothing stale or forged), the self-write note,
  and advice to narrow rather than retry. Bounded at 10 KiB / 20 paths per family, truncation
  named. Ephemeral (`store:false`) runs get no paths — the queue wipes theirs right after settle,
  so a pointer would be dead on arrival. The counters stay in `runs.error` and the `error` event.
- **`max_output_tokens` is never sent to the ChatGPT/Codex subscription backend**, which rejects it
  at any value — parent turns never send one, so the identical connection worked for the parent
  while every `research`/`eval_n`/reflection child died with a billed 400 (24 of 24 child starts on
  one observed run). A denylist of the one host with wire proof; every other Responses endpoint
  keeps its cap. Unblocks the Codex-subscription migration path.
- **YAML block-scalar skill descriptions parse** (`description: >` / `|`), without adding a YAML
  dependency. Two skills were registered but unsearchable for months — the identical file parses
  fine under real YAML on a laptop, which is why nobody noticed. A description under 10 characters
  now warns loudly at scan time: this defect class is defined by its silence.
- **Identifiers the compaction summary dropped ride a machine-built appendix.** The audit retry
  ships lossy after two attempts by design, and 18-34% of load-bearing identifiers were measured
  missing from committed summaries (worst cases lost 30 of 30). The appendix is bounded per id and
  in aggregate, and reserved INSIDE the summary cap so it can never bloat the context it protects.

### Added
- **`DELTA_SCRATCH_DIR`** — one root for all three per-run artifact families the engine used to
  write into the workspace: spilled tool results (`.delta/spill/`), research artifacts (now
  `.delta/research/`), and the model's per-run scratchpad (`scratch/<runId>/`, wiped every run).
  Defaults to the workspace, so nothing moves unless set. On a git-tracked or human-browsed
  workspace, point it at machine-local disposable storage (the Fly template now ships
  `/data/scratch`). File tools accept the scratch root as a second confined root, so relocated
  artifacts stay readable and the scratchpad stays writable; `.delta/*` is write-reserved under
  BOTH roots; pre-existing artifacts keep resolving via a legacy fallback (no migration — delete
  old trees at leisure); demotion derives paths against both roots so historical rows keep
  shrinking the retained tail. A root that would contain the daemon DB or the workspace is refused
  back to the workspace with a WARN rather than handing the model file-tool reach over `delta.db`.
- **`GET /v1/status` reports tool usability** in three states, because the operator's next action
  differs: `registered` (in the live registry, read per request), `unusable` (registered but a live
  precondition fails NOW — e.g. no `EXA_API_KEY` in env or vault; heals the moment a credential
  lands, no restart), and `omitted` (never registered this boot, with a reason: no vault, CLI
  missing, sub-agent depth, not control-plane-wired, or an allowlist name matching nothing). One
  stderr line at boot when something is omitted or unusable. No tool is ever de-registered for a
  missing credential — the 0.2.10 vault contract stands, locked by test.
- **`tool.rejected` telemetry event** on the unknown-tool branch, with a closed reason enum
  (`unknown` / `not_allowed` / `breaker_disabled`) that exports bare; the raw model-requested name
  is payload and stays local unless `DELTA_CAPTURE_PAYLOADS=1`. 9.4% of one lane's tool calls were
  rejections no counter recorded.
- **`DELTA_MAX_STEPS`** completes the third budget axis, same shape as tokens and cost but floored
  at 1 (a zero-step budget fails every run before step 1, undiagnosably). Honest scope: the fleet's
  binding constraint is tokens — max observed steps is 62 of 100 — so this is a knob for
  deep-research shapes, not a change anyone currently deployed will see.
- **The skill index refreshes without a restart.** `search()` re-scans behind a per-`SKILL.md`
  stat (mtime AND size — a same-timestamp rewrite still re-indexes), so skills added, renamed, or
  re-described after boot are findable. Never a watcher: a watcher is a timer by another name and
  this daemon must be able to suspend.
- **A `remember` refusal for size names the exact overage and hands back the current file** as a
  merge base. 86 of 240 fleet saves were refused with neither, so the model compressed by
  guesswork, re-fired, and hit the three-strike breaker — the largest self-learning failure mode
  on the fleet. One informed retry instead of three blind ones; the Cockpit keeps the short error.

### Changed
- **The delegated code CLI defaults to `--disable apps --disable plugins`.** A `codex exec`
  session, asked to prove its Gmail skill was inert, listed the operator's real inbox — 6,913
  messages, write scope — granted by nothing on the host: account connectors live server-side on
  the CLI's own login. Anyone who deliberately relies on a connector through `code` must set
  `DELTA_CODE_CLI` explicitly (used verbatim, never modified). Requires codex-cli >= 0.146.0; an
  older binary resolves and then rejects the flags per-call.
- **A failed run's `output_text` is the user-facing outcome, not the operator diagnostic.** The
  diagnostic (`budget exhausted: N/M steps, …`) lives in `runs.error` and the `error` event, as it
  always did. Consumers that string-matched counters out of `output_text` must move to
  `runs.error`.
- **Research artifacts write under `.delta/research/`** instead of a bare `research/` directory in
  the workspace — hidden and uniquely named, so no operator has to write the ignore rule that, on
  one deployment, silently swallowed new files in five legitimate vault folders. Old trees stay
  where they are and are wiped/read via the legacy fallback.
- **The compaction summary's lead-in says "the request you are working on"** rather than "the
  original session request" — the sentence now matches what is actually pinned. The
  `<original_request>` tag name is unchanged, so nothing that greps the wire format breaks.


## [0.2.14] - 2026-08-10

Bounds and correctness. The debug capture table can no longer fill a volume, a shrinking turn no
longer reads as a cache disaster, and sub-agent capabilities are locked to what the engine actually
enforces. Plus one real prompt-cache fix that **no current lane triggers** — read the next paragraph
before hoping it is yours.

**The cache fix, scoped honestly.** Anthropic's cache lookback is 20 blocks per breakpoint and finds
only positions earlier requests already wrote. Our rolling breakpoints were landing one block apart,
sharing a single window instead of starting separate ones, so a turn issuing **10 or more parallel
tool calls** outran all of them and re-billed the whole prefix. Measured live on both wires, at burst
width 12: cache read `2,523 → 10,207`, roughly 4.8x cheaper on an affected turn.

**Below 10 parallel calls per turn this release changes nothing about your cost.** At widths 4 and 9
the before/after arms are identical to the token. Agents that batch 2-3 calls a turn, which is what
ours do today, will see no difference. This was found by enumerating our own serializer, not by
observing a lane in trouble, and it is shipped because it is a real defect rather than because
anyone is currently hitting it.

**It does not close the open prompt-cache question.** Production turns still show cache shortfalls of
2,000-10,000 tokens at burst widths of 0-2, with a byte-identical prefix and a constant ephemeral
tail. That signature is unexplained and predates this release. Better telemetry for it is the next
piece of work.

### Upgrade
0.2.14 adds no migration, so from 0.2.13 it is reversible. **From 0.2.11 or earlier it is not** — it
carries the one-way schema step 0.2.13 introduced. Snapshot the whole `/data` volume, grep the
archive for `DELTA.md`, then restore it and boot the old version against it before upgrading. A
snapshot that exists is not a rollback path that works.

### Fixed
- **Rolling cache breakpoint windows are chained contiguously**, on both the native Anthropic and
  OpenAI-compatible wires. A breakpoint covers 20 blocks including itself, so the next window begins
  exactly 20 back; three marks now rather than two, since Anthropic allows four, the system prefix
  takes one, and breakpoints cost nothing. Block counting is real: an assistant turn carrying N tool
  calls is N blocks, not one. Beyond a burst of ~19 the cache is still lost and no placement fixes
  it, because that burst is a single message wider than the entire lookback window.
- **`calls` is bounded** by age and a byte budget (`DELTA_RETENTION_MAX_CALL_BYTES`, default 32MB).
  The debug-capture table had no bound at all; on one lane it reached 45% of the database from a flag
  left on. Bytes rather than rows, because a captured call is ~95KB on one lane and ~700KB on another.
  Byte-accurate: SQLite `LENGTH()` counts characters, which undercounted non-ASCII payloads by ~3x.
- **`cache_shortfall_tokens` is bounded by the current turn's input too.** A request cannot re-read
  more than it contains, so a turn that shrank, which is what compaction produces, previously
  reported a large shortfall for a turn that had cached everything available to it.
- **`list_schedules` and `cancel_schedule` carry the control server's reason.** A bare `409` was read
  by an agent as "my schedules are unreadable" when the server had said "no active agent turn".
- **An empty provider error body carries its HTTP status**, and a 404 names the usual cause: a
  `MODEL_BASE_URL` missing its `/v1` path.

### Changed
- **Sub-agent capability prose is locked to the enforced filter by test.** Children have been
  read-only since 0.2.4 while five places said otherwise, including the child's own role prompt,
  which instructed it to write files the engine refuses.

## [0.2.13] - 2026-08-09

Say what changed. The engine now reports which part of the prompt moved between turns, so a cache
miss names its own cause. Compaction gets under its own ceiling reliably, and the arguments the
model itself writes are bounded for the first time.

This release also carries the work prepared as 0.2.12, which was never published. Upgrading from
0.2.11 is a single one-way step rather than two.

### Upgrade note: this step is one-way
Two migrations. A lane rolled back to 0.2.11 afterwards will not boot, and recreating the volume to
recover destroys the agent's learned `DELTA.md`, which lives in the workspace rather than the
database. Snapshot the workspace and verify the archive before upgrading:

```sh
fly machine start <machine-id> -a <app>

# The workspace is wherever DELTA_WORKSPACE points, which is NOT the same on every deployment
# (the image default is /data/workspace; Ferni uses /data/bundle). Ask the machine rather than
# assuming, or just take the whole volume.
fly ssh console -a <app> -C "printenv DELTA_WORKSPACE"
fly ssh console -a <app> -C "tar cf - -C /data ." > <app>-data-$(date +%Y%m%d).tar

tar tf <app>-data-*.tar | head        # verify: non-empty
tar tf <app>-data-*.tar | grep DELTA.md   # verify: the self-file is actually in there
```

A lane that autosuspends must be started first. Full
procedure in `hosting.md`.

### Changed
- **Compaction targets a flat budget instead of one derived from its own trigger.** A high ceiling
  used to produce a retained tail nearly as large as the ceiling, so compaction landed just under
  budget and re-fired next turn. It now compacts to a fixed target, fires less often, and reliably
  gets under the limit. **No effect on lanes with a ceiling below roughly 33,000 tokens**, where the
  previous calculation was already the smaller of the two.
- **`compaction` events count attempts, not rewrites.** An attempt that ran the summarizer and
  produced nothing usable was billed and reported nothing. It now emits with `shrank: false` and a
  reason. **Filter `shrank = true` to reproduce previous counts.**
- **`model.call` covers the utility model.** Compaction summaries, research fan-out, reflection and
  `eval_n` judging previously charged the run without emitting anything. **Filter `tier = 'main'`
  anywhere you count turns.**

### Added
- **Prefix identity on `model.call`.** `spine_hash` and `tools_hash`, salted per daemon process,
  alongside `spine_bytes`, `tools_bytes`, `tools_n`, `self_bytes`, `history_bytes` and
  `ephemeral_bytes`. A miss with a moved hash names the segment that changed; a miss with both
  stable proves the prefix was intact.
- **`cache_shortfall_tokens`**, the previous request's gross input minus this call's cache reads.
  Prefer it to `cache_hit_pct`, which is a ratio whose denominator grows as history is appended and
  so moves even when caching is perfect. The shortfall's floor equals `ephemeral_bytes` and is
  structural.
- **A context ceiling derived from the model.** `pricing.ts` gains an optional `window`;
  `DELTA_COMPACT_AT_TOKENS` becomes an override, clamped with a boot warning when it exceeds what
  the smallest model in the cascade supports. An unknown model keeps the 120,000 default.
- **`tool.breaker`** when a failing tool is quarantined, with the schema bytes withdrawn.
- **`last_event_ms_ago` on `/v1/busy`** while a run is in flight: how long the daemon has been
  silent, which is the signal a stall detector needs. Daemon-wide, so use `/v1/tasks/:id/events` for
  a per-run decision.
- **`capture_enabled` on `/v1/dev/runs/:id/calls`**, plus an explanation when the result is empty.
  Request capture requires `DELTA_CAPTURE_CALLS`, which is dev-only and distinct from
  `DELTA_CAPTURE_PAYLOADS`.
- `self: {bytes, cap}` on `/v1/status`, and the canonical profile name.
- `recall` with an empty query lists the thread's spilled and evicted artifacts.

### Fixed
- **A compaction interrupted by a crash no longer resumes with a stale context estimate.** The
  provider-anchored estimate is reset inside the same transaction that rewrites history, on both the
  proactive and overflow-recovery paths.
- **A succeeded call's arguments are bounded.** Tool results were capped on arrival and demoted at
  compaction; the arguments the model wrote were bounded by neither. They are now elided to a
  pointer once the call has succeeded, at a seam where a resume no longer needs them, so it costs no
  prefix-cache churn.
- **A crash mid-batch no longer strands uncommitted parallel tool calls.**
- **Concurrent `spawn_subagent` cannot overspend the run budget.** Each child read the full
  remaining budget at spawn, before any sibling had charged a token. Replaced with a live
  reservation reconciled on exit.
- **The self-write breaker no longer quarantines an agent that is converging.** An attempt closing a
  material share of the remaining gap resets the streak, bounded by a hard attempt ceiling.

### Documentation
- `bundle-reference-material.md`: operator reference material belongs in the workspace and is read
  on demand, not resident in the bundle.
- `hosting.md`: what survives a suspend, and the one-way upgrade procedure.

## [0.2.11] - 2026-08-03

Context economics. Prompt caching and compaction were each defeating themselves; both are fixed and
the pair compounds, because a prompt that stays small needs compacting far less often. No
configuration change is required and nothing is opt-in.

### Fixed
- **Rolling cache breakpoints land on persisted transcript.** They were marking the derived
  per-turn blocks the engine appends after the history - context, retrieval, plan, budget - one of
  which carries a clock. A cached prefix ending on a block that changes every turn can never be
  matched, so every turn wrote a cache that could not be read back and only the system prefix was
  ever served from cache. Both wire serializers now share one eligibility rule.
- **Compaction shrinks the prompt it was called to shrink.** Nothing re-bounded the recent tail it
  keeps: `capAndSpill` caps a tool result once, when it is produced, and the capped copy then rode
  the active context for the rest of the session. Spilled results in the retained tail are demoted
  to a bounded head plus their spill pointer; the full output stays on disk and the original row
  stays archived for `recall`. When demotion alone is enough, the summarizer is skipped entirely.
- **Compaction's tail floor is a wire group, not a row count.** Two rows of any size could survive a
  zeroed budget, and the loop that repaired split tool groups was unbounded. Whole groups are
  selected instead, so a group is never split and there is nothing to repair.
- **Compaction reports progress honestly.** Success compared the summary against the prefix alone,
  in UTF-16 code units. It now compares the whole active set, before and after, in UTF-8 bytes, and
  requires a material reduction - except on overflow recovery, where any reduction beats failing
  the turn.
- **`prompt_cache_key` on the OpenAI-compatible wire.** It was sent on the Responses wire only, but
  it is a Chat Completions field and OpenAI documents it as required for reliable matching on
  GPT-5.6 and later. Sent only to hosts documented to accept it, with a per-provider override
  (`DELTA_PROMPT_CACHE_KEY`) for a verified proxy.
- **`max_completion_tokens` on OpenAI's own endpoint.** `max_tokens` is deprecated on Chat
  Completions and o-series reasoning models reject it, so a direct `api.openai.com` base URL with a
  reasoning model failed on a parameter the engine controls. Other endpoints keep `max_tokens`,
  which OpenRouter normalizes for every upstream.

### Caveat
Anthropic's cache lookup scans a bounded number of blocks back from each breakpoint. Demotion
reduces the size of a tool result but not the number of blocks, so a turn with many parallel tool
calls can still miss the previous cached tail. Unchanged in this release.

## [0.2.10] - 2026-08-01

The secret vault. An agent's third-party credentials can live encrypted in the daemon instead of
the deployment environment, under one rule: a secret value never enters model-readable state. Fully
opt-in; with no vault key set, a deployment runs exactly as 0.2.9.

### Added
- **The vault.** `DELTA_VAULT_KEY_FILE` (or `DELTA_VAULT_KEY`) enables an AES-256-GCM store in the
  daemon database - outside the model-writable workspace, so the workspace-confined file tools
  cannot reach the ciphertext. With neither set there is no vault: the routes `503`, the tool is
  not registered, and a reference fails closed. Safe mode never carries one.
- **Write-only seam.** `PUT /v1/secrets/:name` stores a credential and `GET /v1/secrets` lists
  names, purposes, and timestamps. No route returns a value. `PUT` is create-only (`409` on an
  existing name), so a gateway flow cannot silently replace an established credential; rotation and
  deletion are operator acts on `/v1/dev/secrets/:name` behind the inspect token.
- **`{{vault:NAME}}` references** in MCP HTTP headers and stdio `env`, resolved in engine code at
  egress - per call for headers, at spawn for a child. Configuration holds the name, never a value.
  A backend that could not connect at boot for want of its credential reconnects when it arrives.
- **`list_secrets`**, the model's entire view of the vault: names and purposes. There is
  deliberately no tool that returns a value.
- **Runtime credentials for built-ins.** `web_search` falls back to a vaulted `EXA_API_KEY`,
  resolved per call, so handing an agent a search key enables the tool without a redeploy.
- **Exact-value redaction.** A value is registered when resolved for egress, in raw,
  percent-encoded, and JSON-escaped form. A later reflection of it is replaced with `[vault:NAME]`
  before reaching the model, the transcript, a spill file, a research artifact, or telemetry.
- **`/v1/status` reports the vault** live: `enabled`, `count`, and `declared` - the names the
  running configuration wires a destination for, so an edge can refuse a request for a credential
  nothing is configured to use.

### Changed
- **stdio MCP servers no longer inherit the daemon environment.** A configured server child now
  receives process plumbing (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`) plus its own
  `env` object. Previously every stdio server received the daemon's full environment, including
  broker, control, telemetry, and provider credentials. A server that relied on an inherited
  variable must now declare it in its `env`.

## [0.2.9] - 2026-08-01

Two additive affordances that let a fire-and-forget gateway (Delta Connect) run long chat turns
correctly. Both are opt-in; with nothing new set, a deployment runs exactly as 0.2.8.

### Added
- **Opt-in exactly-once tasks.** A request may set `idempotency_terminal: true` (on a durable run)
  so its `idempotency_key` also dedupes against its own *terminal* run, not only a live one. A
  fire-and-forget caller that loses the `202` for a run the daemon durably accepted can re-POST the
  same key and re-attach to that run instead of starting a second - no duplicate billing, no
  stranded result. The dedupe stays scoped to the run's owner. The default (a terminal run frees
  its key, so a stable key reused later runs fresh) is unchanged.
- **Run identity on self-scheduling.** `schedule_self` / `list_schedules` / `cancel_schedule` now
  assert the run's owner to the control plane via `x-delta-user`, so a gateway can bind a schedule
  to the right conversation even when several users' turns run concurrently. An unowned/dev run
  sends no assertion and the gateway falls back as before.

## [0.2.8] - 2026-08-01

A legible command surface. A deployed agent can describe its own provider and effort in plain
terms, safe mode is observable and self-aware, and the provider cascade is queryable. All
additive read-surface plus one honesty fix; with nothing new set, a deployment runs exactly as
0.2.7.

### Added
- `/v1/status` names the provider: a friendly wire label (`anthropic-native`, `openai-native`,
  `openrouter`, `codex-sign-in`) on the model view, plus `provider_chain` for the full failover
  cascade.
- Reasoning effort always resolves: the status `reasoning_effort` field is never omitted. An
  unset effort reports `default` (the provider's own) instead of leaving the field blank.
- `safe_mode` on `/v1/status`: an operator can confirm safe mode from an edge client instead of
  reading the boot log.

### Changed
- Safe mode is now self-aware. The system spine drops the configured agent name in a safe-mode
  boot (so the agent no longer presents as its configured persona) and states that persona,
  policy, and the learned self-file are not loaded this run. The agent is honest about its
  footing instead of inferring an identity from conversation history.

## [0.2.7] - 2026-07-31

Agents that know their limits and can't wedge. The two run tiers are renamed to name what
they are, the tool set becomes an operator knob, and a poisoned config is always recoverable.
Default behavior is unchanged: with the new env vars unset, a deployment runs exactly as 0.2.6.

### Added
- Envelope knob: `DELTA_ALLOWED_TOOLS` / `DELTA_PINNED_TOOLS` define a custom capability
  envelope. They narrow within the tier and cannot escalate it (a `safe` daemon stays safe);
  build a custom powerful envelope from `trusted` plus a list.
- Budget self-awareness: a one-time qualitative wrap-up nudge to the model once any budget
  axis passes ~85%. Not a raw counter.
- Resilience: an output-capped tool call is reissued smaller instead of executed truncated;
  one deterministic tool-argument repair pass for slightly-malformed calls; unified provider
  error classification (moderation terminal, quota fails over, transient retries).
- Safe mode: `DELTA_SAFE_MODE=1` boots a neutral, safe-floor, no-MCP agent so a poisoned
  self-file or broken config can never wedge the daemon. Self-file revert via the existing
  Cockpit revision endpoints.
- Local skills: `DELTA_SKILLS=local` reads a `skills/<name>/SKILL.md` folder (use-only,
  progressive disclosure - only name and description enter the prompt). `off` hides skills
  entirely; `mcp` (default) is unchanged.
- `GET /v1/status`: a secret-free model / effort / profile / budget read for edge tooling.

### Changed
- The two run tiers are renamed `chat` → `safe` and `work` → `trusted` to name the capability
  axis, not an activity. The old names remain as aliases, so existing `DELTA_PROFILE=work`
  deployments resolve unchanged; the canonical name in telemetry and `/v1/status` is the new one.
- A committed self-file (`remember`) write on a budget-failed turn is now surfaced in the
  failure result instead of silently swallowed (error-as-value).

## [0.2.6] - 2026-07-30

A default deployment that describes itself. Two telemetry blind spots are closed, so a
default deployment is fully self-describing: cost, fallbacks, and error classes are
queryable without turning on payload capture. The Anthropic fast-mode wire ships inert by
default, so enabling it is a single env flip the day an org's allocation lands. No
behavior changes when nothing is set; upgrading is a version bump.

### Added

- **Safe telemetry without payload consent.** `model.call`, `tool.call`, and `tool.result`
  now export a closed allowlist of operational attributes (model, provider, tokens, cost,
  latency, effort, fallback, `error.class`, tool names). Prompts, tool arguments, results,
  `error.message`, and `tool_calls` still require `DELTA_CAPTURE_PAYLOADS=1`.
- **`model.fallback` event** when a call is served by a model other than the configured
  primary, plus `fallback: true` on that `model.call` and a stderr marker.
- **`error.class` on failed `tool.result`** - a low-cardinality class (`self_cap`,
  `self_conflict`, `self_spine_echo`, `self_empty`, `self_unavailable`, `self_protected`,
  `timeout`, `transient`, `categorical`). A 200-char `error.message` snippet rides
  alongside it, local-only unless payload capture is on.
- **`gen_ai.request.effort` on `model.call`** - the reasoning effort each call ran at,
  bounded to the known tiers on export.
- **`self.pressure` event + stderr warning** when `DELTA.md` is elided from the prompt
  (over cap) or over 90% full. Seed `DELTA.md` at no more than half its cap.
- **Anthropic fast mode** (`DELTA_SPEED=fast`, off by default, byte-identical when unset).
  Opus 5 and Opus 4.8 only; the served speed lands on `model.call` telemetry. 2x token
  pricing, so pair it with a `DELTA_MODEL_PRICES` override.

### Changed

- **The categorical-failure breaker now latches self-write storm classes.** Repeated
  `remember` refusals whose messages vary per call (byte counts, file text) are now
  quarantined at 3 instead of grinding. Conflict, transient, and timeout never latch.

## [0.2.5] - 2026-07-30

The first turn after an idle or suspended machine wakes is now fast and reliable, and a
misbehaving provider is visible instead of silent. Field data (Aperture, 2026-07-29) traced a rare
turn-1 stall to the first model call reusing a pooled connection left stranded by a suspend/resume,
where it hung with no logs and no events. This release heals that automatically, bounds any future
stall to seconds, and surfaces every retry, plus an opt-in cache knob for lanes that run several
turns an hour. No wire changes, so upgrading is a one-line version bump and every new setting is
safe by default.

### Added

- **First-byte deadline** (`DELTA_FIRST_BYTE_MS`, default 30s; per-provider `firstByteMs`). Bounds
  the connect-and-first-header phase that the per-chunk idle watchdog cannot see. A call that cannot
  reach the provider now fails fast and retries in ~30s instead of hanging on a dead connection up
  to the 600s cap. On by default and independent of `DELTA_STREAM_IDLE_MS`; set `0` to opt out.
- **Self-healing provider wire after idle or resume.** The first call after a suspend/resume, or
  after five minutes of silence, automatically opens a fresh connection instead of reusing a stale
  pooled one, so a woken lane's opening turn just works. A best-effort preconnect at boot and on
  resume also pays DNS and TLS off the first turn's path. Fully automatic; the only cost is one
  extra TLS handshake on that first call.
- **Retry visibility, end to end.** Every retry, re-auth, model switch, and provider failover now
  emits a persisted `model.retry` event (with a stable `error.type`) and one log line, so a host
  can show real "retrying" state instead of dead air. `model.call` also carries `wall_ms` and
  `retries` beside `latency_ms`, so a slow turn's pre-call gap is one query away (`wall_ms` minus
  `latency_ms`). Nothing to enable.
- **`DELTA_CACHE_TTL=1h`** (opt-in, off by default, byte-identical when unset). For a lane serving
  several turns an hour, keeps the stable prefix (system spine plus tools, ~13k tokens) cached for
  an hour instead of five minutes, for a faster and cheaper turn 1. 1h cache writes bill double, so
  turn it on only for busy lanes; the per-run tail keeps the default TTL.

### Fixed

- Failed model attempts now log one line each, so a retry storm is never silent (previously only
  successful calls printed a line).

## [0.2.4] - 2026-07-28

Harden what shipped + close the remaining Aperture field-report gaps. Five code audits of the 0.2.3
binary plus a three-way competitor teardown (openclaw / hermes / pi) found that the two roadmap "big
blocks" - context management and scoped memory - were already shipped, so this release is targeted
correctness, security, and observability, each with tests. The two security surfaces (task tenancy,
memory widening) were codex-gated to a GO. Every change is provider-agnostic (no wire changes);
validated end-to-end on a real compiled binary against OpenRouter (Sonnet 5) and native Anthropic
(Opus 5).

### Security

- **Task-route tenancy + identity boundary.** `GET`/`DELETE /v1/tasks/:id` and `…/events` checked
  only that a run *existed*, so any control-token holder could read, poll, or cancel any run. They
  now enforce that the caller owns the run: the tenancy principal is the gateway-asserted
  `x-delta-user` header (never a request-body field), a cross-tenant hit and a miss return the same
  `404` (no existence disclosure), and the header is canonicalized into the stored run at ingress so
  memory recall, reflection, and event identity all key on the same owner - a body `user_id` can no
  longer point them at another tenant. The idempotency dedupe is scoped to the run's owner (a shared
  key can't return another tenant's live run or its streamed result), and the `previous_response_id`
  continuation check no longer leaks existence via a `400`-vs-`403` split. New `DELTA_STRICT_TENANT`
  requires every run to be owned (creation without a principal is `401`, unowned runs are
  inaccessible, `/v1/queue` is principal-scoped with tenant-local positions) for a daemon that serves
  multiple users behind one control token. `/v1/busy` stays global by design - it is the host's
  whole-machine suspend gate, control-token-gated and host-only.
- **Memory-widening authorization can't be self-asserted.** Reflection widens a `user`-scoped memory
  to a broader audience only on `review_kind = submission_disposition` + `widen_authorized`, both
  read from run metadata - which a caller controls. A shared control token authenticates the gateway,
  not that a body field came from a human reviewer, so those fields are now stripped from **every**
  request body by default (an untrusted body could otherwise widen its memory into a cross-user
  audience). `DELTA_TRUST_REVIEW_METADATA=1` is the single-tenant opt-in; a durable trusted
  challenge path is planned separately.

### Added

- **Pollable per-task event feed + per-turn cache-hit%** (Aperture A1). `GET /v1/tasks/:id/events`
  now also serves a bounded, cursor-paged JSON poll when given `?since=<id>` (with a `cursor` and a
  `done` flag), for hosts that can't hold an SSE connection; the live SSE tail takes an opt-in
  `?coarse=1` that drops the per-token deltas, leaving the structural heartbeat. `model.call` events
  carry a pre-computed `cache_hit_pct`, so a host sees live per-turn cache warmth (the 0–99%
  oscillation that previously could only be diagnosed forensically) instead of deriving it. Both
  surfaces inherit the task-tenancy gate above.
- **`delta bundle apply`** (Aperture A12). A first-class command (also run on every container boot)
  that re-seeds the FIXED operator files - `POLICY.md`, `vocab.json`, `PROMPT_CONTEXT.md` - from
  their base64 env vars and **never** touches the agent's learned `DELTA.md`. It validates every
  payload first (a `vocab.json` that isn't a JSON object, or a `POLICY.md` over the byte or token
  budget, is refused and *nothing* is written), so updating operator config on a live machine is one
  safe step instead of the old five-step `fly machine update` dance. The FIXED/self file split now
  lives in one manifest (`src/bundle.ts`) that the write-guard and cockpit allowlist also derive
  from, so it can't drift.
- **New config flags:** `DELTA_STRICT_TENANT`, `DELTA_TRUST_REVIEW_METADATA`, and
  `DELTA_ISOLATE_AGENT_MEMORY` (below). All default off (current single-tenant behavior).
- **Configurable run concurrency** (`DELTA_MAX_CONCURRENCY`, clamped 1–256). The number of
  concurrent cross-session runs was a hardcoded 4; it is now a config knob whose **default is 8**.
  Each run is IO-bound async work on one event loop (not a thread), and sessions stay serial, so the
  practical ceiling is the provider's concurrent-request tolerance (keep it low on a subscription
  key; a high-limit API key can run 25+), then per-run context memory (~4–15 MB/run). The queue
  mechanism is tested correct to 128 concurrent runs.

### Changed

- **Suspend-safe resume** (Aperture A2). The write-lease heartbeat exited the daemon when renewal
  failed - which, after a Fly suspend/resume across a wall-clock jump, meant the daemon exited
  *without releasing* and Fly's restart cap turned that into a minutes-long stall. It now
  `renew-or-reacquire`s: it reclaims its own machine-scoped lease and stays up, exiting only when a
  *different* live holder genuinely owns it. Both lease functions now sample the clock inside the
  write transaction. This is recovery, not fencing (the lease is unfenced and machine-scoped, as
  documented); it lets a scale-to-zero host flip `stop` → `suspend` and cut cold-start ~4.7s → ~1.1s.
- **Research subagents are genuinely read-only.** A research sub-agent inherited the parent's full
  rights, so it could `write_file` / `remember` / mutate via a mis-named MCP tool mid-run. Tools now
  carry a positive, fail-closed `readonly` marker and a research child is admitted **only** read-only
  tools; MCP tools are classed read-only from the authoritative `readOnlyHint` annotation, never a
  name heuristic. Anything unmarked defaults to mutating, so a new or forgotten tool can never leak a
  write into a child.
- **Pre-send context estimate is provider-anchored.** The pre-send compaction gate estimated the
  request with a byte rule that could sit just under budget while the provider's real input was over,
  wasting a frontier call before the post-provider overflow retry corrected it. It now also projects
  off the last call's *real* gross input plus the estimated growth since, taking the max with the
  byte estimate - so a long run compacts a call earlier without a tokenizer dependency, and never
  estimates below the existing floor.
- **Deterministic memory recall + agent isolation.** Recall ranked partly on a `hits` counter that
  the recall itself mutates, so an identical repeated query drifted its order; `hits` is dropped from
  ranking (usefulness now survives via TTL, not rank) and the sort gets a stable `id` tiebreak, so
  the same query returns the same set. New `DELTA_ISOLATE_AGENT_MEMORY=1` excludes the anonymous
  (`agent_id=''`) memory bucket from recall on a shared multi-agent DB, so one agent can't read
  another's unbound rows.

### Fixed

- **Concurrent self-writes no longer clobber each other.** Two runs on one daemon both calling
  `remember` wrote `DELTA.md` last-write-wins, silently dropping one run's lesson. `writeSelf` now
  uses optimistic concurrency: a write carries the base revision it read, a diverged base is refused
  (returning the current content), and the run re-reads, re-merges, and retries - so both concurrent
  lessons survive. An idempotent re-fire (the content already on disk) still no-ops. This is the one
  documented file-level compare-and-swap layer; other file writes remain last-write-wins.
- **A distilled learning could be silently dropped.** When the utility model returned a non-string
  field in a distilled artifact (a numeric `name`, an object `body`), reflection threw while
  persisting and the whole learning was lost - latent since 0.1.0. The artifact's `content`, `name`,
  and `body` are now type-guarded with safe fallbacks before use, so a malformed distiller response
  degrades to a best-effort learning instead of none.

## [0.2.3] - 2026-07-28

Failure-visibility + native-wire batch, driven by Aperture's production field report (two prod
agents, the harness's heaviest real consumer). Every item ships with a test.

### Added

- **Run error on the task surface.** `GET /v1/tasks/:id` now returns a first-class `error` field
  carrying the run's last error - the provider or fatal error that ended it (length-capped) - so a
  plain HTTP poller learns *why* a run failed before its first token instead of seeing a merely-dead
  run. Both motivating incidents were provider errors that failed the run before its first token
  (Opus 5 rejecting `thinking.type=enabled`; an untranslated fallback id). Per-tool errors stay in
  the message stream, as before.
- **Run lifecycle timestamps on the task surface.** `GET /v1/tasks/:id` now returns `created_at`
  (accepted/enqueued), `started_at` (dequeued and began executing), and `finished_at` (terminal),
  so a host can measure queue wait (created → started) separately from execution time (started →
  finished) instead of showing one faith-based spinner over the whole thing.
- **Native Anthropic adaptive thinking.** `DELTA_REASONING_EFFORT` now maps to the correct wire
  per model: `thinking:{type:"adaptive"}` + `output_config.effort` on Claude 4.6+ and all Claude 5
  models (Opus 5, Sonnet 5, Fable 5…), which **reject** the legacy `thinking:{type:"enabled"}`;
  the legacy budget wire is kept for Claude ≤4.5. Effort control now works on frontier models.
  Two specifics worth knowing: on the adaptive path the OpenAI-only `none` and `minimal` efforts
  map to `low` (always-on reasoning models reject a disabled thinking type), and Delta
  automatically raises the request's `max_tokens` by an effort-based headroom so adaptive thinking
  (which has no fixed budget) has room to breathe - size `DELTA_STEP_MAX_TOKENS` generously at high
  effort regardless.
- **Opus 5 pricing** baked into the cost table (`claude-opus-5`), so the native/subscription paths
  meter real dollars without a `DELTA_MODEL_PRICES` override.

### Changed

- **Categorical-failure breaker.** A tool that returns the *same* categorical `[tool error]` on
  three consecutive turns (a missing CLI, a persistent schema reject) is quarantined for the
  remainder of the run and the model is told to try another approach - a success, a transient
  error, or a different error resets the count, and multiple failures in one turn count once. This
  caps the field report's worst case (a missing `code` CLI that burned ~$3.50 of a $5.17 run by
  looping ~17 turns): a live replay spent pennies on the dead end and still filed its output.
- **`code` tool self-disables when its CLI isn't an executable file.** Probed once at boot: a bare
  name via `Bun.which` (PATH), an explicit path via `accessSync(X_OK)` - a real executable check, so
  a path *this process* can't exec (e.g. a root-owned `0700` file) is rejected rather than passing a
  mode-bit glance and then `EACCES`-ing on spawn. This stops the model being handed a tool whose CLI
  is simply absent. A CLI that passes the probe but fails at *runtime* (the bc8e877e case - the CLI
  was present, its runtime dependency was not) is caught by the breaker above, not here; the two
  layers are complementary.
- **All native-wire model ids are normalized** (provider prefix stripped, dotted versions →
  dashes), for the primary *and* every fallback - not just the utility model. An untranslated
  fallback id was one of the report's two silent zero-token failures (a run that looked merely
  dead to a polling host); `claude-opus-4.8` and `claude-opus-4-8` both reach the wire correctly now.

### Documented

- **The four hosting lifecycle contracts are now documented guarantees** (`docs/hosting.md`):
  idempotency keys are freed on terminal runs, `recover()` resumes mid-flight runs on boot,
  `/v1/busy` reports the durable queued-or-running truth, and seeding never touches an existing
  `DELTA.md`. Each is pinned by a named guard test (`test/contracts.test.ts`) so it can't silently
  regress. Hosts (Aperture) already build their reconcilers on these; they now change semantics
  only with a major-version note.

## [0.2.2] - 2026-07-27

### Added

- **`DELTA_ALLOW_SELF_WRITE` - trusted-gateway self-write.** Off by default. When set, the
  `remember` self-write tool is granted (and pinned) even on the restricted `chat` profile - for a
  daemon fronted by a trusted, authenticated gateway. This is what lets a chat agent learn safely.
- **`DELTA_STEP_MAX_TOKENS`** - cap the tokens a single tool call may emit, with an honest
  truncation error for oversized tool calls instead of silent corruption.

### Changed

- **`DELTA_MAX_TOKENS` / `DELTA_MAX_COST_USD` now override the profile budget** instead of only
  narrowing it, so an operator can raise as well as lower a profile's budget explicitly.

### Companion

- **[`@carrara-labs/delta-connect`](https://www.npmjs.com/package/@carrara-labs/delta-connect)** -
  a new companion package: a thin, always-on edge that plugs a Delta agent into a chat channel
  (Telegram first). The agent scales to zero between messages; the edge holds the conversation.
  See [/connect](https://deltaharness.dev/connect).

## [0.2.1] - 2026-07-22

### Added
- **`GET /v1/busy` - the scale-to-zero lifecycle signal.** A host managing suspend/resume can
  now ask the daemon "is it safe to suspend?" and get `{ busy, running, queued }`. `busy` is the
  durable queued-**or**-running truth read from the run table, so a host never suspends a Machine
  with work still owed (a queued-but-not-yet-dispatched run keeps `busy` true). Behind the `/v1/`
  control-token gate, deliberately not folded into the open, data-free `/healthz`. Turns the
  scale-to-zero pattern from "read the provisioner source" into a ten-line host integration.
- **`docs/hosting.md` - the hosting lifecycle contract.** Documents control-plane-owned
  suspend/resume (why not `fly-proxy` autostop), the three host hooks (wake before dispatch, busy
  check before suspend, suspend after terminal), and the WAL suspend-safety guarantee that makes
  aggressive suspend safe.

### Changed
- **`DELTA_MCP_SERVERS` parsing fails loud, never silent.** A malformed value used to return no
  backends with zero trace - the agent booted tool-less and burned a full model run before anyone
  noticed. Malformed JSON, a non-array, and each unusable entry (no `name`, an `http` entry with no
  `url`, a `stdio` entry with no `command`) are now dropped with a specific boot-log warning. A
  **missing `transport` is inferred** from the entry shape (`url` → `http`, `command` → `stdio`)
  and stamped on the entry, so a common omission just works instead of crashing the stdio path on
  `Bun.spawn(undefined)`.

### Fixed
- **A bad `stdio` MCP server no longer crashes boot.** A `stdio` entry whose command spawns and
  throws synchronously (a non-existent binary, an empty argv element) used to escape the startup
  loop and take the daemon down, despite the "one bad server is never fatal" contract. The
  connection is now constructed inside the registry's catch boundary, so any spawn failure is
  logged (`mcp: <name> failed - …`) and the daemon boots with the remaining backends. Non-string
  or empty `command` elements are also rejected at config time with a clear skip.

## [0.2.0] - 2026-07-22

### Changed
- **Sub-agents (`research`) now have the same rights as the parent, not a read-only subset.** A
  `research` child's callable tools are the parent's full registry minus a small *withheld* set
  (the delegation tools `research`/`spawn_subagent`/`eval_n`, plus the run-scheduling tools), so
  nesting stays exactly one level deep. A child can now read, write, run code, use `remember`, and
  call MCP reads **and** writes - whatever the parent can. Children are built from the **same
  system spine** as the parent (identity + safety norms + `DELTA.md` + `POLICY.md`), so they inherit
  the parent's operating rules along with its rights - not powerful-but-unconstrained. Each child
  starts resident on the parent's pinned tool set and can `search_tools` for the rest, so a large
  MCP surface never blows the child's own token budget. Children run concurrently in one shared
  workspace; the child prompt cautions against clobbering a sibling's writes (full worktree
  isolation is a future option, not yet built).

### Removed
- **`DELTA_RESEARCH_TOOLS`.** The operator allowlist that gated which MCP read tools a `research`
  child could use is gone - children inherit the parent's tools directly. The env var is now
  ignored; remove it from any config.

## [0.1.2] - 2026-07-22

### Added
- **Dispatch idempotency for `POST /v1/tasks`.** A run request may now carry an `idempotency_key`;
  `enqueue` returns any existing non-terminal run with the same key instead of starting a duplicate.
  This makes fire-and-forget async dispatch safe to retry - a client retry, or a controller
  re-driving a slow-but-alive task, dedupes onto the live run rather than spawning a second one. A
  terminal run frees the key. Race-safe (single-writer, synchronous check-before-insert) with no
  schema migration, and composes with `store: false` (the ephemeral transcript is still purged at
  terminal).

## [0.1.1] - 2026-07-16

### Fixed
- Subagents inherit the parent's model: `childEnv` forwards `DELTA_MODEL_PRIMARY`, not just the
  legacy `DELTA_MODEL` alias.

### Changed
- Clearer, technical README and npm package description.
- Removed stale monorepo doc-sync tooling so `bun run check` works on a clean clone.

### Added
- `docker run` published to `ghcr.io/carrara-labs/delta-harness` (on the Deploy docs).
- Hardened release/secret-scan workflows (checksum-verified gitleaks, tag-gated scan, ghcr publish).

## [0.1.0] - 2026-07-16

Initial public release.

### Added
- Product-neutral engine: durable Run + queue (crash/redeploy resume), zero-dep
  OpenAI-compatible provider with model failover and prompt-cache breakpoints, the tool-call
  loop with builtins and profiles, an MCP client with progressive tool disclosure,
  usage-aware compaction, a governed memory rail, and NDJSON observability.
- The bundle model (`agent = engine + bundle + state`): `delta init` scaffolds a bundle;
  `delta dev` boots the local Cockpit.
- `POST /v1/responses`, `GET /healthz`, and the async `POST /v1/tasks` surface.
- Apache 2.0 license, single-binary builds, and the container image.

[Unreleased]: https://github.com/Carrara-Labs/delta-harness/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Carrara-Labs/delta-harness/releases/tag/v0.1.0
