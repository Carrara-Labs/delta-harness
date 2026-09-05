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
export type ModelPrice = {
  in: number;
  out: number;
  cacheRead: number;
  /** Context window in tokens (0.2.13 / S6). Optional: an unknown model keeps today's hand-set
   * compaction default rather than inheriting a guess. Only seed a value the field has PROVEN,
   * because under-seeding costs a little extra compaction and over-seeding costs overflow. */
  window?: number;
};

// The OpenRouter-option fleet + the harness default, priced from
// the live OpenRouter models API (GET /api/v1/models), verified 2026-07-09. $/M tokens,
// prompt / completion / input_cache_read. Keyed by the model's last path segment (provider
// prefixes are stripped at match time), so "anthropic/claude-sonnet-5" and "claude-sonnet-5"
// both hit. Cache WRITES aren't billed here — the harness doesn't capture creation tokens;
// a small first-turn undercount, negligible against the cache-HIT-dominated steady state.
export const BAKED_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2 }, // harness default (config.ts)
  // window: a FIELD-DERIVED floor, not a published number. Aperture ran 249,127 input tokens on a
  // production lane with zero overflow, zero "prompt too long" and zero forced-compaction retries,
  // with no 1M beta header sent (see FAST_MODE_BETA in provider.ts — the only beta we send). A 200k
  // window rejects that call, so the real window is above 249,127; 249,000 sits under the proven
  // floor and needs no argument. Raise it only on evidence, never on a spec sheet.
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, window: 249_000 }, // api pricing 2026-07-27
  "claude-sonnet-4.6": { in: 3, out: 15, cacheRead: 0.3 }, // fleet default (openrouter)
  "claude-opus-4.8": { in: 5, out: 25, cacheRead: 0.5 },
  "claude-haiku-4.5": { in: 1, out: 5, cacheRead: 0.1 }, // utility-model default
  "gpt-5.5": { in: 5, out: 30, cacheRead: 0.5 },
  "gemini-3.5-flash": { in: 1.5, out: 9, cacheRead: 0.15 },
  // Bench/fleet GLMs — without these the subscription paths meter $0 (verified live 2026-07-10).
  "glm-5.2": { in: 0.84, out: 2.64, cacheRead: 0.156 },
  "glm-5": { in: 0.6, out: 1.92, cacheRead: 0.12 },
  "gpt-5": { in: 1.25, out: 10, cacheRead: 0.125 }, // codex #5: was inheriting 5.5's price via substring
  // GPT-5.6 family — live pricing page 2026-09-05 (sol cut to $4/$20/$0.40 since the 08-19 read;
  // terra/luna unchanged). Without these, sol prefix-matched "gpt-5" and the metered demo lane
  // under-billed ~4×. Cache writes bill 1.25× (computeCost's existing multiplier — OpenAI's 5.6+
  // rate happens to match Anthropic's 5-min rate exactly). The >272K long-context tier (2× in /
  // 1.5× out) is NOT modeled; override via DELTA_MODEL_PRICES if a lane lives there. "gpt-5.6"
  // is the server-side alias for sol.
  "gpt-5.6": { in: 4, out: 20, cacheRead: 0.4 },
  "gpt-5.6-sol": { in: 4, out: 20, cacheRead: 0.4 },
  "gpt-5.6-terra": { in: 2, out: 12, cacheRead: 0.2 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2, cacheRead: 0.02 },
  // GPT-6 Astra (0.2.18) — same page, same date. No `window` on purpose: a window also CLAMPS an
  // operator's DELTA_COMPACT_AT_TOKENS (maxSafeCeiling), and the only honest number here, the
  // 272K price cliff, is a cost choice rather than a capacity. The 120k default applies; a lane
  // that wants more sets DELTA_MODEL_PRICES={"gpt-6-astra":{..., "window": N}} and accepts the
  // 2× / 1.5× tier above 272K.
  "gpt-6-astra": { in: 10, out: 50, cacheRead: 1 },
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
      ) {
        const key = k.toLowerCase();
        // MERGE over the baked entry rather than replacing it (S6): a plain price override must not
        // silently DELETE the model's `window` and drop it back to the 120k default. Anyone already
        // running DELTA_MODEL_PRICES would have lost the new field on upgrade without noticing —
        // a knob quietly disabling a derived value is the exact failure this batch exists to fix.
        const window =
          typeof v.window === "number" && Number.isFinite(v.window) && v.window > 0
            ? Math.floor(v.window)
            : out[key]?.window;
        out[key] = {
          in: v.in,
          out: v.out,
          cacheRead: v.cacheRead,
          ...(window ? { window } : {}),
        };
      }
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

/** Tokens held back from the derived compaction ceiling for the model's OWN output.
 *
 * Deliberately ONE conservative constant rather than a computed `max_output` (codex): there is no
 * single output cap to subtract today. The main loop passes no `maxTokens` at all, so the
 * Chat-Completions and Responses paths send no cap; the Anthropic path applies a private default
 * plus reasoning headroom that varies with effort. A derived number would be fiction, so this is
 * sized to the worst of those plus slack. */
export const OUTPUT_RESERVE = 40_000;

/** Below this a derived ceiling is not a ceiling, it is a compaction loop: every non-trivial
 * request would exceed it on the first turn. A `window` that cannot clear it is treated as UNKNOWN
 * rather than obeyed — an operator override of `{window: 30000}` would otherwise derive a ceiling of
 * 0 and compact every request forever (codex). */
const MIN_USABLE_CEILING = 16_000;

/** The usable ceiling for one model, or null when its window is unknown or unusably small. */
function usableCeiling(model: string, table: Record<string, ModelPrice> = TABLE): number | null {
  const w = resolvePrice(model, table)?.window;
  if (!w) return null;
  const c = w - OUTPUT_RESERVE;
  return c >= MIN_USABLE_CEILING ? c : null;
}

/** The compaction ceiling derived from what the MODELS can actually take (S6).
 *
 * Two rules, both learned the hard way:
 *  1. Every cascade member counts. Delta fails over between models, so a gate set from one known
 *     250k model would overflow an unknown fallback. An unknown member therefore contributes the
 *     conservative default rather than being skipped (codex).
 *  2. The MINIMUM wins, because the gate is global while the model serving any given turn is not.
 *
 * Returns null when no model is known at all, so the caller keeps today's behaviour instead of
 * inheriting a guess. */
export function deriveContextCeiling(
  models: string[],
  fallback: number,
  table: Record<string, ModelPrice> = TABLE,
): number | null {
  if (!models.length) return null;
  let known = false;
  let min = Number.POSITIVE_INFINITY;
  for (const m of models) {
    const c = usableCeiling(m, table);
    if (c !== null) known = true;
    // An unknown model contributes `fallback`, NOT nothing — skipping it is what would let a known
    // large window set a ceiling that overflows the model actually serving the turn.
    min = Math.min(min, c ?? fallback);
  }
  return known ? min : null;
}

/** The largest ceiling the cascade can survive — used to CLAMP an operator override. A
 * `DELTA_COMPACT_AT_TOKENS` above this turns compaction into overflow, which is silent today and is
 * the inverse of the bug that motivated this work. Null when no model is known.
 *
 * This protects the OVERRIDE, not the table: a wrong `window` entry still overflows, and only
 * conservative seeding plus the existing post-provider overflow retry guard that. */
export function maxSafeCeiling(
  models: string[],
  table: Record<string, ModelPrice> = TABLE,
): number | null {
  let min = Number.POSITIVE_INFINITY;
  for (const m of models) {
    // KNOWN windows only, and this asymmetry with `deriveContextCeiling` is deliberate (codex asked).
    // The two answer different questions. The DEFAULT is ours to choose, so an unknown member makes
    // it conservative. An OVERRIDE is the operator's explicit decision, and we overrule it only
    // where we have positive evidence it cannot work. Counting unknowns here would clamp every
    // deployment whose cascade contains one unpriced model — which is most of them, since only one
    // model carries a window today — silently halving ceilings that are working fine. Overruling an
    // explicit choice on the basis of ignorance is the failure mode this batch exists to remove.
    const c = usableCeiling(m, table);
    if (c !== null) min = Math.min(min, c);
  }
  return Number.isFinite(min) ? min : null;
}
