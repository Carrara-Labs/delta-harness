// SPDX-License-Identifier: Apache-2.0
// S5 (0.2.12): the self-write breaker must not cut off an agent that is CONVERGING.
//
// STORM_CLASSES keys every cap refusal to one constant so the varying byte counts cannot defeat
// equality matching. That was the right fix for the 2026-07-30 grinding storm, and it also discards
// the only signal that separates grinding from converging. Aperture measured a run go
// 6,654 → 6,482 → 6,445 against a 6,400 cap and get latched at three attempts: 45 bytes short and
// shrinking monotonically.
//
// Their own first suggestion (exempt monotone shrinking) is deliberately NOT what ships: one byte
// per attempt would grind forever. The rule is MATERIAL convergence plus a hard attempt ceiling.

import { describe, expect, test } from "bun:test";
import { Queue } from "../src/queue";
import type { ToolDef, Tools } from "../src/tools";
import { makeDeps, textResult, toolCallResult } from "./helpers";

const CAP = 6_400;

/** A `remember` whose refusals replay a real byte sequence, then answers. The message shape is the
 * one self.ts emits, because the byte counts in it ARE the progress signal. */
function rememberWith(sequence: number[]): { tools: Tools; attempts: () => number } {
  let i = 0;
  const tool: ToolDef = {
    name: "remember",
    description: "write the self file",
    parameters: { type: "object", properties: {} },
    idempotent: true,
    execute: async () => {
      const landed = sequence[Math.min(i, sequence.length - 1)] as number;
      i++;
      return `[tool error] DELTA.md would be ${landed} bytes (cap ${CAP}) — compact your notes and rewrite the whole file smaller. It rides in every prompt, so it must stay lean.`;
    },
  };
  return { tools: new Map([["remember", tool]]), attempts: () => i };
}

/** Drive `steps` turns of a single repeated remember call, then let the model answer. */
async function drive(tools: Tools, steps: number) {
  let call = 0;
  const deps = makeDeps(async () => {
    call++;
    return call <= steps
      ? toolCallResult("remember", { content: "x" }, `call_${call}`)
      : textResult("done");
  }, tools);
  const queue = new Queue(deps);
  await queue.wait(queue.enqueue({ input: "learn", metadata: { profile: "trusted" } }).id);
  const disabled = (
    deps.db.query("SELECT msg FROM messages WHERE msg LIKE '%[norm]%'").all() as { msg: string }[]
  ).length;
  deps.db.close();
  return { latched: disabled > 0 };
}

describe("self-write breaker convergence", () => {
  test("Aperture's run B is not cut off — 88% of the gap closed in three attempts", async () => {
    // gaps against the 6,400 cap: 254 → 82 → 45. Each closes far more than 5% of the remainder.
    const { tools, attempts } = rememberWith([6_654, 6_482, 6_445]);
    const { latched } = await drive(tools, 4);
    expect(latched).toBe(false);
    expect(attempts()).toBeGreaterThan(3); // it kept being allowed to try
  });

  test("run A is not cut off either", async () => {
    // 7,975 → 6,956 → 6,813: gaps 1,575 → 556 → 413.
    const { tools } = rememberWith([7_975, 6_956, 6_813]);
    expect((await drive(tools, 4)).latched).toBe(false);
  });

  test("a one-byte-per-attempt grind still latches", async () => {
    // The unbounded case Aperture's original suggestion would have allowed forever.
    const { tools } = rememberWith([6_654, 6_653, 6_652, 6_651, 6_650, 6_649]);
    expect((await drive(tools, 6)).latched).toBe(true);
  });

  test("a flat, non-converging refusal still latches at three", async () => {
    const { tools } = rememberWith([6_654]);
    expect((await drive(tools, 4)).latched).toBe(true);
  });

  test("even a converging run stops at the hard ceiling", async () => {
    // Halving the gap every turn converges forever in principle; the attempt ceiling ends it.
    const { tools } = rememberWith([
      12_800, 9_600, 8_000, 7_200, 6_800, 6_600, 6_500, 6_450, 6_425, 6_412, 6_406,
    ]);
    expect((await drive(tools, 11)).latched).toBe(true);
  });
});
