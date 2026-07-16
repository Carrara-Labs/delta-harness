// The portability release's acceptance test (Sprints 6+7): retarget the harness
// from the kb to a recruiting product with NO code edit — one vocab JSON
// (nouns, subject keys, writeShape) + one POLICY.md. The spine speaks ATS, the
// hydration scopes on candidate, the mid-run write flows through the Ashby-shaped
// tool, and the background reflection emits the Ashby envelope.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../src/policy";
import type { ChatRequest } from "../src/provider";
import { Queue } from "../src/queue";
import type { ToolDef, Tools } from "../src/tools";
import { parseVocab } from "../src/vocab";
import { makeDeps, ok, textResult, toolCallResult } from "./helpers";

const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// Everything a developer would actually ship: env-shaped config, no TypeScript.
const ASHBY_VOCAB_JSON = JSON.stringify({
  coreVerbs: ["get_candidate", "search_candidates", "propose_change"],
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
    changes: [{ action: "add", object: "{{target_kind}}", body: "{{content}}" }],
  },
});
const PLAYBOOK =
  "- File every {{itemNoun}} in the {{writeNoun}} via {{writeTool}}, stamped {{runRefKey}}.";

function ashbyTool(calls: Record<string, unknown>[]): ToolDef {
  return {
    name: "ashby__propose_change",
    description: "propose an ATS change request",
    parameters: { type: "object" },
    idempotent: false,
    execute: async (args) => {
      calls.push(args);
      return "change request cr_1 opened (pending review)";
    },
  };
}
function readTool(seen: Record<string, unknown>[]): ToolDef {
  return {
    name: "ashby__get_candidate",
    description: "read a candidate record",
    parameters: { type: "object" },
    idempotent: true,
    execute: async (args) => {
      seen.push(args);
      return '{"name":"Jane Doe","stage":"onsite"}';
    },
  };
}

describe("retarget with no recompile (acceptance)", () => {
  test("vocab JSON + POLICY.md drive spine, write rail, and reflection envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-retarget-"));
    tmps.push(dir);
    writeFileSync(join(dir, "POLICY.md"), PLAYBOOK);

    const writes: Record<string, unknown>[] = [];
    const reads: Record<string, unknown>[] = [];
    const tools: Tools = new Map<string, ToolDef>([
      ["ashby__propose_change", ashbyTool(writes)],
      ["ashby__get_candidate", readTool(reads)],
    ]);

    const systems: string[] = [];
    let call = 0;
    const deps = {
      ...makeDeps(async (req: ChatRequest) => {
        call++;
        const sys = req.messages.find((m) => m.role === "system")?.content;
        if (typeof sys === "string") systems.push(sys);
        // turn 1: the agent files a change request; turn 2: done; call 3: reflection.
        if (call === 1)
          return toolCallResult("ashby__propose_change", {
            title: "Move Jane to offer",
            run_ref: "placeholder",
          });
        if (call === 2) return textResult("Filed the change request for review.");
        return ok({
          role: "assistant",
          content:
            '{"kind":"learning","content":"Onsite-passed candidates should move to offer within 48h.","confidence":0.9}',
        });
      }, tools),
      vocab: parseVocab(ASHBY_VOCAB_JSON),
      policy: await loadPolicy(dir, 800),
      reflect: true,
      // Stage-then-promote (Phase 1/2): a reflection now STAGES an eligible artifact and
      // the promoter drains it through the product's write rail. minRuns=1 promotes the
      // single occurrence immediately so this portability check still observes the write
      // (the recurrence gate itself is covered in promote.test.ts).
      promoteMinRuns: 1,
    };

    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "review Jane's pipeline", metadata: { candidate_id: "jane" } }).id,
    );
    expect(done.status).toBe("done");

    // 1) The spine speaks the product's language, from POLICY.md, not the binary.
    expect(systems[0]).toContain(
      "File every change request in the ATS via ashby__propose_change, stamped run_ref.",
    );
    expect(systems[0]).not.toContain("Knowledge Base writes"); // no kb prose leaked

    // 2) The mid-run write flowed through the product's rail.
    expect((writes[0] as { title: string }).title).toBe("Move Jane to offer");

    // 3) The background reflection proposed through the Ashby writeShape envelope.
    for (let i = 0; i < 50 && writes.length < 2; i++) await Bun.sleep(20);
    const reflection = writes[1] as {
      title: string;
      run_ref: string;
      changes: Array<{ object: string; body: string }>;
    };
    // Stage-then-promote carries the canonical artifact_kind (learning → fact), not the
    // distiller's raw word — the write speaks the taxonomy, still via the Ashby envelope.
    expect(reflection.title).toContain("Reflection (fact) from run");
    expect(reflection.run_ref).toBe(done.id);
    expect(reflection.changes[0]?.object).toBe("note");
    expect(reflection.changes[0]?.body).toContain("within 48h");
    // No kb keys in the product envelope.
    expect("items" in reflection).toBe(false);
    expect("delta_run_ref" in reflection).toBe(false);
  });
});
