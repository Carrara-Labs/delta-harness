// SPDX-License-Identifier: Apache-2.0
// The Secret Vault (0.2.10). ONE invariant: a secret value never enters model-readable
// state. Values are captured at the door (the seam), stored encrypted in the DAEMON db
// (outside the model-writable workspace, so the confined file tools cannot reach the
// ciphertext at all), referenced BY NAME in config, and dereferenced only in engine code
// at the moment of egress. No route and no tool ever returns a value.
//
// Deliberately NOT a sentinel/placeholder-swap layer (OpenClaw's `oc-sent-v2…`): config
// holds a NAME until the destination transport resolves it, so scope is structural — the
// only destinations are operator-configured ones. Nothing to bind, nothing to forge.

import type { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { registerSecretValue } from "./scrub";

/** Env-var shape: what an operator writes in a config placeholder. */
export const VAULT_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** `{{vault:NAME}}` — the only way a secret is referenced anywhere in config. */
export const VAULT_REF_RE = /\{\{vault:([A-Z][A-Z0-9_]{0,63})\}\}/g;
/** A key shorter than this is a typo, not a key. Fail loudly rather than encrypt weakly. */
const MIN_KEY_CHARS = 16;
const MAX_VALUE_BYTES = 4096;

export type SecretMeta = { name: string; purpose: string; created_at: number; updated_at: number };

/** Thrown by `resolve` when a referenced name has no stored value. Carries the NAME only —
 *  every error message in this module is value-free by construction. */
export class MissingSecret extends Error {
  constructor(readonly name: string) {
    super(`no secret named ${name} is in the vault — ask your operator to provide it`);
  }
}

/**
 * The store. Absent `DELTA_VAULT_KEY` there is NO vault: `open` returns null, the HTTP
 * surface 503s, the tool isn't registered, and refs fail closed. There is deliberately no
 * plaintext fallback — a vault that silently degrades is worse than no vault.
 */
export class Vault {
  private constructor(
    private db: Database,
    private key: Buffer,
  ) {}

  /** Build a vault, or null when unconfigured/too-weak (both logged, both fail-safe). */
  static open(db: Database, rawKey: string | undefined, safeMode = false): Vault | null {
    if (safeMode) return null;
    if (!rawKey) return null;
    if (rawKey.length < MIN_KEY_CHARS) {
      console.error(
        `delta: DELTA_VAULT_KEY is only ${rawKey.length} chars (need ≥${MIN_KEY_CHARS}) — refusing to run a weakly-keyed vault. Generate one with: openssl rand -base64 32`,
      );
      return null;
    }
    const key = createHash("sha256").update(rawKey, "utf8").digest();
    const vault = new Vault(db, key);
    // Fail fast + LOUD on a changed key: every stored value is undecryptable, and finding that
    // out one-by-one at egress time (mid-task) is the worst place to learn it.
    const undecryptable = vault.list().filter((s) => vault.peek(s.name) === null);
    if (undecryptable.length > 0) {
      console.error(
        `delta: DELTA_VAULT_KEY does not decrypt ${undecryptable.length} stored secret(s) (${undecryptable.map((s) => s.name).join(", ")}) — the key changed. Restore the previous key, or delete and re-provide those secrets.`,
      );
    }
    return vault;
  }

  /** Metadata for every stored secret. Never a value. */
  list(): SecretMeta[] {
    return this.db
      .query("SELECT name, purpose, created_at, updated_at FROM vault ORDER BY name")
      .all() as SecretMeta[];
  }

  has(name: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM vault WHERE name = ?").get(name));
  }

  /**
   * Store a value. `replace` false (the intake default) REFUSES to overwrite an existing
   * name: a prompt-injected intake flow must not be able to silently swap an established
   * credential for an attacker's. Rotation is an explicit operator act.
   */
  put(
    name: string,
    value: string,
    purpose = "",
    replace = false,
  ): { ok: true } | { ok: false; error: string; status: number } {
    if (!VAULT_NAME_RE.test(name))
      return { ok: false, error: "name must match ^[A-Z][A-Z0-9_]{0,63}$", status: 400 };
    if (!value) return { ok: false, error: "value is empty", status: 400 };
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES)
      return { ok: false, error: `value exceeds ${MAX_VALUE_BYTES} bytes`, status: 413 };
    // A control char in a credential is either a paste artifact or a header-injection attempt;
    // both are worth refusing at the door rather than at egress. Checked by code point — a
    // literal control character inside a regex is its own hazard.
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c < 0x20 || c === 0x7f)
        return { ok: false, error: "value contains control characters", status: 400 };
    }
    if (purpose.length > 200) purpose = purpose.slice(0, 200);
    if (!replace && this.has(name))
      return { ok: false, error: `${name} already exists`, status: 409 };
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO vault (name, purpose, value_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET purpose = excluded.purpose, value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      )
      .run(name, purpose, this.seal(value), now, now);
    return { ok: true };
  }

  delete(name: string): boolean {
    return this.db.query("DELETE FROM vault WHERE name = ?").run(name).changes > 0;
  }

  /**
   * Dereference for EGRESS. This is the only path that produces a plaintext value, and every
   * caller is engine code writing it straight onto a wire. Resolution registers the value for
   * exact-value redaction, so any later reflection (an MCP server echoing its own auth header
   * inside a 4xx body) is scrubbed before it can reach the model.
   */
  resolve(name: string): string {
    const value = this.peek(name);
    if (value === null) throw new MissingSecret(name);
    registerSecretValue(name, value);
    return value;
  }

  /** Decrypt without registering — for boot verification only. null = undecryptable/absent. */
  private peek(name: string): string | null {
    const row = this.db.query("SELECT value_enc FROM vault WHERE name = ?").get(name) as {
      value_enc: Uint8Array;
    } | null;
    if (!row) return null;
    try {
      return this.unseal(Buffer.from(row.value_enc));
    } catch {
      return null;
    }
  }

  /** AES-256-GCM: 12B random iv ‖ 16B tag ‖ ciphertext. Fresh iv per write (never a counter). */
  private seal(value: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]);
  }

  private unseal(blob: Buffer): string {
    if (blob.length < 29) throw new Error("malformed vault blob");
    const d = createDecipheriv("aes-256-gcm", this.key, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
  }
}

/**
 * Expand `{{vault:NAME}}` refs in a config string. Engine-only: callers are the MCP header
 * builder and the stdio child-env builder, both of which write the result to a destination
 * the OPERATOR configured. A missing name throws (naming the ref, never a value) so the
 * backend fails with a clean, actionable error instead of authenticating as nobody.
 */
export function expandRefs(text: string, vault: Vault | null): string {
  // `replace` with a global regex manages (and resets) lastIndex itself. A `test()` fast-path
  // would NOT — it advances lastIndex and makes the function stateful across calls, which is a
  // real bug source for exactly zero gain on strings this short.
  return text.replace(VAULT_REF_RE, (_m, name: string) => {
    if (!vault)
      throw new Error(`{{vault:${name}}} needs a vault, but no DELTA_VAULT_KEY is configured`);
    return vault.resolve(name);
  });
}

/** Does this config string reference the vault at all? (Cheap pre-check; no resolution.) */
export function hasRef(text: string): boolean {
  return text.includes("{{vault:");
}

/**
 * Every name the CONFIG declares a destination for — the operator-sanctioned request set.
 * The edge (Connect) uses this to refuse a model-solicited secret whose name isn't wired to
 * anything: an injected agent can't invent `AWS_ROOT_KEY` and talk a human into pasting it.
 */
export function declaredNames(mcpServers: unknown[], extra: string[] = []): string[] {
  const names = new Set(extra);
  const scan = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(VAULT_REF_RE)) names.add(m[1] as string);
    } else if (Array.isArray(v)) for (const x of v) scan(x);
    else if (v && typeof v === "object") for (const x of Object.values(v)) scan(x);
  };
  scan(mcpServers);
  return [...names].sort();
}

/** Constant-time compare for the intake path (unused names must not be probeable by timing). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
