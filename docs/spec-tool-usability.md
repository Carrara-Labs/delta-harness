# Spec: a tool that cannot work must not be silently offered

Status: **spec v1, pre-implementation.** D-3 + D-2 of `docs/backlog-delos-field-report.md`. Batch:
`harness-0.2.15-plan.md`, item 3. **The report's proposed D-2 fix is rejected here** — §3 shows it
would break a feature we shipped in Connect 0.4.3.

## 1. The defect, in two halves

`DELTA_ALLOWED_TOOLS` is a **ceiling, not a guarantee.** Registration has preconditions that fail
silently, and no surface reports the outcome.

| tool | gate | site | today |
|---|---|---|---|
| `schedule_self`, `list_schedules`, `cancel_schedule` | `cfg.controlUrl && cfg.controlToken` | `builtins.ts:1012` | **silent** |
| `code` | `codeAvailable` — env set *and* binary resolvable | `builtins.ts:798` | warns on stderr |
| `web_search` | credential resolved **at call time** | `builtins.ts:284` | **silent until it costs money** |
| `research`, `spawn_subagent` | register fine, then fail 100% on a Codex backend | D-12 | **silent** |

Delos configured 16 tools and had 13. Nothing said so: not the daemon, not the logs, and not
`/v1/status`, which reports version, agent id, profile, safe mode, model, budget, MCP servers, vault
and self-file fullness (`server.ts:443-472`) — and no tool list.

The report's claim that *nothing* warned is slightly too strong: `code` does warn
(`builtins.ts:795-798`), and that warning is the precedent this spec generalises. The genuinely silent
gates are the three scheduling tools and `web_search`.

### 1.1 What the silence costs

`web_search` with no `EXA_API_KEY` errors only when called, and **the model does not stop when a tool
errors — it routes around it.** Delos, one Telegram message: the agent brute-forced `web_fetch` at
GitHub's API and raw forum HTML, six to eight in parallel per turn, pulling whole Discourse threads in
as unstripped JSON. **74 tool calls and 724,804 input tokens.** The same question with the key: 8 steps,
37 tool calls, 350k tokens, zero compactions, right answer.

One absent environment variable cost roughly 2× the tokens and the correctness of the reply.

## 2. What `/v1/status` gains

Follow the shape the endpoint already established for `vault` and `self`, both of which are read
**live** rather than from the boot snapshot, with comments saying why (`server.ts:456-470`): a secret
provided a minute ago must be visible, and a per-run number would otherwise report the seed forever.
Tool usability has the same property, for the same reason.

```json
"tools": {
  "registered": ["read_file", "write_file", "web_search", "web_fetch", "..."],
  "unusable": [{ "name": "web_search", "reason": "no EXA_API_KEY in the environment or the vault" }],
  "omitted":  [{ "name": "schedule_self", "reason": "no controlUrl/controlToken — not CP-wired" },
               { "name": "code", "reason": "CLI 'codex exec …' not found on PATH" }]
}
```

Three lists because there are three states, and collapsing them loses the operator's next action:

- **registered** — offered to the model this run.
- **unusable** — registered, but a live precondition says a call will fail now. May become usable
  without a restart. *Check the credential, or hand it to the agent.*
- **omitted** — never registered this run, and only a restart changes that. *Fix the config and
  restart.*

Names and reasons only. No values, no key fragments, no probe requests — the endpoint is documented as
a data-free read sourced from the allowlisted boot-config view, and that must hold.

## 3. Why the report's D-2 fix is rejected

The report offers two options and prefers the first: *"either do not register a credential-gated tool
whose credential is absent, or emit a loud startup warning."* It then generalises to *"a tool that
cannot work should not be registered."*

**De-registration would break the vault.** `credentialFor` (`builtins.ts:61-72`) resolves from the
environment **or the encrypted vault**, on every call, deliberately — the comment at `builtins.ts:282`
says a key handed to the agent at runtime works immediately. That is not incidental: it is the whole
point of the secure in-chat intake shipped in Harness 0.2.10 + Connect 0.4.3, where "the agent is told
when a credential lands (no restart, and no more routing around a tool that started working)" was a
release headline.

The evidence is on the box. Ferni's `EXA_API_KEY` lives in its vault — the single entry — and:

| outcome | first seen | last seen |
|---|---|---|
| missing-credential error | 2026-07-28 | 2026-08-01 |
| successful search | 2026-07-30 | 2026-08-13 |

The errors stop the day the key lands. Under the proposed fix, that agent would have had `web_search`
de-registered at boot and would have needed a restart to see a key it had just been handed — turning a
self-healing configuration gap into an operator ticket. It also falsifies the report's supporting claim
of "zero successful Exa calls" on Ferni.

**So the principle ships with one word changed:**

> A tool that cannot function in the current configuration must not be **silently** offered, and where
> that cannot be determined at boot, the daemon must say so loudly at startup.

"Registered" → "silently offered". D-12 is then the other kind of case entirely: there, the tool
genuinely *cannot* become usable at runtime, and the fix is to make the provider call work
(`spec-codex-output-cap.md`), not to hide the tool.

## 4. The fix

### 4.1 Report omissions out of `builtinTools`

`builtinTools(cfg: BuiltinConfig): Tools` where `Tools = Map<string, ToolDef>` (`tools.ts:132`), and it
has **exactly one caller** (`index.ts:46`). A callback would keep the signature; with one caller the
honest return shape is cheap, so take it:

```ts
export type ToolRegistration = {
  tools: Tools;
  omitted: Array<{ name: string; reason: string }>;
};
export function builtinTools(cfg: BuiltinConfig): ToolRegistration
```

Every existing `if (gate) add({...})` gains an `else omitted.push({ name, reason })`. Mechanical, and
the compiler finds anything missed.

### 4.2 A live usability predicate

Only credential-gated tools need one. Add an optional field to `ToolDef`:

```ts
/** Live precondition check for a tool that is registered but may not be callable right now.
 * Must be pure and local: no network, no probe request. Absent → assumed usable. */
usable?: () => { ok: true } | { ok: false; reason: string };
```

For `web_search`:

```ts
usable: () => credentialFor("EXA_API_KEY", cfg.exaKey, cfg.vault)
  ? { ok: true }
  : { ok: false, reason: "no EXA_API_KEY in the environment or the vault" },
```

That is the same expression the tool already evaluates at call time, so the status answer and the call
outcome cannot disagree. Keep the call-time check exactly as it is — this is a report, not a gate.

**The contract is deliberately not credential-specific.** `reason` is free text and `usable()` may
encode any live precondition — a missing credential today, a provider that rejects a required
parameter tomorrow. See §7.4 for why that generality is worth stating and why we are still not
building a provider predicate in this release.

### 4.3 One startup line

After registration, mirroring the existing `code` warning:

```
delta: 13 of 16 configured tools registered. Omitted: schedule_self, list_schedules, cancel_schedule
  (no controlUrl/controlToken). Registered but not usable now: web_search (no EXA_API_KEY in the
  environment or the vault).
```

One line, on stderr, only when something is omitted or unusable. A clean boot stays silent.

## 5. What must not change

1. **No de-registration.** §3. The allowlist still governs what may be offered; a missing credential
   never removes a tool.
2. **No behaviour change at call time.** `web_search` still returns its `[tool error]` string when the
   key is absent. Error-as-value is unaffected.
3. **No network I/O in `usable()`.** A probe would make `/v1/status` slow, failable, and billable.
4. **`/v1/status` stays data-free.** Names and reasons; reasons are engine-authored constants, never
   interpolated secret material.
5. **The seam token still gates it** — it is a `/v1/*` route (`server.ts:436`).

## 6. The test that fails without the fix

`test/status.tools.test.ts`, booting a daemon with no `EXA_API_KEY`, no vault entry, no
`controlUrl`/`controlToken`, and a bogus `DELTA_CODE_CLI`:

1. `GET /v1/status` → `tools.registered` **includes** `web_search`.
2. `tools.unusable` contains `web_search` with a non-empty reason.
3. `tools.omitted` contains all three schedule tools **and** `code`, each with a reason.
4. `registered.length + omitted.length` equals the configured allowlist size.
5. Then insert `EXA_API_KEY` into the vault and re-`GET` **without restarting**:
   `tools.unusable` no longer contains `web_search`. This is the assertion that locks §3 — it fails
   under the report's proposed fix, which is the point.
6. No response field anywhere in the payload contains the key's value.

Pre-fix, 1–5 all fail because the field does not exist. Verify that before keeping the test.

## 7. For the reviewer

1. **Return shape vs callback.** Spec takes the return shape on the strength of "one caller". Confirm
   `index.ts:46` really is the only one, including tests.
2. **Should `unusable` tools be de-pinned rather than de-registered?** A middle option nobody proposed:
   keep the schema resident but drop it from the pinned set so it costs no prompt tokens until
   `search_tools` surfaces it. Interacts with the 0.2.13 "keep a quarantined tool's schema resident"
   item. Probably a separate change; say if you disagree.
3. **Is one startup line enough for an unattended agent?** Nobody reads stderr on a Hetzner box at 3am.
   The counter-argument is that `/v1/status` is the surface an operator or a supervising agent can
   actually poll, and that is the half of this change that scales. If you want a periodic re-warn, note
   that a timer in the daemon is forbidden by `CLAUDE.md` ("budgets, not timers") — it would have to
   ride a turn.
4. **D-12's tools — answer revised by the reporter, 2026-08-17.** The original recommendation was
   *no*: once `spec-codex-output-cap.md` lands the condition disappears, so a provider predicate on
   `research`/`spawn_subagent` would be dead code by design. Delos's answer supplies the argument
   against that reading. Their operator **kept both tools in the allowlist after seeing them fail
   100% of the time** — 24 child starts and 24 failures on one run — rather than reconfigure twice
   and lose the delegation surface again on the day D-12 lands. Their conclusion, which is correct:
   *"a deployment will happily keep paying for a broken tool rather than reconfigure twice, which is
   an argument for your startup warning covering provider-incompatible tools and not only
   credential-less ones."*

   The recommendation stands at *no predicate for these two specific tools* — after D-12 they work,
   and inventing a mechanism for a class with zero remaining members is how speculative surface
   area gets built. What changes is §4.2: the `usable()` contract is **explicitly not
   credential-specific**, its `reason` is free text, and the guide must say a provider
   incompatibility is a legitimate reason. That costs nothing today and gives the next instance
   somewhere to go instead of a redesign.

## 8. Review outcome — Codex pass, 2026-08-19 (pre-implementation)

1. **§7.1 decided: keep `builtinTools(): Tools`.** "Exactly one caller" was false counting tests —
   25 test invocations use Map methods directly. Omissions are collected via an optional
   `onOmit?: (name: string, reason: string) => void` parameter; §4.1's return-shape change is dead.
2. **The gate table missed four:** `list_secrets` (no vault, `builtins.ts:750`);
   `research`/`spawn_subagent`/`eval_n` (suppressed at `subagentDepth ≥ 1`, `builtins.ts:882` —
   report in the child's status, but do NOT stderr-warn in every child process); skill-registry
   tools stripped post-registration (`index.ts:339`); failed MCP registration. Also: an allowlist
   name that matches nothing deserves an "unknown tool in DELTA_ALLOWED_TOOLS" omission entry.
3. **`/v1/status` reads the LIVE registry** (`deps.tools`), not the boot snapshot — MCP reconnects
   after credential intake mutate it (`index.ts:371-379`).
4. §6.4's `registered + omitted === allowlist` assertion is unsatisfiable from `builtinTools`
   alone (profile intersection, MCP, skills all interpose) — assert the specific expected tools
   per list instead.
5. "Registered = offered to the model this run" is imprecise: residency/pinning and breaker
   quarantine narrow what a given run sees. Status reports the daemon's allowed registry; the
   guide says so.
