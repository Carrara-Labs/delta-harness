// P1 cost-truth: compute cost_usd from tokens on the paths the provider doesn't meter.

import { describe, expect, test } from "bun:test";
import {
  BAKED_PRICES,
  computeCost,
  deriveContextCeiling,
  maxSafeCeiling,
  parsePrices,
  resolvePrice,
} from "../src/pricing";

describe("resolvePrice", () => {
  test("exact, provider-prefixed, and leaf all match the same price", () => {
    const sonnet = { in: 3, out: 15, cacheRead: 0.3 };
    expect(resolvePrice("claude-sonnet-4.6", BAKED_PRICES)).toEqual(sonnet);
    expect(resolvePrice("anthropic/claude-sonnet-4.6", BAKED_PRICES)).toEqual(sonnet);
    expect(resolvePrice("gpt-5.5", BAKED_PRICES)).toEqual({ in: 5, out: 30, cacheRead: 0.5 });
  });
  test("unknown model → null (caller keeps cost 0)", () => {
    expect(resolvePrice("some/unknown-model", BAKED_PRICES)).toBeNull();
  });
  test("opus-5 is priced on every id form (A10 — native + prefixed + versioned)", () => {
    // `window` rides along on this entry (S6) and must survive every id form — a versioned or
    // provider-prefixed slug that resolved the price but LOST the window would silently fall back
    // to the 120k compaction default on exactly the lanes this was seeded for.
    const opus5 = { in: 5, out: 25, cacheRead: 0.5, window: 249_000 };
    expect(resolvePrice("claude-opus-5", BAKED_PRICES)).toEqual(opus5);
    expect(resolvePrice("anthropic/claude-opus-5", BAKED_PRICES)).toEqual(opus5);
    expect(resolvePrice("claude-opus-5-20260601", BAKED_PRICES)).toEqual(opus5);
    expect(computeCost(opus5, { input: 1_000_000, output: 0, cacheRead: 0 })).toBeCloseTo(5, 5);
  });
});

describe("computeCost", () => {
  test("bills fresh input + cache-reads + output at their rates", () => {
    const p = { in: 3, out: 15, cacheRead: 0.3 }; // $/M
    // 100k input of which 80k cached, 20k output.
    // fresh = 20k*3 + cache 80k*0.3 + out 20k*15 = 60000+24000+300000 = 384000 / 1e6 = $0.384
    expect(computeCost(p, { input: 100_000, output: 20_000, cacheRead: 80_000 })).toBeCloseTo(
      0.384,
      6,
    );
  });
  test("cache-reads never over-bill fresh input (clamped at 0)", () => {
    const p = { in: 3, out: 15, cacheRead: 0.3 };
    // cacheRead > input shouldn't make fresh negative.
    const c = computeCost(p, { input: 10, output: 0, cacheRead: 999 });
    expect(c).toBeGreaterThanOrEqual(0);
  });
});

describe("parsePrices override", () => {
  test("valid override replaces a baked entry; others untouched", () => {
    const t = parsePrices(JSON.stringify({ "claude-sonnet-5": { in: 9, out: 9, cacheRead: 9 } }));
    expect(t["claude-sonnet-5"]).toEqual({ in: 9, out: 9, cacheRead: 9 });
    expect(t["claude-opus-4.8"]).toEqual({ in: 5, out: 25, cacheRead: 0.5 });
  });
  test("malformed entry is ignored; malformed JSON → baked defaults", () => {
    const partial = parsePrices(JSON.stringify({ x: { in: 1 } })); // missing out/cacheRead
    expect(partial.x).toBeUndefined();
    expect(parsePrices("{not json")).toEqual({ ...BAKED_PRICES });
  });
  test("undefined → baked defaults", () => {
    expect(parsePrices(undefined)).toEqual({ ...BAKED_PRICES });
  });
});

describe("gpt-5.6 family (M3, 0.2.16)", () => {
  // Live pricing page 2026-09-05 (sol cut to $4/$20/$0.40 since the 08-19 read).
  // Without these entries gpt-5.6-sol prefix-matched "gpt-5" at $1.25/$10 — the metered demo
  // lane under-billed ~4×. Long-context (>272K) tiers exist and are NOT modeled; the
  // DELTA_MODEL_PRICES override is the correction path if a lane lives in that band.
  test("sol/terra/luna and the bare alias resolve to their own prices, not gpt-5's", () => {
    expect(resolvePrice("gpt-5.6-sol", BAKED_PRICES)).toEqual({ in: 4, out: 20, cacheRead: 0.4 });
    expect(resolvePrice("gpt-5.6-terra", BAKED_PRICES)).toEqual({ in: 2, out: 12, cacheRead: 0.2 });
    expect(resolvePrice("gpt-5.6-luna", BAKED_PRICES)).toEqual({
      in: 0.2,
      out: 1.2,
      cacheRead: 0.02,
    });
    // The "gpt-5.6" alias routes to sol server-side; it must not fall back to gpt-5 pricing.
    expect(resolvePrice("gpt-5.6", BAKED_PRICES)).toEqual({ in: 4, out: 20, cacheRead: 0.4 });
    // …and gpt-5 itself keeps its own entry (prefix matching must not shadow it).
    expect(resolvePrice("gpt-5", BAKED_PRICES)).toEqual({ in: 1.25, out: 10, cacheRead: 0.125 });
  });
  test("cache writes bill at 1.25× — the OpenAI 5.6 rate matches the existing multiplier", () => {
    const sol = { in: 4, out: 20, cacheRead: 0.4 };
    // Guide example shape: 2600 input = 2000 cached + 400 written + 200 fresh.
    // 200*4 + 2000*0.4 + 400*5 + 0 = 800 + 800 + 2000 = 3600 / 1e6
    expect(
      computeCost(sol, { input: 2_600, output: 0, cacheRead: 2_000, cacheWrite: 400 }),
    ).toBeCloseTo(0.0036, 8);
  });
});

describe("gpt-6-astra (0.2.18)", () => {
  // Model page + pricing page 2026-09-05: $10 in / $50 out / $1 cached read; writes 1.25×.
  const astra = { in: 10, out: 50, cacheRead: 1 };
  test("priced on every id form; no `gpt-6` alias OpenAI does not document", () => {
    expect(resolvePrice("gpt-6-astra", BAKED_PRICES)).toEqual(astra);
    expect(resolvePrice("openai/gpt-6-astra", BAKED_PRICES)).toEqual(astra);
    expect(resolvePrice("gpt-6-astra-2026-09-01", BAKED_PRICES)).toEqual(astra);
    expect(resolvePrice("gpt-6", BAKED_PRICES)).toBeNull();
  });
  test("cache writes bill at 1.25× of $10", () => {
    // 200 fresh*10 + 2000 cached*1 + 400 written*12.5 = 2000 + 2000 + 5000 = 9000 / 1e6
    expect(
      computeCost(astra, { input: 2_600, output: 0, cacheRead: 2_000, cacheWrite: 400 }),
    ).toBeCloseTo(0.009, 8);
  });
  test("no baked window: the ceiling keeps its default and never clamps an existing cascade", () => {
    // A `window` would also clamp an operator's DELTA_COMPACT_AT_TOKENS through maxSafeCeiling
    // (codex P1 on the spec), and the only number on offer (the 272K price cliff) is a cost
    // choice, not a capacity. Unknown → default; Astra beside Opus 5 leaves Opus's ceiling alone.
    expect(deriveContextCeiling(["gpt-6-astra"], 120_000, BAKED_PRICES)).toBeNull();
    expect(maxSafeCeiling(["gpt-6-astra", "claude-opus-5"], BAKED_PRICES)).toBe(209_000);
  });
});
