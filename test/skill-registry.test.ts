// G5b: the skill-promotion path. proposeSkill must speak the skill registry's real write API —
// a CREATE (skill_create, needs a description) for a brand-new skill, an UPDATE
// (skill_update, needs base_version) when improving a known version — and route to
// the matching tool so an unknown-key-strict deployment doesn't reject the call.

import { describe, expect, test } from "bun:test";
import { proposeSkill } from "../src/skill-registry";
import type { ToolCtx, ToolDef, Tools } from "../src/tools";

const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

function spy(name: string): { tool: ToolDef; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    tool: {
      name,
      description: "skills write",
      parameters: { type: "object" },
      idempotent: false,
      execute: async (args) => {
        calls.push(args);
        return `ok (${name})`;
      },
    },
  };
}

describe("proposeSkill", () => {
  test("no version → CREATE: routes to skill_create with a description", async () => {
    const create = spy("skills__skill_create");
    const update = spy("skills__skill_update");
    const tools: Tools = new Map([
      [create.tool.name, create.tool],
      [update.tool.name, update.tool],
    ]);
    const res = await proposeSkill(tools, ctx, {
      name: "triage-inbox",
      body: "1. batch by sender\n2. star what needs a reply",
      description: "Use when clearing a noisy inbox fast.",
    });
    expect(res).toContain("skill_create");
    expect(update.calls.length).toBe(0); // did NOT hit update
    const a = create.calls[0] as Record<string, unknown>;
    expect(a.name).toBe("triage-inbox");
    expect(a.body).toContain("batch by sender");
    expect(a.description).toBe("Use when clearing a noisy inbox fast.");
    expect("base_version" in a).toBe(false); // create carries no version
  });

  test("with a version → UPDATE: routes to skill_update with base_version (exact key)", async () => {
    const create = spy("skills__skill_create");
    const update = spy("skills__skill_update");
    const tools: Tools = new Map([
      [create.tool.name, create.tool],
      [update.tool.name, update.tool],
    ]);
    const res = await proposeSkill(tools, ctx, {
      name: "weekly-update",
      body: "1. pull the dashboard\n2. draft\n3. propose",
      basedOnVersion: 3,
      note: "sharpen the draft step",
    });
    expect(res).toContain("skill_update");
    expect(create.calls.length).toBe(0);
    const a = update.calls[0] as Record<string, unknown>;
    expect(a.base_version).toBe(3); // the key the skill registry actually requires
    expect(a.change_summary).toBe("sharpen the draft step");
    expect("description" in a).toBe(false); // update doesn't take a description
  });

  test("derives a valid (≥20 char) description when the caller gives none or a short one", async () => {
    const create = spy("skills__skill_create");
    const tools: Tools = new Map([[create.tool.name, create.tool]]);
    await proposeSkill(tools, ctx, {
      name: "draft-from-kb",
      body: "Pull the entity context, then draft the memo in the house voice.",
    });
    const desc = create.calls[0]?.description as string;
    expect(desc.length).toBeGreaterThanOrEqual(20);
    expect(desc).toContain("Pull the entity context");
  });

  test("no skill-registry write tool connected → null (caller degrades to a learning)", async () => {
    const kb = spy("kb__propose_submission"); // not a skill tool
    const tools: Tools = new Map([[kb.tool.name, kb.tool]]);
    const res = await proposeSkill(tools, ctx, { name: "x", body: "y" });
    expect(res).toBeNull();
    expect(kb.calls.length).toBe(0);
  });

  test("a single `propose` verb takes the create args", async () => {
    const propose = spy("skills__skill_propose");
    const tools: Tools = new Map([[propose.tool.name, propose.tool]]);
    await proposeSkill(tools, ctx, {
      name: "research-a-company",
      body: "Gather sources, synthesize, cite inline.",
      description: "Use when you need a fast, sourced company brief.",
    });
    expect(propose.calls[0]?.description).toBe("Use when you need a fast, sourced company brief.");
  });
});
