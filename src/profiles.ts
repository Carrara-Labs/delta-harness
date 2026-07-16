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
  work: {
    name: "work",
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
  chat: {
    name: "chat",
    // No hands that mutate beyond the workspace, no delegation: chat placements
    // must stay safe even when driven by untrusted inbound (spec §J trust model).
    // `recall` (read this thread's history) and `todo` (this thread's own plan) are read/own-state
    // only → safe here, and a chat placement can still hit forced compaction + long tasks.
    allowed: ["web_search", "web_fetch", "read_file", "list_dir", "recall", "todo"],
    pinned: ["web_search", "web_fetch", "read_file", "list_dir", "recall", "todo"],
    budget: { maxSteps: 10, maxTokens: 100_000, maxCostUsd: 0.25 },
  },
};

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

/** The daemon's placement sets the ceiling (DELTA_PROFILE); request metadata may
 * only narrow it, never escalate — callers are untrusted (spec §J). */
export function getProfile(requested: unknown, ceiling = "work"): Profile {
  const max = PROFILES[ceiling] ?? (PROFILES.work as Profile);
  const req = typeof requested === "string" ? PROFILES[requested] : undefined;
  const selected = req && isSubset(req, max) ? req : max;
  const envTokens = Number(process.env.DELTA_MAX_TOKENS);
  const envCost = Number(process.env.DELTA_MAX_COST_USD);
  return {
    ...selected,
    budget: {
      ...selected.budget,
      ...(Number.isFinite(envTokens) && envTokens >= 0
        ? { maxTokens: Math.min(selected.budget.maxTokens, envTokens) }
        : {}),
      ...(Number.isFinite(envCost) && envCost >= 0
        ? { maxCostUsd: Math.min(selected.budget.maxCostUsd, envCost) }
        : {}),
    },
  };
}
