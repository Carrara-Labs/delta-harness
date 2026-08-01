# Harness 0.2.10 — The Secret Vault

Status: DRAFT for codex review · security-critical release, ships alone (no bundling)
Pairs with: Connect 0.4.0 (secure secret intake) — the edge that writes this vault.

## Intent

An agent doing real work needs third-party credentials (an Exa key, a client's API key,
a bearer for an MCP backend). Today those arrive operator-side as env vars at deploy
time. The vault lets a credential arrive AT RUNTIME (from Connect's secure intake, or an
operator curl) and be USED by the agent's tools — under one invariant:

> **A secret value never enters model-readable state.**

The model sees a secret's NAME, PURPOSE, and configured-ness. Values are captured at the
door, stored encrypted outside the workspace, referenced by name, injected at egress in
engine code, and no tool returns a value. Redaction of accidental echoes is
defense-in-depth on top, not the invariant itself.

**What beats OpenClaw (verified against their live code, codex-researched 2026-08-01):**

- Their stores are ALL plaintext and agent-readable by default: inline config in
  `openclaw.json`, dotenv fallback, file refs, auth profiles as plain JSON strings in
  sqlite — `tools.fs.workspaceOnly` defaults to FALSE, the read tool takes absolute
  paths, and their own doctor warns agents can read the config. `0600` protects against
  other OS users, not the model-driven process. Their 1Password agent tool even RETURNS
  `{value}` to the model turn. Our store: encrypted at rest in the daemon DB (outside
  the workspace, unreachable by the confined file tools), key held only in the daemon's
  env — denylisted from every model-directed child — and NO route or tool ever returns
  a value.
- They materialize resolved plaintext into a runtime config object, then need a
  process-local AES-GCM *sentinel* layer (`oc-sent-v2…`) to keep it out of transports —
  and codex found that layer isn't scope-bound (`resolveSecretSentinel` enforces no
  expected label; a holder can direct a sentinel to any public origin). We skip the
  whole sentinel apparatus: config never holds a resolved value — a `{{vault:NAME}}`
  ref stays a NAME until the destination transport dereferences it at the socket, and
  every destination is operator-configured (never model-writable). Structural scope
  binding, zero extra machinery.
- We borrow their one proven mechanism — exact-value redaction registered at resolution
  time (raw + percent-encoded + JSON-escaped forms, min 6 chars, longest-first) — in
  ~40 lean lines instead of a 42k-line module.

## Non-goals (deferred, earn-it)

- Self-wiring MCP / the agent choosing where a secret goes (H0.3.0 frontier).
- Vault-refs for the PRIMARY provider key (operator/env domain; unchanged).
- Generic "attach secret X to this web_fetch" (free-form egress = exfiltration surface).
- External vault backends (1Password/exec) — the encrypted local store is the product.

## Design

### 1. Store — `src/vault.ts` (new, ~120 lines)

- SQLite table in the DAEMON DB (`DELTA_DB`, e.g. `/data/delta.db` — outside the
  workspace, unreachable by workspace-confined file tools):

```sql
CREATE TABLE vault (
  name       TEXT PRIMARY KEY,       -- ^[A-Z][A-Z0-9_]{0,63}$ (env-var shape)
  purpose    TEXT NOT NULL DEFAULT '',
  value_enc  BLOB NOT NULL,          -- 12B iv || 16B GCM tag || ciphertext
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

- AES-256-GCM via `node:crypto` (zero new deps). Key = SHA-256 of `DELTA_VAULT_KEY`
  (any string ≥ 16 chars; operators generate with `openssl rand -base64 32`).
- **No `DELTA_VAULT_KEY` → vault OFF, fail-safe**: loud boot log, HTTP surface 503s,
  no model tool registered. Never a plaintext fallback.
- Safe mode: vault surfaces off (like every non-floor capability).
- `DELTA_VAULT_KEY` joins `CHILD_ENV_SECRET_DENYLIST` — no model-directed child
  (code CLI, subagent) ever inherits it.
- **Fix folded in (found during spec work):** the stdio MCP transport currently spawns
  its child with `{...process.env, ...env}` (mcp.ts) — FULL daemon env inheritance,
  which would hand the vault key (and today already hands broker/control/telemetry
  tokens) to any configured stdio MCP server process. Change to the same default-deny
  posture: safe process plumbing + the server's own configured `env` block only.

### 2. HTTP surface — the seam (control-token authed, same bearer as `/v1/*`)

- `PUT /v1/secrets/:name` body `{value, purpose?}` → `{ok, name}`. Upsert. The value
  field is read and encrypted; it is never logged, never echoed, never emitted as an
  event payload (the event records the name only).
- `DELETE /v1/secrets/:name` → `{ok}`.
- `GET /v1/secrets` → `{secrets: [{name, purpose, created_at, updated_at}]}` — no values.
- No `GET /v1/secrets/:name` — there is deliberately NO read-back route. Nothing
  returns a value; a lost value is re-entered, not recovered.

### 3. Model surface — one read-only tool

- `list_secrets` (registered only when the vault is enabled + not safe mode):
  returns `NAME — purpose (configured <date>)` lines, or `(vault is empty)`.
- The agent REQUESTS a secret conversationally; the edge (Connect 0.4.0) owns the
  secure intake UX. The harness ships the store + use; the doorway is Connect's.

### 4. Egress injection — engine code only

- **MCP `{{vault:NAME}}` placeholders** in `DELTA_MCP_SERVERS` http `headers` values and
  stdio `env` values. Resolved at egress time (http: per-call in `buildHeaders`; stdio:
  at child spawn), so a secret set AFTER boot lights the backend up without restart.
  Unresolvable name → the call fails with a clean error naming the placeholder (never
  the value); the config itself keeps holding only the name.
- **Builtin light-up**: `web_search` resolves `cfg.exaKey ?? vault("EXA_API_KEY")` at
  call time. Hand your agent an Exa key in chat → search works on the next turn, no
  redeploy. (The value goes only to the hardcoded `api.exa.ai` — no model-directed URL.)
- Injection is always into OPERATOR-configured destinations (MCP config is env-owned;
  `.env*` is already write-fenced from the model). The model can name WHICH secret only
  where config already says `{{vault:NAME}}` — it can never choose WHERE a value goes.

### 5. Redaction — defense-in-depth for echoes

- `src/scrub.ts` grows a bounded registry (name → surface forms: raw, `encodeURIComponent`,
  JSON-escaped; min length 6, matching OpenClaw's proven floor). Values are registered when
  RESOLVED for injection (not at rest — an unused secret has no echo to catch).
- `redactVault(text)` replaces any registered form with `[vault:NAME]`.
- Hooks:
  - `execCall` (run.ts): the ONE tool-result choke point — redact the raw result BEFORE
    breaker classification, capAndSpill (so spill files are clean), journal, message
    insert, and the telemetry error snippet. Every tool's echo is covered in one line.
  - `scrubText` callers (server read surfaces) get the registry pass folded in.
- KNOWN LIMIT (named, like the childEnv residuals): redaction is best-effort against
  TRANSFORMED echoes (base64 of a value, a hash). The invariant holds because no tool
  returns a value in the first place; redaction only mops up reflections (e.g. an MCP
  server echoing an auth header inside a 4xx body).

### 6. Observability without values

- `devConfigView`: `vault: {enabled, secrets: [names]}` + `DELTA_VAULT_KEY` presence
  in `secrets_present`.
- Events: `vault.set` / `vault.delete` / `vault.resolve` with `{name}` only.
- `/v1/status`: `vault: {enabled, count}`.

### 7. Named residuals (accepted, documented)

- A same-UID process (the code CLI is "run arbitrary code" by design) can in principle
  read the daemon's env via OS introspection. That is the OS/microVM isolation layer,
  same class as the existing HOME residual — one agent per VM is the boundary. Still
  strictly stronger than OpenClaw: their store is plaintext-readable with `cat`; ours
  requires active process-memory attack.
- A secret injected into a configured MCP server goes wherever THAT server's
  operator-set URL points. Operator config is trusted; it is not model-writable.

## Tests (contract-grade)

- Crypto roundtrip + wrong-key fails closed + malformed blob fails closed.
- Name validation rejects traversal/garbage; upsert updates purpose + value.
- HTTP: auth required; PUT/DELETE/GET shapes; **no response body on ANY route ever
  contains a stored value** (fuzz all routes with a sentinel value).
- `list_secrets` output contains names, never values; absent when vault off/safe mode.
- Injection: http header + stdio env placeholder resolution; unresolved → clean error
  naming the ref; resolution registers redaction forms.
- Redaction: raw/percent/JSON forms replaced in tool results + spill + error snippet.
- `childEnv`: DELTA_VAULT_KEY denied to both child kinds (extend the existing guard test).
- Vault-off daemon: 503 surface, no tool, boots clean (fail-safe proof).

## Rollout

- Additive + opt-in ⇒ MINOR per the guard-tested semver policy → **0.2.10**.
- Ferni: set `DELTA_VAULT_KEY` Fly secret at upgrade; POLICY.md seed gains a line about
  requesting secrets by name/purpose (full intake UX lands with Connect 0.4.0).
