// D-7: per-run scratch is relocatable off the workspace via DELTA_SCRATCH_DIR (deps.scratchDir).
// Spill and research move under `${scratch}/.delta/`; the model's scratchpad to
// `${scratch}/scratch/<runId>` (NOT under .delta — the model must write there). The §3 hazard:
// relocating the root must not stop legacy rows demoting, and file tools must still reach the
// relocated artifacts (the confinement seam gains the scratch root).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeCompact } from "../src/compaction";
import { openDb } from "../src/db";
import { Events } from "../src/events";
import { PROFILES } from "../src/profiles";
import type { ChatMsg, ChatRequest } from "../src/provider";
import { Queue } from "../src/queue";
import { spillPathFor, type ToolDef, type Tools } from "../src/tools";
import { makeDeps, ok, toolCallResult } from "./helpers";

const dirs: string[] = [];
function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `delta-${name}-`));
  dirs.push(d);
  return d;
}
// afterAll-style cleanup piggybacks on test completion; dirs are tiny.
process.on("beforeExit", () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
const looper = async (req: ChatRequest) => {
  const sys = req.messages[0]?.content;
  if (typeof sys === "string" && sys.startsWith("You compact"))
    return ok({ role: "assistant", content: "Goal: g\nProgress: p\nNext: n\nArtifacts: a" });
  callN++;
  return callN <= 2
    ? toolCallResult("big", {}, `call_${callN}`)
    : ok({ role: "assistant", content: "done" });
};

PROFILES.scratchy = {
  name: "scratchy",
  allowed: "*",
  pinned: "*",
  budget: { maxSteps: 40, maxTokens: 400_000, maxCostUsd: 1 },
};

describe("relocatable scratch (D-7)", () => {
  test("spill lands under the scratch root; the workspace tree stays untouched", async () => {
    callN = 0;
    const ws = tmp("ws");
    const scratch = tmp("scratch");
    const before = readdirSync(ws).sort();
    const tools: Tools = new Map([["big", bigTool()]]);
    const deps = makeDeps(looper, tools, { workspace: ws, scratchDir: scratch });
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "go", metadata: { profile: "scratchy" } }).id,
    );
    expect(done.status).toBe("done");
    const spillDir = join(scratch, ".delta", "spill");
    expect(existsSync(spillDir)).toBe(true);
    expect(readdirSync(spillDir).filter((e) => e.startsWith(`${done.id}.`)).length).toBe(2);
    // The vault-pollution assertion: nothing engine-written appeared in the workspace.
    expect(existsSync(join(ws, ".delta"))).toBe(false);
    expect(readdirSync(ws).sort()).toEqual(before);
  });

  test("demotion works under the new root, and LEGACY workspace-root rows still demote", async () => {
    const ws = tmp("ws2");
    const scratch = tmp("scratch2");
    const db = openDb(":memory:");
    const events = new Events(db);
    const now = Date.now();
    db.query(
      "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s', NULL, ?, ?)",
    ).run(now, now);
    db.query(
      "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r','s',1,'running','{}',?)",
    ).run(now);
    const insert = (m: ChatMsg) =>
      db
        .query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)")
        .run(JSON.stringify(m), now);

    // A NEW-root spill row (written under scratch) and a LEGACY-root row (under workspace),
    // both with their files on disk — the §3.1 dual-root fallback must demote BOTH.
    const newPath = spillPathFor(scratch, "r", "c1");
    mkdirSync(join(scratch, ".delta", "spill"), { recursive: true });
    writeFileSync(newPath, "n".repeat(30_000));
    const legacyPath = spillPathFor(ws, "r", "c2");
    mkdirSync(join(ws, ".delta", "spill"), { recursive: true });
    writeFileSync(legacyPath, "l".repeat(30_000));

    insert({ role: "user", content: "start" });
    for (let i = 0; i < 6; i++) insert({ role: "user", content: `filler ${i} ${"f".repeat(200)}` });
    insert({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "big", arguments: "{}" } }],
    });
    insert({
      role: "tool",
      tool_call_id: "c1",
      content: `head1 ${"x".repeat(24_000)}\n… [elided 1 chars — full output saved to ${newPath}; read that file for the rest] …`,
    } as ChatMsg);
    insert({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c2", type: "function", function: { name: "big", arguments: "{}" } }],
    });
    insert({
      role: "tool",
      tool_call_id: "c2",
      content: `head2 ${"y".repeat(24_000)}\n… [elided 1 chars — full output saved to ${legacyPath}; read that file for the rest] …`,
    } as ChatMsg);

    await maybeCompact(
      db,
      events,
      async () => ok({ role: "assistant", content: "Goal: g\nProgress: p\nNext: n\nArtifacts: a" }),
      "s",
      { sessionId: "s" },
      { recentBudgetTokens: 5, anchorRunId: "r", workspace: ws, scratchDir: scratch },
    );

    const all = (
      db.query("SELECT msg FROM messages WHERE session_id='s'").all() as { msg: string }[]
    ).map((r) => JSON.parse(r.msg) as ChatMsg);
    const demoted = all.filter(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.length < 5_000,
    );
    const bodies = demoted.map((m) => m.content as string).join("\n");
    expect(bodies).toContain(newPath); // new-root row demoted to a stub pointing at scratch
    expect(bodies).toContain(legacyPath); // legacy row STILL demotes — the §3 hazard assertion
  });

  test("research artifacts write under the scratch root .delta/research and escapes are refused", async () => {
    const ws = tmp("ws3");
    const scratch = tmp("scratch3");
    const { writeArtifact } = await import("../src/research");
    const rel = await writeArtifact(ws, scratch, "run1", "0", 0, "taskname", "BODY");
    expect(existsSync(join(scratch, ".delta", "research", "run1.0", `0-taskname.md`))).toBe(true);
    // Off-workspace artifacts come back ABSOLUTE so read_file (workspace-relative) can find them.
    expect(rel.startsWith(scratch)).toBe(true);
    expect(existsSync(join(ws, "research"))).toBe(false);
  });

  test("file tools reach the scratch root: read relocated artifacts, write the scratchpad, .delta stays reserved", async () => {
    const ws = tmp("ws4");
    const scratch = tmp("scratch4");
    const { builtinTools } = await import("../src/builtins");
    const tools = builtinTools({
      workspace: ws,
      codeCli: ["echo"],
      selfCmd: ["true"],
      subagentDepth: 0,
      fetchAllowPrivate: true,
    });
    const ctx = { workspace: ws, scratchDir: scratch, activate: () => {} };

    // The engine wrote a spill file under the scratch root and told the model to read_file it.
    mkdirSync(join(scratch, ".delta", "spill"), { recursive: true });
    writeFileSync(join(scratch, ".delta", "spill", "r.c1.txt"), "SPILLED BODY");
    const read = await tools
      .get("read_file")
      ?.execute({ path: join(scratch, ".delta", "spill", "r.c1.txt") }, ctx);
    expect(read).toContain("SPILLED BODY");

    // The advertised scratchpad ({{run.scratch}} absolute form) is writable.
    const wrote = await tools
      .get("write_file")
      ?.execute({ path: join(scratch, "scratch", "r1", "notes.md"), content: "note" }, ctx);
    expect(wrote).toContain("wrote");
    expect(existsSync(join(scratch, "scratch", "r1", "notes.md"))).toBe(true);

    // `.delta/*` stays write-reserved under the scratch root too.
    const reserved = await tools
      .get("write_file")
      ?.execute({ path: join(scratch, ".delta", "spill", "r.c1.txt"), content: "forged" }, ctx);
    expect(reserved).toContain("off-limits");

    // A path under NEITHER root is still refused (thrown here; run.ts converts tool throws
    // to [tool error] values — same contract as before the seam).
    expect(tools.get("read_file")?.execute({ path: "/etc/hosts" }, ctx)).rejects.toThrow("escapes");
  });

  test("default equality: with no scratchDir the spill path and scratchpad advert are unchanged", () => {
    const ws = "/data/bundle";
    expect(spillPathFor(ws, "resp_abc", "call_1")).toBe(
      "/data/bundle/.delta/spill/resp_abc.call_1.txt",
    );
  });
});
