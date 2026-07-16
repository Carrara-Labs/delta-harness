// SPDX-License-Identifier: Apache-2.0
// Delta's batteries-included default store bindings — the ONLY module that imports a
// backend (skill-registry.ts, vocab.ts). Kept separate from adapters.ts (the pure contract)
// so a product building on the harness imports the contract + its OWN adapters and
// never bundles skill-registry/knowledge-base (codex P1). Delta's own binary imports both, on purpose.

import type {
  CapabilityAdapter,
  CuratedAdapter,
  CuratedWrite,
  RoleHealth,
  SkillProposal,
  SkillRef,
} from "./adapters";
import { renderSkillIndex } from "./adapters";
import {
  findSkillBase,
  findSkillTool,
  proposeSkill,
  SKILL_WRITE_RE,
  searchSkills,
} from "./skill-registry";
import type { ToolCtx, Tools } from "./tools";
import { buildWriteArgs, NEUTRAL_VOCAB, type Vocab } from "./vocab";

/** The default capability store: the skill registry over the connected MCP tools. All the skill registry
 * specifics (verb regexes, field names, the version_conflict string) stay inside
 * skill-registry.ts, which this wraps. */
export class SkillRegistryAdapter implements CapabilityAdapter {
  readonly binding = "skills";

  constructor(private tools: Tools) {}

  health(): RoleHealth {
    // Presence of a write verb = bound; absence = unbound. A connected-but-erroring
    // backend (`unreachable`) needs the Phase-3 registry role-health to detect.
    return findSkillTool(this.tools, SKILL_WRITE_RE) ? "bound" : "unbound";
  }

  search(_query: string, ctx: ToolCtx): Promise<SkillRef[]> {
    // The query is unused today — the skill registry's skill_search returns a list index. Wiring
    // the task query into a top-K semantic search is the Phase-3 retrieval concern (§1.6).
    return searchSkills(this.tools, ctx);
  }

  get(name: string, ctx: ToolCtx) {
    return findSkillBase(this.tools, ctx, name);
  }

  async propose(
    p: SkillProposal & { idempotencyKey: string },
    ctx: ToolCtx,
  ): Promise<"ok" | "error"> {
    // proposeSkill routes create-vs-update, sends the exact keys each verb needs, and
    // retries once on version_conflict. Returns the reply on success, null on
    // no-write-tool / unrecoverable failure. `idempotencyKey` is unused on this direct
    // path — the skill registry versions are keyed by base_version, and reflection fires once
    // (background, best-effort, no retry loop). The key becomes load-bearing in the
    // Phase-2 promoter/outbox, which dedupes a crash between backend-ok and `promoted`.
    const res = await proposeSkill(this.tools, ctx, p);
    return res === null ? "error" : "ok";
  }
}

/** The default curated store: dispatches a reviewed write at the tool named by
 * vocab.writeVerbSuffix, with args from vocab.writeShape / buildWriteArgs. Fully generic —
 * the product's vocab supplies the tool name and the envelope. */
export class DefaultCuratedAdapter implements CuratedAdapter {
  constructor(
    private tools: Tools,
    private vocab: Vocab = NEUTRAL_VOCAB,
  ) {}

  get binding() {
    return `default:${this.vocab.writeVerbSuffix}`;
  }

  private writeTool() {
    return [...this.tools.values()].find((t) => t.name.endsWith(this.vocab.writeVerbSuffix));
  }

  health(): RoleHealth {
    return this.writeTool() ? "bound" : "unbound";
  }

  async propose(a: CuratedWrite, ctx: ToolCtx): Promise<"ok" | "error"> {
    const tool = this.writeTool();
    if (!tool) return "error";
    const args = buildWriteArgs(this.vocab, {
      runId: a.runId,
      kind: a.kind,
      content: a.content,
      ...(typeof a.confidence === "number" ? { confidence: a.confidence } : {}),
      review: a.review,
    });
    const res = await tool.execute(args as Record<string, unknown>, ctx);
    return res.startsWith("[tool error]") ? "error" : "ok";
  }
}

/** A compact "name — description" index string, or null when nothing is available —
 * the rendered form of a skill-registry capability search, for callers that want a ready block. */
export async function listSkillIndex(
  tools: Tools,
  ctx: ToolCtx,
  limit = 25,
): Promise<string | null> {
  const refs = await searchSkills(tools, ctx, limit);
  return refs.length ? renderSkillIndex(refs) : null;
}
