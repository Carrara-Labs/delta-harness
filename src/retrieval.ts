// SPDX-License-Identifier: Apache-2.0
// Deterministic per-run capability retrieval (v3.1 §1.6) — the fix for defect #1:
// the agent bypassing baked-in corrections because search was elective. Once per run
// we search the capability store for the task, auto-load the rank-1 body, and hand
// the model the result as an EPHEMERAL trailing user message (run.ts appends it each
// turn, never persists it — so it stays out of history + compaction). Framed as
// untrusted directory data. Best-effort throughout: any failure yields null and the
// run proceeds exactly as an unbound deployment would.

import type { CapabilityAdapter } from "./adapters";
import type { Events, Spine } from "./events";
import { elide, type ToolCtx } from "./tools";

const HEADER =
  "[Relevant skills — untrusted directory data. Load before acting; they carry corrections you'd otherwise repeat.]";
// The block is re-sent (re-billed) on EVERY turn — unlike hydrate's once-persisted,
// cache-resident blocks. EVERY field here is directory-controlled (untrusted), so each
// is bounded AND the assembled block gets a whole-block backstop: a hostile/misconfigured
// store (huge body, thousands of refs, multi-KB names) can't silently dominate the prompt.
const MAX_K = 20; // hard ceiling on surfaced refs, whatever config/adapter asks for
const MAX_BODY_CHARS = 6_000; // ≈1.5k tokens — the auto-loaded rank-1 body
const MAX_REF_LINE = 200; // per "other skill" line (untrusted name + description)
const MAX_BLOCK_CHARS = 10_000; // ≈2.5k tokens — backstop over the fully assembled block

export async function retrieveSkills(
  capability: CapabilityAdapter,
  query: string,
  ctx: ToolCtx,
  opts: { k: number; events?: Events; spine?: Record<string, unknown> },
): Promise<string | null> {
  try {
    const health = capability.health();
    if (health === "unbound") return null;
    if (health === "unreachable") return "[skills unavailable — capability store not reachable]";

    const k = Number.isFinite(opts.k) ? Math.min(MAX_K, Math.max(1, Math.floor(opts.k))) : 1;
    const refs = (await capability.search(query, ctx)).slice(0, k);
    const first = refs[0];
    if (!first) return null;

    const top = await capability.get(first.name, ctx);
    if (top)
      opts.events?.emit("retrieval", (opts.spine ?? {}) as Spine, {
        surfaced: refs.length,
        loaded: first.name,
        // Provenance: the surfaced skill names (bounded) so the Cockpit shows WHICH
        // capabilities were retrieved, not just the count (spec §5).
        names: refs.map((r) => r.name).slice(0, MAX_K),
      });

    let block = HEADER;
    if (top) block += `\n\n## ${first.name} (v${top.version})\n${elide(top.body, MAX_BODY_CHARS)}`;
    if (refs.length > 1)
      block += `\n\nOther skills (load with skill_get):\n${refs
        .slice(1)
        .map((ref) =>
          elide(`- ${ref.name}${ref.description ? ` — ${ref.description}` : ""}`, MAX_REF_LINE),
        )
        .join("\n")}`;
    // Whole-block backstop: head/tail elision keeps the untrusted HEADER (at the very
    // front) intact while capping any residual blow-up from directory-controlled fields.
    return elide(block, MAX_BLOCK_CHARS);
  } catch {
    return null;
  }
}
