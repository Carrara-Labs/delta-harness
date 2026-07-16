// Sprint 5 §3.2: skill vN+1. Reflection resolves an existing skill's current
// version through the the skill registry read surface and routes to UPDATE (append-merge,
// version_conflict retry); a genuinely-new skill still CREATEs; the reflect prompt
// carries the skill index so the distiller improves by exact name.

import { describe, expect, test } from "bun:test";
import {
  DefaultCuratedAdapter,
  listSkillIndex,
  SkillRegistryAdapter,
} from "../src/adapter-defaults";
import { mergeSkillBody } from "../src/adapters";
import { openDb } from "../src/db";
import { Events } from "../src/events";
import { drainOnce } from "../src/promote";
import type { ChatMsg, ChatRequest } from "../src/provider";
import { reflect } from "../src/reflect";
import { findSkillBase } from "../src/skill-registry";
import type { ToolCtx, ToolDef, Tools } from "../src/tools";
import { ok } from "./helpers";

const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

function tool(name: string, execute: ToolDef["execute"]): ToolDef {
  return { name, description: name, parameters: { type: "object" }, idempotent: false, execute };
}

function seedDoneRun(db: ReturnType<typeof openDb>, msgs: ChatMsg[]) {
  const now = Date.now();
  db.query("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s', ?, ?)").run(now, now);
  db.query(
    "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r','s',1,'done',?,?)",
  ).run(JSON.stringify({ input: "do it" }), now);
  for (const m of msgs)
    db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)").run(
      JSON.stringify(m),
      now,
    );
  return db.query("SELECT * FROM runs WHERE id='r'").get() as Parameters<typeof reflect>[1];
}

const transcript: ChatMsg[] = [
  { role: "user", content: "draft the weekly update" },
  { role: "assistant", content: "Done — learned a better dashboard-first flow." },
];

/** A mock the skill registry surface: skill_get knows `weekly-update` at v3. */
function mockSkillRegistry(opts: { conflictOnce?: boolean } = {}) {
  const calls: Record<string, Record<string, unknown>[]> = {
    get: [],
    search: [],
    create: [],
    update: [],
    fileGet: [],
  };
  let conflicted = false;
  let version = 3;
  const tools: Tools = new Map<string, ToolDef>([
    [
      "skills__skill_get",
      tool("skills__skill_get", async (args) => {
        calls.get?.push(args);
        if (args.name !== "weekly-update") return "[tool error] not found";
        return JSON.stringify({
          skill: { name: "weekly-update", version, body: "1. open dashboard\n2. draft" },
        });
      }),
    ],
    [
      "skills__skill_file_get",
      tool("skills__skill_file_get", async (args) => {
        calls.fileGet?.push(args);
        return "[tool error] wrong tool — lookup must not hit skill_file_get";
      }),
    ],
    [
      "skills__skill_search",
      tool("skills__skill_search", async (args) => {
        calls.search?.push(args);
        return JSON.stringify({
          skills: [
            { name: "weekly-update", description: "Draft the weekly client update", version },
            { name: "triage-inbox", description: "Clear a noisy inbox fast", version: 1 },
          ],
        });
      }),
    ],
    [
      "skills__skill_create",
      tool("skills__skill_create", async (args) => {
        calls.create?.push(args);
        return `Published "${args.name}" v1`;
      }),
    ],
    [
      "skills__skill_update",
      tool("skills__skill_update", async (args) => {
        calls.update?.push(args);
        if (opts.conflictOnce && !conflicted) {
          conflicted = true;
          version = 4; // someone else published v4 meanwhile
          return "[tool error] version_conflict: base_version 3 is stale (latest is 4)";
        }
        return `Published "${args.name}" v${Number(args.base_version) + 1}`;
      }),
    ],
  ]);
  return { tools, calls };
}

describe("findSkillBase / listSkillIndex", () => {
  test("resolves the latest version by exact name via skill_get (never skill_file_get)", async () => {
    const { tools, calls } = mockSkillRegistry();
    const base = await findSkillBase(tools, ctx, "weekly-update");
    expect(base?.version).toBe(3);
    expect(base?.body).toContain("open dashboard");
    expect(calls.fileGet?.length).toBe(0);
  });

  test("unknown skill → null (caller creates)", async () => {
    const { tools } = mockSkillRegistry();
    expect(await findSkillBase(tools, ctx, "no-such-skill")).toBeNull();
  });

  test("no skill-registry read tool → null, no throw", async () => {
    expect(await findSkillBase(new Map(), ctx, "weekly-update")).toBeNull();
  });

  test("index renders name — description lines for the reflect prompt", async () => {
    const { tools } = mockSkillRegistry();
    const idx = await listSkillIndex(tools, ctx);
    expect(idx).toContain("- weekly-update — Draft the weekly client update");
    expect(idx).toContain("- triage-inbox");
  });
});

describe("mergeSkillBody", () => {
  test("appends a dated improvement section — v(N)'s content survives", () => {
    const merged = mergeSkillBody("1. open dashboard\n2. draft", "3. cite the diff inline");
    expect(merged).toContain("1. open dashboard");
    expect(merged).toContain("## Improvement (");
    expect(merged).toContain("cite the diff inline");
  });
});

describe("reflect() → skill vN+1", () => {
  const improvement = ok({
    role: "assistant",
    content:
      '{"kind":"skill_improvement","name":"weekly-update","content":"dashboard-first beats inbox-first","body":"1. open dashboard FIRST\\n2. then draft","confidence":0.8}',
  });

  test("an existing skill is UPDATED with base_version and an append-merged body", async () => {
    const db = openDb(":memory:");
    const { tools, calls } = mockSkillRegistry();
    const run = seedDoneRun(db, transcript);
    const out = await reflect(
      { db, events: new Events(db), chat: async () => improvement, tools },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    await drainOnce({
      db,
      events: new Events(db),
      capability: new SkillRegistryAdapter(tools),
      curated: new DefaultCuratedAdapter(tools),
      ctx,
      promoteMinRuns: 1,
    });
    expect(calls.create?.length).toBe(0); // no duplicate v1
    const upd = calls.update?.[0] as Record<string, unknown>;
    expect(upd.base_version).toBe(3);
    expect(String(upd.body)).toContain("1. open dashboard"); // v3 body preserved
    expect(String(upd.body)).toContain("dashboard FIRST"); // improvement appended
  });

  test("version_conflict → one re-get + retry with the fresh base", async () => {
    const db = openDb(":memory:");
    const { tools, calls } = mockSkillRegistry({ conflictOnce: true });
    const run = seedDoneRun(db, transcript);
    const out = await reflect(
      { db, events: new Events(db), chat: async () => improvement, tools },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    await drainOnce({
      db,
      events: new Events(db),
      capability: new SkillRegistryAdapter(tools),
      curated: new DefaultCuratedAdapter(tools),
      ctx,
      promoteMinRuns: 1,
    });
    expect(calls.update?.length).toBe(2);
    expect((calls.update?.[1] as Record<string, unknown>).base_version).toBe(4);
  });

  test("a genuinely-new skill still CREATEs (today's contract)", async () => {
    const db = openDb(":memory:");
    const { tools, calls } = mockSkillRegistry();
    const run = seedDoneRun(db, transcript);
    const brandNew = ok({
      role: "assistant",
      content:
        '{"kind":"skill_improvement","name":"research-a-company","content":"gather sources then synthesize with inline citations","body":"1. gather\\n2. synthesize","confidence":0.8}',
    });
    await reflect(
      { db, events: new Events(db), chat: async () => brandNew, tools },
      run,
      { runId: "r" },
      ctx,
    );
    await drainOnce({
      db,
      events: new Events(db),
      capability: new SkillRegistryAdapter(tools),
      curated: new DefaultCuratedAdapter(tools),
      ctx,
      promoteMinRuns: 1,
    });
    expect(calls.update?.length).toBe(0);
    expect((calls.create?.[0] as Record<string, unknown>).name).toBe("research-a-company");
  });

  test("the skill index rides the USER message as data — never the system prompt (injection surface)", async () => {
    const db = openDb(":memory:");
    const { tools } = mockSkillRegistry();
    let systemSeen = "";
    let userSeen = "";
    const chat = async (req: ChatRequest) => {
      systemSeen = (req.messages.find((m) => m.role === "system")?.content as string) ?? "";
      userSeen = (req.messages.find((m) => m.role === "user")?.content as string) ?? "";
      return ok({ role: "assistant", content: '{"kind":"none"}' });
    };
    const run = seedDoneRun(db, transcript);
    await reflect({ db, events: new Events(db), chat, tools }, run, { runId: "r" }, ctx);
    // A registry description must not acquire system-role authority (codex #5).
    expect(systemSeen).not.toContain("weekly-update");
    expect(userSeen).toContain("Existing-skill index");
    expect(userSeen).toContain("weekly-update");
  });

  test("no skill-registry write tool → no index fetch (no behavior change for plain deployments)", async () => {
    const db = openDb(":memory:");
    const { tools, calls } = mockSkillRegistry();
    tools.delete("skills__skill_create");
    tools.delete("skills__skill_update");
    const run = seedDoneRun(db, transcript);
    await reflect(
      {
        db,
        events: new Events(db),
        chat: async () => ok({ role: "assistant", content: '{"kind":"none"}' }),
        tools,
      },
      run,
      { runId: "r" },
      ctx,
    );
    expect(calls.search?.length).toBe(0); // index never fetched — nothing could be proposed
  });
});
