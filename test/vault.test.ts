import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import {
  redactSecretValues,
  registerSecretValue,
  resetSecretRegistry,
  scrubText,
} from "../src/scrub";
import { declaredNames, expandRefs, hasRef, MissingSecret, Vault } from "../src/vault";

// A deliberately low-entropy, obviously-synthetic fixture: a high-entropy literal here trips
// the repo's secret scanner, and a test key should read as a test key.
const KEY = ["delta", "test", "vault", "key", "not", "a", "real", "credential"].join("-");
// NB: takes the key positionally with no default — a default would swallow an explicit
// `undefined` and silently test the configured-key path instead of the unconfigured one.
const open = (key: string | undefined, safeMode = false) =>
  Vault.open(openDb(":memory:"), key, safeMode);

afterEach(() => resetSecretRegistry());

describe("vault storage", () => {
  test("roundtrips a value through AES-256-GCM", () => {
    const v = open(KEY) as Vault;
    expect(v.put("EXA_API_KEY", "sk-live-abc123", "web search")).toEqual({ ok: true });
    expect(v.resolve("EXA_API_KEY")).toBe("sk-live-abc123");
  });

  test("ciphertext on disk is not the plaintext (and each write uses a fresh nonce)", () => {
    const db = openDb(":memory:");
    const v = Vault.open(db, KEY) as Vault;
    v.put("A_KEY", "the-secret-value");
    v.put("B_KEY", "the-secret-value"); // same value, different row
    const rows = db.query("SELECT name, value_enc FROM vault ORDER BY name").all() as {
      name: string;
      value_enc: Uint8Array;
    }[];
    for (const r of rows) {
      const blob = Buffer.from(r.value_enc).toString("utf8");
      expect(blob).not.toContain("the-secret-value");
    }
    // Identical plaintexts must NOT produce identical ciphertext — that would leak equality.
    expect(Buffer.from(rows[0]?.value_enc as Uint8Array).toString("hex")).not.toBe(
      Buffer.from(rows[1]?.value_enc as Uint8Array).toString("hex"),
    );
  });

  test("a wrong key cannot decrypt (fails closed, never returns garbage)", () => {
    const db = openDb(":memory:");
    (Vault.open(db, KEY) as Vault).put("K", "value-under-key-one");
    const other = Vault.open(db, "a-completely-different-key-here") as Vault;
    expect(() => other.resolve("K")).toThrow(MissingSecret);
  });

  test("a tampered blob fails closed (GCM tag)", () => {
    const db = openDb(":memory:");
    const v = Vault.open(db, KEY) as Vault;
    v.put("K", "value-to-tamper-with");
    const row = db.query("SELECT value_enc FROM vault WHERE name = 'K'").get() as {
      value_enc: Uint8Array;
    };
    const blob = Buffer.from(row.value_enc);
    blob[blob.length - 1] = (blob[blob.length - 1] as number) ^ 0xff;
    db.query("UPDATE vault SET value_enc = ? WHERE name = 'K'").run(blob);
    expect(() => v.resolve("K")).toThrow(MissingSecret);
  });

  test("create-only by default; explicit replace rotates", () => {
    const v = open(KEY) as Vault;
    v.put("K", "first-value");
    const second = v.put("K", "attacker-value");
    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(v.resolve("K")).toBe("first-value"); // NOT swapped
    expect(v.put("K", "rotated-value", "", true)).toEqual({ ok: true });
    expect(v.resolve("K")).toBe("rotated-value");
  });

  test("rejects bad names, empty values, oversize values, and control characters", () => {
    const v = open(KEY) as Vault;
    for (const bad of ["lowercase", "../escape", "9LEADING", "WITH-DASH", ""])
      expect(v.put(bad, "x-value-long")).toMatchObject({ ok: false, status: 400 });
    expect(v.put("K", "")).toMatchObject({ ok: false, status: 400 });
    expect(v.put("K", `header\r\ninjection`)).toMatchObject({ ok: false, status: 400 });
    expect(v.put("K", "x".repeat(5000))).toMatchObject({ ok: false, status: 413 });
  });

  test("list returns metadata and NEVER a value", () => {
    const v = open(KEY) as Vault;
    v.put("EXA_API_KEY", "sk-super-secret-value", "web search");
    const rows = v.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("EXA_API_KEY");
    expect(rows[0]?.purpose).toBe("web search");
    expect(JSON.stringify(rows)).not.toContain("sk-super-secret-value");
  });

  test("delete removes it; resolving a missing name throws with the NAME only", () => {
    const v = open(KEY) as Vault;
    v.put("K", "some-value-here");
    expect(v.delete("K")).toBe(true);
    expect(v.delete("K")).toBe(false);
    try {
      v.resolve("K");
      throw new Error("should have thrown");
    } catch (e) {
      expect(String(e)).toContain("K");
      expect(String(e)).not.toContain("some-value-here");
    }
  });
});

describe("vault enablement (fail-safe)", () => {
  test("no key → no vault", () => {
    expect(open(undefined)).toBeNull();
  });
  test("a too-short key is refused rather than used weakly", () => {
    expect(open("short")).toBeNull();
  });
  test("safe mode has no vault even with a key", () => {
    expect(open(KEY, true)).toBeNull();
  });
});

describe("{{vault:NAME}} refs", () => {
  test("expands at egress and leaves other text alone", () => {
    const v = open(KEY) as Vault;
    v.put("TOKEN", "abc123secret");
    expect(expandRefs("Bearer {{vault:TOKEN}}", v)).toBe("Bearer abc123secret");
    expect(expandRefs("no refs here", v)).toBe("no refs here");
  });

  test("a missing name throws naming the REF, never a value", () => {
    const v = open(KEY) as Vault;
    expect(() => expandRefs("Bearer {{vault:ABSENT}}", v)).toThrow(/ABSENT/);
  });

  test("with no vault a ref fails closed rather than sending an empty credential", () => {
    expect(() => expandRefs("Bearer {{vault:TOKEN}}", null)).toThrow(/DELTA_VAULT_KEY/);
    // and a multi-ref string expands every ref, not just the first (global-regex sanity)
  });

  test("hasRef detects refs without resolving (and is not stateful across calls)", () => {
    expect(hasRef("x {{vault:A}} y")).toBe(true);
    expect(hasRef("x {{vault:A}} y")).toBe(true); // lastIndex must not leak between calls
    expect(hasRef("plain")).toBe(false);
  });

  test("declaredNames finds every ref an operator wired, at any config depth", () => {
    const servers = [
      {
        name: "kb",
        transport: "http",
        url: "https://kb",
        headers: { authorization: "Bearer {{vault:KB_TOKEN}}" },
      },
      { name: "cli", transport: "stdio", command: ["x"], env: { API: "{{vault:CLI_KEY}}" } },
    ];
    expect(declaredNames(servers, ["EXA_API_KEY"])).toEqual(["CLI_KEY", "EXA_API_KEY", "KB_TOKEN"]);
  });
});

describe("exact-value redaction", () => {
  test("resolution registers the value; later echoes are replaced by name", () => {
    const v = open(KEY) as Vault;
    v.put("KB_TOKEN", "tok-abcdef123456");
    expect(redactSecretValues("saw tok-abcdef123456 here")).toBe("saw tok-abcdef123456 here");
    v.resolve("KB_TOKEN"); // egress
    expect(redactSecretValues("401: bad token tok-abcdef123456")).toBe(
      "401: bad token [vault:KB_TOKEN]",
    );
  });

  test("percent-encoded and JSON-escaped surface forms are caught too", () => {
    const v = open(KEY) as Vault;
    const value = 'tok/with+special"chars';
    v.put("K", value);
    v.resolve("K");
    expect(redactSecretValues(encodeURIComponent(value))).toBe("[vault:K]");
    expect(redactSecretValues(JSON.stringify(value).slice(1, -1))).toBe("[vault:K]");
  });

  test("scrubText applies the registry as well as the shape patterns", () => {
    const v = open(KEY) as Vault;
    v.put("CUSTOM", "zzz-not-a-known-shape-9999");
    v.resolve("CUSTOM");
    const out = scrubText("key zzz-not-a-known-shape-9999 and sk-abcdefghijklmnopqrst");
    expect(out).toContain("[vault:CUSTOM]");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("zzz-not-a-known-shape-9999");
  });

  test("the store refuses a value too short to be redactable (no storable-but-unscrubbed gap)", () => {
    const v = open(KEY) as Vault;
    // The redaction floor and the store's minimum are deliberately aligned: if a value could
    // be stored but not registered, a reflection of it would reach the model unscrubbed.
    expect(v.put("TINY", "abc")).toMatchObject({ ok: false, status: 400 });
    expect(v.put("TINY", "abcdefgh")).toEqual({ ok: true });
    v.resolve("TINY");
    expect(redactSecretValues("value abcdefgh here")).toBe("value [vault:TINY] here");
  });

  test("regex metacharacters in a value are escaped, not interpreted", () => {
    const v = open(KEY) as Vault;
    v.put("K", "a.b*c+d(e)");
    v.resolve("K");
    expect(redactSecretValues("value a.b*c+d(e) here")).toBe("value [vault:K] here");
    expect(redactSecretValues("axbxcxdxe")).toBe("axbxcxdxe"); // not treated as a pattern
  });
});

describe("key sourcing", () => {
  test("DELTA_VAULT_KEY_FILE wins over the inline env var (it keeps the key out of the process env block)", () => {
    const path = join(tmpdir(), `delta-vault-key-${process.pid}`);
    writeFileSync(path, `${KEY}\n`); // trailing newline is the normal `echo >` case
    const cfg = loadConfig({
      DELTA_VAULT_KEY_FILE: path,
      DELTA_VAULT_KEY: "inline-key-should-lose",
    });
    expect(cfg.vaultKey).toBe(KEY);
    rmSync(path);
  });

  test("a configured but unreadable key file fails closed rather than falling back", () => {
    const cfg = loadConfig({
      DELTA_VAULT_KEY_FILE: join(tmpdir(), "definitely-not-here"),
      DELTA_VAULT_KEY: "inline-key-must-not-rescue-it",
    });
    expect(cfg.vaultKey).toBeUndefined();
  });

  test("safe mode carries no vault key at all", () => {
    expect(loadConfig({ DELTA_SAFE_MODE: "1", DELTA_VAULT_KEY: KEY }).vaultKey).toBeUndefined();
  });
});

describe("expandRefs is stateless across calls", () => {
  test("repeated calls and multi-ref strings both expand fully", () => {
    const v = open(KEY) as Vault;
    v.put("A_TOKEN", "value-alpha-1234");
    v.put("B_TOKEN", "value-bravo-5678");
    const s = "a={{vault:A_TOKEN}} b={{vault:B_TOKEN}}";
    // Same input twice must give the same output — a stateful lastIndex would break the second.
    expect(expandRefs(s, v)).toBe("a=value-alpha-1234 b=value-bravo-5678");
    expect(expandRefs(s, v)).toBe("a=value-alpha-1234 b=value-bravo-5678");
  });
});

describe("redaction registry under pressure", () => {
  test("a secret still in use survives eviction; a long-idle one may be dropped", () => {
    const v = open(KEY) as Vault;
    v.put("ACTIVE", "active-secret-value-aaaa");
    v.put("IDLE", "idle-secret-value-bbbb");
    v.resolve("IDLE"); // registered first, then never used again
    v.resolve("ACTIVE");
    // Churn well past the cap with distinct throwaway values, re-resolving ACTIVE
    // throughout — the way a real deployment re-resolves on every egress.
    for (let i = 0; i < 300; i++) {
      registerSecretValue(`FILLER_${i}`, `filler-value-number-${i}-padding`);
      if (i % 3 === 0) v.resolve("ACTIVE");
    }
    expect(redactSecretValues("saw active-secret-value-aaaa")).toBe("saw [vault:ACTIVE]");
  });

  test("the matcher picks up a newly registered secret immediately", () => {
    const v = open(KEY) as Vault;
    v.put("FIRST", "first-secret-value-1234");
    v.resolve("FIRST");
    expect(redactSecretValues("first-secret-value-1234")).toBe("[vault:FIRST]");
    v.put("SECOND", "second-secret-value-5678");
    v.resolve("SECOND");
    expect(redactSecretValues("second-secret-value-5678")).toBe("[vault:SECOND]");
    expect(redactSecretValues("first-secret-value-1234")).toBe("[vault:FIRST]");
  });

  test("overlapping values redact longest-first, so no fragment survives", () => {
    const v = open(KEY) as Vault;
    v.put("SHORT", "abc123456");
    v.put("LONG", "abc123456-with-more-tail");
    v.resolve("SHORT");
    v.resolve("LONG");
    expect(redactSecretValues("abc123456-with-more-tail")).toBe("[vault:LONG]");
  });
});

describe("codex-caught hardening", () => {
  test("ciphertext cannot be moved between names (the name is authenticated data)", () => {
    const db = openDb(":memory:");
    const v = Vault.open(db, KEY) as Vault;
    v.put("STAGING_KEY", "staging-value-1234");
    v.put("PROD_KEY", "prod-value-5678");
    // Swap the stored blob: without name-binding this would silently resolve the staging
    // credential under the production name and send it to the production destination.
    const staging = db.query("SELECT value_enc FROM vault WHERE name='STAGING_KEY'").get() as {
      value_enc: Uint8Array;
    };
    db.query("UPDATE vault SET value_enc = ? WHERE name = 'PROD_KEY'").run(staging.value_enc);
    expect(() => v.resolve("PROD_KEY")).toThrow(MissingSecret);
  });

  test("a purpose containing the value is refused", () => {
    const v = open(KEY) as Vault;
    expect(v.put("K", "the-secret-value", "for the-secret-value backend")).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});
