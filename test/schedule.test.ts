// Sprint 4 — the self-scheduling builtins against a REAL mock control plane (auth header,
// wire shapes, error paths), plus the graceful-off path for non-CP-wired binaries.

import { afterAll, describe, expect, test } from "bun:test";
import { builtinTools } from "../src/builtins";
import type { ToolCtx } from "../src/tools";

let lastAuth: string | null = null;
const seenUsers: (string | null)[] = [];
let lastBody: Record<string, unknown> = {};
const srv = Bun.serve({
  port: 0,
  async fetch(req) {
    lastAuth = req.headers.get("authorization");
    seenUsers.push(req.headers.get("x-delta-user"));
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
    // The real control server 409s when it cannot resolve the origin (Connect control.ts: "no
    // active agent turn"), which is what a run driven straight at the daemon seam looks like. Keyed
    // on an owner no other test uses so the happy paths are untouched.
    if (req.headers.get("x-delta-user") === "tg:409" && req.method !== "POST")
      return Response.json({ error: "no active agent turn" }, { status: 409 });
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

  test("schedule/list/cancel assert the run's owner via x-delta-user (concurrent-safe binding)", async () => {
    const tools = builtinTools(cfg);
    const owned = { ...ctx, owner: "tg:42" } as ToolCtx;
    seenUsers.length = 0;
    await tools
      .get("schedule_self")
      ?.execute({ spec: { kind: "interval", intervalMs: 3_600_000 }, prompt: "p" }, owned);
    await tools.get("list_schedules")?.execute({}, owned);
    await tools.get("cancel_schedule")?.execute({ id: "sch_1" }, owned);
    // POST, GET and DELETE all assert the owner.
    expect(seenUsers).toEqual(["tg:42", "tg:42", "tg:42"]);
    // An unowned/dev run sends no assertion (gateway falls back to its single-origin binding).
    seenUsers.length = 0;
    await tools
      .get("schedule_self")
      ?.execute({ spec: { kind: "interval", intervalMs: 3_600_000 }, prompt: "p" }, ctx);
    expect(seenUsers).toEqual([null]);
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

  // Ferni, 2026-08-10: a bare "[tool error] list_schedules 409" was read by the agent as "my
  // schedules are unreadable" and filed as a blocker, when the control server had actually said
  // "no active agent turn". schedule_self already carried its reason; the two read paths dropped
  // it. The status is not the diagnosis, so assert on the REASON reaching the agent.
  test("a 409 on the read paths carries the control server's reason, not just the status", async () => {
    const tools = builtinTools(cfg);
    const orphan = { ...ctx, owner: "tg:409" } as ToolCtx;
    expect(await tools.get("list_schedules")?.execute({}, orphan)).toBe(
      "[tool error] list_schedules 409: no active agent turn",
    );
    expect(await tools.get("cancel_schedule")?.execute({ id: "sch_1" }, orphan)).toBe(
      "[tool error] cancel_schedule 409: no active agent turn",
    );
  });
});
