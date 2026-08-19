// D-3+D-2: DELTA_ALLOWED_TOOLS is a ceiling, not a guarantee — registration preconditions fail
// silently (Delos configured 16 tools and had 13; one missing EXA key cost 724,804 input tokens
// of routing-around). /v1/status now reports three states: registered (in the live registry),
// unusable (registered, live precondition says a call fails NOW — may heal without a restart),
// omitted (never registered this boot — fix config and restart). No de-registration: a key handed
// to the agent at runtime must keep working the moment it lands (the 0.2.10 vault contract).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtins";
import { openDb } from "../src/db";
import { Queue } from "../src/queue";
import { createServer } from "../src/server";
import { Vault } from "../src/vault";
import { makeDeps, textResult } from "./helpers";

const ws = mkdtempSync(join(tmpdir(), "delta-status-"));
const db = openDb(":memory:");
const vault = Vault.open(db, "a-test-vault-key-of-sufficient-length") as Vault;

// No EXA key in env or vault, no controlUrl/controlToken, a bogus code CLI, no depth.
const omitted: Array<{ name: string; reason: string }> = [];
const tools = builtinTools(
  {
    workspace: ws,
    codeCli: ["definitely-not-a-real-binary-xyz"],
    selfCmd: ["true"],
    subagentDepth: 0,
    vault,
  },
  (name, reason) => omitted.push({ name, reason }),
);

const deps = makeDeps(async () => textResult("ok"), tools, { workspace: ws });
const server = createServer(new Queue(deps), deps.events, 0, {
  workspace: ws,
  vault,
  tools: deps.tools,
  toolsOmitted: omitted,
});
const base = `http://localhost:${server.port}`;
afterAll(() => {
  server.stop();
  rmSync(ws, { recursive: true, force: true });
});

type ToolsReport = {
  registered: string[];
  unusable: Array<{ name: string; reason: string }>;
  omitted: Array<{ name: string; reason: string }>;
};

describe("GET /v1/status tools report (D-3)", () => {
  test("registered includes web_search; unusable names it with a reason; omitted has the gated set", async () => {
    const body = (await (await fetch(`${base}/v1/status`)).json()) as { tools: ToolsReport };
    const t = body.tools;
    // web_search is REGISTERED (never de-registered for a missing key — the vault contract)…
    expect(t.registered).toContain("web_search");
    // …but reported unusable, with a reason an operator can act on.
    const unusable = t.unusable.find((u) => u.name === "web_search");
    expect(unusable).toBeDefined();
    expect(unusable?.reason.length).toBeGreaterThan(0);
    // The silently-gated set is named, each with a reason.
    for (const name of ["schedule_self", "list_schedules", "cancel_schedule", "code"]) {
      const o = t.omitted.find((x) => x.name === name);
      expect(o).toBeDefined();
      expect(o?.reason.length).toBeGreaterThan(0);
    }
    // Depth-gated delegation tools were NOT omitted at depth 0.
    expect(t.omitted.find((x) => x.name === "research")).toBeUndefined();
    // And nothing anywhere carries a secret value shape (names + reasons only).
    expect(JSON.stringify(t)).not.toContain("Bearer");
  });

  test("a key landing in the vault heals `unusable` WITHOUT a restart — the assertion that locks §3", async () => {
    vault.put("EXA_API_KEY", "exa-test-key-value");
    const body = (await (await fetch(`${base}/v1/status`)).json()) as { tools: ToolsReport };
    expect(body.tools.unusable.find((u) => u.name === "web_search")).toBeUndefined();
    expect(body.tools.registered).toContain("web_search");
    // The key's VALUE never appears anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain("exa-test-key-value");
  });

  test("depth-gated tools are omitted with a reason at subagent depth 1", () => {
    const childOmitted: Array<{ name: string; reason: string }> = [];
    builtinTools(
      { workspace: ws, codeCli: ["echo"], selfCmd: ["true"], subagentDepth: 1 },
      (name, reason) => childOmitted.push({ name, reason }),
    );
    for (const name of ["research", "spawn_subagent", "eval_n"])
      expect(childOmitted.find((x) => x.name === name)).toBeDefined();
  });
});
