// POLICY.md — the fixed operating contract (the review rail + operator rules). Loaded
// once at boot; the embedded DEFAULT_POLICY makes a zero-file boot byte-equivalent to
// before; a supplied POLICY.md renders always; an oversized one FAILS BOOT (a fixed rule
// is never elided). Rendering (vocab nouns + write-tool name) lives in run.ts now; the
// spine just places the already-rendered block.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BootError, DEFAULT_POLICY, loadPolicy, renderPolicy } from "../src/policy";
import type { Vocab } from "../src/vocab";
import { exampleVocab } from "./helpers";

const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
function ws(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "delta-policy-"));
  tmps.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("renderPolicy", () => {
  test("the DEFAULT_POLICY renders a product's review-loop lines from its vocab", () => {
    const out = renderPolicy(DEFAULT_POLICY, exampleVocab, "kb__propose_submission");
    expect(out).toContain(
      "Knowledge Base writes go ONLY through kb__propose_submission: bundle your deliverable",
    );
    expect(out).toContain("ONE review item a human approves, stamped with delta_run_ref");
    expect(out).toContain("each step a task assigned to you, under a real project");
    expect(out).toContain("check your own open work first (your review items/tasks)");
    expect(out).toContain("revise the SAME item (supersede it)");
  });
  test("interpolates vocab nouns; unknown placeholders stay visible", () => {
    const v: Vocab = { ...exampleVocab, writeNoun: "ATS", itemNoun: "change request" };
    const out = renderPolicy(
      "File every {{itemNoun}} in {{writeNoun}} via {{writeTool}}. {{mystery}}",
      v,
      "ashby__propose_change",
    );
    expect(out).toBe("File every change request in ATS via ashby__propose_change. {{mystery}}");
  });
});

describe("loadPolicy", () => {
  test("no POLICY.md → the embedded default (fromFile=false), silently", async () => {
    const p = await loadPolicy(ws(), 800);
    expect(p.template).toBe(DEFAULT_POLICY);
    expect(p.fromFile).toBe(false);
  });
  test("a supplied POLICY.md is used and marked fromFile", async () => {
    const p = await loadPolicy(ws({ "POLICY.md": "- never email without approval" }), 800);
    expect(p.fromFile).toBe(true);
    expect(p.template).toContain("never email without approval");
  });
  test("a comment/heading-only POLICY.md (the delta init scaffold) falls back to the default", async () => {
    // The scaffolded file is a `# Policy` heading + an HTML guidance comment — it must NOT
    // silently replace the embedded review rail with an empty policy.
    const scaffold = "# Policy\n\n<!-- Fixed operating rules. Leave out to use the default. -->\n";
    const p = await loadPolicy(ws({ "POLICY.md": scaffold }), 800);
    expect(p.fromFile).toBe(false);
    expect(p.template).toBe(DEFAULT_POLICY);
  });
  test("comments are stripped from a real policy but its rules survive", async () => {
    const p = await loadPolicy(
      ws({ "POLICY.md": "# Policy\n<!-- note -->\n- escalate refunds over $500" }),
      800,
    );
    expect(p.fromFile).toBe(true);
    expect(p.template).toContain("escalate refunds over $500");
    expect(p.template).not.toContain("note");
  });
  test("an oversized POLICY.md FAILS BOOT (never silently elided)", async () => {
    const huge = "x".repeat(5_000); // ~1250 tokens > 200-token budget
    await expect(loadPolicy(ws({ "POLICY.md": huge }), 200)).rejects.toBeInstanceOf(BootError);
  });
});
