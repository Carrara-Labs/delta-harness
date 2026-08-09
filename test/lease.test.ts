import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { MIGRATIONS, openDb } from "../src/db";
import { acquireLease, releaseLease, renewLease } from "../src/lease";

type LeaseRow = {
  holder_id: string;
  acquired_at: number;
  expires_at: number;
  heartbeat_at: number;
};

function row(db: Database): LeaseRow {
  return db
    .query("SELECT holder_id, acquired_at, expires_at, heartbeat_at FROM lease WHERE name='writer'")
    .get() as LeaseRow;
}

describe("writer lease", () => {
  test("acquires fresh, rejects a live peer, and permits an expired takeover", () => {
    const db = openDb(":memory:");
    let time = 1_000;
    const now = () => time;

    expect(acquireLease(db, "first", 100, now)).toBe(true);
    time = 1_099;
    // A same-holder reacquire REFRESHES the TTL (the crash-restart path): expiry moves
    // from 1_100 to now+ttl = 1_199. This is what lets a restarted daemon reclaim its
    // own lease with a fresh lease rather than inheriting the crashed one's stale expiry.
    expect(acquireLease(db, "first", 100, now)).toBe(true);
    expect(row(db).expires_at).toBe(1_199);
    expect(acquireLease(db, "second", 100, now)).toBe(false); // live peer rejected
    expect(row(db).holder_id).toBe("first");

    time = 1_199; // now the lease has expired → a different holder may take over
    expect(acquireLease(db, "second", 100, now)).toBe(true);
    expect(row(db)).toEqual({
      holder_id: "second",
      acquired_at: 1_199,
      expires_at: 1_299,
      heartbeat_at: 1_199,
    });
    db.close();
  });

  test("renews only for the owner and rejects the old owner after a steal", () => {
    const db = openDb(":memory:");
    let time = 1_000;
    const now = () => time;

    expect(acquireLease(db, "first", 100, now)).toBe(true);
    time = 1_050;
    expect(renewLease(db, "first", 100, now)).toBe(true);
    expect(row(db)).toEqual({
      holder_id: "first",
      acquired_at: 1_000,
      expires_at: 1_150,
      heartbeat_at: 1_050,
    });
    expect(renewLease(db, "second", 100, now)).toBe(false);

    time = 1_150;
    expect(renewLease(db, "first", 100, now)).toBe(false);
    expect(acquireLease(db, "second", 100, now)).toBe(true);
    time = 1_160;
    expect(renewLease(db, "first", 100, now)).toBe(false);
    expect(row(db).holder_id).toBe("second");
    db.close();
  });

  test("release is owner-guarded and permits immediate handoff", () => {
    const db = openDb(":memory:");
    const now = () => 1_000;

    expect(acquireLease(db, "first", 100, now)).toBe(true);
    releaseLease(db, "second");
    expect(acquireLease(db, "second", 100, now)).toBe(false);

    releaseLease(db, "first");
    expect(acquireLease(db, "second", 100, now)).toBe(true);
    db.close();
  });

  test("fails closed when the database cannot prove ownership", () => {
    const db = openDb(":memory:");
    db.close();
    expect(acquireLease(db, "first", 100)).toBe(false);
    expect(renewLease(db, "first", 100)).toBe(false);
    expect(() => releaseLease(db, "first")).not.toThrow();
  });
});

describe("writer lease — suspend/resume recovery (S3)", () => {
  // The heartbeat (index.ts) decision, modeled directly: renew, else reacquire our own
  // machine-scoped lease. Recovery, not fencing.
  const renewOrReacquire = (db: Database, holder: string, ttl: number, now: () => number) =>
    renewLease(db, holder, ttl, now) || acquireLease(db, holder, ttl, now);

  test("a suspend past the TTL is recovered: renew fails, reacquire (own holder) succeeds", () => {
    const db = openDb(":memory:");
    let time = 1_000;
    const now = () => time;

    expect(acquireLease(db, "me", 100, now)).toBe(true); // expires 1_100
    time = 5_000; // VM frozen across a wall-clock jump — the interval never fired

    expect(renewLease(db, "me", 100, now)).toBe(false); // lapsed → renew can't
    expect(renewOrReacquire(db, "me", 100, now)).toBe(true); // but we reclaim our own lease
    expect(row(db)).toEqual({
      holder_id: "me",
      acquired_at: 5_000,
      expires_at: 5_100,
      heartbeat_at: 5_000,
    });
    db.close();
  });

  test("split-brain: a different live holder took the lease during suspend → we exit", () => {
    const db = openDb(":memory:");
    let time = 1_000;
    const now = () => time;

    expect(acquireLease(db, "me", 100, now)).toBe(true);
    time = 5_000; // suspended long past expiry
    expect(acquireLease(db, "peer", 100, now)).toBe(true); // a peer legitimately took over

    time = 5_010; // we wake; peer's lease (expires 5_100) is still live
    expect(renewOrReacquire(db, "me", 100, now)).toBe(false); // → heartbeat exits
    expect(row(db).holder_id).toBe("peer");
    db.close();
  });

  test("distinct daemons cannot both reacquire one expired lease (SQLite serializes)", () => {
    const db = openDb(":memory:");
    let time = 1_000;
    const now = () => time;

    expect(acquireLease(db, "old", 100, now)).toBe(true);
    time = 9_000; // "old" long gone; its lease expired at 1_100
    expect(acquireLease(db, "A", 100, now)).toBe(true); // first contender wins
    expect(acquireLease(db, "B", 100, now)).toBe(false); // A is now live → B loses
    expect(row(db).holder_id).toBe("A");
    db.close();
  });

  test("documented limitation: a DUPLICATE holder id across machines both reacquire", () => {
    // The accepted bound (lease.ts header): DELTA_LEASE_HOLDER must be unique per machine.
    // Two daemons sharing an id both match the same-holder branch — this is why the default
    // holder is FLY_MACHINE_ID/hostname, and same-machine double-start is caught by the port
    // bind instead. This test pins the limitation so a future change is a conscious one.
    const db = openDb(":memory:");
    let time = 1_000;
    const now = () => time;

    expect(acquireLease(db, "dup", 100, now)).toBe(true);
    time = 9_000;
    expect(acquireLease(db, "dup", 100, now)).toBe(true); // machine 1 reacquires
    expect(acquireLease(db, "dup", 100, now)).toBe(true); // machine 2, same id, also "succeeds"
    db.close();
  });
});

describe("lease migration", () => {
  const path = join(tmpdir(), `delta-lease-${process.pid}-${Math.floor(performance.now())}.db`);

  afterEach(() => {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) rmSync(file);
  });

  test("applies cleanly to the complete pre-lease schema", () => {
    const prior = openDb(path);
    // A true "version 9" schema predates the lease (index 9), `calls` capture (index 10),
    // `self_revisions` (index 11), `thread_state` (index 12) and `vault` (index 13)
    // migrations — drop all five, then re-open replays them.
    prior.exec(
      "DROP TABLE calls; DROP TABLE lease; DROP TABLE self_revisions; DROP TABLE thread_state; DROP TABLE vault; PRAGMA user_version = 9",
    );
    prior.close();

    const db = openDb(path);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'lease'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'calls'").get()).toBeTruthy();
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name = 'self_revisions'").get(),
    ).toBeTruthy();
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name = 'thread_state'").get(),
    ).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'vault'").get()).toBeTruthy();
    // Pinned to the migration COUNT, not a literal: this assertion is about "every migration
    // replayed", and hard-coding the number makes every future migration look like a failure.
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      MIGRATIONS.length,
    );
    db.close();
  });
});

describe("lease config", () => {
  test("defaults to 30s and clamps the configured TTL to 5s", () => {
    expect(loadConfig({}).leaseTtlMs).toBe(30_000);
    expect(loadConfig({ DELTA_LEASE_TTL_MS: "1" }).leaseTtlMs).toBe(5_000);
    expect(loadConfig({ DELTA_LEASE_TTL_MS: "invalid" }).leaseTtlMs).toBe(30_000);
  });
});
