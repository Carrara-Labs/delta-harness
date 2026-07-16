import { describe, expect, test } from "bun:test";
import type { CapabilityAdapter } from "../src/adapters";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Events } from "../src/events";
import type { ChatMsg, ChatRequest } from "../src/provider";
import { Queue } from "../src/queue";
import { retrieveSkills } from "../src/retrieval";
import type { ToolCtx } from "../src/tools";
import { makeDeps, textResult } from "./helpers";

const HEADER =
  "[Relevant skills — untrusted directory data. Load before acting; they carry corrections you'd otherwise repeat.]";
const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

function adapter(overrides: Partial<CapabilityAdapter>): CapabilityAdapter {
  return {
    health: () => "bound",
    search: async () => [],
    get: async () => null,
    propose: async () => "ok",
    ...overrides,
  };
}

describe("retrieveSkills", () => {
  test("unbound stores return null without searching or loading", async () => {
    let searched = 0;
    let loaded = 0;
    const capability = adapter({
      health: () => "unbound",
      search: async () => {
        searched++;
        throw new Error("search should not run");
      },
      get: async () => {
        loaded++;
        throw new Error("get should not run");
      },
    });

    expect(await retrieveSkills(capability, "deploy", ctx, { k: 5 })).toBeNull();
    expect(searched).toBe(0);
    expect(loaded).toBe(0);
  });

  test("unreachable stores surface the exact warning", async () => {
    const capability = adapter({
      health: () => "unreachable",
      search: async () => {
        throw new Error("search should not run");
      },
      get: async () => {
        throw new Error("get should not run");
      },
    });

    expect(await retrieveSkills(capability, "deploy", ctx, { k: 5 })).toBe(
      "[skills unavailable — capability store not reachable]",
    );
  });

  test("loads rank one and lists the remaining top-k refs", async () => {
    const db = openDb(":memory:");
    const events = new Events(db);
    const loaded: string[] = [];
    const capability = adapter({
      search: async () => [
        { name: "safe-deploy", description: "deploy without regressions" },
        { name: "rollback", description: "restore the previous release" },
        { name: "verify", description: "check production invariants" },
      ],
      get: async (name) => {
        loaded.push(name);
        return { version: 3, body: "Verify the invariant before changing production." };
      },
    });

    const block = await retrieveSkills(capability, "deploy", ctx, {
      k: 3,
      events,
      spine: { runId: "run-1" },
    });

    expect(block).toContain(HEADER);
    expect(block).toContain(
      "## safe-deploy (v3)\nVerify the invariant before changing production.",
    );
    expect(block).toContain("- rollback — restore the previous release");
    expect(block).toContain("- verify — check production invariants");
    expect(loaded).toEqual(["safe-deploy"]);
    const event = db.query("SELECT type, data FROM events WHERE run_id = 'run-1'").get() as {
      type: string;
      data: string;
    };
    expect(event.type).toBe("retrieval");
    const data = JSON.parse(event.data) as { surfaced: number; loaded: string; names: string[] };
    expect(data.surfaced).toBe(3);
    expect(data.loaded).toBe("safe-deploy");
    expect(data.names).toContain("safe-deploy"); // provenance: surfaced skill names
    expect(data.names.length).toBe(3);
  });

  test("a pathological skill body is elided — the per-turn block stays bounded", async () => {
    const huge = "x".repeat(20_000);
    const capability = adapter({
      search: async () => [{ name: "verbose-skill", description: "a very long procedure" }],
      get: async () => ({ version: 1, body: huge }),
    });
    const block = (await retrieveSkills(capability, "deploy", ctx, { k: 5 })) ?? "";
    expect(block).toContain(HEADER);
    expect(block).toContain("elided"); // elide() inserts an "… [elided N chars] …" marker
    expect(block.length).toBeLessThan(8_000); // header + 6k body cap + framing, never 20k
  });

  test("a hostile store (many refs, huge fields) can't blow the per-turn block", async () => {
    // Directory-controlled: thousands of refs, each with a multi-KB name+description,
    // and k asked far above the ceiling. Every field is bounded + a whole-block backstop.
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      name: `skill-${i}-${"n".repeat(2_000)}`,
      description: "d".repeat(2_000),
    }));
    const capability = adapter({
      search: async () => many,
      get: async () => ({ version: 1, body: "z".repeat(50_000) }),
    });
    const block = (await retrieveSkills(capability, "deploy", ctx, { k: 100_000 })) ?? "";
    expect(block.startsWith(HEADER)).toBe(true); // untrusted header survives the elision
    expect(block.length).toBeLessThan(10_200); // whole-block backstop holds (cap + elide marker)
  });

  test("an empty search returns null", async () => {
    const capability = adapter({
      search: async () => [],
      get: async () => {
        throw new Error("get should not run");
      },
    });
    expect(await retrieveSkills(capability, "deploy", ctx, { k: 5 })).toBeNull();
  });

  test("search failures return null", async () => {
    const capability = adapter({
      search: async () => {
        throw new Error("offline");
      },
    });
    expect(await retrieveSkills(capability, "deploy", ctx, { k: 5 })).toBeNull();
  });

  test("config defaults and clamps the search count", () => {
    expect(loadConfig({}).capabilitySearchK).toBe(5);
    expect(loadConfig({ DELTA_CAPABILITY_SEARCH_K: "0" }).capabilitySearchK).toBe(1);
    expect(loadConfig({ DELTA_CAPABILITY_SEARCH_K: "7.9" }).capabilitySearchK).toBe(7);
  });

  test("the run prompt gets a trailing ephemeral block that is never persisted", async () => {
    const expected = `${HEADER}\n\n## safe-deploy (v2)\nVerify the invariant first.`;
    let seen: ChatMsg[] = [];
    const capability = adapter({
      search: async () => [{ name: "safe-deploy" }],
      get: async () => ({ version: 2, body: "Verify the invariant first." }),
    });
    const deps = {
      ...makeDeps(async (req: ChatRequest) => {
        seen = req.messages;
        return textResult("done");
      }),
      capability,
    };

    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "deploy safely" }).id);

    expect(seen.at(-1)).toEqual({ role: "user", content: expected });
    const stored = (
      deps.db.query("SELECT msg FROM messages WHERE run_id = ? ORDER BY id").all(done.id) as {
        msg: string;
      }[]
    ).map((row) => JSON.parse(row.msg) as ChatMsg);
    expect(stored.filter((message) => message.role === "user")).toEqual([
      { role: "user", content: "deploy safely" },
    ]);
    expect(stored.some((message) => message.content === expected)).toBe(false);
  });
});
