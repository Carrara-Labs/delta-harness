// Sprint 4 — the self-scheduling builtins against a REAL mock control plane (auth header,
// wire shapes, error paths), plus the graceful-off path for non-CP-wired binaries.

import { afterAll, describe, expect, test } from "bun:test";
import { builtinTools } from "../src/builtins";
import type { ToolCtx } from "../src/tools";

let lastAuth: string | null = null;
let lastBody: Record<string, unknown> = {};
const srv = Bun.serve({
  port: 0,
  async fetch(req) {
    lastAuth = req.headers.get("authorization");
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/api/agents/self/schedules") {
      lastBody = (await req.json()) as Record<string, unknown>;
      const spec = (lastBody.spec ?? {}) as Record<string, unknown>;
      if (spec.kind === "bogus")
        return Response.json(
          { error: "spec.kind must be one of: once | interval | cron" },
          { status: 400 },
        );
      return Response.json(
        { schedule: { id: "sch_1", nextRunAt: "2026-07-10T13:00:00.000Z" } },
        { status: 201 },
      );
    }
    if (req.method === "GET" && url.pathname === "/api/agents/self/schedules") {
      return Response.json({
        schedules: [
          {
            id: "sch_1",
            state: "active",
            specKind: "interval",
            nextRunAt: "2026-07-10T13:00:00.000Z",
            prompt: "check the deploy",
          },
        ],
      });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/agents/self/schedules/")) {
      return url.pathname.endsWith("/gone")
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json({ ok: true });
    }
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => srv.stop(true));

const cfg = {
  workspace: "/tmp/delta-sched-ws",
  codeCli: ["true"],
  selfCmd: ["true"],
  subagentDepth: 0,
  controlUrl: `http://localhost:${srv.port}`,
  controlToken: "gw_secret_token",
};
const ctx = { workspace: cfg.workspace, activate: () => {} } as unknown as ToolCtx;

describe("self-scheduling builtins", () => {
  test("registered only when CP-wired; absent on a bare dev binary", () => {
    const wired = builtinTools(cfg);
    expect(wired.has("schedule_self")).toBe(true);
    expect(wired.has("list_schedules")).toBe(true);
    expect(wired.has("cancel_schedule")).toBe(true);
    const bare = builtinTools({ ...cfg, controlUrl: undefined, controlToken: undefined } as never);
    expect(bare.has("schedule_self")).toBe(false);
  });

  test("schedule_self POSTs spec+prompt with the VM's bearer and reports the next run", async () => {
    const tools = builtinTools(cfg);
    const out = await tools
      .get("schedule_self")
      ?.execute(
        { spec: { kind: "interval", intervalMs: 3_600_000 }, prompt: "check the deploy" },
        ctx,
      );
    expect(out).toBe("scheduled sch_1 — next run 2026-07-10T13:00:00.000Z");
    expect(lastAuth).toBe("Bearer gw_secret_token"); // the VM self-auths with ITS token
    expect((lastBody.spec as Record<string, unknown>).kind).toBe("interval");
    expect(lastBody.prompt).toBe("check the deploy");
  });

  test("a CP validation error surfaces as an agent-readable [tool error]", async () => {
    const tools = builtinTools(cfg);
    const out = await tools
      .get("schedule_self")
      ?.execute({ spec: { kind: "bogus" }, prompt: "x" }, ctx);
    expect(out).toMatch(/^\[tool error\] schedule_self 400: spec\.kind/);
  });

  test("list_schedules formats rows; cancel handles found and missing ids", async () => {
    const tools = builtinTools(cfg);
    const list = await tools.get("list_schedules")?.execute({}, ctx);
    expect(list).toContain("sch_1 [active] interval → next 2026-07-10T13:00:00.000Z");
    expect(await tools.get("cancel_schedule")?.execute({ id: "sch_1" }, ctx)).toBe(
      "cancelled sch_1",
    );
    expect(await tools.get("cancel_schedule")?.execute({ id: "gone" }, ctx)).toBe(
      "[tool error] no such schedule gone",
    );
  });
});
