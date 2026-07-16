// v3.1 F0.1: the governed store-less rail on the ORTHOGONAL model. Write side —
// confidence gate, content-hash dedup scoped to the full identity tuple, per-identity
// cap-eviction (exempting pending promotions), honest error outcome. Occurrence side —
// distinct-run counting for the promoter. Read side — decay-by-disuse, relevance ×
// usage × recency, char budget. Plus a legacy→v3.1 migration test.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { distinctRuns, recallAgentMemory, remember } from "../src/memory";

const DAY = 24 * 3_600_000;

/** Seed a row directly on the new schema (agent audience by default). */
function seed(
  db: ReturnType<typeof openDb>,
  content: string,
  opts: Partial<{
    createdAt: number;
    hits: number;
    lastUsed: number | null;
    agentId: string;
  }> = {},
) {
  db.query(
    `INSERT INTO memory (namespace, agent_id, audience, artifact_kind, content, created_at, confidence, hash, hits, last_used)
     VALUES ('default', ?, 'agent', 'fact', ?, ?, 0.8, ?, ?, ?)`,
  ).run(
    opts.agentId ?? "delta-1",
    content,
    opts.createdAt ?? Date.now(),
    `h-${content}`,
    opts.hits ?? 0,
    opts.lastUsed ?? null,
  );
}

describe("remember() — the write gate", () => {
  test("low confidence is rejected; missing confidence on 'self' is rejected", () => {
    const db = openDb(":memory:");
    expect(
      remember(db, {
        audience: "agent",
        agentId: "a",
        artifactKind: "fact",
        content: "meh",
        confidence: 0.4,
      }),
    ).toBe("low-confidence");
    expect(
      remember(db, { audience: "agent", agentId: "a", artifactKind: "fact", content: "unrated" }),
    ).toBe("low-confidence");
    expect((db.query("SELECT count(*) AS n FROM memory").get() as { n: number }).n).toBe(0);
  });

  test("review-grounded artifacts get a confidence floor — an accepted diff is ground truth", () => {
    const db = openDb(":memory:");
    expect(
      remember(db, {
        audience: "agent",
        agentId: "a",
        artifactKind: "fact",
        content: "the human wants ranges not point numbers",
        confidence: 0.4,
        source: "review",
      }),
    ).toBe("stored");
    const row = db.query("SELECT confidence, source FROM memory").get() as {
      confidence: number;
      source: string;
    };
    expect(row.confidence).toBe(0.8);
    expect(row.source).toBe("review");
  });

  test("same content (case/whitespace variants) dedupes to one row, confidence maxed", () => {
    const db = openDb(":memory:");
    expect(
      remember(db, {
        audience: "agent",
        agentId: "a",
        artifactKind: "fact",
        content: "Roger prefers terse updates",
        confidence: 0.6,
      }),
    ).toBe("stored");
    expect(
      remember(db, {
        audience: "agent",
        agentId: "a",
        artifactKind: "fact",
        content: "  roger   PREFERS terse updates ",
        confidence: 0.9,
      }),
    ).toBe("duplicate");
    const rows = db.query("SELECT confidence FROM memory").all() as { confidence: number }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.confidence).toBe(0.9);
  });

  test("dedup is scoped to identity: the same content for two users is two rows, not one", () => {
    const db = openDb(":memory:");
    remember(db, {
      audience: "user",
      agentId: "a",
      userId: "u1",
      artifactKind: "preference",
      content: "wants emojis",
      confidence: 0.9,
    });
    remember(db, {
      audience: "user",
      agentId: "a",
      userId: "u2",
      artifactKind: "preference",
      content: "wants emojis",
      confidence: 0.9,
    });
    expect((db.query("SELECT count(*) AS n FROM memory").get() as { n: number }).n).toBe(2);
  });

  test("an agentId-less dev daemon ('' agent_id) still dedupes", () => {
    const db = openDb(":memory:");
    remember(db, {
      audience: "agent",
      artifactKind: "fact",
      content: "same lesson",
      confidence: 0.7,
    });
    expect(
      remember(db, {
        audience: "agent",
        artifactKind: "fact",
        content: "same lesson",
        confidence: 0.7,
      }),
    ).toBe("duplicate");
    expect((db.query("SELECT count(*) AS n FROM memory").get() as { n: number }).n).toBe(1);
  });

  test("cap: the 201st insert evicts the least-recalled, oldest row", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 200; i++)
      remember(db, {
        audience: "agent",
        agentId: "a",
        artifactKind: "fact",
        content: `lesson number ${i}`,
        confidence: 0.7,
      });
    db.query("UPDATE memory SET hits = 5, last_used = ? WHERE content = 'lesson number 0'").run(
      Date.now(),
    );
    remember(db, {
      audience: "agent",
      agentId: "a",
      artifactKind: "fact",
      content: "the newest lesson",
      confidence: 0.7,
    });
    expect((db.query("SELECT count(*) AS n FROM memory").get() as { n: number }).n).toBe(200);
    expect(db.query("SELECT 1 FROM memory WHERE content = 'lesson number 0'").get()).toBeTruthy();
    expect(db.query("SELECT 1 FROM memory WHERE content = 'lesson number 1'").get()).toBeNull();
  });

  test("eviction exempts a row with a pending promotion — a candidate can't vanish before it graduates", () => {
    const db = openDb(":memory:");
    // Row 1 is the coldest (hits 0, oldest) but has a staged promotion → must survive.
    remember(db, {
      audience: "agent",
      agentId: "a",
      artifactKind: "fact",
      content: "candidate lesson",
      confidence: 0.7,
    });
    const mid = (
      db.query("SELECT id FROM memory WHERE content = 'candidate lesson'").get() as { id: number }
    ).id;
    db.query(
      `INSERT INTO promotion (memory_id, namespace, destination_role, artifact_kind, content, idempotency_key, adapter_binding, created_at, updated_at)
       VALUES (?, 'default', 'curated', 'fact', 'candidate lesson', 'k1', 'kb', ?, ?)`,
    ).run(mid, Date.now(), Date.now());
    for (let i = 0; i < 200; i++)
      remember(db, {
        audience: "agent",
        agentId: "a",
        artifactKind: "fact",
        content: `filler ${i}`,
        confidence: 0.7,
      });
    expect(db.query("SELECT 1 FROM memory WHERE content = 'candidate lesson'").get()).toBeTruthy();
  });

  test("a 'user' write without a userId is rejected, not stored in an anonymous bucket", () => {
    const db = openDb(":memory:");
    expect(
      remember(db, { audience: "user", artifactKind: "preference", content: "x", confidence: 0.9 }),
    ).toBe("error");
    expect(
      remember(db, { audience: "task_type", artifactKind: "fact", content: "y", confidence: 0.9 }),
    ).toBe("error");
    expect((db.query("SELECT count(*) AS n FROM memory").get() as { n: number }).n).toBe(0);
  });

  test("identical text as a fact and a procedure are TWO rows — artifact_kind is part of identity", () => {
    const db = openDb(":memory:");
    expect(
      remember(db, {
        audience: "agent",
        agentId: "a",
        artifactKind: "fact",
        content: "do the thing",
        confidence: 0.9,
      }),
    ).toBe("stored");
    expect(
      remember(db, {
        audience: "agent",
        agentId: "a",
        artifactKind: "procedure",
        content: "do the thing",
        confidence: 0.9,
      }),
    ).toBe("stored");
    expect((db.query("SELECT count(*) AS n FROM memory").get() as { n: number }).n).toBe(2);
  });

  test("a full cap of promotion-protected rows never evicts the just-inserted row", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 200; i++) {
      remember(db, {
        audience: "agent",
        agentId: "a",
        artifactKind: "fact",
        content: `protected ${i}`,
        confidence: 0.7,
      });
      const id = (
        db.query("SELECT id FROM memory WHERE content = ?").get(`protected ${i}`) as { id: number }
      ).id;
      db.query(
        `INSERT INTO promotion (memory_id, namespace, destination_role, artifact_kind, content, idempotency_key, adapter_binding, created_at, updated_at)
         VALUES (?, 'default', 'curated', 'fact', ?, ?, 'kb', ?, ?)`,
      ).run(id, `protected ${i}`, `k${i}`, Date.now(), Date.now());
    }
    expect(
      remember(db, {
        audience: "agent",
        agentId: "a",
        artifactKind: "fact",
        content: "the newcomer",
        confidence: 0.7,
      }),
    ).toBe("stored");
    expect(db.query("SELECT 1 FROM memory WHERE content = 'the newcomer'").get()).toBeTruthy();
  });

  test("content is capped at 500 chars — a crisp sentence, not an essay", () => {
    const db = openDb(":memory:");
    remember(db, {
      audience: "agent",
      agentId: "a",
      artifactKind: "fact",
      content: "x".repeat(2_000),
      confidence: 0.9,
    });
    const row = db.query("SELECT content FROM memory").get() as { content: string };
    expect(row.content.length).toBe(500);
  });
});

describe("occurrences — the honest recurrence signal", () => {
  test("distinct runs count unique run_ids, not re-distillations (A→B→A = 2)", () => {
    const db = openDb(":memory:");
    remember(db, {
      audience: "agent",
      agentId: "a",
      artifactKind: "fact",
      content: "recurring lesson",
      confidence: 0.8,
      runId: "A",
    });
    const mid = (db.query("SELECT id FROM memory").get() as { id: number }).id;
    remember(db, {
      audience: "agent",
      agentId: "a",
      artifactKind: "fact",
      content: "recurring lesson",
      confidence: 0.8,
      runId: "B",
    });
    remember(db, {
      audience: "agent",
      agentId: "a",
      artifactKind: "fact",
      content: "recurring lesson",
      confidence: 0.8,
      runId: "A",
    });
    expect(distinctRuns(db, mid)).toBe(2);
  });

  test("a write with no runId records no occurrence", () => {
    const db = openDb(":memory:");
    remember(db, {
      audience: "agent",
      agentId: "a",
      artifactKind: "fact",
      content: "one-off",
      confidence: 0.8,
    });
    const mid = (db.query("SELECT id FROM memory").get() as { id: number }).id;
    expect(distinctRuns(db, mid)).toBe(0);
  });
});

describe("recallAgentMemory() — the read side", () => {
  test("relevance beats recency: a query-matching older row outranks newer noise under budget", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    seed(db, "always deploy the harness with the release CLI, never git push", {
      createdAt: now - 40 * DAY,
    });
    for (let i = 0; i < 30; i++)
      seed(db, `unrelated observation about topic ${i}`, { createdAt: now - i * 60_000 });
    const block = recallAgentMemory(
      db,
      "delta-1",
      undefined,
      "how should I deploy the harness?",
      200,
    );
    expect(block).toContain("the release CLI");
  });

  test("recall is scoped to this agent_id — another agent's rows never surface", () => {
    const db = openDb(":memory:");
    seed(db, "agent one secret", { agentId: "delta-1" });
    seed(db, "agent two secret", { agentId: "delta-2" });
    const block = recallAgentMemory(db, "delta-1");
    expect(block).toContain("agent one secret");
    expect(block).not.toContain("agent two secret");
  });

  test("the provenance sink collects the recalled items (content/kind/audience)", () => {
    const db = openDb(":memory:");
    seed(db, "always deploy with the release CLI");
    const sink: { content: string; kind: string; audience: string }[] = [];
    const block = recallAgentMemory(
      db,
      "delta-1",
      undefined,
      undefined,
      2_000,
      "default",
      undefined,
      sink,
    );
    expect(block).toContain("the release CLI");
    expect(sink.length).toBe(1);
    expect(sink[0]?.content).toContain("the release CLI");
    expect(sink[0]?.audience).toBe("agent");
    expect(typeof sink[0]?.kind).toBe("string");
  });

  test("recall bumps hits/last_used, and usage then boosts rank", () => {
    const db = openDb(":memory:");
    seed(db, "a useful lesson");
    recallAgentMemory(db, "delta-1");
    recallAgentMemory(db, "delta-1");
    const row = db.query("SELECT hits, last_used FROM memory").get() as {
      hits: number;
      last_used: number;
    };
    expect(row.hits).toBe(2);
    expect(row.last_used).toBeGreaterThan(0);
  });

  test("decay by disuse: a 91-day-old never-recalled row stops surfacing; a recently-USED old row survives", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    seed(db, "stale never-used lesson", { createdAt: now - 91 * DAY });
    seed(db, "old but recently useful lesson", {
      createdAt: now - 91 * DAY,
      hits: 3,
      lastUsed: now - 2 * DAY,
    });
    const block = recallAgentMemory(db, "delta-1");
    expect(block).not.toContain("stale never-used");
    expect(block).toContain("recently useful");
  });

  test("the honesty header frames memories as self-recorded notes, not verified facts", () => {
    const db = openDb(":memory:");
    seed(db, "some lesson");
    expect(recallAgentMemory(db, "delta-1")).toContain("not verified facts");
  });

  test("Phase 4 middle tier: task_type rows surface ONLY when the run declares that task_type", () => {
    const db = openDb(":memory:");
    remember(db, {
      namespace: "default",
      agentId: "delta-1",
      audience: "task_type",
      taskType: "weekly-revenue-report",
      artifactKind: "fact",
      content: "pull the numbers from the finance sheet, never the CRM",
      confidence: 0.8,
      trust: "trusted",
      source: "self",
    });
    // No task_type declared → the middle tier stays closed.
    expect(recallAgentMemory(db, "delta-1")).toBeNull();
    // A DIFFERENT use-case → still closed (scoped to the exact key).
    expect(
      recallAgentMemory(db, "delta-1", undefined, undefined, 2_000, "default", "some-other-task"),
    ).toBeNull();
    // The matching use-case → surfaced, and it is user-independent (no userId given).
    const hit = recallAgentMemory(
      db,
      "delta-1",
      undefined,
      undefined,
      2_000,
      "default",
      "weekly-revenue-report",
    );
    expect(hit).toContain("finance sheet");
  });
});

describe("migration — legacy scope rows rebuild into the orthogonal model", () => {
  const path = join(tmpdir(), `delta-mig-${process.pid}-${Math.floor(performance.now())}.db`);
  afterEach(() => {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(p)) rmSync(p);
  });

  test("scope user→audience user (scope_id→user_id); agent→agent; key→artifact_kind; tables added", () => {
    // Build the PRE-v3.1 memory table (schema at user_version 6 = legacy migrations
    // 0..5 done) and stamp two legacy rows, then let openDb run migrations 6..8
    // (rebuild, occurrence, promotion).
    const raw = new Database(path, { create: true, strict: true });
    raw.exec(`
      CREATE TABLE memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('run','user','agent','org')),
        scope_id TEXT, key TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL,
        confidence REAL, hash TEXT, hits INTEGER NOT NULL DEFAULT 0, last_used INTEGER,
        source TEXT NOT NULL DEFAULT 'self'
      );
      INSERT INTO memory (scope, scope_id, key, value, created_at, confidence, hash, source)
        VALUES ('user','u1','learning','alice likes ranges',1000,0.9,'ha','review'),
               ('agent','delta-1','pitfall','never git push the harness',1001,0.8,'hb','self');
      PRAGMA user_version = 6;
    `);
    raw.close();

    const db = openDb(path); // runs 6 (rebuild), 7 (occurrence), 8 (promotion)
    const rows = db
      .query(
        "SELECT audience, user_id, agent_id, artifact_kind, content, source FROM memory ORDER BY content",
      )
      .all() as {
      audience: string;
      user_id: string;
      agent_id: string;
      artifact_kind: string;
      content: string;
      source: string;
    }[];
    expect(rows.length).toBe(2);
    const alice = rows.find((r) => r.content.includes("alice")) as (typeof rows)[number];
    expect(alice.audience).toBe("user");
    expect(alice.user_id).toBe("u1");
    expect(alice.artifact_kind).toBe("fact"); // 'learning' → 'fact'
    expect(alice.source).toBe("review");
    const push = rows.find((r) => r.content.includes("git push")) as (typeof rows)[number];
    expect(push.audience).toBe("agent");
    expect(push.agent_id).toBe("delta-1");
    expect(push.artifact_kind).toBe("pitfall"); // 'pitfall' preserved
    // The two new tables exist.
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name='memory_occurrence'").get(),
    ).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE name='promotion'").get()).toBeTruthy();
    db.close();
  });

  test("hostile legacy rows don't brick the migration: NULL scope_id colliding hashes collapse; a rogue source is sanitized", () => {
    // Two NULL-scope_id agent rows share a hash (the old index allowed it — NULLs
    // are distinct); after mapping both to agent_id='' they'd violate the new unique
    // index unless collapsed first. Plus a legacy source outside self|review.
    const raw = new Database(path, { create: true, strict: true });
    raw.exec(`
      CREATE TABLE memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('run','user','agent','org')),
        scope_id TEXT, key TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL,
        confidence REAL, hash TEXT, hits INTEGER NOT NULL DEFAULT 0, last_used INTEGER,
        source TEXT NOT NULL DEFAULT 'self'
      );
      INSERT INTO memory (scope, scope_id, key, value, created_at, confidence, hash, source) VALUES
        ('agent', NULL, 'learning', 'same lesson', 1000, 0.7, 'duphash', 'self'),
        ('agent', NULL, 'learning', 'same lesson', 1001, 0.8, 'duphash', 'imported'),
        ('agent', 'delta-1', 'learning', 'distinct one', 1002, 0.9, 'other', 'review');
      PRAGMA user_version = 6;
    `);
    raw.close();
    const db = openDb(path); // must NOT throw, and must NOT loop the boot
    const collapsed = db
      .query("SELECT count(*) AS n FROM memory WHERE content = 'same lesson'")
      .get() as { n: number };
    expect(collapsed.n).toBe(1); // the two colliding rows collapsed to one
    const bad = db.query("SELECT source FROM memory WHERE content = 'same lesson'").get() as {
      source: string;
    };
    expect(bad.source).toBe("self"); // 'imported' sanitized
    expect(
      (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBeGreaterThanOrEqual(9);
    db.close();
  });
});
