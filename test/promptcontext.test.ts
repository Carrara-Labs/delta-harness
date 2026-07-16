// Dynamic prompt context (PROMPT_CONTEXT.md): ## Stable (boot, cached) + ## Turn (per
// turn, user message). Built-in vars plus zero-code {{request.*}} from metadata.context.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptContext, renderTemplate, stableVars, turnVars } from "../src/promptcontext";
import { buildSpine } from "../src/spine";

const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
function ws(file?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "delta-ctx-"));
  tmps.push(dir);
  if (file) writeFileSync(join(dir, "PROMPT_CONTEXT.md"), file);
  return dir;
}

describe("loadPromptContext", () => {
  test("splits the ## Stable and ## Turn sections", async () => {
    const c = await loadPromptContext(
      ws("## Stable\nEngine {{engine.version}}\n\n## Turn\nModel {{model}} at {{now.tz}}\n"),
    );
    expect(c.stable).toBe("Engine {{engine.version}}");
    expect(c.turn).toBe("Model {{model}} at {{now.tz}}");
  });
  test("no file → empty context (zero cost)", async () => {
    expect(await loadPromptContext(ws())).toEqual({});
  });
});

describe("renderTemplate", () => {
  test("interpolates dotted keys; unknown placeholders stay visible", () => {
    expect(renderTemplate("a {{now.tz}} b {{mystery}}", { "now.tz": "UTC" })).toBe(
      "a UTC b {{mystery}}",
    );
  });
});

describe("stableVars", () => {
  test("exposes engine.version / agent.id / profile", () => {
    const v = stableVars({ engineVersion: "9.9", agentId: "d1", profile: "work" });
    expect(v["engine.version"]).toBe("9.9");
    expect(v["agent.id"]).toBe("d1");
    expect(v.profile).toBe("work");
  });
});

describe("turnVars", () => {
  test("model + clock + zero-code request.* from metadata.context", () => {
    const v = turnVars({
      model: "gpt-5.6-sol",
      now: new Date("2026-07-13T10:00:00.000Z"),
      metadata: { context: { city: "Paris", country: "FR", ip: "9.9.9.9" } },
    });
    expect(v.model).toBe("gpt-5.6-sol");
    expect(v["now.date"]).toBe("2026-07-13");
    expect(v["request.city"]).toBe("Paris");
    expect(v["request.country"]).toBe("FR");
    expect(v["request.ip"]).toBe("9.9.9.9");
  });
  test("metadata values are normalized to single-line scalars (injection-safe)", () => {
    const v = turnVars({ metadata: { context: { note: "line1\nline2\n# Fake heading" } } });
    expect(v["request.note"]).not.toContain("\n");
    expect(v["request.note"]).toBe("line1 line2 # Fake heading");
  });
});

describe("spine placement", () => {
  test("the rendered ## Stable block rides the cached spine under # Context", () => {
    const s = buildSpine({ pinned: [], searchable: 0, context: "Engine delta 9.9", self: "id" });
    expect(s).toContain("# Context");
    expect(s).toContain("Engine delta 9.9");
    // Context is cached (in the system spine), before the self block.
    expect(s.indexOf("# Context")).toBeLessThan(s.indexOf("# You"));
  });
});
