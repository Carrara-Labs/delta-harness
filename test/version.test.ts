// Version identity + migration safety: the harness version is a single source of truth,
// every DB records the binary that opened it, reopening is idempotent, and a database
// migrated by a NEWER binary is REFUSED rather than silently corrupted (the downgrade
// guard the competitor harnesses lack).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { openDb } from "../src/db";
import { HARNESS_VERSION } from "../src/version";

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "delta-ver-"));
  return {
    path: join(dir, "delta.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("version identity", () => {
  test("HARNESS_VERSION is the single source of truth — package.json matches (no drift)", () => {
    expect(HARNESS_VERSION).toBe((pkg as { version: string }).version);
    expect(HARNESS_VERSION).toMatch(/^\d+\.\d+\.\d+/); // SemVer
  });
});

describe("openDb — stamping + idempotent reopen", () => {
  test("a fresh DB records the harness version and the applied schema version", () => {
    const { path, cleanup } = tmpDb();
    try {
      const db = openDb(path);
      const meta = Object.fromEntries(
        (db.query("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map(
          (r) => [r.key, r.value],
        ),
      );
      expect(meta.harness_version).toBe(HARNESS_VERSION);
      const applied = (db.query("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      expect(meta.schema_version).toBe(String(applied));
      expect(applied).toBeGreaterThan(0); // migrations ran
      db.close();
    } finally {
      cleanup();
    }
  });

  test("reopening an existing DB is idempotent — no re-migration, data preserved", () => {
    const { path, cleanup } = tmpDb();
    try {
      const a = openDb(path);
      const applied = (a.query("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      a.query("INSERT INTO meta (key, value) VALUES ('canary', 'kept')").run();
      a.close();

      const b = openDb(path); // second boot — same binary
      expect((b.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
        applied,
      );
      expect(
        (b.query("SELECT value FROM meta WHERE key='canary'").get() as { value: string }).value,
      ).toBe("kept");
      b.close();
    } finally {
      cleanup();
    }
  });
});

describe("downgrade guard", () => {
  test("a DB whose schema is NEWER than this binary is refused, not opened", () => {
    const { path, cleanup } = tmpDb();
    try {
      // Establish the real schema, then simulate a future binary having migrated further.
      const seed = openDb(path);
      const applied = (seed.query("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      seed.query("INSERT INTO meta (key, value) VALUES ('precious', 'do-not-lose')").run();
      seed.close();

      const raw = new Database(path);
      raw.exec(`PRAGMA user_version = ${applied + 5}`); // a newer binary's schema
      raw.close();

      // An older binary (this one) must REFUSE rather than operate an unknown schema.
      expect(() => openDb(path)).toThrow(/newer than this binary/i);
      // And it must not have mutated the state it refused to open.
      const check = new Database(path);
      expect(
        (check.query("SELECT value FROM meta WHERE key='precious'").get() as { value: string })
          .value,
      ).toBe("do-not-lose");
      check.close();
      expect(existsSync(path)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
