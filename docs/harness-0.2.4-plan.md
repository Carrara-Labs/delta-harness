# Delta Harness 0.2.4 — Plan

*Status: v2 — revised after codex adversarial review (NO-GO-as-written → revised).*
*Author: build session 2026-07-28. Base: `~/delta-harness` main @ 0.2.3 (548 tests green).*

## Codex review deltas (v1 → v2)

Codex stress-tested v1 against the real code and returned NO-GO-as-written. The seven
diagnoses held; the *fixes* had holes. Every change below is folded into the slices:

- **S1 was bypassable.** `x-delta-user` is caller-supplied (server.ts:387) and the bearer
  authenticates one shared control token (server.ts:114), so a token holder can claim any
  user. Session ownership also derives from caller-body metadata (queue.ts:70). → S1
  redesigned: derive ONE authoritative principal at the HTTP boundary, stop trusting body
  metadata for ownership, apply the check to status/events/**cancel**/**queue**/`previous_response_id`,
  null-owner open only in explicit dev mode, 404 (not 403) cross-tenant.
- **S5 authorization is already self-assertable today.** `review_kind`/`widen_authorized`
  arrive in the plain JSON body (reflect.ts:75,188) with no proof of trusted origin — a
  live privacy hole. The inline-clarify design was also caller-assertable. → Split: **S5a**
  (P0) close the existing self-assertion hole now; **S5b** memory-isolation hardening;
  **S5c** inline-clarify authorization **DEFERRED** pending a real trusted-challenge protocol.
- **S3 is recovery, not fencing.** Distinct-holder reacquire is exclusive (safe), but
  same-holder duplicates both pass (lease.ts:13) and BOTH `acquire` and `renew` sample the
  clock before write admission (lease.ts:26,58). → Narrow the claim, fix both clock paths.
- **S4 bundle isn't atomic** and the "single source of truth" doesn't exist yet
  (`FIXED_OPERATOR_FILES` is private at builtins.ts:94; also duplicated at index.ts:309,
  self.ts:21). → New `bundle.ts` manifest (filename→env mapping) consumed everywhere;
  validate ALL payloads (schema-validate vocab, size-check POLICY) before any swap;
  all-or-nothing.
- **S6 denylist is insufficient** — `move_file`/`delete_file`/`code`/future tools/MCP
  misclassification leak writes (builtins.ts:409,680; mcp.ts:270). → Positive effect marker
  on `ToolDef`, default unknown→mutating, research admits only explicit reads; drop
  `writeSelf` from child context (research.ts:296).
- **S7 anchor can't read per-call usage** (AssistantMsg has no usage field, provider.ts:19)
  and `char/4` undercounts adversarial tails. → Use `max(existing_estimate,
  last_input_anchor + conservative_tail)` off the already-persisted `runs.last_input`; keep
  the byte estimate as the floor. Not a replacement.
- **Thesis softened:** "fixed by construction" overclaims — archive-safety is strong but
  universal recoverability isn't proved (compaction elides summarizer-input middle
  compaction.ts:145; recall scans only 5000 ids db.ts:347). Say "the silent-truncation
  *regression* is closed," not "truncation is impossible."

## Thesis

0.2.4 is **not** new subsystems. Five parallel audits of the shipped 0.2.3 binary
plus a three-way competitor teardown (openclaw / hermes / pi at `~/delta/.refs/`)
established two things:

1. The two "big blocks" from the roadmap — **context management** and **scoped
   memory** — are **already built, wired, and shipped** in the 0.2.3 line (recall,
   archive-safe tiered compaction, todo recitation, research subagents;
   audience/kind/trust axes, stage-then-promote, deterministic-ish retrieval). The
   silent-truncation *regression* is closed (archive-safe compaction + artifact ledger)
   — though universal recoverability is not proved (compaction elides the summarizer-input
   middle; recall scans only the last 5000 ids), so we say "regression closed," not
   "truncation impossible."
2. When openclaw, hermes and pi independently converge on the same recipe, that
   recipe is the thing to keep — and Delta already has its ~250-line lean core.
   The competitors' bulk is the multi-process / multi-channel / multi-backend
   plumbing Delta deliberately designed out.

So 0.2.4 = **harden what shipped + close the genuine net-new Aperture gaps + adopt a
few cheap primitives the competitors proved.** Leaner, smarter, simpler. Every slice
maps to an Aperture field-report ask, a security fix, or a correctness fix, and each
is validated against a competitor implementation.

Nothing here is speculative. Each slice cites the audit anchor and, where relevant,
the competitor that proves the shape.

---

## Scope — seven slices, ranked

### S1 — Identity boundary + consistent task ownership (SECURITY, P0)

**Problem (audit A1.2 + codex P0):** `GET /v1/tasks/:id`, `/events`, and
`DELETE /v1/tasks/:id` (server.ts:427-459) check only that the run *exists*. But the
naive fix (compare `sessions.user_id` to `x-delta-user`) is **bypassable**: the bearer
gate authenticates a single shared control token (server.ts:114), `x-delta-user` is
caller-supplied (server.ts:387), and session ownership itself derives from
caller-controlled request-body metadata (queue.ts:70). So a control-token holder can
claim any user, and `/v1/queue` already leaks another user's task ids the same way
(queue.ts:206). Null-owner-open is unsafe in multi-tenant (a caller can just omit user
metadata).

**Design (the real fix):** the daemon serves one trust boundary — a **trusted gateway**
that holds the control token and binds the user principal (Aperture's per-tenant-app
model). Make that explicit and consistent:
1. **Derive ONE authoritative principal at the HTTP boundary** from `x-delta-user`
   (the gateway-asserted identity), in a single helper. Everything downstream uses it.
2. **Stop trusting caller-body `metadata.user_id`/`userId` for ownership** — the server
   sets a session's owner from the authenticated principal at creation, never from the
   body. Strip/overwrite body identity fields so they can't be used as auth.
3. **Apply the owner check uniformly** to: task status, `/events`, `DELETE` (cancel),
   `/v1/queue` visibility, and `previous_response_id` continuation (queue.ts:93). One
   `assertOwner(runId, principal)` used everywhere.
4. **Null-owner access only in an explicit single-user/dev mode** (a config flag), not
   merely when the stored owner is null.
5. **404, not 403,** on cross-tenant lookups (no existence disclosure).
6. Document the trust model in `docs/hosting.md`: single shared control token ⇒ the
   gateway is the identity authority; optional user-scoped tokens are a future upgrade.

**Test (mutation-tested):** control-token holder with `x-delta-user: B` gets 404 on A's
task/events/cancel and A's ids never appear in B's `/v1/queue`; body `metadata.user_id`
cannot override the header; owner A sees its own; dev-mode flag opens null-owner only.

**Why first:** live data-exposure + cross-tenant cancel hole, and S2 depends on it.

---

### S2 — A1 pollable events + cache-hit% (P1)

**Problem (audit A1.2-A1.4):** an SSE feed already exists (`streamEvents`,
server.ts:482) but (a) there is no *pollable* cursor variant for hosts that can't
hold an SSE connection, (b) the SSE feed forwards per-token `output_text.delta` /
`reasoning.delta` too, so it is not a coarse heartbeat, and (c) cache-hit% is
computed (run.ts:829) but only `console.error`-logged.

**Build:**
1. `GET /v1/tasks/:id/events?since=<id>` → JSON array from
   `SELECT ... FROM events WHERE run_id=? AND id>? ORDER BY id` (the `events_run`
   index at db.ts:78 already supports it; `streamDev` at server.ts:1195 demonstrates
   the exact cursor query). ~15 lines beside `streamEvents`. Same tenancy gate as S1.
2. Coarse allowlist param (`?coarse=1` or default) filtering to the structural set
   (`run.*`, `turn.*`, `tool.*`, `model.call`, `checkpoint`, `error`) so the
   heartbeat sits *under* the token-delta narrative. Do not remove the verbose feed;
   gate it.
3. Emit the already-computed `cache_hit_pct` field on the persisted `model.call`
   event (run.ts:820) so hosts don't recompute. Data is already there.

**Global cursor id is sufficient** — the audit confirms `WHERE run_id=? AND id>?` is
correct; we do not need openclaw's per-run `seq` counter (that's for their multi-store
world). Keep it lean.

**Codex corrections folded in:** (a) token deltas are ephemeral, never persisted
(events.ts:65) — a SQL poll can't return them anyway, so coarse filtering matters on
**SSE**, not the poll. (b) the poll needs a bounded `LIMIT` + a returned cursor, not an
unbounded array. (c) explicit contract: `since` present ⇒ JSON poll, absent ⇒ SSE. (d)
`opts.db` is optional in `createServer` (server.ts:83) — poll requires it or 501s. (e)
inherits S1's gate.

**Accounting (codex P1 nuance):** our main-loop accounting is ALREADY correct in the
openclaw-bug sense — `model.call` records only the served call (run.ts:812), and
`addUsage`/`run.finished` accumulate run totals *intentionally* (run.ts:236,1142). So
"snapshot cost, never `+=`" applies **only to per-call events**, not run totals (which
must accumulate). The one real inconsistency to note: `run.finished` fires before
background reflection, which later adds its cost to `runs.usage` (reflect.ts:166) — the
terminal event and the eventual DB total can disagree. Document it; optionally emit a
`usage.updated` event post-reflection. Add a regression pinning per-call `model.call`
usage to the served call only.

**Test:** poll returns only this run's events after a cursor, bounded + cursor returned,
in id order; coarse mode (SSE) excludes deltas; cache_hit_pct present on model.call;
per-call usage regression; S1 gate enforced on the poll.

---

### S3 — A2 suspend-safe resume (P0 latency)

**Problem (audit A2.3):** the lease heartbeat (index.ts:222-228) exits the daemon
when `renewLease` fails. After a Fly suspend across a wall-clock jump, the lease's
`expires_at` is in the past, renew's `WHERE expires_at > now()` guard fails, and the
daemon does `shutdown(1, false)` — exit **without releasing** — which Fly's restart
cap turns into a minutes-long stall. The irony: the next boot's `acquireLease` would
immediately reclaim (same `holder_id` branch, lease.ts:41). The exit is gratuitous.

**Fix (one line of intent):** renew-or-reacquire.
```
if (renewLease(db, holder, ttl) || acquireLease(db, holder, ttl)) return; // stay up
console.error("delta: write lease held by a different live holder — exiting");
shutdown(1, false);
```
`acquireLease`'s `expires_at <= now OR holder_id = me` predicate (lease.ts:41)
succeeds whenever the lease is unheld, expired, or still ours — i.e. exactly the
suspend-across-TTL case — and refreshes it atomically. We exit only on genuine
split-brain (a *different* live holder owns a non-expired lease), which is the only
case worth dying for. No schema change, no monotonic clock (a wall-clock jump is
indistinguishable from real elapsed time, and reclaim-own-lease is correct either way
because the lease is machine-scoped).

**Framing (codex P1):** this is **recovery, not fencing**. Keep it — it fixes the
target latency failure — but do not overclaim split-brain protection. The lease is
unfenced (a stale daemon can write after expiry before its heartbeat notices,
lease.ts:10), resume ordering doesn't guarantee the heartbeat runs before resumed
tool callbacks, and two live daemons with the *same* holder id both pass the same-holder
branch (lease.ts:13; only the port bind protects same-machine duplicates). Distinct-holder
reacquire IS atomically exclusive (SQLite serializes the upsert; the second contender
changes 0 rows), so two *distinct* daemons can't both hold it — that's the guarantee we
claim, no more.

**Clock fix (both paths):** BOTH `acquireLease` (lease.ts:26) and `renewLease`
(lease.ts:58) sample `Date.now()` *before* write admission. Sample after `BEGIN
IMMEDIATE` in both so neither commits an already-expired lease. (v1 mentioned only
acquire.)

**Test:** injected-`now()` suspend sim — advance past TTL, fire heartbeat, assert the
daemon reclaims and stays up; two connections with **distinct** holders → exclusive (one
wins); a **duplicate-holder** negative test documenting the known same-id limitation; a
genuine foreign non-expired holder → exit. Extend lease.test.ts + resume.test.ts.

---

### S4 — A12 `delta bundle apply` (P1, net-new)

**Problem (audit A12.1):** write-if-absent seeding correctly protects DELTA.md but
also freezes the FIXED files (POLICY.md, vocab.json, PROMPT_CONTEXT.md) after first
boot. Updating POLICY.md on a live machine is a fragile 5-step Fly dance.

**Build (codex-revised — manifest + all-or-nothing):**
- **New `src/bundle.ts` module** owning a single readonly **manifest**: `DELTA.md →
  DELTA_SELF_MD_B64 (self, write-if-absent only)`, `POLICY.md → DELTA_POLICY_MD_B64`,
  `vocab.json → DELTA_VOCAB_JSON_B64`, `PROMPT_CONTEXT.md → DELTA_CONTEXT_MD_B64`, each
  tagged `self | fixed`. This replaces the THREE current duplications of the fixed set
  (`FIXED_OPERATOR_FILES` private at builtins.ts:94, `SELF_FILE` at self.ts:21, the
  cockpit list at index.ts:309) — they all import the manifest. The "single source of
  truth" v1 claimed did not exist; this creates it (filename→env mapping, not just names).
- `cliBundle(argv, cfg)` in cli.ts, dispatched from index.ts after `loadConfig()`,
  `argv[0]==="apply"`: apply only the `fixed` manifest entries whose env is non-empty.
- **All-or-nothing:** decode + **validate every payload first**, then swap all. Validate
  = base64 decodes, `vocab.json` passes the real `parseVocab` schema (not just
  `JSON.parse` — `parseVocab` silently substitutes invalid fields, vocab.ts:63), and
  `POLICY.md` is within the boot size limit (policy.ts:36) so apply never installs a
  boot-looping policy. Any validation failure → apply nothing, non-zero exit, clear
  message. Only after all pass: atomic temp → `renameSync` each (per-file atomic; the
  pre-validation makes a mid-swap crash near-impossible, and a documented "re-run apply
  is idempotent" recovery contract covers the residual).
- **DELTA.md is never in the fixed set** — `manifest.fixed` excludes `self` by
  construction; assert it structurally.
- Wire `entrypoint.sh` to call `delta bundle apply` on boot when fixed B64 vars are
  present; DELTA.md stays on the write-if-absent `seed_ws_file` path. One mechanism,
  two entry points.

**Competitor validation (Area 5):** re-seed-not-hot-reload is unanimous across all
three harnesses — config/persona changes take effect next session, deliberately, to
protect the prompt cache. A12 is exactly this shape.

**DELTA.md tripwire (extend contracts.test.ts:122):** cliInit a temp dir → overwrite
DELTA.md with distinctive learned bytes → set POLICY/VOCAB B64 to new payloads AND set
`DELTA_SELF_MD_B64` to *different* bytes → run `cliBundle(["apply"], cfg)` → assert
(1) DELTA.md byte-identical to the learned bytes despite `DELTA_SELF_MD_B64` differing,
(2) POLICY.md/vocab.json now equal the new payloads, (3) structural:
`FIXED_OPERATOR_FILES.has("DELTA.md") === false`.

---

### S5a — Close the widen-authorization self-assertion hole (SECURITY, P0)

**Problem (codex P0):** the privacy boundary is weaker than v1 assumed. `reflect` reads
`metadata.review_kind` (reflect.ts:75) and `metadata.widen_authorized` (reflect.ts:188)
straight from the ordinary JSON request body — with **no proof a control plane or human
supplied them**. A caller can POST `review_kind=submission_disposition` +
`widen_authorized=true` and a model-proposed audience escapes user scope (reflect.ts:195).
This is a live hole today, independent of any new feature.

**Fix:** externally-supplied `review_kind` / `widen_authorized` must carry **verified
trusted provenance** or be rejected. The daemon only honors them from an authenticated
trusted path (the same trust-boundary work as S1 — a review disposition is a
control-plane action, not an arbitrary caller field). A plain task-creation body cannot
set them. Default: ignore/strip them from untrusted bodies.

**Test (mutation-tested):** a task body asserting `widen_authorized=true` from an
untrusted caller does NOT widen; the authenticated control-plane path still can.

---

### S5b — Memory isolation + determinism hardening (P1)

Three cheap fixes the audit surfaced, corrected by codex:
1. **Retrieval determinism (codex P2).** Scoring already happens *before* the
   `hits`/`last_used` bump (memory.ts:327 before :351), so "snapshotting" is a no-op —
   v1 was wrong. To actually make repeated identical queries stable, **remove `hits`
   from the ranking inputs** (or define a stable snapshot epoch) **and add an `id`
   tie-breaker**. Add a reproducibility test. Document that capability-store ordering is
   the store's property.
2. **Close the `agent_id=''` bleed (memory.ts:301).** The anonymous bucket surfaces to
   every agent on a shared DB — a real multi-tenant leak that contradicts "isolation
   fully shipped." Gate `OR agent_id=''` behind an explicit single-agent/dev flag.
3. **Scope-symmetry parity test.** Symmetry (namespace, user_id, task_type) is proven
   only end-to-end today. Add a focused parity test so a refactor can't silently
   reintroduce the asymmetry class (the 3 silent-recall bugs).

---

### S5c — Inline-clarify → authorization (Aperture A13) — **DEFERRED**

**Why deferred (codex P0):** the Aperture A13 idea — "the human's inline clarify answer
IS the authorization" — cannot be done safely as a quick field. Codex is right: any
answer to a *model-authored* question is unsafe to treat as consent (a model can ask an
innocuous question and request an `org` audience), and there is no `awaitingInput` /
trusted-resume provenance in the runtime today (only generic `previous_response_id`,
run.ts:158). A correct design needs a real protocol: a **server-generated opaque
challenge** bound to {session, user, origin run, exact target audience, candidate
content}, an **explicit human approval action** (not "a human sent a message"),
one-time consumption + expiry, stored **outside** model-visible request metadata. Plus a
provenance-semantics fix (inline clarify is `source="self"`; widening requires
`source="review"`, reflect.ts:204 — so stamping alone does nothing, and reclassifying as
`review` would wrongly grant the review confidence floor).

That is its own spec, not a 0.2.4 slice. **S5a closes the urgent hole now; S5c gets a
dedicated design doc + threat model next.** Recorded so it isn't lost.

**Competitor validation (Area 2):** openclaw's Dreaming ≈ our stage-then-promote;
hermes's frozen-snapshot ≈ our DELTA.md. Architecture confirmed.

---

### S6 — Context: research subagents genuinely read-only (correctness/safety)

**Problem (audit context §4):** the "read-only research subagent" is a misnomer. A
research child inherits the parent's full rights minus the delegation/scheduling trio
(research.ts:2-9) — so it can `write_file`, `remember`, and do MCP writes. The v4 plan
scoped these to read-only (context-management-plan.md:128-133) but that hardening was
deferred, not implemented. A research child can mutate the shared workspace and
self-file mid-run.

**Fix (codex-corrected — positive admission, not a denylist):** a name blocklist is
insufficient — it still admits `move_file`/`delete_file` (builtins.ts:409), `code`
(arbitrary workspace writes, builtins.ts:680), any *future* mutation tool (childTools is
a name blocklist, research.ts:81), and MCP tools misclassified by name regex (mcp.ts:270;
even an MCP "read" can write image bytes to `.delta/media`, mcp.ts:298). Instead:
- Add a **positive effect marker** to `ToolDef` (e.g. `effect: "read" | "mutate"`),
  **defaulting unknown/unmarked tools to `mutate`** (fail closed).
- Mark the genuinely read-only builtins (`read_file`, `grep`, `recall`, knowledge reads)
  as `read`; everything else stays `mutate` by default.
- Research children **admit only `effect: "read"` tools.** MCP tools honor the standard
  read-only annotation where present, else default to `mutate` (fail closed).
- Remove `writeSelf` from the child context (research.ts:296).

This is a small, general, correct primitive — and it makes "which tools can a restricted
child use" answerable by construction rather than by an ever-growing blocklist.

**Competitor validation (Area 1):** hermes's `delegate_tool.py` restricts child
capabilities; MAX_DEPTH=1; parent sees only the child's summary. The shape is right; the
effect-marker makes it fail-closed where a blocklist fails-open.

**Scope honesty (codex):** the deferred per-session spill read-isolation means children
are made non-mutating but **not tenant-private** (a child can still *read* other runs'
spills). Do NOT label S6 "research isolation" — it is "research children can't mutate."
Spill read-isolation stays a documented follow-up.

**Test:** a research child is denied `write_file`/`remember`/`move_file`/`delete_file`/
`code`; an unmarked/new tool is denied by default; a `read`-marked tool works and the
child returns its summary; parent window sees only the ≤1.2k summary + path.

---

### S7 — Efficiency: provider-usage-anchored token estimate (crown jewel)

**Problem (audit context §a.3):** the pre-send compaction gate estimates tokens as
bytes/3 + overhead (`estimateTokens`, run.ts:54). High-entropy text undercounts; the
gross `lastInputTokens` backstop then triggers a *post-call* compaction — one wasted
frontier call before it self-corrects.

**Fix (codex-revised — a second signal, not a replacement):** v1's "trust last
assistant `usage.totalTokens` + char/4 the tail" doesn't map onto Delta — `AssistantMsg`
has **no usage field** (provider.ts:19), per-run usage is accumulated (can't identify the
last call), and `char/4` *undercounts* adversarial high-entropy tails (approaching 1
token/char) worse than the current bytes rule. Instead, use the already-persisted
**`runs.last_input`** (the provider's real gross input from the prior call) as an anchor
and take the max of both signals:
```
estimate = max( existing_byte_estimate,  runs.last_input + conservativeTailDelta )
```
where `conservativeTailDelta` bounds the new messages since that call by the existing
(conservative) byte rule. Keep the byte estimate as the floor so we never estimate
*lower* than today. This turns today's post-call gross backstop into a **pre-send**
signal without a tokenizer, new schema, or per-message usage plumbing.

**Why it fits Delta:** smarter (anchored on provider truth we already store), simpler (no
tokenizer, reuses `runs.last_input`), safer (never below the current floor), more
efficient (compacts before the overflow call, not one call late). Note the caveats codex
raised — the prior input includes the old system prompt / tool schemas that can change
(e.g. after `search_tools`) and a failover can switch tokenizers — which is exactly why
it's a `max()` second signal, not the sole estimate.

**Test:** high-entropy ASCII + Unicode + large tool-JSON tails do not estimate *below*
the byte floor; a crafted long-context session fires the pre-send gate **before** the
overflow call where 0.2.3 fires the gross backstop post-call; assert compaction fires
before the configured safety boundary (not a fragile "tight band" assertion).

---

## Explicitly DEFERRED (kept lean — candidates, not 0.2.4)

Recorded so they aren't lost, but out of scope to protect the release:
- **Tool-output demotion pass** (hermes) — demote old tool results to one-liners
  outside the tail. Our compaction tail already handles this; an ADD, defer.
- **Anti-thrash compaction breaker** (hermes) — stop auto-compacting after 2 sub-10%
  reclaims, surface `ineffective`. Nice safety; defer unless trivial.
- **Model-driven memory consolidation** (hermes) — reject over-budget DELTA.md writes
  with an inline "consolidate then retry" instruction instead of cap-eviction. Elegant;
  a behavior change to the `remember` tool; defer to its own slice.
- **Pre-compaction memory-flush turn** (openclaw/hermes) — a silent persist turn before
  compaction. Our artifact ledger already prevents losing successful results; defer.
- **Hash-memoized stable prompt prefix** (openclaw) — memoize the invariant prompt zone
  by `hash(identity+policy+tools+vocab)`. Verify whether our spine is already
  byte-stable end-to-end (if so, the provider already caches it and this is only a CPU
  micro-opt). Investigate; likely defer.
- **Async research handles / `POST /v1/tasks` for subagents** — documented v4 deferral.
- **Cron via a lease table** — real v2 gap, but not an Aperture 0.2.4 ask. Out of scope.

---

## Sequencing & validation

**Build order (revised):** start with the isolated, fully-specified slices, then the
security boundary, then what depends on it:
S3 (lease, tiny) → S6 (effect marker) → S7 (token estimate) → S4 (bundle module) →
**S1 (identity boundary, P0)** → S5a (widen-auth hole, rides S1's trust work) → S2 (poll,
depends on S1) → S5b (memory hardening). **S5c deferred** to its own spec.
Each slice independently shippable, tested, and codex-reviewed before the next. S1 + S5a
(the two security slices) get a dedicated codex pass before they land.

**Test philosophy (Nic's standing rules):**
- Unit + regression per slice; mutation-test the security/invariant guards (S1, S4).
- **Old-vs-new on ambitious real agent tasks** across **three providers**: OpenRouter,
  Codex subscription, and native Anthropic. A hard, long, multi-tool task that
  exercises compaction, recall, research, and memory — run on 0.2.3 vs 0.2.4, compare
  correctness, cost, cache warmth, and whether the pre-send gate fires pre-call (S7).
- Full suite green (548 baseline + new) + tsc + biome clean before release.

**Release:** tag-driven (push `v0.2.4` → release.yml → npm/ghcr/binaries), then guide +
changelog + site, per the release ceremony. **Public tag only on explicit Nic
go-ahead** — this plan covers spec/build/test, not the autonomous publish.

## Field-report / audit traceability

| Slice | Source | Kind |
|---|---|---|
| S1 | Audit A1.2 + codex P0 (new find) | Security |
| S2 | Aperture A1 | Observability |
| S3 | Aperture A2 | Latency/recovery |
| S4 | Aperture A12 | DX/ops |
| S5a | codex P0 (existing hole) | Security |
| S5b | Memory audit | Isolation/determinism |
| S5c | Aperture A13 | Feature — **DEFERRED** (needs protocol) |
| S6 | Context audit + hermes delegate | Correctness/safety |
| S7 | Context audit + pi compaction | Efficiency |
