// Local diagnostic-state retention: events, journal and the `calls` capture must stay bounded
// regardless of telemetry — the exact hole a telemetry-less daemon (every `delta dev` agent) would
// otherwise grow without limit. events/journal are bounded by age + row count; `calls` by age +
// BYTES, because captured-call size varies ~7x between lanes.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { pruneLocalState } from "../src/retention";

const NOW = 1_800_000_000_000; // fixed clock (Date.now is real in the daemon; tests pass it in)
const DAY = 24 * 3_600_000;

/** Minimal parent rows so the journal FK (run_id → runs → sessions) is satisfiable. */
function seedRun(db: Database): string {
  db.query("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s1', ?, ?)").run(NOW, NOW);
  db.query(
    "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r1','s1',1,'done','{}',?)",
  ).run(NOW);
  return "r1";
}
function addEvent(db: Database, ts: number): void {
  db.query("INSERT INTO events (ts, type, data) VALUES (?, 'x', '{}')").run(ts);
}
function addJournal(db: Database, run: string, call: string, createdAt: number): void {
  db.query(
    "INSERT INTO journal (run_id, call_id, tool, args, status, created_at) VALUES (?,?, 'write_file','{}','done',?)",
  ).run(run, call, createdAt);
}
/** One captured call of a given payload size. `bytes` is split across request+response, which is
 *  how the byte budget measures them. */
function addCall(db: Database, run: string, turn: number, bytes: number, createdAt: number): void {
  const half = "x".repeat(Math.max(1, Math.floor(bytes / 2)));
  db.query(
    "INSERT INTO calls (run_id, turn, request, response, created_at) VALUES (?,?,?,?,?)",
  ).run(run, turn, half, half, createdAt);
}
const count = (db: Database, t: string): number =>
  (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const callBytes = (db: Database): number =>
  (
    db.query("SELECT COALESCE(SUM(LENGTH(request)+LENGTH(response)),0) AS b FROM calls").get() as {
      b: number;
    }
  ).b;

describe("pruneLocalState", () => {
  test("drops events + journal older than the age cutoff (telemetry off)", () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    addEvent(db, NOW - 10 * DAY); // stale
    addEvent(db, NOW - 1 * DAY); // fresh
    addJournal(db, run, "c-old", NOW - 10 * DAY); // stale
    addJournal(db, run, "c-new", NOW - 1 * DAY); // fresh

    const deleted = pruneLocalState(db, {
      now: NOW,
      retentionMs: 7 * DAY,
      maxEvents: 1000,
      maxJournal: 1000,
      maxCallBytes: 1 << 30, // effectively unbounded: these cases are about events + journal
      telemetryActive: false,
    });

    expect(deleted).toBe(2);
    expect(count(db, "events")).toBe(1); // only the fresh event survives
    expect(count(db, "journal")).toBe(1); // only the fresh journal row survives
    db.close();
  });

  test("row-count cap keeps the NEWEST N (not just N of them) when all rows are fresh", () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    // events: insert 10, ascending ts (id is monotonic → later inserts are "newest").
    for (let i = 0; i < 10; i++) addEvent(db, NOW - (10 - i)); // i=9 is the newest (ts closest to NOW)
    // journal: created_at ascending with i, so c9 is the newest.
    for (let i = 0; i < 10; i++) addJournal(db, run, `c${i}`, NOW - (10 - i));

    pruneLocalState(db, {
      now: NOW,
      retentionMs: 365 * DAY, // age never trips — the count cap must
      maxEvents: 3,
      maxJournal: 4,
      maxCallBytes: 1 << 30, // effectively unbounded: these cases are about events + journal
      telemetryActive: false,
    });

    expect(count(db, "events")).toBe(3);
    expect(count(db, "journal")).toBe(4);
    // The survivors must be the newest — assert by the highest event ids and journal timestamps.
    const evTs = db.query("SELECT ts FROM events ORDER BY id").all() as { ts: number }[];
    expect(evTs.map((r) => r.ts)).toEqual([NOW - 3, NOW - 2, NOW - 1]); // the 3 most recent
    const jrTs = db.query("SELECT created_at AS t FROM journal ORDER BY t").all() as {
      t: number;
    }[];
    expect(jrTs.map((r) => r.t)).toEqual([NOW - 4, NOW - 3, NOW - 2, NOW - 1]); // the 4 most recent
    db.close();
  });

  test("telemetry ON: the events count-cap is SKIPPED (Exporter owns it); journal still bounded", () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    // Seed MORE than maxEvents so a count-cap, if it ran, WOULD delete — proving it's skipped.
    for (let i = 0; i < 5; i++) addEvent(db, NOW - 30 * DAY); // ancient + over-cap, all un-shipped
    addJournal(db, run, "c-old", NOW - 30 * DAY);

    const deleted = pruneLocalState(db, {
      now: NOW,
      retentionMs: 7 * DAY,
      maxEvents: 2, // 5 > 2: a live cap would drop 3 — it must not
      maxJournal: 1000,
      maxCallBytes: 1 << 30, // effectively unbounded: these cases are about events + journal
      telemetryActive: true,
    });

    expect(deleted).toBe(1); // only the journal row
    expect(count(db, "events")).toBe(5); // ALL events survive — the Exporter owns them
    expect(count(db, "journal")).toBe(0); // journal is always swept
    db.close();
  });

  test("a clean DB prunes nothing (idempotent, no throw)", () => {
    const db = openDb(":memory:");
    seedRun(db);
    const deleted = pruneLocalState(db, {
      now: NOW,
      retentionMs: 7 * DAY,
      maxEvents: 50_000,
      maxJournal: 50_000,
      maxCallBytes: 1 << 30, // effectively unbounded: these cases are about events + journal
      telemetryActive: false,
    });
    expect(deleted).toBe(0);
    db.close();
  });

  // `calls` (DELTA_CAPTURE_CALLS) was bounded by NOTHING before 0.2.14 — only deleting a session
  // cleared it. Measured on a live agent: 174 rows, 16.5MB, 45% of the database file, from a flag
  // staged as temporary and never pulled. Bounded by BYTES because a captured call is ~95KB on one
  // lane and ~700KB on another, so no single row count serves both.
  test("calls: the byte budget keeps the NEWEST calls that fit", () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    for (let i = 0; i < 10; i++) addCall(db, run, i, 1000, NOW - (10 - i)); // ~1000B each, i=9 newest

    pruneLocalState(db, {
      now: NOW,
      retentionMs: 365 * DAY, // age never trips — the byte budget must
      maxEvents: 1000,
      maxJournal: 1000,
      maxCallBytes: 3000,
      telemetryActive: false,
    });

    expect(callBytes(db)).toBeLessThanOrEqual(3000);
    // The survivors are the NEWEST turns, not an arbitrary three.
    const turns = db.query("SELECT turn FROM calls ORDER BY turn").all() as { turn: number }[];
    expect(turns.map((r) => r.turn)).toEqual([7, 8, 9]);
    db.close();
  });

  test("calls: overshoot is bounded to ONE call (a row is judged on what is NEWER than it)", () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    for (let i = 0; i < 5; i++) addCall(db, run, i, 1000, NOW - (5 - i));

    pruneLocalState(db, {
      now: NOW,
      retentionMs: 365 * DAY,
      maxEvents: 1000,
      maxJournal: 1000,
      maxCallBytes: 1500, // between one and two calls
      telemetryActive: false,
    });

    // The newest is always kept; the next one back sees only 1000B newer than it, which is under
    // 1500, so it survives too. Retained = 2000B against a 1500B budget: over, by one call, by
    // design. Assert the bound is ONE call rather than unbounded.
    expect(callBytes(db)).toBeLessThanOrEqual(1500 + 1000);
    expect(count(db, "calls")).toBe(2);
    db.close();
  });

  test("calls: a single call larger than the whole budget is still kept", () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    addCall(db, run, 1, 1000, NOW - 2);
    addCall(db, run, 2, 100_000, NOW - 1); // newest, and alone exceeds the budget

    pruneLocalState(db, {
      now: NOW,
      retentionMs: 365 * DAY,
      maxEvents: 1000,
      maxJournal: 1000,
      maxCallBytes: 5000,
      telemetryActive: false,
    });

    // A bound that empties the table would make the capture useless exactly where it is needed
    // most — the lane with enormous requests.
    const turns = db.query("SELECT turn FROM calls").all() as { turn: number }[];
    expect(turns.map((r) => r.turn)).toEqual([2]);
    db.close();
  });

  test("calls: the age cutoff applies too, and telemetry does not exempt them", () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    addCall(db, run, 1, 100, NOW - 10 * DAY); // stale
    addCall(db, run, 2, 100, NOW - 1 * DAY); // fresh

    const deleted = pruneLocalState(db, {
      now: NOW,
      retentionMs: 7 * DAY,
      maxEvents: 1000,
      maxJournal: 1000,
      maxCallBytes: 1 << 30, // budget never trips — the age cutoff must
      telemetryActive: true, // `calls` is never shipped anywhere, so telemetry is irrelevant
    });

    expect(deleted).toBe(1);
    expect(count(db, "calls")).toBe(1);
    db.close();
  });
});
