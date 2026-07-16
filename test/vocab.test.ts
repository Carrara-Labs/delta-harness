// The portability seam + the review-loop invariants it drives. Vocab is the small set
// of product bindings (noun/tools) that let the same lean spine + policy serve the kb
// or any other review-rail product. Rendering the policy from vocab now lives in
// renderPolicy (run.ts calls it); buildSpine just places the already-rendered block.

import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, renderPolicy } from "../src/policy";
import { buildSpine } from "../src/spine";
import type { ToolDef } from "../src/tools";
import { NEUTRAL_VOCAB, parseVocab } from "../src/vocab";
import { exampleVocab } from "./helpers";

const stub = (name: string): ToolDef => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object", properties: {} },
  idempotent: true,
  execute: async () => "",
});

describe("renderPolicy drives the product's review-loop prose from vocab", () => {
  test("kb vocab → names the tool + intake + self-check + revise-in-place", () => {
    const s = renderPolicy(DEFAULT_POLICY, exampleVocab, "kb__propose_submission");
    expect(s).toContain("kb__propose_submission");
    expect(s).toContain("Knowledge Base writes go ONLY through"); // writeNoun
    expect(s).toContain("delta_run_ref"); // runRefKey stamp
    expect(s).toContain("one-line summary of what you did"); // actions_brief drives the inbox card
    expect(s).toContain("propose a PLAN first"); // plan-vs-direct intake
    expect(s).toContain("a task assigned to you, under a real project"); // chat-plan self-assign
    expect(s).toContain("check your own open work first"); // self-check
    expect(s).toContain("revise the SAME item (supersede it)"); // revise-in-place
  });
});

describe("the engine is product-free (neutral default)", () => {
  // Forcing function: a blank agent (no self, no policy) must not leak any product
  // identity into the assembled spine. Guards the open boundary.
  test("a neutral spine names no product — no kb__/Carrara/Quarry", () => {
    const s = buildSpine({ pinned: [stub("read_file"), stub("web_search")], searchable: 2 });
    expect(s).not.toContain("kb__");
    expect(s).not.toContain("Carrara");
    expect(s).not.toContain("Quarry");
    expect(s).toContain("You are Delta"); // the engine's own name is fine
  });
});

describe("vocab rebinds the loop to another product (portability)", () => {
  const RECRUITING = {
    ...exampleVocab,
    writeVerbSuffix: "propose_change",
    writeNoun: "ATS",
    runRefKey: "run_ref",
  };
  test("the same policy names the product's tool + noun, not the kb's", () => {
    const s = renderPolicy(DEFAULT_POLICY, RECRUITING, "ashby__propose_change");
    expect(s).toContain("ATS writes go ONLY through ashby__propose_change");
    expect(s).toContain("run_ref");
    expect(s).not.toContain("Knowledge Base writes go ONLY through");
  });
});

describe("parseVocab", () => {
  test("undefined → neutral default (the engine names no product)", () => {
    expect(parseVocab(undefined)).toBe(NEUTRAL_VOCAB);
    expect(NEUTRAL_VOCAB.coreVerbs).toEqual([]); // no product verbs pinned
    expect(NEUTRAL_VOCAB.writeNoun).toBe("the record");
  });
  test("partial JSON overrides only named fields; unnamed fields keep the neutral default", () => {
    const v = parseVocab(JSON.stringify({ writeNoun: "ATS" }));
    expect(v.writeNoun).toBe("ATS");
    expect(v.writeVerbSuffix).toBe("propose_change"); // untouched → neutral default
    expect(v.coreVerbs).toEqual(NEUTRAL_VOCAB.coreVerbs);
  });
  test("malformed JSON → neutral default, never throws", () => {
    expect(parseVocab("{not json")).toBe(NEUTRAL_VOCAB);
  });
  test("a product vocab can pin its revise-loop reads (e.g. kb's list_my_submissions)", () => {
    const v = parseVocab(JSON.stringify(exampleVocab));
    expect(v.coreVerbs).toContain("list_my_submissions");
  });
});
