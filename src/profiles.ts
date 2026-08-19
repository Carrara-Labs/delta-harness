// SPDX-License-Identifier: Apache-2.0
// Run profiles (spec §B/§D): named presets bundling an allowed tool subset, a
// pinned subset (schemas resident from step one), and budgets. Budgets, not
// timers — steps, tokens, and dollars cap a run; wall-clock never does.

export type Budget = { maxSteps: number; maxTokens: number; maxCostUsd: number };

export type Profile = {
  name: string;
  /** Tools this profile may use at all. "*" = everything registered. */
  allowed: string[] | "*";
  /** Subset whose schemas ride in every model call; the rest need search_tools.
   *  "*" = pin everything (only safe for a tiny tool set — a large MCP surface blows the token
   *  budget on step 1). "core" = the lean default: builtins + a curated knowledge-base core, with every
   *  MCP-connector tool discoverable via search_tools. An explicit list pins exactly those. */
  pinned: string[] | "*" | "core";
  budget: Budget;
};

export const PROFILES: Record<string, Profile> = {
  trusted: {
    name: "trusted",
    allowed: "*",
    // Lean by default: a Delta may hold hundreds of connector tools (knowledge base + Gmail + Slack + …).
    // Pinning all of them resident exceeds the per-turn token budget before step 1 (the 464-tool
    // brick). "core" pins only the everyday surface; the rest ride search_tools.
    pinned: "core",
    // Generous while we validate real owner tasks — budgets are counted on FRESH (non-cached)
    // tokens (see billedTokens in run.ts), so this is real work, not re-sent cached context. Steps
    // raised in lockstep so they don't become the artificial limiter. Tighten once usage is known.
    budget: { maxSteps: 100, maxTokens: 2_000_000, maxCostUsd: 5.0 },
  },
  safe: {
    name: "safe",
    // No hands that mutate beyond the workspace, no delegation: the safe floor
    // must stay safe even when driven by untrusted inbound (spec §J trust model).
    // `recall` (read this thread's history) and `todo` (this thread's own plan) are read/own-state
    // only → safe here, and a safe placement can still hit forced compaction + long tasks.
    allowed: ["web_search", "web_fetch", "read_file", "list_dir", "recall", "todo"],
    pinned: ["web_search", "web_fetch", "read_file", "list_dir", "recall", "todo"],
    budget: { maxSteps: 10, maxTokens: 100_000, maxCostUsd: 0.25 },
  },
};

// The two tiers were renamed in 0.2.7 (chat→safe, work→trusted) to name the capability
// axis, not an activity. The old names stay as aliases so existing DELTA_PROFILE=work /
// =chat deployments and request metadata keep resolving unchanged — a pure rename, no
// behavior change.
const ALIASES: Record<string, string> = { chat: "safe", work: "trusted" };
/** The raw safe-floor profile (pre-env-override). Safe mode clones this directly. */
export const SAFE_FLOOR = PROFILES.safe as Profile;
function resolveProfile(key: string): Profile | undefined {
  return PROFILES[key] ?? PROFILES[ALIASES[key] ?? ""];
}

/** Parse a comma-separated tool-name list env var. `undefined` = unset (no override);
 *  `[]` = set-but-empty OR malformed, which the envelope knob treats as fail-safe (the safe
 *  floor). All-or-nothing: any member that isn't a plausible tool identifier voids the whole
 *  var, so a typo never yields a silent partial set. */
function envToolList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.some((p) => !/^[A-Za-z0-9_-]{1,128}$/.test(p)) ? [] : parts;
}

/** Intersect an env tool list with the tier's own allowed set: the ceiling is the honest max,
 *  so DELTA_ALLOWED_TOOLS on a `safe` daemon can NARROW but never escalate it. Build a custom
 *  powerful envelope from `trusted` (allowed "*", so the list passes through) plus the list. */
function clampTools(list: string[], ceiling: string[] | "*"): string[] {
  return ceiling === "*" ? list : list.filter((t) => ceiling.includes(t));
}

/** a is no more permissive than b: tools ⊆ and budgets ≤. */
export function isSubset(a: Profile, b: Profile): boolean {
  const toolsOk =
    b.allowed === "*" || (a.allowed !== "*" && a.allowed.every((n) => b.allowed.includes(n)));
  const budgetOk =
    a.budget.maxSteps <= b.budget.maxSteps &&
    a.budget.maxTokens <= b.budget.maxTokens &&
    a.budget.maxCostUsd <= b.budget.maxCostUsd;
  return toolsOk && budgetOk;
}

/** Trusted-gateway self-write: grant (and pin) `remember` to a restricted profile
 * when the operator vouches (DELTA_ALLOW_SELF_WRITE) that an authenticated gateway
 * fronts the daemon. A "*"-tools profile already has it; only a finite profile that
 * lacks it changes. Pinned so the model actually sees the tool. */
export function grantSelfWrite(profile: Profile, allow: boolean): Profile {
  if (!allow || profile.allowed === "*" || profile.allowed.includes("remember")) return profile;
  return {
    ...profile,
    allowed: [...profile.allowed, "remember"],
    pinned: Array.isArray(profile.pinned) ? [...profile.pinned, "remember"] : profile.pinned,
  };
}

/** The daemon's placement sets the ceiling (DELTA_PROFILE); request metadata may
 * only narrow it, never escalate — callers are untrusted (spec §J). The ENV values
 * are different: they are the operator's own knobs on their own daemon, so they
 * OVERRIDE the profile's budget in either direction (a $5-per-run default is right
 * for a chat sidekick and wrong for a deep-research agent; before this, a raised
 * DELTA_MAX_COST_USD was silently clamped back down and operators never knew). */
export function getProfile(requested: unknown, ceiling = "trusted"): Profile {
  const max = resolveProfile(ceiling) ?? (PROFILES.trusted as Profile);
  const req = typeof requested === "string" ? resolveProfile(requested) : undefined;
  const selected = req && isSubset(req, max) ? req : max;
  // Envelope knob (0.2.7): DELTA_ALLOWED_TOOLS / DELTA_PINNED_TOOLS let an operator define any
  // point on the capability spectrum without minting a named profile. Operator-owned env (like the
  // budget overrides below), so it SETS the tool surface directly. Fail-safe: a var that is set but
  // parses to nothing falls back to the safe floor's set, never to allow-all.
  const allowed = envToolList("DELTA_ALLOWED_TOOLS");
  const pinned = envToolList("DELTA_PINNED_TOOLS");
  const finalAllowed: string[] | "*" = (() => {
    if (allowed === undefined) return selected.allowed;
    const c = allowed.length ? clampTools(allowed, selected.allowed) : [];
    return c.length ? c : SAFE_FLOOR.allowed;
  })();
  const finalPinned: string[] | "*" | "core" = (() => {
    if (pinned === undefined) return selected.pinned;
    const c = pinned.length ? clampTools(pinned, finalAllowed) : [];
    return c.length ? c : SAFE_FLOOR.pinned;
  })();
  const envSteps = Number(process.env.DELTA_MAX_STEPS);
  const envTokens = Number(process.env.DELTA_MAX_TOKENS);
  const envCost = Number(process.env.DELTA_MAX_COST_USD);
  return {
    ...selected,
    allowed: finalAllowed,
    pinned: finalPinned,
    budget: {
      ...selected.budget,
      // ≥ 1, DELIBERATELY unlike the other two axes: a zero token or cost budget is a coherent
      // "refuse all work" setting, but maxSteps 0 fires the guard before step 1 and every run
      // fails with a budget error the operator cannot diagnose (D-11).
      ...(Number.isFinite(envSteps) && envSteps >= 1 ? { maxSteps: Math.floor(envSteps) } : {}),
      ...(Number.isFinite(envTokens) && envTokens >= 0 ? { maxTokens: envTokens } : {}),
      ...(Number.isFinite(envCost) && envCost >= 0 ? { maxCostUsd: envCost } : {}),
    },
  };
}
