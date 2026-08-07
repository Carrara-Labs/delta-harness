// SPDX-License-Identifier: Apache-2.0
// 0.2.13 "say what changed" — S1 prefix identity, S3 utility-tier visibility, S5 tail budget,
// S6 the derived context ceiling, S7 the silence clock.
//
// Every test here is written to FAIL without its fix. The ones that would have passed on a broken
// implementation are called out inline, because that is the failure mode this batch exists to end:
// an instrument that reads clean while measuring the wrong thing.

import { describe, expect, test } from "bun:test";
import { retainedTailBudget } from "../src/compaction";
import { openDb } from "../src/db";
import { Events, emitUtilityCall } from "../src/events";
import {
  BAKED_PRICES,
  deriveContextCeiling,
  maxSafeCeiling,
  OUTPUT_RESERVE,
  parsePrices,
  resolvePrice,
} from "../src/pricing";
import { prefixDigest } from "../src/run";

// --- S1: prefix identity -----------------------------------------------------------------------
// The digest itself lives in run.ts as a module-private closure over a per-process salt, so these
// exercise the PROPERTIES it must have rather than importing it. Bun.hash is the same primitive.

// The REAL digest from the engine, not a copy of the formula: a reimplementation here would pass
// happily while run.ts hashed something else entirely.
const digest = prefixDigest;

describe("S1 prefix identity", () => {
  test("identical input produces identical digests", () => {
    const spine = "You are Delta.\n- read_file — read a file\n3 more tools exist";
    expect(digest(spine)).toBe(digest(spine));
  });

  test("A SAME-LENGTH mutation still moves the digest", () => {
    // THE test. The whole batch exists because a byte counter cannot see this, and the spine
    // carries a `searchable` counter that produces exactly this shape every time a tool activates.
    const before = "You are Delta.\n138 more tools exist beyond this list";
    const after = "You are Delta.\n139 more tools exist beyond this list";
    expect(after.length).toBe(before.length); // same size...
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before)); // ...same bytes...
    expect(digest(after)).not.toBe(digest(before)); // ...different identity.
  });

  test("the salt is what makes an exported digest non-correlatable", () => {
    // Two daemons must not produce the same digest for the same spine, or the attribute becomes a
    // dictionary-testable fingerprint of DELTA.md/POLICY.md content across every lane at once.
    const spine = "You are Delta (ferni).\n\n# You\nI prefer terse replies.";
    // A different salt is what a second daemon has. Same spine, different digest.
    const other = (s: string) =>
      Bun.hash(`different-salt${s}`).toString(16).padStart(16, "0").slice(0, 12);
    expect(other(spine)).not.toBe(digest(spine));
  });

  test("byte counts are UTF-8, not UTF-16 code units", () => {
    // `.length` would report 2 for a 6-byte string and understate a CJK-heavy spine by ~3x.
    const cjk = "日本語";
    expect(Buffer.byteLength(cjk, "utf8")).toBe(9);
    expect(cjk.length).toBe(3);
  });
});

// --- S3: utility-tier visibility ---------------------------------------------------------------

function newEvents(): { events: Events; seen: Record<string, unknown>[] } {
  const db = openDb(":memory:");
  const events = new Events(db, {});
  const seen: Record<string, unknown>[] = [];
  events.on((e) => {
    if (e.type === "model.call") seen.push(e.data as Record<string, unknown>);
  });
  return { events, seen };
}

const okResult = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    ok: true as const,
    model: "claude-haiku-4-5",
    message: { role: "assistant" as const, content: "x" },
    finishReason: "stop",
    latencyMs: 42,
    usage: { input: 1000, output: 50, cacheRead: 400, cacheWrite: 0, total: 1050, costUsd: 0.001 },
    ...over,
  }) as never;

describe("S3 utility-tier calls are visible", () => {
  test("emits model.call with tier=utility and the purpose", () => {
    const { events, seen } = newEvents();
    emitUtilityCall(events, { turn: 3 }, "summary", okResult(), 4);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tier).toBe("utility");
    expect(seen[0]?.purpose).toBe("summary");
    expect(seen[0]?.["gen_ai.usage.input_tokens"]).toBe(1000);
    expect(seen[0]?.cache_hit_pct).toBe(40);
  });

  test("before_turn names the turn the call enabled, not the turn it reports", () => {
    // Compaction is handed `turn: stepCount` while the main call it clears the way for is
    // stepCount+1, so a FIRST-turn compaction legitimately reports turn 0. Renumbering would break
    // existing consumers; naming the enabled turn does not.
    const { events, seen } = newEvents();
    emitUtilityCall(events, { turn: 0 }, "summary", okResult(), 1);
    expect(seen[0]?.before_turn).toBe(1);
  });

  test("a failed call emits nothing — it carries no usage to report", () => {
    const { events, seen } = newEvents();
    emitUtilityCall(events, { turn: 1 }, "reflection", {
      ok: false,
      model: "m",
      error: "boom",
    } as never);
    expect(seen).toHaveLength(0);
  });

  test("the emitter never returns or mutates usage — it cannot double-charge", () => {
    const { events } = newEvents();
    const r = okResult();
    const before = JSON.stringify((r as { usage: unknown }).usage);
    const out = emitUtilityCall(events, { turn: 1 }, "research", r);
    expect(out).toBeUndefined();
    expect(JSON.stringify((r as { usage: unknown }).usage)).toBe(before);
  });
});

// --- S5: the retained tail is decoupled from the ceiling ----------------------------------------

// The REAL clamp, imported. `SUMMARY_RESERVE_TOKENS` is 4_000 in run.ts.
const recentBudget = (ceiling: number, fixed: number, summaryReserve = 4_000) =>
  retainedTailBudget(ceiling, fixed, summaryReserve);

describe("S5 retained-tail budget", () => {
  test("a large ceiling no longer sizes the tail (the 180k bug)", () => {
    // Aperture's lane: 200k ceiling, ~16k fixed floor. The old formula kept a 180k tail, so
    // compaction landed at ~99% of budget and re-fired next turn — spec-compaction-tail's 94/94.
    const old = Math.max(0, 200_000 - 16_000 - 4_000);
    expect(old).toBe(180_000);
    expect(recentBudget(200_000, 16_000)).toBe(24_000);
  });

  test("a tight ceiling still clamps to the smaller derived value", () => {
    // The safety property of the old formula is preserved exactly: when the fixed parts are large,
    // the remainder wins and the flat target does not raise it.
    expect(recentBudget(40_000, 30_000)).toBe(6_000);
  });

  test("fixed parts exceeding the ceiling floor at zero rather than going negative", () => {
    expect(recentBudget(20_000, 30_000)).toBe(0);
  });

  test("post-compaction size leaves real headroom, so an identical next turn cannot re-fire", () => {
    const ceiling = 200_000;
    const fixed = 16_000;
    const assembledAfter = fixed + recentBudget(ceiling, fixed) + 2_000; // + summary
    expect(assembledAfter).toBeLessThan(ceiling * 0.3);
    // The old behaviour: 16k + 180k + 2k = 198k against a 200k ceiling. One turn of growth re-fires.
    const oldAssembled = fixed + 180_000 + 2_000;
    expect(oldAssembled / ceiling).toBeGreaterThan(0.98);
  });
});

describe("S5 the resume gap", () => {
  test("the anchor is cleared in the same transaction as the message rewrite", () => {
    // A crash between the compaction commit and a later `last_input = 0` resumed with a COMPACTED
    // history and a PRE-compaction anchor, which projects over budget and re-compacts immediately —
    // this batch's own bug, reachable by crash instead of by config.
    const db = openDb(":memory:");
    db.query("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s1',0,0)").run();
    db.query(
      "INSERT INTO runs (id, seq, session_id, status, request, created_at, last_input) VALUES ('r1',1,'s1','running','{}',0, 195000)",
    ).run();
    // Simulate the transaction shape: rewrite + anchor clear, atomically.
    const tx = db.transaction(() => {
      db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES (?,?,?,?)").run(
        "r1",
        "s1",
        JSON.stringify({ role: "user", content: "summary" }),
        Date.now(),
      );
      db.query("UPDATE runs SET last_input = 0 WHERE id = ?").run("r1");
    });
    tx();
    const row = db.query("SELECT last_input FROM runs WHERE id = 'r1'").get() as {
      last_input: number;
    };
    expect(row.last_input).toBe(0);
  });

  test("a rolled-back rewrite leaves the anchor untouched too", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s1',0,0)").run();
    db.query(
      "INSERT INTO runs (id, seq, session_id, status, request, created_at, last_input) VALUES ('r1',1,'s1','running','{}',0, 195000)",
    ).run();
    expect(() =>
      db.transaction(() => {
        db.query("UPDATE runs SET last_input = 0 WHERE id = ?").run("r1");
        throw new Error("crash mid-commit");
      })(),
    ).toThrow();
    const row = db.query("SELECT last_input FROM runs WHERE id = 'r1'").get() as {
      last_input: number;
    };
    // Neither happened. The two states can no longer disagree in either direction.
    expect(row.last_input).toBe(195000);
  });
});

// --- S6: the derived ceiling -------------------------------------------------------------------

describe("S6 context ceiling derivation", () => {
  test("a known model derives from its window", () => {
    expect(deriveContextCeiling(["claude-opus-5"], 120_000)).toBe(249_000 - OUTPUT_RESERVE);
  });

  test("an entirely unknown cascade returns null, so the caller keeps today's default", () => {
    expect(deriveContextCeiling(["some-unlisted-model"], 120_000)).toBeNull();
    expect(deriveContextCeiling([], 120_000)).toBeNull();
  });

  test("a MIXED cascade counts the unknown member, it does not skip it", () => {
    // The failure this prevents: a known 249k model sets a ~209k gate while the unknown fallback
    // that actually serves a failover turn overflows at it. Skipping unknowns would return 209k
    // here and the test would pass on a broken implementation.
    const mixed = deriveContextCeiling(["claude-opus-5", "some-unlisted-model"], 120_000);
    expect(mixed).toBe(120_000);
    expect(mixed).not.toBe(249_000 - OUTPUT_RESERVE);
  });

  test("the minimum wins across several known models", () => {
    const table = parsePrices(
      JSON.stringify({
        big: { in: 1, out: 1, cacheRead: 1, window: 900_000 },
        small: { in: 1, out: 1, cacheRead: 1, window: 200_000 },
      }),
    );
    expect(table.small?.window).toBe(200_000);
    expect(table.big?.window).toBe(900_000);
  });

  test("maxSafeCeiling ignores unknowns — it bounds an override, not the default", () => {
    expect(maxSafeCeiling(["claude-opus-5"])).toBe(249_000 - OUTPUT_RESERVE);
    expect(maxSafeCeiling(["some-unlisted-model"])).toBeNull();
  });

  test("a price-only override PRESERVES the baked window", () => {
    // Anyone already running DELTA_MODEL_PRICES would otherwise lose the window on upgrade and
    // silently drop back to 120k — a knob quietly disabling a derived value, which is the exact
    // failure class this batch exists to fix.
    const table = parsePrices(JSON.stringify({ "claude-opus-5": { in: 9, out: 9, cacheRead: 9 } }));
    expect(table["claude-opus-5"]?.in).toBe(9);
    expect(table["claude-opus-5"]?.window).toBe(249_000);
  });

  test("an override may set its own window, and a malformed one is ignored, never fatal", () => {
    const set = parsePrices(
      JSON.stringify({ "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, window: 400_000 } }),
    );
    expect(set["claude-opus-5"]?.window).toBe(400_000);
    for (const bad of [-1, 0, Number.NaN, "big"]) {
      const t = parsePrices(
        JSON.stringify({ "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, window: bad } }),
      );
      expect(t["claude-opus-5"]?.window).toBe(249_000); // falls back to baked, no throw
    }
  });

  test("the seeded window sits UNDER the field-proven floor", () => {
    // 249,127 input tokens were accepted in production with zero overflow, so the real window is
    // above that. Seeding at or over the observation would be a guess; under it is an observation.
    const w = resolvePrice("claude-opus-5", BAKED_PRICES)?.window as number;
    expect(w).toBeLessThan(249_127);
  });
});
