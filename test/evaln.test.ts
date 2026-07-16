// F3: eval_n-keep-winner. Fans out N sub-agents, a judge picks the winner. The
// child sub-agents are real oneshot processes (a tiny mock model backs them);
// the judge is ctx.chat. Also covers the depth cap and single-survivor fallback.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtins";
import type { ModelResult, Usage } from "../src/provider";
import type { ToolCtx } from "../src/tools";

const ws = mkdtempSync(join(tmpdir(), "delta-evaln-"));
afterAll(() => rmSync(ws, { recursive: true, force: true }));

// A mock model that makes the oneshot children answer with their attempt number,
// so the judge has distinguishable candidates to pick from.
const mock = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = (await req.json()) as { messages: Array<{ content: string }> };
    const user = body.messages.at(-1)?.content ?? "";
    const attempt = user.match(/attempt (\d+)/i)?.[1] ?? "x";
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `answer from attempt ${attempt}` }, finish_reason: "stop" }] })}\n\n` +
        // A usage chunk so each child variant reports real spend for eval_n to charge back.
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } })}\n\n` +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
afterAll(() => mock.stop());

const tools = builtinTools({
  workspace: ws,
  codeCli: ["echo"],
  selfCmd: ["bun", join(import.meta.dir, "..", "src", "index.ts")],
  subagentDepth: 0,
});

function ctxWithJudge(winner: number, charged?: Usage[]): ToolCtx {
  return {
    workspace: ws,
    activate: () => {},
    chat: async (): Promise<ModelResult> => ({
      ok: true,
      model: "judge",
      message: { role: "assistant", content: `{"winner": ${winner}, "reason": "best"}` },
      finishReason: "stop",
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, total: 10, costUsd: 0 },
      latencyMs: 1,
    }),
    ...(charged ? { chargeUsage: (usage: Usage) => charged.push(usage) } : {}),
  };
}

const childEnv = {
  MODEL_BASE_URL: `http://localhost:${mock.port}/v1`,
  MODEL_API_KEY: "test",
  DELTA_MODEL: "test/model",
};

describe("eval_n", () => {
  test("fans out N variants and returns the judge's winner", async () => {
    for (const [k, v] of Object.entries(childEnv)) process.env[k] = v;
    try {
      const charged: Usage[] = [];
      const out = await tools
        .get("eval_n")
        ?.execute({ task: "write a haiku", n: 3 }, ctxWithJudge(2, charged));
      expect(out).toContain("winner #2");
      expect(out).toContain("answer from attempt 3"); // candidate index 2 = the 3rd attempt
      expect(out).toContain("3/3 variants");
      expect(charged).toHaveLength(3);
      expect(charged.every((usage) => usage.total > 0)).toBe(true);
    } finally {
      for (const k of Object.keys(childEnv)) delete process.env[k];
    }
  }, 30_000);

  test("needs a model to judge — clean error without ctx.chat", async () => {
    const out = await tools
      .get("eval_n")
      ?.execute({ task: "x" }, { workspace: ws, activate: () => {} });
    expect(out).toContain("[tool error]");
    expect(out).toContain("no provider");
  });

  test("n is clamped to 2..5", async () => {
    // With the schema saying 2-5, a request of 10 must not spawn 10 children.
    // We assert via the variant count in the header (mock makes all succeed).
    for (const [k, v] of Object.entries(childEnv)) process.env[k] = v;
    try {
      const out = await tools.get("eval_n")?.execute({ task: "t", n: 10 }, ctxWithJudge(0));
      expect(out).toContain("5/5 variants");
    } finally {
      for (const k of Object.keys(childEnv)) delete process.env[k];
    }
  }, 30_000);

  test("depth cap: eval_n and spawn_subagent absent inside a sub-agent", () => {
    const child = builtinTools({
      workspace: ws,
      codeCli: ["echo"],
      selfCmd: ["x"],
      subagentDepth: 1,
    });
    expect(child.has("eval_n")).toBe(false);
    expect(child.has("spawn_subagent")).toBe(false);
    expect(tools.has("eval_n")).toBe(true);
  });
});
