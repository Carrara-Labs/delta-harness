// SPDX-License-Identifier: Apache-2.0
// Task-start hydration (spec §E / G3): before the first model call, pull a context
// pack so the model starts primed instead of spending a turn fetching. Three
// sources, all best-effort (a failure never blocks a run):
//   • the recency read tools (dashboard, recent learnings) scoped to the subject;
//   • a TASK-KEYED knowledge-base search — the relevant knowledge for THIS ask, not just the
//     most recent (G3a); and
//   • the local agent-self memory table — the standalone fallback, finally READ, not
//     just written (G3c).

import { elide, type ToolCtx, type Tools } from "./tools";

export type HydrateSpec = {
  /** Registry tool names to call at start, e.g. <server>__get_my_dashboard. */
  toolNames: string[];
  /** Subject scoping — key/value pairs spread into every hydration read call.
   * Built by the caller from vocab.subjectKeys (was hard-coded entity/person —
   * Sprint 6: a recruiting product scopes on candidate/job with no code edit). */
  subject?: Record<string, string>;
  /** The task itself (req.input) — drives the task-keyed relevance search (G3a). */
  query?: string;
  /** Knowledge-base search tool for the relevance query; absent → recency-only. */
  searchTool?: string;
  /** Total chars across ALL blocks (Sprint 5 §3.4 — budget by tokens, not rows).
   * The old shape was 20k PER block: three reads + a search could inject ~80k
   * chars (~20k tokens) into the cached prefix of every turn in the session. */
  budgetChars?: number;
};

const HYDRATE_BUDGET = 16_000; // ~4k tokens total
const SEARCH_RESERVE = 4_000; // the task-keyed search is the highest-signal block —
// reserve a quarter so recency dumps can't crowd it out.

/** Args a hydration read-tool likely accepts, derived from the run's subject.
 * Extra keys a given tool doesn't declare are harmless (MCP ignores them). */
function argsFor(spec: HydrateSpec): Record<string, unknown> {
  return { ...(spec.subject ?? {}), limit: 20 };
}

/** Returns a context block (or null if nothing hydrated). */
export async function hydrate(
  tools: Tools,
  ctx: ToolCtx,
  spec: HydrateSpec,
): Promise<string | null> {
  const blocks: string[] = [];
  const total = spec.budgetChars ?? HYDRATE_BUDGET;
  const search = spec.searchTool ? tools.get(spec.searchTool) : undefined;
  const query = spec.query?.trim() ?? "";
  const willSearch = Boolean(search && query.length >= 2); // the knowledge base requires min 2 chars
  // A tiny explicit budget shrinks the reserve too — the reserve is a floor for the
  // search block, never a license to exceed the total.
  const reserve = willSearch ? Math.min(SEARCH_RESERVE, total) : 0;
  let used = 0; // charged on FULL block length (heading included), not just the body
  // 1) Recency reads — what's on the agent's plate for this subject. Bounded here:
  // hydrate calls tools DIRECTLY (not via execCall's central cap+spill), and MCP
  // results arrive raw — an unbounded read would bloat the task-start prompt.
  for (const name of spec.toolNames) {
    const remaining = total - reserve - used;
    if (remaining <= 0) break; // budget spent — skip the MCP round-trip too
    const tool = tools.get(name);
    if (!tool) continue; // no knowledge base connected / tool absent → skip silently
    try {
      const out = await tool.execute(argsFor(spec), ctx);
      if (out && !out.startsWith("[tool error]")) {
        const block = `### ${name}\n${elide(out.trim(), remaining)}`;
        blocks.push(block);
        used += block.length;
      }
    } catch {
      // best-effort — a failed hydration read never blocks the run
    }
  }
  // 2) Task-keyed relevance search — the knowledge that matches THIS ask (G3a).
  // A recency dump surfaces what's new; this surfaces what's relevant. Unused
  // recency budget rolls over INTO the search (reserve is a floor, not a cap).
  if (search && willSearch) {
    try {
      const q = query.slice(0, 500); // knowledge-base schema: q string min 2 max 500
      const out = await search.execute(
        // Both key spellings: some search tools take `q` (zod strips the
        // rest); another deployment's search may take `query`.
        { q, query: q, ...argsFor(spec), limit: 8 },
        ctx,
      );
      if (out && !out.startsWith("[tool error]"))
        blocks.push(
          `### ${spec.searchTool} (relevant to this task)\n${elide(out.trim(), Math.max(reserve, total - used))}`,
        );
    } catch {
      // best-effort
    }
  }
  if (blocks.length === 0) return null;
  return `[Task-start context — hydrated from the knowledge base. Treat as background you already know; do not re-fetch it.]\n\n${blocks.join("\n\n")}`;
}

// recallAgentMemory moved to memory.ts (Sprint 5 §3.3) — the governed rail owns
// both its write (remember) and its read.
export { type RecalledMemory, recallAgentMemory } from "./memory";
