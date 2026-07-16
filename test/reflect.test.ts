// F2: the learning loop. Reflection distills a finished run into a structured
// artifact, writes governed local memory, and stages eligible shared promotion.

import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { Events } from "../src/events";
import type { ChatMsg, ChatRequest } from "../src/provider";
import { Queue } from "../src/queue";
import { reflect } from "../src/reflect";
import type { ToolCtx, ToolDef, Tools } from "../src/tools";
import { makeDeps, ok, textResult } from "./helpers";

const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

function seedDoneRun(
  db: ReturnType<typeof openDb>,
  msgs: ChatMsg[],
  metadata?: Record<string, unknown>,
) {
  const now = Date.now();
  db.query("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s', ?, ?)").run(now, now);
  db.query(
    "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r','s',1,'done',?,?)",
  ).run(JSON.stringify({ input: "do it", ...(metadata ? { metadata } : {}) }), now);
  for (const m of msgs) {
    db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)").run(
      JSON.stringify(m),
      now,
    );
  }
  return db.query("SELECT * FROM runs WHERE id='r'").get() as Parameters<typeof reflect>[1];
}

const transcript: ChatMsg[] = [
  { role: "user", content: "research the client and note anything reusable" },
  { role: "assistant", content: "Done. The client always wants sources inline." },
];

function proposeSpy(): { tool: ToolDef; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    tool: {
      name: "kb__propose_submission",
      description: "propose a reviewable submission",
      parameters: { type: "object" },
      idempotent: false,
      execute: async (args) => {
        calls.push(args);
        return "submission proposed (pending review)";
      },
    },
  };
}

describe("reflect()", () => {
  test("a user-less learning stages to curated without proposing directly", async () => {
    const db = openDb(":memory:");
    const spy = proposeSpy();
    const tools: Tools = new Map([[spy.tool.name, spy.tool]]);
    const run = seedDoneRun(db, transcript);
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"learning","content":"This client wants sources inline.","proposed_audience":"agent","confidence":0.8}',
      });
    const out = await reflect(
      { db, events: new Events(db), chat, tools, agentId: "delta-1" },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    expect(spy.calls).toHaveLength(0);
    const row = db.query("SELECT destination_role, lifecycle, content FROM promotion").get() as {
      destination_role: string;
      lifecycle: string;
      content: string;
    };
    expect(row.destination_role).toBe("curated");
    expect(row.lifecycle).toBe("staged");
    expect(row.content).toContain("sources inline");
  });

  test("task_type audience keys on the CALLER's metadata, never the model's invented key", async () => {
    const db = openDb(":memory:");
    // The model proposes task_type AND invents a key; the run's metadata carries the real one.
    const run = seedDoneRun(db, transcript, { task_type: "weekly-revenue-report" });
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"learning","content":"Pull numbers from finance, not CRM.","proposed_audience":"task_type","task_type":"model-hallucinated-key","confidence":0.8}',
      });
    await reflect(
      { db, events: new Events(db), chat, tools: new Map(), agentId: "delta-1" },
      run,
      {
        runId: "r",
      },
      ctx,
    );
    const mem = db.query("SELECT audience, task_type FROM memory").get() as {
      audience: string;
      task_type: string;
    };
    expect(mem.audience).toBe("task_type");
    expect(mem.task_type).toBe("weekly-revenue-report"); // caller's key, not the model's
  });

  test("a declared task_type routes to the middle tier BY DEFAULT — even when the model proposes nothing (deterministic)", async () => {
    const db = openDb(":memory:");
    // The caller declared a use-case; the distiller made no audience claim (defaults agent).
    const run = seedDoneRun(db, transcript, { task_type: "weekly-revenue-report" });
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"learning","content":"Pull numbers from finance, not CRM.","confidence":0.8}',
      });
    await reflect(
      { db, events: new Events(db), chat, tools: new Map(), agentId: "delta-1" },
      run,
      {
        runId: "r",
      },
      ctx,
    );
    const mem = db.query("SELECT audience, task_type FROM memory").get() as {
      audience: string;
      task_type: string;
    };
    expect(mem.audience).toBe("task_type"); // the caller's declaration fires the tier
    expect(mem.task_type).toBe("weekly-revenue-report");
  });

  test("PRIVACY: a user-bearing run with a declared task_type stays USER — never the shared tier", async () => {
    const db = openDb(":memory:");
    const run = seedDoneRun(db, transcript, {
      user_id: "alice",
      task_type: "weekly-revenue-report",
    });
    const chat = async () =>
      ok({
        role: "assistant",
        content: '{"kind":"preference","content":"Alice wants terse updates.","confidence":0.8}',
      });
    await reflect(
      { db, events: new Events(db), chat, tools: new Map(), agentId: "delta-1" },
      run,
      {
        runId: "r",
      },
      ctx,
    );
    const mem = db.query("SELECT audience, user_id FROM memory").get() as {
      audience: string;
      user_id: string;
    };
    expect(mem.audience).toBe("user"); // task_type declaration cannot widen a user's data
    expect(mem.user_id).toBe("alice");
    expect((db.query("SELECT COUNT(*) AS n FROM promotion").get() as { n: number }).n).toBe(0);
  });

  test("a deliberate broader claim (org) still wins over a declared task_type", async () => {
    const db = openDb(":memory:");
    const run = seedDoneRun(db, transcript, { task_type: "weekly-revenue-report" });
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"learning","content":"A broadly reusable operating principle.","proposed_audience":"org","confidence":0.8}',
      });
    await reflect(
      { db, events: new Events(db), chat, tools: new Map(), agentId: "delta-1" },
      run,
      {
        runId: "r",
      },
      ctx,
    );
    const mem = db.query("SELECT audience FROM memory").get() as { audience: string };
    expect(mem.audience).toBe("org"); // not downgraded to task_type
  });

  test("task_type proposed but NO caller key → downgrades to agent (recall could never reconstruct it)", async () => {
    const db = openDb(":memory:");
    const run = seedDoneRun(db, transcript); // no task_type in metadata
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"learning","content":"A generic reusable lesson.","proposed_audience":"task_type","task_type":"whatever","confidence":0.8}',
      });
    await reflect(
      { db, events: new Events(db), chat, tools: new Map(), agentId: "delta-1" },
      run,
      {
        runId: "r",
      },
      ctx,
    );
    const mem = db.query("SELECT audience, task_type FROM memory").get() as {
      audience: string;
      task_type: string;
    };
    expect(mem.audience).toBe("agent");
    expect(mem.task_type).toBe("");
  });

  test("falls back to agent-self memory when no a kb is connected", async () => {
    const db = openDb(":memory:");
    const run = seedDoneRun(db, transcript);
    const chat = async () =>
      ok({
        role: "assistant",
        content: '{"kind":"pitfall","content":"Do not skip the sources.","confidence":0.6}',
      });
    const out = await reflect(
      { db, events: new Events(db), chat, tools: new Map(), agentId: "delta-1" },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    const mem = db.query("SELECT * FROM memory WHERE audience='agent'").get() as {
      agent_id: string;
      artifact_kind: string;
      content: string;
    };
    expect(mem.agent_id).toBe("delta-1");
    expect(mem.artifact_kind).toBe("pitfall");
    expect(mem.content).toContain("skip the sources");
  });

  test("a user-context reflection lands in USER scope, not shared agent scope (codex P1)", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    db.query(
      "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s', 'alice', ?, ?)",
    ).run(now, now);
    db.query(
      "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r','s',1,'done',?,?)",
    ).run(JSON.stringify({ input: "do it" }), now);
    for (const m of transcript) {
      db.query(
        "INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)",
      ).run(JSON.stringify(m), now);
    }
    const run = db.query("SELECT * FROM runs WHERE id='r'").get() as Parameters<typeof reflect>[1];
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"preference","content":"Alice wants bullet points.","proposed_audience":"org","confidence":0.8}',
      });
    await reflect(
      { db, events: new Events(db), chat, tools: new Map(), agentId: "delta-1" },
      run,
      { runId: "r" },
      ctx,
    );
    const row = db.query("SELECT audience, user_id FROM memory").get() as {
      audience: string;
      user_id: string;
    };
    expect(row.audience).toBe("user"); // scoped to alice, not shared across users
    expect(row.user_id).toBe("alice");
    expect((db.query("SELECT COUNT(*) AS n FROM promotion").get() as { n: number }).n).toBe(0);
  });

  test("a user-bearing review widens only with explicit authorization", async () => {
    const db = openDb(":memory:");
    const run = seedDoneRun(db, transcript, {
      user_id: "alice",
      review_kind: "submission_disposition",
      widen_authorized: true,
    });
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"pitfall","content":"Always cite the primary record.","proposed_audience":"org","confidence":0.8}',
      });
    await reflect({ db, events: new Events(db), chat, tools: new Map() }, run, { runId: "r" }, ctx);
    const memory = db.query("SELECT audience, user_id, source FROM memory").get() as {
      audience: string;
      user_id: string;
      source: string;
    };
    expect(memory).toEqual({ audience: "org", user_id: "", source: "review" });
    expect((db.query("SELECT COUNT(*) AS n FROM promotion").get() as { n: number }).n).toBe(1);
  });

  test("re-reflection keeps a stable idempotency key and does not duplicate the outbox", async () => {
    const db = openDb(":memory:");
    const run = seedDoneRun(db, transcript);
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"learning","content":"Cite the primary record.","proposed_audience":"agent","confidence":0.8}',
      });
    const d = { db, events: new Events(db), chat, tools: new Map() };
    await reflect(d, run, { runId: "r" }, ctx);
    const first = (
      db.query("SELECT idempotency_key FROM promotion").get() as { idempotency_key: string }
    ).idempotency_key;
    await reflect(d, run, { runId: "r" }, ctx);
    const rows = db.query("SELECT idempotency_key FROM promotion").all() as {
      idempotency_key: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotency_key).toBe(first);
  });

  test("skips when the reflection says nothing is worth sharing", async () => {
    const db = openDb(":memory:");
    const run = seedDoneRun(db, transcript);
    const chat = async () => ok({ role: "assistant", content: '{"kind":"none"}' });
    const out = await reflect(
      { db, events: new Events(db), chat, tools: new Map() },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out).toBeNull();
    expect((db.query("SELECT COUNT(*) AS n FROM memory").get() as { n: number }).n).toBe(0);
  });
});

function skillSpy(): { tool: ToolDef; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    tool: {
      name: "skills__skill_create",
      description: "propose a skill version",
      parameters: { type: "object" },
      idempotent: false,
      execute: async (args) => {
        calls.push(args);
        return "skill v3 proposed (pending review)";
      },
    },
  };
}

describe("reflect() routes facts vs procedures (G3b)", () => {
  test("a skill_improvement stages a capability promotion with the full body", async () => {
    const db = openDb(":memory:");
    const skill = skillSpy();
    const propose = proposeSpy();
    // Both a kb propose tool AND a skill-registry write tool are connected.
    const tools: Tools = new Map<string, ToolDef>([
      [propose.tool.name, propose.tool],
      [skill.tool.name, skill.tool],
    ]);
    const run = seedDoneRun(db, transcript);
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"skill_improvement","name":"draft weekly update","content":"codify the update flow","body":"1. pull the dashboard\\n2. draft\\n3. propose","proposed_audience":"agent","confidence":0.7}',
      });
    const out = await reflect(
      { db, events: new Events(db), chat, tools },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    expect(skill.calls).toHaveLength(0);
    expect(propose.calls.length).toBe(0);
    const row = db.query("SELECT destination_role, name, body FROM promotion").get() as {
      destination_role: string;
      name: string;
      body: string;
    };
    expect(row.destination_role).toBe("capability");
    expect(row.name).toBe("draft-weekly-update");
    expect(row.body).toContain("pull the dashboard");
  });

  test("a preference can stage only to curated, never capability", async () => {
    const db = openDb(":memory:");
    const propose = proposeSpy();
    const tools: Tools = new Map([[propose.tool.name, propose.tool]]);
    const run = seedDoneRun(db, transcript);
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"preference","content":"Use terse weekly updates.","proposed_audience":"org","confidence":0.8}',
      });
    const out = await reflect(
      { db, events: new Events(db), chat, tools },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    expect(propose.calls).toHaveLength(0);
    const row = db.query("SELECT destination_role, artifact_kind FROM promotion").get() as {
      destination_role: string;
      artifact_kind: string;
    };
    expect(row).toEqual({ destination_role: "curated", artifact_kind: "preference" });
  });

  test("the Success statement grounds the reflection rubric (G4)", async () => {
    const db = openDb(":memory:");
    let systemSeen = "";
    const chat = async (req: ChatRequest) => {
      systemSeen = (req.messages.find((m) => m.role === "system")?.content as string) ?? "";
      return ok({ role: "assistant", content: '{"kind":"none"}' });
    };
    const run = seedDoneRun(db, transcript);
    await reflect(
      {
        db,
        events: new Events(db),
        chat,
        tools: new Map(),
        charter: { success: "every client update ships same-day" },
      },
      run,
      { runId: "r" },
      ctx,
    );
    expect(systemSeen).toContain("This agent succeeds when: every client update ships same-day");
  });
});

describe("reflection fires from the queue after a done run", () => {
  test("opt-in via metadata.reflect → a learning lands in agent memory (background)", async () => {
    let call = 0;
    const deps = makeDeps(async (_req: ChatRequest) => {
      call++;
      // call 1 = the task turn; call 2 = the reflection distiller.
      if (call === 1) return textResult("finished the task with a clear insight");
      return ok({
        role: "assistant",
        content: '{"kind":"learning","content":"Prefer terse updates for Roger.","confidence":0.7}',
      });
    });
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "do the thing", metadata: { reflect: true } }).id,
    );
    expect(done.status).toBe("done");
    // Reflection is background — wait for the memory row to appear.
    for (let i = 0; i < 50; i++) {
      const n = (deps.db.query("SELECT COUNT(*) AS n FROM memory").get() as { n: number }).n;
      if (n > 0) break;
      await Bun.sleep(20);
    }
    const mem = deps.db
      .query("SELECT content AS value FROM memory WHERE audience='agent'")
      .get() as {
      value: string;
    } | null;
    expect(mem?.value).toContain("terse updates");
  });

  test("no reflection when not opted in", async () => {
    const deps = makeDeps(async () => textResult("done"));
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "plain run" }).id);
    await Bun.sleep(60);
    expect((deps.db.query("SELECT COUNT(*) AS n FROM memory").get() as { n: number }).n).toBe(0);
  });
});
