// SPDX-License-Identifier: Apache-2.0
// Model pricing (P1 cost-truth). The provider fills usage.cost_usd directly only on
// the OpenRouter path (OpenRouter reports a metered `cost`); the Anthropic- and
// OpenAI-subscription paths report tokens but NO dollars. This table computes cost
// from the token counts so cost_usd is real on every path — the number the leanness
// cost benchmark rests on.
//
// On the subscription paths the marginal cost is ~$0 (flat subscription), so this
// figure is the METERED-EQUIVALENT: what the same tokens would cost at API rates. That
// is exactly the right unit for the benchmark — it measures token efficiency in dollars.
//
// Source: baked defaults for the fleet + a DELTA_MODEL_PRICES env override (JSON:
// {"<model>": {"in": <$/M>, "out": <$/M>, "cacheRead": <$/M>}, ...}), merged over the
// defaults — correctable without a redeploy, matching config.ts's defaults+env pattern.

/** Dollars per 1,000,000 tokens. cacheRead = the (cheap) rate for cache-hit input.
 * Cache WRITES bill at 1.25× the input rate (Anthropic 5-min TTL) — computeCost applies
 * that multiplier to usage.cacheWrite, which the rolling breakpoints produce every turn. */
export type ModelPrice = { in: number; out: number; cacheRead: number };

// The OpenRouter-option fleet + the harness default, priced from
// the live OpenRouter models API (GET /api/v1/models), verified 2026-07-09. $/M tokens,
// prompt / completion / input_cache_read. Keyed by the model's last path segment (provider
// prefixes are stripped at match time), so "anthropic/claude-sonnet-5" and "claude-sonnet-5"
// both hit. Cache WRITES aren't billed here — the harness doesn't capture creation tokens;
// a small first-turn undercount, negligible against the cache-HIT-dominated steady state.
export const BAKED_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2 }, // harness default (config.ts)
  "claude-sonnet-4.6": { in: 3, out: 15, cacheRead: 0.3 }, // fleet default (openrouter)
  "claude-opus-4.8": { in: 5, out: 25, cacheRead: 0.5 },
  "claude-haiku-4.5": { in: 1, out: 5, cacheRead: 0.1 }, // utility-model default
  "gpt-5.5": { in: 5, out: 30, cacheRead: 0.5 },
  "gemini-3.5-flash": { in: 1.5, out: 9, cacheRead: 0.15 },
  // Bench/fleet GLMs — without these the subscription paths meter $0 (verified live 2026-07-10).
  "glm-5.2": { in: 0.84, out: 2.64, cacheRead: 0.156 },
  "glm-5": { in: 0.6, out: 1.92, cacheRead: 0.12 },
  "gpt-5": { in: 1.25, out: 10, cacheRead: 0.125 }, // codex #5: was inheriting 5.5's price via substring
  // Anthropic NATIVE model ids use dashes ("claude-haiku-4-5"); alias them so the native
  // wire path never meters $0 (codex #2).
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3 },
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5 },
};

/** Merge a DELTA_MODEL_PRICES JSON override over the baked defaults. Malformed → defaults,
 * logged, never fatal (config style). Only well-formed {in,out,cacheRead} entries apply. */
export function parsePrices(raw: string | undefined): Record<string, ModelPrice> {
  if (!raw) return { ...BAKED_PRICES };
  try {
    const over = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
    const out: Record<string, ModelPrice> = { ...BAKED_PRICES };
    for (const [k, v] of Object.entries(over)) {
      if (
        v &&
        typeof v.in === "number" &&
        typeof v.out === "number" &&
        typeof v.cacheRead === "number"
      )
        out[k.toLowerCase()] = { in: v.in, out: v.out, cacheRead: v.cacheRead };
    }
    return out;
  } catch {
    console.error("delta: DELTA_MODEL_PRICES is not valid JSON — using baked model prices.");
    return { ...BAKED_PRICES };
  }
}

/** Match a model to a price: exact, then last path segment (drop provider prefixes), then a
 * PREFIX fallback for versioned slugs ("claude-sonnet-5-20260115" → "claude-sonnet-5"), longest
 * key wins. Prefix-only — the old bidirectional substring could hand a variant the wrong price
 * (codex #minor: "-mini"/"-thinking" suffixes still inherit the base price, which is the intent;
 * an unrelated slug that merely CONTAINS a key no longer matches). null if unpriced. */
export function resolvePrice(model: string, table: Record<string, ModelPrice>): ModelPrice | null {
  const m = model.toLowerCase();
  if (table[m]) return table[m];
  const leaf = m.split("/").pop() ?? m;
  if (table[leaf]) return table[leaf];
  let best: { k: string; p: ModelPrice } | null = null;
  for (const [k, p] of Object.entries(table))
    if (leaf.startsWith(k) && (!best || k.length > best.k.length)) best = { k, p };
  return best?.p ?? null;
}

/** Cost in dollars from tokens. input is GROSS (includes cache-reads and cache-writes), so
 * fresh = input − cacheRead − cacheWrite; cache-reads bill at the cheap cacheRead rate,
 * cache-writes at 1.25× the input rate (Anthropic 5-min TTL), output at the out rate. */
export function computeCost(
  p: ModelPrice,
  u: { input: number; output: number; cacheRead: number; cacheWrite?: number },
): number {
  const write = u.cacheWrite ?? 0;
  const fresh = Math.max(0, u.input - u.cacheRead - write);
  return (
    (fresh * p.in + u.cacheRead * p.cacheRead + write * p.in * 1.25 + u.output * p.out) / 1_000_000
  );
}

const TABLE = parsePrices(process.env.DELTA_MODEL_PRICES);
const warned = new Set<string>();

/** cost_usd for a turn from its token usage — the entry point the provider calls on the
 * non-OpenRouter paths. Unpriced model → 0 (graceful, same as before) + a one-time warn. */
export function priceUsd(
  model: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite?: number },
): number {
  const p = resolvePrice(model, TABLE);
  if (!p) {
    if (!warned.has(model)) {
      warned.add(model);
      console.error(
        `delta: no price for model '${model}' — cost_usd stays 0; add it to DELTA_MODEL_PRICES to meter this path.`,
      );
    }
    return 0;
  }
  return computeCost(p, usage);
}
