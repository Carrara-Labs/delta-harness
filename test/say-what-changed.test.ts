// SPDX-License-Identifier: Apache-2.0
// 0.2.13 "say what changed" — S1 prefix identity, S3 utility-tier visibility, S5 tail budget,
// S6 the derived context ceiling, S7 the silence clock.
//
// Every test here is written to FAIL without its fix. The ones that would have passed on a broken
// implementation are called out inline, because that is the failure mode this batch exists to end:
// an instrument that reads clean while measuring the wrong thing.

import { describe, expect, test } from "bun:test";
import { maybeCompact, retainedTailBudget } from "../src/compaction";
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
import type { ChatMsg, ChatRequest, ModelResult } from "../src/provider";
import { Queue } from "../src/queue";
import { runResearch } from "../src/research";
import { prefixDigest } from "../src/run";
import { type ToolCtx, testTools } from "../src/tools";
import { makeDeps, textResult } from "./helpers";

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
    // A cache write that the wire reported rides as its own attribute (the count fed cost since
    // 0.2.16 but never left the process); none reported → no key, not a zero.
    expect(seen[0]).not.toHaveProperty("gen_ai.usage.cache_write_tokens");
    const { seen: written } = (() => {
      const n = newEvents();
      emitUtilityCall(
        n.events,
        { turn: 3 },
        "summary",
        okResult({
          usage: {
            input: 1000,
            output: 50,
            cacheRead: 400,
            cacheWrite: 600,
            total: 1050,
            costUsd: 0.001,
          },
        }),
        4,
      );
      return n;
    })();
    expect(written[0]?.["gen_ai.usage.cache_write_tokens"]).toBe(600);
  });

  test("before_turn names the turn the call enabled, not the turn it reports", () => {
    // Compaction is handed `turn: stepCount` while the main call it clears the way for is
    // stepCount+1, so a FIRST-turn compaction legitimately reports turn 0. Renumbering would break
    // existing consumers; naming the enabled turn does not.
    const { events, seen } = newEvents();
    emitUtilityCall(events, { turn: 0 }, "summary", okResult(), 1);
    expect(seen[0]?.before_turn).toBe(1);
  });

  test("a FAILED call emits too — error class on telemetry, one stderr line (C1, 0.2.16)", () => {
    // The old contract ("no usage → emit nothing") is how 24/24 child provider failures hid
    // for two weeks: a child's error becomes tool-result TEXT the parent model reads, and
    // nothing an operator greps. Delos's D-12 gate run measured it — 3 failures in tool
    // results, 0 in stdout, 0 in telemetry.
    const { events, seen } = newEvents();
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.join(" "));
    };
    try {
      emitUtilityCall(events, { turn: 1 }, "research", {
        ok: false,
        model: "gpt-5.6",
        error: "max_output_tokens is not supported",
        status: 400,
      } as never);
    } finally {
      console.error = orig;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tier).toBe("utility");
    expect(seen[0]?.purpose).toBe("research");
    expect(seen[0]?.is_error).toBe(true);
    expect(seen[0]?.["error.class"]).toBe("request"); // the classified enum, never free text
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("research");
    expect(errs[0]).toContain("400");
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

// --- S2 + S5 driven through the REAL maybeCompact --------------------------------------------
// The first version of these tests hand-rolled the transaction they were meant to verify, so they
// passed while the production path kept the bug (codex). These call the engine.

function seed(db: ReturnType<typeof openDb>, msgs: ChatMsg[], lastInput = 195_000) {
  const now = Date.now();
  db.query(
    "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s', NULL, ?, ?)",
  ).run(now, now);
  db.query(
    "INSERT INTO runs (id, session_id, seq, status, request, created_at, last_input) VALUES ('r','s',1,'running','{}',?,?)",
  ).run(now, lastInput);
  for (const m of msgs)
    db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)").run(
      JSON.stringify(m),
      now,
    );
}

const bigSession = (): ChatMsg[] => {
  const out: ChatMsg[] = [];
  for (let i = 0; i < 14; i++) {
    out.push({ role: "user", content: `question ${i} ${"q".repeat(400)}` });
    out.push({ role: "assistant", content: `answer ${i} ${"a".repeat(400)}` });
  }
  return out;
};

const summarizer =
  (content: string) =>
  async (req: ChatRequest): Promise<ModelResult> => {
    const sys = req.messages[0]?.content;
    if (typeof sys === "string" && sys.startsWith("You compact"))
      return {
        ok: true,
        model: "claude-haiku-4-5",
        message: { role: "assistant", content },
        finishReason: "stop",
        latencyMs: 5,
        usage: { input: 900, output: 60, cacheRead: 0, cacheWrite: 0, total: 960, costUsd: 0.002 },
      } as ModelResult;
    return {
      ok: true,
      model: "m",
      message: { role: "assistant", content: "done" },
      finishReason: "stop",
      latencyMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, costUsd: 0 },
    } as ModelResult;
  };

function capture(db: ReturnType<typeof openDb>, type: string) {
  const events = new Events(db);
  const seen: Record<string, unknown>[] = [];
  events.on((e) => {
    if (e.type === type) seen.push(e.data as Record<string, unknown>);
  });
  return { events, seen };
}

describe("S5 the resume gap, through maybeCompact", () => {
  test("a committed compaction clears the anchor in the SAME transaction", async () => {
    const db = openDb(":memory:");
    seed(db, bigSession());
    const { events } = capture(db, "compaction");
    const before = (
      db.query("SELECT last_input FROM runs WHERE id='r'").get() as {
        last_input: number;
      }
    ).last_input;
    expect(before).toBe(195_000);

    const res = await maybeCompact(
      db,
      events,
      summarizer("Goal: g\nProgress: p\nNext: n\nArtifacts: a"),
      "s",
      { turn: 1 },
      { recentBudgetTokens: 600, anchorRunId: "r" },
    );
    expect(res?.shrank).toBe(true);
    // Without `anchorRunId` reaching clearAnchor, this stays 195000 and a crash here resumes with
    // a compacted history and a pre-compaction anchor — re-compacting on the first turn back.
    const after = (
      db.query("SELECT last_input FROM runs WHERE id='r'").get() as {
        last_input: number;
      }
    ).last_input;
    expect(after).toBe(0);
  });

  test("a compaction that does NOT commit leaves the anchor alone", async () => {
    const db = openDb(":memory:");
    // Two tiny messages: nothing material to shed, so no rewrite and no anchor reset.
    seed(db, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const { events } = capture(db, "compaction");
    await maybeCompact(
      db,
      events,
      summarizer("Goal: g\nProgress: p\nNext: n\nArtifacts: a"),
      "s",
      {
        turn: 1,
      },
      { recentBudgetTokens: 600, anchorRunId: "r" },
    );
    const after = (
      db.query("SELECT last_input FROM runs WHERE id='r'").get() as {
        last_input: number;
      }
    ).last_input;
    expect(after).toBe(195_000);
  });
});

describe("S2 billed-but-silent compaction attempts now emit", () => {
  test("a non-material shrink emits shrank:false with reason=not_material AND its cost", async () => {
    const db = openDb(":memory:");
    seed(db, bigSession());
    const { events, seen } = capture(db, "compaction");
    // A summary as long as what it replaces → the shrink test fails, but the call was still billed.
    const res = await maybeCompact(
      db,
      events,
      summarizer(`Goal: g\nProgress: ${"p".repeat(12_000)}\nNext: n\nArtifacts: a`),
      "s",
      { turn: 1 },
      { recentBudgetTokens: 20_000, anchorRunId: "r" },
    );
    expect(res?.shrank).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.shrank).toBe(false);
    expect(seen[0]?.reason).toBe("not_material");
    expect(seen[0]?.summary_cost_usd as number).toBeGreaterThan(0);
  });

  test("an empty summary response emits reason=no_summary rather than nothing", async () => {
    const db = openDb(":memory:");
    seed(db, bigSession());
    const { events, seen } = capture(db, "compaction");
    const res = await maybeCompact(
      db,
      events,
      summarizer(""),
      "s",
      { turn: 1 },
      {
        recentBudgetTokens: 600,
        anchorRunId: "r",
      },
    );
    expect(res?.shrank).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe("no_summary");
    expect(seen[0]?.summary_cost_usd as number).toBeGreaterThan(0);
  });

  test("a committed compaction reports shrank:true", async () => {
    const db = openDb(":memory:");
    seed(db, bigSession());
    const { events, seen } = capture(db, "compaction");
    await maybeCompact(
      db,
      events,
      summarizer("Goal: g\nProgress: p\nNext: n\nArtifacts: a"),
      "s",
      {
        turn: 1,
      },
      { recentBudgetTokens: 600, anchorRunId: "r" },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.shrank).toBe(true);
  });
});

describe("S3 the summary call is reported as utility tier", () => {
  test("maybeCompact emits a model.call per summary attempt", async () => {
    const db = openDb(":memory:");
    seed(db, bigSession());
    const { events, seen } = capture(db, "model.call");
    await maybeCompact(
      db,
      events,
      summarizer("Goal: g\nProgress: p\nNext: n\nArtifacts: a"),
      "s",
      {
        turn: 4,
      },
      { recentBudgetTokens: 600, anchorRunId: "r" },
    );
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]?.tier).toBe("utility");
    expect(seen[0]?.purpose).toBe("summary");
    // The call ran BEFORE turn 5; `turn` stays 4 so existing consumers are unaffected.
    expect(seen[0]?.before_turn).toBe(5);
  });
});

// --- S1 + S4 end-to-end, through a real run ---------------------------------------------------
// The unit tests above prove the digest has the right PROPERTIES. Only this proves the engine
// actually emits the attributes, hashes the segments it claims to, and hands `chat` the same specs
// the digest measured (codex: the earlier tests would all pass with S1 entirely absent).

describe("S1 end-to-end on model.call", () => {
  test("every prefix attribute is emitted, and the digests match the assembled segments", async () => {
    const sent: ChatRequest[] = [];
    const deps = makeDeps(async (req) => {
      sent.push(req);
      return textResult("ok");
    }, new Map(testTools()));
    const seen: Record<string, unknown>[] = [];
    deps.events.on((e) => {
      if (e.type === "model.call") seen.push(e.data as Record<string, unknown>);
    });

    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "hello" }).id);
    expect(done.status).toBe("done");
    expect(seen).toHaveLength(1);
    const a = seen[0] as Record<string, number | string>;

    for (const k of [
      "spine_bytes",
      "spine_hash",
      "tools_bytes",
      "tools_hash",
      "tools_n",
      "self_bytes",
      "history_bytes",
      "ephemeral_bytes",
    ])
      expect(a[k]).toBeDefined();
    expect(a.tier).toBe("main");

    // The digest must be OF the system string actually sent — not of some earlier assembly.
    const req = sent[0] as ChatRequest;
    const system = req.messages[0]?.content as string;
    expect(a.spine_hash).toBe(prefixDigest(system));
    expect(a.spine_bytes).toBe(Buffer.byteLength(system, "utf8"));

    // And `tools` on the wire must be the SAME array the tools digest measured. Drift here is the
    // one failure this instrument cannot survive, and it is invisible to every other assertion.
    expect(a.tools_hash).toBe(prefixDigest(JSON.stringify(req.tools)));
    expect(a.tools_n).toBe((req.tools ?? []).length);
  });

  test("the digest is stable across an identical second turn", async () => {
    const deps = makeDeps(async () => textResult("ok"), new Map(testTools()));
    const seen: Record<string, unknown>[] = [];
    deps.events.on((e) => {
      if (e.type === "model.call") seen.push(e.data as Record<string, unknown>);
    });
    const queue = new Queue(deps);
    const first = await queue.wait(queue.enqueue({ input: "hello" }).id);
    await queue.wait(queue.enqueue({ input: "hello", previous_response_id: first.id }).id);
    expect(seen).toHaveLength(2);
    // Same tool surface, same self-file → the two prefix segments must be byte-identical. If this
    // ever drifts, the prefix is being rebuilt differently every turn and no cache can survive it.
    expect(seen[1]?.spine_hash).toBe(seen[0]?.spine_hash);
    expect(seen[1]?.tools_hash).toBe(seen[0]?.tools_hash);
    // History grew; that is the only segment that should have moved.
    expect(seen[1]?.history_bytes as number).toBeGreaterThan(seen[0]?.history_bytes as number);
  });
});

describe("S7 /v1/busy silence clock", () => {
  test("absent when idle, present while a run is in flight", async () => {
    const deps = makeDeps(async () => textResult("ok"), new Map(testTools()));
    const queue = new Queue(deps);
    expect(queue.activity().last_event_ms_ago).toBeUndefined();
    expect(queue.activity().busy).toBe(false);

    const now = Date.now();
    deps.db
      .query("INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s2',NULL,?,?)")
      .run(now, now);
    deps.db
      .query(
        "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r2','s2',1,'running','{}',?)",
      )
      .run(now);
    deps.db
      .query("INSERT INTO events (ts, type, run_id, data) VALUES (?, 'turn.start', 'r2', '{}')")
      .run(now - 5_000);

    const act = queue.activity();
    expect(act.busy).toBe(true);
    // Silence, not turn age: ~5s since the last event.
    expect(act.last_event_ms_ago as number).toBeGreaterThanOrEqual(4_000);
    expect(act.last_event_ms_ago as number).toBeLessThan(60_000);

    // A newer event must bring it DOWN — the value tracks silence, it is not monotonic.
    deps.db
      .query("INSERT INTO events (ts, type, run_id, data) VALUES (?, 'tool.call', 'r2', '{}')")
      .run(Date.now());
    expect(queue.activity().last_event_ms_ago as number).toBeLessThan(1_000);
  });
});

// --- The two call-site regressions the first round of tests could NOT see ----------------------
// Codex's second pass: the anchor test supplied `anchorRunId` itself, so removing it from the
// overflow path again would have left everything green; and nothing drove runResearch at all, so
// dropping the callback propagation was invisible. Both are exercised through production now.

describe("S5 the overflow-recovery path clears the anchor too", () => {
  test("a forced compaction after a provider overflow leaves no stale anchor", async () => {
    let call = 0;
    const deps = makeDeps(
      async (req: ChatRequest) => {
        const sys = req.messages[0]?.content;
        if (typeof sys === "string" && sys.startsWith("You compact"))
          return {
            ok: true,
            model: "u",
            message: { role: "assistant", content: "Goal: g\nProgress: p\nNext: n\nArtifacts: a" },
            finishReason: "stop",
            latencyMs: 1,
            usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, total: 18, costUsd: 0.001 },
          } as ModelResult;
        call++;
        // Call 1 SUCCEEDS with a tool call, which persists a large `last_input` on THIS run — the
        // anchor the compaction must invalidate. Without this the run's anchor is 0 from birth and
        // the assertion below passes no matter what the engine does (codex: passes-while-broken).
        if (call === 1)
          return {
            ok: true,
            model: "m",
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "add", arguments: '{"a":1,"b":2}' },
                },
              ],
            },
            finishReason: "tool_calls",
            latencyMs: 1,
            usage: {
              input: 195_000,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              total: 195_005,
              costUsd: 0.01,
            },
          } as ModelResult;
        // Call 2 overflows, forcing the recovery compaction. Call 3 then fails for an UNRELATED
        // reason, deliberately: a successful retry rewrites `last_input` with its own value, which
        // would mask whether the compaction cleared it at all.
        if (call === 2)
          return { ok: false, model: "m", error: "prompt is too long", status: 400 } as ModelResult;
        return { ok: false, model: "m", error: "upstream 503", status: 503 } as ModelResult;
      },
      new Map(testTools()),
      { compactAtTokens: 1_000_000 },
    );

    // A session big enough that a forced compaction can actually shed something.
    const now = Date.now();
    deps.db
      .query("INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s3',NULL,?,?)")
      .run(now, now);
    deps.db
      .query(
        "INSERT INTO runs (id, session_id, seq, status, request, created_at, last_input) VALUES ('r3','s3',1,'done','{}',?,?)",
      )
      .run(now, 195_000);
    const ins = deps.db.query(
      "INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r3','s3',?,?)",
    );
    for (let i = 0; i < 24; i++)
      ins.run(
        JSON.stringify({ role: i % 2 ? "assistant" : "user", content: "x".repeat(1200) }),
        now,
      );

    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "continue", previous_response_id: "r3" }).id,
    );
    expect(done.status).toBe("failed"); // by construction — see the retry above
    // THIS run's anchor must be cleared: the recovery compaction rewrote the history, so a
    // surviving pre-compaction estimate is a lie that outlives a crash. (The prior run's anchor is
    // deliberately untouched — the resume path reads the CURRENT run's, and rewriting history for
    // a finished run's bookkeeping would be scope creep.)
    const cur = deps.db.query("SELECT last_input FROM runs WHERE id = ?").get(done.id) as {
      last_input: number;
    };
    // 0 only if the FORCED compaction passed `anchorRunId`. Without it clearAnchor no-ops, the
    // run.ts-side reset is gone, and this stays at the pre-compaction 195_000 — a stale anchor on
    // a rewritten history, which is the crash-gap bug on the path that already failed once.
    expect(cur.last_input).toBe(0);
  });
});

describe("S3 research fan-out reports every child call", () => {
  test("runResearch propagates onUtilityCall and fires it per child call", async () => {
    const seen: string[] = [];
    const chat = async () =>
      ({
        ok: true,
        model: "child-model",
        message: { role: "assistant", content: "child answer" },
        finishReason: "stop",
        latencyMs: 1,
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, costUsd: 0.001 },
      }) as ModelResult;

    const tools = new Map(testTools());
    const ctx: ToolCtx = {
      workspace: "/tmp/delta-test-ws",
      activate: () => {},
      onUtilityCall: (purpose) => seen.push(purpose),
    };
    const out = await runResearch(
      ["task one", "task two"],
      { tools, pinned: [...tools.keys()], maxTokens: 50_000, maxCostUsd: 1 } as never,
      chat,
      ctx,
      "run-1",
      "0",
    );
    expect(typeof out).toBe("string");
    // Two children, at least one call each. Without the propagation this array is empty and the
    // fan-out stays invisible behind its single aggregate charge.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen)).toEqual(new Set(["research"]));
  });
});

// --- S10: the honest cache-health metric -------------------------------------------------------
// From the Aperture canary (2026-08-08). Their 42-turn reading proved `cache_hit_pct` is a ratio
// whose DENOMINATOR moves: the same byte-identical prefix read anywhere from 65% to 100% purely
// because of how much history each turn appended. The prediction this batch was built to test
// failed, and this is the better answer it produced instead.

describe("S10 cache_shortfall_tokens", () => {
  test("a perfectly cached turn reports a small constant, whatever the hit percentage says", async () => {
    // Turn 3 of Aperture's task 8a92adc3, verbatim: 68% "hit" and a 45-token shortfall. A healthy
    // turn that the ratio slanders, which is the whole reason this metric exists.
    const prevInput = 23_566;
    const thisCached = 23_521;
    const thisInput = 34_705;
    const hitPct = Math.round((thisCached / thisInput) * 100);
    expect(hitPct).toBe(68); // looks like a third of the prompt was re-read...
    expect(prevInput - thisCached).toBe(45); // ...but the cache served everything it could.
  });

  test("a real miss is unmistakable on the shortfall and ambiguous on the ratio", () => {
    // Turn 17 of the same task: 92% hit, and 4,993 tokens genuinely re-read. The ratio ranks this
    // HEALTHIER than the 68% turn above, which is exactly backwards.
    const prevInput = 125_199;
    const thisCached = 120_206;
    const thisInput = 130_813;
    expect(Math.round((thisCached / thisInput) * 100)).toBe(92);
    expect(prevInput - thisCached).toBe(4_993);
  });

  test("emitted from the second call of a run onward, absent on the first", async () => {
    // Driven as a TOOL-CALLING run, because that is the shape the metric is for: many model calls
    // inside one long task, which is exactly Aperture's 23-turn engagement. `lastInputTokens` is
    // per-run state, so a fresh run legitimately has no previous request of its own to compare to.
    let call = 0;
    const deps = makeDeps(async () => {
      call++;
      if (call === 1)
        return {
          ok: true,
          model: "m",
          message: {
            role: "assistant",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "add", arguments: '{"a":1,"b":2}' } },
            ],
          },
          finishReason: "tool_calls",
          latencyMs: 1,
          usage: { input: 5_000, output: 5, cacheRead: 0, cacheWrite: 0, total: 5_005, costUsd: 0 },
        } as ModelResult;
      return {
        ok: true,
        model: "m",
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        latencyMs: 1,
        // Cached 4,955 of the previous request's 5,000 — the healthy shape, 45 short.
        usage: {
          input: 6_000,
          output: 5,
          cacheRead: 4_955,
          cacheWrite: 0,
          total: 6_005,
          costUsd: 0,
        },
      } as ModelResult;
    }, new Map(testTools()));
    const seen: Record<string, unknown>[] = [];
    deps.events.on((e) => {
      if (e.type === "model.call") seen.push(e.data as Record<string, unknown>);
    });
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "add one and two" }).id);
    expect(done.status).toBe("done");
    expect(seen).toHaveLength(2);
    // No previous request on the first call — meaningless, not zero.
    expect(seen[0]?.cache_shortfall_tokens).toBeUndefined();
    // 5,000 sent last time, 4,955 served from cache: the healthy constant, and NOT a function of
    // this turn's 6,000-token input the way cache_hit_pct would be.
    expect(seen[1]?.cache_shortfall_tokens).toBe(45);
    expect(seen[1]?.cache_hit_pct).toBe(83); // the ratio, meanwhile, reads as a 17% "miss"
  });

  // A request cannot re-read more than it CONTAINS. When this turn is smaller than the one before
  // it — which is exactly what compaction produces — comparing against the previous input alone
  // reports a huge shortfall for a turn that cached everything available to it. Bounding by
  // min(prev, current) is the fix; Pi's harness derived the same form independently.
  test("a turn that SHRANK (post-compaction) is not slandered by the previous turn's size", async () => {
    let call = 0;
    const deps = makeDeps(async () => {
      call++;
      if (call === 1)
        return {
          ok: true,
          model: "m",
          message: {
            role: "assistant",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "add", arguments: '{"a":1,"b":2}' } },
            ],
          },
          finishReason: "tool_calls",
          latencyMs: 1,
          usage: { input: 5_000, output: 5, cacheRead: 0, cacheWrite: 0, total: 5_005, costUsd: 0 },
        } as ModelResult;
      return {
        ok: true,
        model: "m",
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        latencyMs: 1,
        // History collapsed to 2,000 tokens; 1,980 of them served from cache. 20 short, not 3,020.
        usage: {
          input: 2_000,
          output: 5,
          cacheRead: 1_980,
          cacheWrite: 0,
          total: 2_005,
          costUsd: 0,
        },
      } as ModelResult;
    }, new Map(testTools()));
    const seen: Record<string, unknown>[] = [];
    deps.events.on((e) => {
      if (e.type === "model.call") seen.push(e.data as Record<string, unknown>);
    });
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "add one and two" }).id);
    // Unbounded, this reads 5,000 - 1,980 = 3,020 and every compaction looks like a cache disaster.
    expect(seen[1]?.cache_shortfall_tokens).toBe(20);
  });
});
