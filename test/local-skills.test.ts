import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { LocalSkillsAdapter } from "../src/local-skills";
import type { ChatRequest } from "../src/provider";
import { Queue } from "../src/queue";
import { retrieveSkills } from "../src/retrieval";
import { stripSkillRegistryTools } from "../src/skill-registry";
import type { ToolCtx, ToolDef, Tools } from "../src/tools";
import { makeDeps, ok, textResult } from "./helpers";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "delta-local-skills-"));
  dirs.push(dir);
  mkdirSync(join(dir, "skills"));
  return dir;
}

function writeSkill(root: string, name: string, description: string, body: string): void {
  mkdirSync(join(root, "skills", name));
  writeFileSync(
    join(root, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  );
}

const tool = (name: string): ToolDef => ({
  name,
  description: name,
  parameters: { type: "object" },
  idempotent: true,
  execute: async () => "ok",
});

describe("LocalSkillsAdapter", () => {
  test("search is metadata-only and deterministic; get reads one body on demand", async () => {
    const root = workspace();
    writeSkill(root, "safe-deploy", "Deploy safely with verification", "SECRET BODY");
    writeSkill(root, "rollback", "Restore a release", "ROLLBACK BODY");
    const local = new LocalSkillsAdapter(root);

    expect(local.health()).toBe("bound");
    const refs = await local.search("deploy verification", ctx);
    expect(refs.map((r) => r.name)).toEqual(["safe-deploy", "rollback"]);
    expect(refs[0]).toEqual({
      name: "safe-deploy",
      description: "Deploy safely with verification",
      version: 1,
      location: "skills/safe-deploy/SKILL.md",
    });
    expect(JSON.stringify(refs)).not.toContain("SECRET BODY");
    expect(await local.get("safe-deploy", ctx)).toEqual({ version: 1, body: "SECRET BODY" });
    expect("propose" in local).toBe(false);
  });

  test("progressive disclosure gives a read_file hint and never auto-loads the body", async () => {
    const root = workspace();
    writeSkill(root, "safe-deploy", "Deploy safely", "BODY MUST STAY OUT");
    const local = new LocalSkillsAdapter(root);
    let gets = 0;
    const original = local.get.bind(local);
    local.get = async (...args) => {
      gets++;
      return original(...args);
    };

    const block = await retrieveSkills(local, "deploy", ctx, { k: 5 });
    expect(block).toContain("safe-deploy — Deploy safely");
    expect(block).toContain("Read skills/safe-deploy/SKILL.md with read_file before acting");
    expect(block).not.toContain("BODY MUST STAY OUT");
    expect(gets).toBe(0);
  });

  test("malformed metadata, mismatched names, traversal, and symlinks are rejected", async () => {
    const root = workspace();
    writeSkill(root, "good", "A valid local procedure", "ok");
    mkdirSync(join(root, "skills", "malformed"));
    writeFileSync(join(root, "skills", "malformed", "SKILL.md"), "name: malformed\nbody");
    mkdirSync(join(root, "skills", "mismatch"));
    writeFileSync(
      join(root, "skills", "mismatch", "SKILL.md"),
      "---\nname: another\ndescription: wrong directory\n---\nbody",
    );

    const external = workspace();
    writeSkill(external, "linked", "Outside the tree", "outside");
    symlinkSync(join(external, "skills", "linked"), join(root, "skills", "linked"), "dir");
    mkdirSync(join(root, "skills", "file-link"));
    symlinkSync(
      join(external, "skills", "linked", "SKILL.md"),
      join(root, "skills", "file-link", "SKILL.md"),
    );

    const local = new LocalSkillsAdapter(root);
    expect((await local.search("anything", ctx)).map((r) => r.name)).toEqual(["good"]);
    expect(await local.get("../linked", ctx)).toBeNull();
    expect(await local.get("linked", ctx)).toBeNull();
    expect(await local.get("file-link", ctx)).toBeNull();
  });
});

describe("skills selector wiring", () => {
  test("defaults to mcp, accepts local/off, and unknown values fall back to mcp", () => {
    expect(loadConfig({}).skills).toBe("mcp");
    expect(loadConfig({ DELTA_SKILLS: "mcp" }).skills).toBe("mcp");
    expect(loadConfig({ DELTA_SKILLS: "local" }).skills).toBe("local");
    expect(loadConfig({ DELTA_SKILLS: "off" }).skills).toBe("off");
    expect(loadConfig({ DELTA_SKILLS: "wat" }).skills).toBe("mcp");
  });

  test("local/off stripping removes only known MCP skill-registry tools", () => {
    const tools: Tools = new Map(
      [
        "skills__skill_search",
        "skills__skill_get",
        "skills__skill_file_get",
        "skills__skill_versions",
        "skills__skill_create",
        "skills__skill_update",
        "skills__skill_propose",
        "other__search",
      ].map((name) => [name, tool(name)]),
    );
    stripSkillRegistryTools(tools);
    expect([...tools.keys()]).toEqual(["other__search"]);
  });

  test("off skips run retrieval and removes all skill prose from reflection", async () => {
    const seen: ChatRequest[] = [];
    let calls = 0;
    const capability = {
      health: () => "bound" as const,
      search: async () => {
        throw new Error("off must not search");
      },
      get: async () => {
        throw new Error("off must not load");
      },
    };
    const deps = makeDeps(
      async (req) => {
        seen.push(req);
        calls++;
        return calls === 1
          ? textResult("done")
          : ok({ role: "assistant", content: '{"kind":"none"}' });
      },
      new Map(),
      { skills: "off", capability, reflect: true },
    );
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "do the task" }).id);
    for (let i = 0; i < 50 && seen.length < 2; i++) await Bun.sleep(10);

    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen[0]?.messages)).not.toContain("Relevant skills");
    expect(JSON.stringify(seen[1]?.messages)).not.toMatch(/skill/i);
  });

  test("local procedures stay in governed memory and never target local authoring", async () => {
    const root = workspace();
    writeSkill(root, "safe-deploy", "Deploy safely", "verify first");
    const local = new LocalSkillsAdapter(root);
    let calls = 0;
    const deps = makeDeps(
      async () => {
        calls++;
        return calls === 1
          ? textResult("done")
          : ok({
              role: "assistant",
              content:
                '{"kind":"skill_improvement","name":"safe-deploy","content":"verify twice","body":"Verify twice.","confidence":0.9}',
            });
      },
      new Map(),
      { workspace: root, skills: "local", capability: local, reflect: true },
    );
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "deploy" }).id);
    for (let i = 0; i < 50; i++) {
      const count = (deps.db.query("SELECT COUNT(*) AS n FROM memory").get() as { n: number }).n;
      if (count) break;
      await Bun.sleep(10);
    }
    expect(
      (deps.db.query("SELECT artifact_kind FROM memory").get() as { artifact_kind: string })
        .artifact_kind,
    ).toBe("procedure");
    expect((deps.db.query("SELECT COUNT(*) AS n FROM promotion").get() as { n: number }).n).toBe(0);
    expect("propose" in local).toBe(false);
  });
});
