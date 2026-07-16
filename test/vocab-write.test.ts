// The write seam. The engine's NEUTRAL default envelope names no product; the Knowledge Base
// bundle carries its exact schema as a writeShape (byte-identical to the historical
// inline reflect.ts envelope — frozen sentinel), and a declarative writeShape retargets
// the envelope to any product schema — typed values, dropped-when-absent keys, no code.

import { describe, expect, test } from "bun:test";
import { buildWriteArgs, NEUTRAL_VOCAB, parseVocab, type Vocab } from "../src/vocab";
import { exampleVocab } from "./helpers";

describe("buildWriteArgs — neutral default envelope (product-free)", () => {
  test("generic field names, no knowledge-base schema baked in", () => {
    const args = buildWriteArgs(NEUTRAL_VOCAB, {
      runId: "r1",
      kind: "note",
      content: "c",
      confidence: 0.5,
      review: false,
    });
    expect(args).toEqual({
      summary: "Reflection (note) from run r1",
      details: "Post-task reflection. c (self-rated confidence 0.5).",
      run_ref: "r1",
      items: [{ kind: "note", content: "c", confidence: 0.5 }],
    });
    // No Knowledge Base field names leak from the engine default.
    expect("output" in args).toBe(false);
    expect("actions_brief" in args).toBe(false);
    expect("delta_run_ref" in args).toBe(false);
  });
});

const ASHBY_VOCAB: Vocab = {
  ...exampleVocab,
  writeVerbSuffix: "propose_change",
  writeNoun: "ATS",
  runRefKey: "run_ref",
  learningTargetKind: "note",
  taskNoun: "search",
  itemNoun: "change request",
  subjectKeys: ["candidate", "job"],
  writeShape: {
    title: "{{summary}}",
    description: "{{brief}}",
    run_ref: "{{run_id}}",
    changes: [
      {
        action: "add",
        object: "{{target_kind}}",
        body: "{{content}}",
        confidence: "{{confidence}}",
      },
    ],
  },
};

describe("buildWriteArgs — Knowledge Base writeShape (byte-identity sentinel)", () => {
  test("matches the historical envelope exactly, confidence present", () => {
    const args = buildWriteArgs(exampleVocab, {
      runId: "r1",
      kind: "learning",
      content: "c",
      confidence: 0.8,
      review: false,
    });
    // JSON.stringify — key ORDER is part of the wire bytes; toEqual would let a
    // serialized-key reorder slip through (codex 6+7 #13).
    expect(JSON.stringify(args)).toBe(
      JSON.stringify({
        output: "Reflection (learning) from run r1",
        actions_brief: "Post-task reflection. c (self-rated confidence 0.8).",
        delta_run_ref: "r1",
        items: [
          {
            op: "create",
            target_kind: "learning",
            payload: { content: "c", source_kind: "agent" },
            confidence: 0.8,
          },
        ],
      }),
    );
  });

  test("confidence absent → 'n/a' in the brief and NO confidence key on the item", () => {
    const args = buildWriteArgs(exampleVocab, {
      runId: "r1",
      kind: "pitfall",
      content: "c",
      review: false,
    }) as { actions_brief: string; items: Record<string, unknown>[] };
    expect(args.actions_brief).toContain("(self-rated confidence n/a).");
    expect("confidence" in (args.items[0] as object)).toBe(false);
  });

  test("review provenance rides the brief", () => {
    const args = buildWriteArgs(exampleVocab, {
      runId: "r1",
      kind: "learning",
      content: "c",
      confidence: 0.9,
      review: true,
    }) as { actions_brief: string };
    expect(args.actions_brief).toContain("Post-review (review-grounded) reflection.");
  });
});

describe("buildWriteArgs — declarative writeShape", () => {
  test("renders the foreign envelope with TYPED values", () => {
    const args = buildWriteArgs(ASHBY_VOCAB, {
      runId: "r9",
      kind: "learning",
      content: "prefer sourced numbers",
      confidence: 0.8,
      review: false,
    }) as { title: string; run_ref: string; changes: Record<string, unknown>[] };
    expect(args.title).toBe("Reflection (learning) from run r9");
    expect(args.run_ref).toBe("r9");
    const change = args.changes[0] as Record<string, unknown>;
    expect(change.object).toBe("note");
    expect(change.body).toBe("prefer sourced numbers");
    expect(change.confidence).toBe(0.8); // a number, not "0.8"
    // No kb keys leak into the product's schema.
    expect("items" in args).toBe(false);
    expect("delta_run_ref" in args).toBe(false);
  });

  test("an exact-placeholder leaf with an absent value drops its KEY", () => {
    const args = buildWriteArgs(ASHBY_VOCAB, {
      runId: "r9",
      kind: "learning",
      content: "c",
      review: false,
    }) as { changes: Record<string, unknown>[] };
    expect("confidence" in (args.changes[0] as object)).toBe(false);
  });

  test("composite strings interpolate as text; unknown placeholders render empty", () => {
    const v: Vocab = {
      ...exampleVocab,
      writeShape: { memo: "run {{run_id}}: {{content}} [{{nonsense}}]" },
    };
    const args = buildWriteArgs(v, { runId: "r2", kind: "learning", content: "x", review: false });
    expect(args.memo).toBe("run r2: x []");
  });
});

describe("parseVocab guards (Sprint 6 fields)", () => {
  test("non-array subjectKeys / non-string nouns fall back to the neutral defaults", () => {
    const v = parseVocab(JSON.stringify({ subjectKeys: "oops", taskNoun: 7, itemNoun: null }));
    expect(v.subjectKeys).toEqual([]);
    expect(v.taskNoun).toBe("task");
    expect(v.itemNoun).toBe("review item");
  });

  test("writeShape round-trips through DELTA_VOCAB JSON", () => {
    const v = parseVocab(JSON.stringify({ writeShape: { a: "{{content}}" } }));
    expect(v.writeShape).toEqual({ a: "{{content}}" });
  });
});
