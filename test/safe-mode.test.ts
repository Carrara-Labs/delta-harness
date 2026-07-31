import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { ChatRequest } from "../src/provider";
import { Queue } from "../src/queue";
import type { ToolDef } from "../src/tools";
import { makeDeps, textResult } from "./helpers";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tool = (name: string): ToolDef => ({
  name,
  description: name,
  parameters: { type: "object" },
  idempotent: true,
  execute: async () => "ok",
});

describe("DELTA_SAFE_MODE", () => {
  test("forces the neutral primary-only boot config without parsing optional inputs", () => {
    const cfg = loadConfig({
      DELTA_SAFE_MODE: "1",
      DELTA_PROFILE: "trusted",
      DELTA_ALLOW_SELF_WRITE: "1",
      DELTA_REFLECT: "1",
      DELTA_SKILLS: "broken",
      DELTA_MCP_SERVERS: "{broken",
      DELTA_PROVIDERS: "{broken",
      DELTA_MODEL_FALLBACKS: "fallback/a,fallback/b",
      DELTA_HYDRATE_TOOLS: "kb__read",
      DELTA_HYDRATE_SEARCH_TOOL: "kb__search",
      DELTA_VOCAB: "{broken",
      DELTA_VISION_MODELS: "[",
      MODEL_HEADERS: "{broken",
      DELTA_MODEL_PRIMARY: "primary/model",
      DELTA_UTILITY_MODEL: "utility/model",
    });

    expect(cfg.safeMode).toBe(true);
    expect(cfg.profile).toBe("safe");
    expect(cfg.allowSelfWrite).toBe(false);
    expect(cfg.reflect).toBe(false);
    expect(cfg.skills).toBe("off");
    expect(cfg.mcpServers).toEqual([]);
    expect(cfg.hydrateTools).toEqual([]);
    expect(cfg.hydrateSearchTool).toBeUndefined();
    expect(cfg.provider.models).toEqual(["primary/model"]);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.provider.headers).toBeUndefined();
    expect(cfg.utilityModel).toBe("");
    expect(cfg.vocab.writeNoun).toBe("the record");
  });

  test("run bypasses env/profile grants and all workspace prompt layers", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "delta-safe-"));
    dirs.push(workspace);
    writeFileSync(join(workspace, "DELTA.md"), "POISONED SELF");
    process.env.DELTA_ALLOWED_TOOLS = "remember";
    process.env.DELTA_PINNED_TOOLS = "remember";
    let seen: ChatRequest | undefined;
    try {
      const deps = makeDeps(
        async (req) => {
          seen = req;
          return textResult("recovered");
        },
        new Map([
          ["read_file", tool("read_file")],
          ["remember", tool("remember")],
        ]),
        {
          workspace,
          safeMode: true,
          profile: "trusted",
          allowSelfWrite: true,
          skills: "off",
          contextStable: "POISONED STABLE CONTEXT",
          contextTurn: "POISONED TURN CONTEXT",
          policy: { template: "POISONED POLICY", fromFile: true },
        },
      );
      const queue = new Queue(deps);
      const done = await queue.wait(
        queue.enqueue({ input: "recover", metadata: { profile: "trusted" } }).id,
      );
      expect(done.status).toBe("done");
      expect(seen?.tools?.map((t) => t.function.name)).toEqual(["read_file"]);
      const wire = JSON.stringify(seen?.messages ?? []);
      expect(wire).not.toContain("POISONED");
      expect(deps.db.query("SELECT COUNT(*) AS n FROM memory").get()).toEqual({ n: 0 });
    } finally {
      delete process.env.DELTA_ALLOWED_TOOLS;
      delete process.env.DELTA_PINNED_TOOLS;
    }
  });

  test("per-run metadata cannot re-enable reflection", async () => {
    let calls = 0;
    const deps = makeDeps(
      async () => {
        calls++;
        return textResult("done");
      },
      new Map(),
      { safeMode: true, reflect: true, skills: "off" },
    );
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "recover", metadata: { reflect: true } }).id);
    await Bun.sleep(20);
    expect(calls).toBe(1);
  });
});
