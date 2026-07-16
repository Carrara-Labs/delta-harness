// Local diagnostic-state retention: events + journal must stay bounded by age AND count
// regardless of telemetry — the exact hole a telemetry-less daemon (every `delta dev`
// agent) would otherwise grow without limit.

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
const count = (db: Database, t: string): number =>
  (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

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
      telemetryActive: false,
    });
    expect(deleted).toBe(0);
    db.close();
  });
});
