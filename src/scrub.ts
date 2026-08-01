// SPDX-License-Identifier: Apache-2.0
// Free-text secret scrubbing — shared by the Cockpit read surface (server.ts) and the
// recall-provenance event (run.ts). The key-based redactor can't catch a secret that
// lands inside prose (a tool result, a recalled learning); these conservative shape
// patterns do. Kept deliberately narrow so ordinary text isn't mangled. This is a
// best-effort shape filter, NOT a guarantee that every possible secret is caught — the
// structural invariants (never returning the raw request, allowlisted config, sandboxed
// files) are what actually enforce "secrets stay hidden".
const SECRET_TEXT: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / OpenRouter-style keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, // Authorization: Bearer …
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT (classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub PAT (fine-grained)
  /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, // JWT
  /\bFlyV1 [A-Za-z0-9._/+-]{16,}/g, // Fly.io macaroon
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM
];

// ── exact-value redaction for resolved vault secrets (0.2.10) ───────────────────
// The shape patterns above can't know a custom credential's format. When the vault
// dereferences a secret for egress we register its EXACT value here, so any later
// reflection of it (an MCP backend echoing its own auth header inside a 4xx body, a
// child process printing its env) is replaced before it can reach the model or disk.
//
// This is CLEANUP, not the containment boundary — the invariant is that no tool returns
// a value in the first place (see vault.ts). Deliberately bounded and deliberately dumb:
// exact substrings, longest-first, plus the two encodings a value actually survives into
// (percent-encoded in a URL, JSON-escaped in a serialized payload). Same floor OpenClaw
// uses, in ~30 lines instead of a module.
const MIN_REDACTABLE = 6;
// Dimensioned far above any plausible vault (a real agent has a handful of credentials, each
// contributing at most three surface forms), so eviction is unreachable in practice; the LRU
// order below is the backstop, and re-registration on every egress keeps live secrets freshest.
const MAX_TRACKED = 4096;
/** surface form → the NAME it belongs to (so the replacement stays diagnosable). */
const registered = new Map<string, string>();
let matcher: RegExp | null = null;

export function registerSecretValue(name: string, value: string): void {
  if (value.length < MIN_REDACTABLE) return;
  for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) {
    if (form.length < MIN_REDACTABLE) continue;
    // Re-registering an already-known form still moves it to the freshest position: every
    // egress re-resolves, so the secrets actually in use are the ones that survive eviction.
    // Only a genuinely NEW key changes the key set, so only that invalidates the matcher.
    const known = registered.has(form);
    registered.delete(form);
    registered.set(form, name);
    if (!known) {
      if (registered.size > MAX_TRACKED) {
        const oldest = registered.keys().next().value;
        if (oldest !== undefined) registered.delete(oldest);
      }
      matcher = null;
    }
  }
}

/** Replace every registered secret value with `[vault:NAME]`. */
export function redactSecretValues(s: string): string {
  if (!s || registered.size === 0) return s;
  if (!matcher) {
    const forms = [...registered.keys()].sort((a, b) => b.length - a.length);
    matcher = new RegExp(forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  }
  matcher.lastIndex = 0;
  return s.replace(matcher, (m) => `[vault:${registered.get(m) ?? "secret"}]`);
}

/** Test-only: drop the registry so cases can't leak into each other. */
export function resetSecretRegistry(): void {
  registered.clear();
  matcher = null;
}

/** Shape patterns + exact registered vault values. One call for every read surface. */
export function scrubText(s: string): string {
  let out = redactSecretValues(s);
  for (const re of SECRET_TEXT) out = out.replace(re, "[redacted]");
  return out;
}
