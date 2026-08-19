// D-9-min: a budget-exhausted run hands back what it already has — the plan and the
// artifact paths already on disk — instead of one sentence of counters. The counters
// stay in runs.error and the error event; output_text becomes the user-facing handoff.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILES } from "../src/profiles";
import type { ChatRequest } from "../src/provider";
import { Queue } from "../src/queue";
import type { ToolDef, Tools } from "../src/tools";
import { makeDeps, ok, toolCallResult } from "./helpers";

const HANDOFF_CAP_BYTES = 10 * 1024;

function bigTool(): ToolDef {
  return {
    name: "big",
    description: "returns a huge result",
    parameters: { type: "object", properties: {} },
    idempotent: true,
    execute: async () => `HUGE ${"z".repeat(25_000)}`,
  };
}

let callN = 0;
const toolLooper = async (req: ChatRequest) => {
  const sys = req.messages[0]?.content;
  if (typeof sys === "string" && sys.startsWith("You compact")) {
    // A summary call with a DISTINCT bill (26+5=31 vs the mains' 15): the arithmetic below
    // guarantees the summary charge, not a main call, is what crosses the ceiling.
    const r = ok({ role: "assistant", content: "Goal: g\nProgress: p\nNext: n\nArtifacts: a" });
    return r.ok ? { ...r, usage: { ...r.usage, input: 26, total: 31 } } : r;
  }
  callN++;
  return toolCallResult("big", {}, `call_${callN}`);
};

function noteTool(): ToolDef {
  return {
    name: "note",
    description: "accepts huge arguments, returns little",
    parameters: { type: "object", properties: { pad: { type: "string" } } },
    idempotent: true,
    execute: async () => "noted",
  };
}

// Turn 1 spills one real file; later turns bloat the history via huge tool ARGUMENTS with
// small results — demotion (spill stubs) can't shrink those with argCap off, so compaction
// must pay for a real summary call, and THAT charge is what crosses the ceiling.
const argBloatLooper = async (req: ChatRequest) => {
  const sys = req.messages[0]?.content;
  if (typeof sys === "string" && sys.startsWith("You compact")) {
    const r = ok({ role: "assistant", content: "Goal: g\nProgress: p\nNext: n\nArtifacts: a" });
    return r.ok ? { ...r, usage: { ...r.usage, input: 26, total: 31 } } : r;
  }
  callN++;
  return callN === 1
    ? toolCallResult("big", {}, "call_1")
    : toolCallResult("note", { pad: "y".repeat(30_000) }, `call_${callN}`);
};

function seedPlan(db: ReturnType<typeof makeDeps>["db"], sessionId: string) {
  db.query(
    "INSERT INTO thread_state (session_id, todo) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET todo = excluded.todo",
  ).run(
    sessionId,
    JSON.stringify([
      { status: "done", text: "PLAN-ITEM-ONE finished" },
      { status: "doing", text: "PLAN-ITEM-TWO in flight" },
    ]),
  );
}

const workspaces: string[] = [];
function tmpWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "delta-budget-"));
  workspaces.push(ws);
  return ws;
}
afterEach(() => {
  for (const ws of workspaces.splice(0)) rmSync(ws, { recursive: true, force: true });
});

// Tight token budget, subset of `work`'s ceiling: two 15-token turns cross 25.
PROFILES.exhausted = {
  name: "exhausted",
  allowed: "*",
  pinned: "*",
  budget: { maxSteps: 40, maxTokens: 25, maxCostUsd: 1 },
};
// maxTokens 61: mains bill 15 each (guard passes at 30/45/60 < 61, and 5 mains = 75 would
// need t5); the first 31-token summary call — compaction engages once history holds units —
// lands billed on 61+ BETWEEN the loop guard and the main call, so the POST-COMPACTION
// re-check (run.ts second guard) is the one that fires.
PROFILES.exhaustedPost = {
  name: "exhaustedPost",
  allowed: "*",
  pinned: "*",
  budget: { maxSteps: 40, maxTokens: 61, maxCostUsd: 1 },
};

describe("exhaustion handoff (D-9-min)", () => {
  test("output_text names the plan and both spill paths; counters stay in runs.error", async () => {
    callN = 0;
    const ws = tmpWorkspace();
    const tools: Tools = new Map([["big", bigTool()]]);
    const deps = makeDeps(toolLooper, tools, { workspace: ws });
    const queue = new Queue(deps);
    const run = queue.enqueue({ input: "do the huge thing", metadata: { profile: "exhausted" } });
    seedPlan(deps.db, run.session_id);
    const done = await queue.wait(run.id);

    expect(done.status).toBe("failed");
    const payload = JSON.parse(done.result ?? "{}");
    const out: string = payload.output_text ?? "";

    // The user sentence: what happened, nothing lost, what to do differently — never counters.
    expect(out).not.toContain("budget exhausted");
    expect(out).toContain("hit its budget");
    // The plan block survives.
    expect(out).toContain("PLAN-ITEM-ONE");
    expect(out).toContain("PLAN-ITEM-TWO");
    // Both real spill files are named, and they exist.
    const spills = [...out.matchAll(/\S*\.delta\/spill\/\S+\.txt/g)].map((m) => m[0]);
    expect(spills.length).toBeGreaterThanOrEqual(2);
    for (const p of spills) expect(await Bun.file(p).exists()).toBe(true);
    // Bounded.
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(HANDOFF_CAP_BYTES + 200);

    // The operator diagnostic is intact where operators look.
    expect(done.error).toContain("budget exhausted");
    const ev = deps.db
      .query("SELECT data FROM events WHERE type='error' AND run_id=? ORDER BY id DESC")
      .all(done.id) as { data: string }[];
    expect(
      ev.some((e) => (JSON.parse(e.data) as { "error.type"?: string })["error.type"] === "budget"),
    ).toBe(true);

    // The handoff also lands in the transcript (resume can read its own map).
    const rows = deps.db
      .query(
        "SELECT msg FROM messages WHERE run_id=? AND active=1 AND json_extract(msg,'$.role')='assistant'",
      )
      .all(done.id) as { msg: string }[];
    expect(
      rows.some((r) =>
        (JSON.parse(r.msg) as { content?: string }).content?.includes("PLAN-ITEM-ONE"),
      ),
    ).toBe(true);
  });

  test("post-compaction budget path produces the same handoff", async () => {
    callN = 0;
    const ws = tmpWorkspace();
    const tools: Tools = new Map([
      ["big", bigTool()],
      ["note", noteTool()],
    ]);
    // compactAtTokens tiny → compaction runs pre-send; the arg-bloated history defeats the
    // demotion-only shortcut, so a charged summary call happens and its charge crosses the
    // ceiling: the SECOND guard (run.ts post-compaction re-check) fires.
    const deps = makeDeps(argBloatLooper, tools, { workspace: ws, compactAtTokens: 10 });
    const queue = new Queue(deps);
    const run = queue.enqueue({
      input: "do the huge thing",
      metadata: { profile: "exhaustedPost" },
    });
    seedPlan(deps.db, run.session_id);
    const done = await queue.wait(run.id);

    expect(done.status).toBe("failed");
    expect(done.error).toContain("budget exhausted (post-compaction)");
    const out: string =
      (JSON.parse(done.result ?? "{}") as { output_text?: string }).output_text ?? "";
    expect(out).not.toContain("budget exhausted");
    expect(out).toContain("PLAN-ITEM-ONE");
    expect(out).toContain(".delta/spill/");
  });

  test("an ephemeral run's handoff does not promise paths the queue is about to wipe", async () => {
    callN = 0;
    const ws = tmpWorkspace();
    const tools: Tools = new Map([["big", bigTool()]]);
    const deps = makeDeps(toolLooper, tools, { workspace: ws });
    const queue = new Queue(deps);
    const run = queue.enqueue({
      input: "do the huge thing",
      store: false,
      metadata: { profile: "exhausted" },
    });
    const done = await queue.wait(run.id);
    expect(done.status).toBe("failed");
    const out: string =
      (JSON.parse(done.result ?? "{}") as { output_text?: string }).output_text ?? "";
    expect(out).not.toContain(".delta/spill/");
    expect(out).toContain("not retained");
  });
});
