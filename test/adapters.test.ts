// F0.2: the store-role adapters — the real portability seam. Two proofs:
//   1. the DEFAULT adapters (the skill registry capability, kb curated) speak their backend's
//      real wire shape through the interface;
//   2. reflect() routes end-to-end through an INJECTED non-the skill registry / non-kb stub
//      adapter — the binary owns no backend name past this seam (retarget = a binding).

import { describe, expect, test } from "bun:test";
import { DefaultCuratedAdapter, SkillRegistryAdapter } from "../src/adapter-defaults";
import type {
  CapabilityAdapter,
  CuratedAdapter,
  CuratedWrite,
  SkillProposal,
  SkillRef,
} from "../src/adapters";
import { openDb } from "../src/db";
import { Events } from "../src/events";
import { drainOnce } from "../src/promote";
import { reflect } from "../src/reflect";
import type { ToolCtx, ToolDef, Tools } from "../src/tools";
import { exampleVocab, ok } from "./helpers";

const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

function tool(name: string, execute: ToolDef["execute"]): ToolDef {
  return { name, description: "x", parameters: { type: "object" }, idempotent: false, execute };
}

describe("SkillRegistryAdapter (default capability store)", () => {
  test("health is unbound with no write verb, bound with one", () => {
    expect(new SkillRegistryAdapter(new Map()).health()).toBe("unbound");
    const tools: Tools = new Map([
      ["skills__skill_create", tool("skills__skill_create", async () => "ok")],
    ]);
    expect(new SkillRegistryAdapter(tools).health()).toBe("bound");
  });

  test("search parses the backend reply into structured SkillRefs", async () => {
    const tools: Tools = new Map([
      [
        "skills__skill_search",
        tool(
          "skills__skill_search",
          async () =>
            '{"skills":[{"name":"weekly-update","description":"Draft the weekly client update"},{"name":"triage-inbox"}]}',
        ),
      ],
    ]);
    const refs = await new SkillRegistryAdapter(tools).search("q", ctx);
    expect(refs.map((r) => r.name)).toEqual(["weekly-update", "triage-inbox"]);
    expect(refs[0]?.description).toContain("weekly client update");
  });

  test("propose routes a create and reports ok / error", async () => {
    const calls: Record<string, unknown>[] = [];
    const tools: Tools = new Map([
      [
        "skills__skill_create",
        tool("skills__skill_create", async (a) => {
          calls.push(a as Record<string, unknown>);
          return "created v1";
        }),
      ],
    ]);
    const cap = new SkillRegistryAdapter(tools);
    const p: SkillProposal & { idempotencyKey: string } = {
      name: "triage-inbox",
      body: "1. batch by sender",
      description: "Use when clearing a noisy inbox fast.",
      idempotencyKey: "k1",
    };
    expect(await cap.propose(p, ctx)).toBe("ok");
    expect(calls[0]?.name).toBe("triage-inbox");
    // No write tool at all → error (caller degrades to a curated learning).
    expect(await new SkillRegistryAdapter(new Map()).propose(p, ctx)).toBe("error");
  });
});

describe("DefaultCuratedAdapter (default curated store)", () => {
  test("health reflects the write-verb presence", () => {
    expect(new DefaultCuratedAdapter(new Map()).health()).toBe("unbound");
    const tools: Tools = new Map([
      ["kb__propose_submission", tool("kb__propose_submission", async () => "proposed")],
    ]);
    expect(new DefaultCuratedAdapter(tools, exampleVocab).health()).toBe("bound");
  });

  test("propose emits the historical knowledge-base envelope (byte-identical default)", async () => {
    let seen: Record<string, unknown> = {};
    const tools: Tools = new Map([
      [
        "kb__propose_submission",
        tool("kb__propose_submission", async (a) => {
          seen = a as Record<string, unknown>;
          return "submission proposed (pending review)";
        }),
      ],
    ]);
    const write: CuratedWrite = {
      kind: "learning",
      content: "This client wants sources inline.",
      idempotencyKey: "k1",
      review: true,
      runId: "r",
      confidence: 0.8,
    };
    expect(await new DefaultCuratedAdapter(tools, exampleVocab).propose(write, ctx)).toBe("ok");
    // The delta_run_ref stamp + a single create item — the reviewed-write contract.
    expect(seen.delta_run_ref).toBe("r");
    const items = seen.items as Array<{ target_kind: string; payload: { content: string } }>;
    expect(items[0]?.target_kind).toBe("learning");
    expect(items[0]?.payload.content).toContain("sources inline");
  });

  test("a tool error surfaces as error, not a false ok", async () => {
    const tools: Tools = new Map([
      ["kb__propose_submission", tool("kb__propose_submission", async () => "[tool error] boom")],
    ]);
    const write: CuratedWrite = {
      kind: "pitfall",
      content: "x",
      idempotencyKey: "k",
      review: false,
      runId: "r",
    };
    expect(await new DefaultCuratedAdapter(tools, exampleVocab).propose(write, ctx)).toBe("error");
  });
});

describe("reflect() runs entirely through injected adapters (portability)", () => {
  function seedRun(db: ReturnType<typeof openDb>) {
    const now = Date.now();
    db.query("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s', ?, ?)").run(now, now);
    db.query(
      "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r','s',1,'done',?,?)",
    ).run(JSON.stringify({ input: "do it" }), now);
    for (const m of [
      { role: "user", content: "research the client" },
      { role: "assistant", content: "Done. Always cite sources inline." },
    ]) {
      db.query(
        "INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)",
      ).run(JSON.stringify(m), now);
    }
    return db.query("SELECT * FROM runs WHERE id='r'").get() as Parameters<typeof reflect>[1];
  }

  test("a staged learning drains through a NON-kb curated adapter", async () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    const seen: CuratedWrite[] = [];
    const curated: CuratedAdapter = {
      binding: "notes-api",
      health: () => "bound",
      propose: async (a) => {
        seen.push(a);
        return "ok";
      },
    };
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"learning","content":"This client wants sources inline.","confidence":0.8}',
      });
    const out = await reflect(
      {
        db,
        events: new Events(db),
        chat,
        tools: new Map(),
        agentId: "delta-1",
        curated,
        promoteMinRuns: 99,
      },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    expect(seen).toHaveLength(0);
    await drainOnce({
      db,
      events: new Events(db),
      capability: new SkillRegistryAdapter(new Map()),
      curated,
      ctx,
      promoteMinRuns: 1,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toContain("sources inline");
    expect(seen[0]?.idempotencyKey).toBeTruthy(); // stable anchor threaded through
    expect((db.query("SELECT COUNT(*) AS n FROM memory").get() as { n: number }).n).toBe(1);
  });

  test("a skill_improvement proposes through a NON-the skill registry capability adapter", async () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    const proposals: Array<SkillProposal & { idempotencyKey: string }> = [];
    const searched: string[] = [];
    const capability: CapabilityAdapter = {
      binding: "procedures-api",
      health: () => "bound",
      search: async (q) => {
        searched.push(q);
        return [{ name: "draft-weekly-update", description: "existing" }] as SkillRef[];
      },
      get: async () => null, // brand-new skill → create path
      propose: async (p) => {
        proposals.push(p);
        return "ok";
      },
    };
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"skill_improvement","name":"draft weekly update","content":"codify the flow","body":"1. pull\\n2. draft","confidence":0.7}',
      });
    const out = await reflect(
      { db, events: new Events(db), chat, tools: new Map(), capability, promoteMinRuns: 99 },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    expect(searched).toHaveLength(1); // the capability search fed the reflect prompt
    expect(proposals).toHaveLength(0);
    await drainOnce({
      db,
      events: new Events(db),
      capability,
      curated: new DefaultCuratedAdapter(new Map()),
      ctx,
      promoteMinRuns: 1,
    });
    expect(proposals[0]?.name).toBe("draft-weekly-update"); // sanitized
    expect(String(proposals[0]?.body)).toContain("pull");
    expect(proposals[0]?.idempotencyKey).toBeTruthy();
  });

  test("capability failure stays staged and never crosses to curated", async () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    const capability: CapabilityAdapter = {
      binding: "procedures-api",
      health: () => "bound",
      search: async () => [],
      get: async () => null,
      propose: async () => "error", // capability store rejects it
    };
    const curatedSeen: CuratedWrite[] = [];
    const curated: CuratedAdapter = {
      binding: "notes-api",
      health: () => "bound",
      propose: async (a) => {
        curatedSeen.push(a);
        return "ok";
      },
    };
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"skill_improvement","name":"triage-inbox","content":"batch by sender","body":"1. batch","confidence":0.6}',
      });
    const out = await reflect(
      {
        db,
        events: new Events(db),
        chat,
        tools: new Map(),
        capability,
        curated,
        promoteMinRuns: 99,
      },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    await drainOnce({
      db,
      events: new Events(db),
      capability,
      curated,
      ctx,
      promoteMinRuns: 1,
    });
    expect(curatedSeen).toHaveLength(0);
    expect(
      (db.query("SELECT lifecycle FROM promotion").get() as { lifecycle: string }).lifecycle,
    ).toBe("staged");
  });

  test("an UNBOUND capability adapter is never touched — degrades without get()/propose()", async () => {
    const db = openDb(":memory:");
    const run = seedRun(db);
    // A foreign adapter that THROWS if the binary ignores its health and calls it.
    const capability: CapabilityAdapter = {
      binding: "offline-procedures",
      health: () => "unbound",
      search: async () => {
        throw new Error("search must not be called when unbound");
      },
      get: async () => {
        throw new Error("get must not be called when unbound");
      },
      propose: async () => {
        throw new Error("propose must not be called when unbound");
      },
    };
    const curatedSeen: CuratedWrite[] = [];
    const curated: CuratedAdapter = {
      binding: "notes-api",
      health: () => "bound",
      propose: async (a) => {
        curatedSeen.push(a);
        return "ok";
      },
    };
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"skill_improvement","name":"triage-inbox","content":"batch by sender","body":"1. batch","confidence":0.6}',
      });
    const out = await reflect(
      { db, events: new Events(db), chat, tools: new Map(), capability, curated },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    expect(curatedSeen).toHaveLength(0);
  });
});
