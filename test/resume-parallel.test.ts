// SPDX-License-Identifier: Apache-2.0
// S9 (0.2.12): a crash MID-BATCH strands the calls that had not committed yet.
//
// A turn's tool calls run under Promise.all, so the daemon can die after call A's result row is
// committed and before call B ever executes. The loop reconciles off `lastRunMessage`, which is now
// A's TOOL row, not the assistant — so `pendingCalls` was never computed, B never ran, and the next
// request carried a tool_use with no tool_result, which the provider rejects.
//
// Pre-existing, found by codex while reviewing the argument-elision seam, covered by no test.
// The naive fix (always reach back to the last tool-calling assistant) breaks the ordinary path,
// so the finalize case below is as load-bearing as the crash case.

import { describe, expect, test } from "bun:test";
import type { AssistantMsg } from "../src/provider";
import { Queue } from "../src/queue";
import type { ToolDef, Tools } from "../src/tools";
import { makeDeps, ok, textResult } from "./helpers";

function tool(name: string, ran: string[]): ToolDef {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    idempotent: true,
    execute: async () => {
      ran.push(name);
      return `${name} ok`;
    },
  };
}

/** An assistant message issuing TWO calls in one batch — the shape Promise.all fans out. */
const batchMsg: AssistantMsg = {
  role: "assistant",
  content: null,
  tool_calls: [
    { id: "call_a", type: "function", function: { name: "alpha", arguments: "{}" } },
    { id: "call_b", type: "function", function: { name: "beta", arguments: "{}" } },
  ],
};
const twoCalls = () => ok(batchMsg);

function seedCrashedBatch(db: ReturnType<typeof makeDeps>["db"], sessionId: string, runId: string) {
  // Exactly the on-disk state a kill -9 between the two commits leaves behind: the assistant row
  // with both calls, call A answered, call B with no journal row and no tool message.
  const now = Date.now();
  db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES (?,?,?,?)").run(
    runId,
    sessionId,
    JSON.stringify(batchMsg),
    now,
  );
  db.query(
    "INSERT INTO journal (run_id, call_id, tool, args, status, result, created_at, finished_at) VALUES (?,?,?,?,'done',?,?,?)",
  ).run(runId, "call_a", "alpha", "{}", "alpha ok", now, now);
  db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES (?,?,?,?)").run(
    runId,
    sessionId,
    JSON.stringify({ role: "tool", tool_call_id: "call_a", content: "alpha ok" }),
    now,
  );
}

describe("parallel sub-turn resume", () => {
  test("executes the sibling a crash left unanswered", async () => {
    const ran: string[] = [];
    const tools: Tools = new Map([
      ["alpha", tool("alpha", ran)],
      ["beta", tool("beta", ran)],
    ]);
    // After the stranded call is reconciled, the model answers.
    const deps = makeDeps(async () => textResult("done"), tools);
    const queue = new Queue(deps);
    const run = queue.enqueue({ input: "go", metadata: { profile: "work" } });
    seedCrashedBatch(deps.db, run.session_id, run.id);

    const result = await queue.wait(run.id);
    expect(result?.status).toBe("done");
    // beta ran on resume; alpha did NOT re-fire (its journal row is already `done`).
    expect(ran).toEqual(["beta"]);

    // and the transcript is wire-valid: every tool_call has a matching tool_result
    const msgs = (
      deps.db
        .query("SELECT msg FROM messages WHERE run_id = ? AND active = 1 ORDER BY id")
        .all(run.id) as { msg: string }[]
    ).map((r) => JSON.parse(r.msg) as Record<string, unknown>);
    const calls = msgs.flatMap((m) =>
      ((m.tool_calls as { id: string }[] | undefined) ?? []).map((c) => c.id),
    );
    const answered = msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(calls.sort()).toEqual(["call_a", "call_b"]);
    expect(answered.sort()).toEqual(["call_a", "call_b"]);
    deps.db.close();
  });

  test("two sequential batches both complete", async () => {
    // The newest active tool-calling assistant must be the one reconciled, so a SECOND batch is
    // never mistaken for the first (codex asked for this shape explicitly).
    const ran: string[] = [];
    const tools: Tools = new Map([
      ["alpha", tool("alpha", ran)],
      ["beta", tool("beta", ran)],
    ]);
    let calls = 0;
    const deps = makeDeps(async () => {
      calls++;
      if (calls === 1) return twoCalls();
      if (calls === 2)
        return ok({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_c", type: "function", function: { name: "alpha", arguments: "{}" } },
          ],
        });
      return textResult("done");
    }, tools);
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "go", metadata: { profile: "work" } }).id);
    expect(done?.status).toBe("done");
    expect(ran.sort()).toEqual(["alpha", "alpha", "beta"]); // both batches ran, nothing re-fired
    expect(calls).toBe(3);
    deps.db.close();
  });

  test("a tool tail left by compaction does not re-open a finished batch", async () => {
    // Compaction can leave the last ACTIVE row as a tool result even though the batch completed.
    // Reconciling must find nothing pending and fall through, not re-execute (codex).
    const ran: string[] = [];
    const tools: Tools = new Map([
      ["alpha", tool("alpha", ran)],
      ["beta", tool("beta", ran)],
    ]);
    const deps = makeDeps(async () => textResult("done"), tools);
    const queue = new Queue(deps);
    const run = queue.enqueue({ input: "go", metadata: { profile: "work" } });
    const now = Date.now();
    // a COMPLETE batch: assistant + both results, both journalled done
    deps.db
      .query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES (?,?,?,?)")
      .run(run.id, run.session_id, JSON.stringify(batchMsg), now);
    for (const [id, name] of [
      ["call_a", "alpha"],
      ["call_b", "beta"],
    ] as const) {
      deps.db
        .query(
          "INSERT INTO journal (run_id, call_id, tool, args, status, result, created_at, finished_at) VALUES (?,?,?,?,'done',?,?,?)",
        )
        .run(run.id, id, name, "{}", `${name} ok`, now, now);
      deps.db
        .query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES (?,?,?,?)")
        .run(
          run.id,
          run.session_id,
          JSON.stringify({ role: "tool", tool_call_id: id, content: `${name} ok` }),
          now,
        );
    }
    const result = await queue.wait(run.id);
    expect(result?.status).toBe("done");
    expect(ran).toEqual([]); // nothing re-executed
    deps.db.close();
  });

  test("an ordinary batch followed by a final answer still finalizes on the first pass", async () => {
    // The regression the naive fix causes: reaching back to the last TOOL-CALLING assistant would
    // re-open a finished exchange and spend another model call instead of finalizing.
    const ran: string[] = [];
    const tools: Tools = new Map([
      ["alpha", tool("alpha", ran)],
      ["beta", tool("beta", ran)],
    ]);
    let calls = 0;
    const deps = makeDeps(async () => {
      calls++;
      return calls === 1 ? twoCalls() : textResult("final answer");
    }, tools);
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "go", metadata: { profile: "work" } }).id);
    expect(done?.status).toBe("done");
    expect(ran.sort()).toEqual(["alpha", "beta"]);
    expect(calls).toBe(2); // the batch, then the answer — no extra round trip
    deps.db.close();
  });
});
