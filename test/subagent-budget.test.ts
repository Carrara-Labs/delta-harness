// SPDX-License-Identifier: Apache-2.0
// S4 (0.2.12): concurrent children must not each spend the whole ceiling.
//
// `remainingBudget()` is derived from the parent run's usage, and a child's usage is only charged
// back when it EXITS. So three children launched in one turn each read the FULL remaining budget,
// and a run could spend a multiple of its ceiling. A cost ceiling that does not hold is a
// correctness defect, not a performance ask.
//
// Aperture asked for a divisor. A divisor is what `eval_n` can do because it knows N up front;
// `spawn_subagent` fans out under a parallel instruction and cannot. Hence a live pool.

import { describe, expect, test } from "bun:test";
import type { ToolCtx, Tools } from "../src/tools";

/** The reservation exactly as run.ts builds it, over a fixed remainder. */
function pool(maxTokens: number, maxCostUsd: number) {
  let reservedTokens = 0;
  let reservedCost = 0;
  const reserve: NonNullable<ToolCtx["reserveBudget"]> = (share) => {
    const t = Math.max(0, Math.floor((maxTokens - reservedTokens) * share));
    const c = Math.max(0, (maxCostUsd - reservedCost) * share);
    reservedTokens += t;
    reservedCost += c;
    let released = false;
    return {
      maxTokens: t,
      maxCostUsd: c,
      release: () => {
        if (released) return;
        released = true;
        reservedTokens -= t;
        reservedCost -= c;
      },
    };
  };
  return { reserve, reserved: () => ({ tokens: reservedTokens, cost: reservedCost }) };
}

describe("subagent budget reservation", () => {
  test("three concurrent children cannot together exceed the ceiling", () => {
    const { reserve } = pool(100_000, 10);
    const claims = [reserve(0.5), reserve(0.5), reserve(0.5)];
    const tokens = claims.reduce((n, c) => n + c.maxTokens, 0);
    const cost = claims.reduce((n, c) => n + c.maxCostUsd, 0);
    expect(tokens).toBeLessThanOrEqual(100_000); // the defect: this was 300_000
    expect(cost).toBeLessThanOrEqual(10);
    // and every child still gets something real to work with
    expect(claims.every((c) => c.maxTokens > 0)).toBe(true);
  });

  test("releasing returns the claim to the pool", () => {
    const { reserve, reserved } = pool(100_000, 10);
    const first = reserve(0.5);
    expect(reserved().tokens).toBe(50_000);
    first.release();
    expect(reserved().tokens).toBe(0);
    // a later child then sees the full remainder again
    expect(reserve(0.5).maxTokens).toBe(50_000);
  });

  test("release is idempotent, so a double release cannot inflate the pool", () => {
    const { reserve, reserved } = pool(100_000, 10);
    const claim = reserve(0.5);
    claim.release();
    claim.release();
    expect(reserved().tokens).toBe(0);
  });

  test("eval_n's divisor rides the same pool", () => {
    // eval_n knows N, so it asks for 1/N — and the pool still bounds the total.
    const { reserve } = pool(90_000, 9);
    const claims = [reserve(1 / 3), reserve(1 / 3), reserve(1 / 3)];
    expect(claims.reduce((n, c) => n + c.maxTokens, 0)).toBeLessThanOrEqual(90_000);
  });

  test("a child stops on its DOLLAR claim, not just its token claim", async () => {
    // The claim was reserved and then never passed to the child, so its loop only ever checked
    // tokens: a run with tokens left but almost no dollars left could still admit several children
    // and overspend. The pool test alone cannot catch a missing wire (codex).
    const { runResearch } = await import("../src/research");
    let calls = 0;
    const chat = async () => {
      calls++;
      return {
        ok: true as const,
        model: "m",
        message: { role: "assistant" as const, content: "finding" },
        finishReason: "stop" as const,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, costUsd: 0.1 },
        latencyMs: 1,
      };
    };
    const tools: Tools = new Map([
      [
        "read_file",
        {
          name: "read_file",
          description: "r",
          parameters: { type: "object", properties: {} },
          idempotent: true,
          readonly: true,
          execute: async () => "ok",
        },
      ],
    ]);
    const out = await runResearch(
      ["one task"],
      { tools, pinned: ["read_file"] },
      chat,
      {
        workspace: "/tmp",
        activate: () => {},
        // plenty of tokens, almost no dollars — the child must stop on cost
        remainingBudget: () => ({ maxTokens: 500_000, maxCostUsd: 0.15 }),
        reserveBudget: (share) => ({
          maxTokens: Math.floor(500_000 * share),
          maxCostUsd: 0.15 * share,
          release: () => {},
        }),
      } as Parameters<typeof runResearch>[3],
      "run",
      "1",
    );
    expect(typeof out).toBe("string");
    expect(calls).toBeLessThan(5); // stopped on cost, not on the 500k token budget
  });

  test("an exhausted pool grants zero rather than a negative budget", () => {
    const { reserve } = pool(0, 0);
    const claim = reserve(0.5);
    expect(claim.maxTokens).toBe(0);
    expect(claim.maxCostUsd).toBe(0);
  });
});
