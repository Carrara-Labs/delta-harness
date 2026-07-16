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

export function scrubText(s: string): string {
  let out = s;
  for (const re of SECRET_TEXT) out = out.replace(re, "[redacted]");
  return out;
}
