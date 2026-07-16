// P1 cost-truth: compute cost_usd from tokens on the paths the provider doesn't meter.

import { describe, expect, test } from "bun:test";
import { BAKED_PRICES, computeCost, parsePrices, resolvePrice } from "../src/pricing";

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
