import { describe, expect, test } from "bun:test";

import { controlPort, ScheduleControl, validateScheduleRequest } from "../src/control";
import { Connector } from "../src/core";
import { type ScheduleOrigin, Store } from "../src/store";
import type { AgentSupervisor, ChannelCodec } from "../src/types";

const origin: ScheduleOrigin = {
  conversationId: "tg:100",
  actorId: "tg:7",
  chatId: "100",
};

describe("schedule validation", () => {
  test("accepts once and interval, rejects cron and malformed bounds", () => {
    expect(
      validateScheduleRequest({
        prompt: "wake up",
        spec: { kind: "once", runAt: "2026-08-01T12:00:00Z" },
      }).ok,
    ).toBe(true);
    expect(
      validateScheduleRequest({ prompt: "repeat", spec: { kind: "interval", intervalMs: 60_000 } })
        .ok,
    ).toBe(true);
    const cron = validateScheduleRequest({
      prompt: "repeat",
      spec: { kind: "cron", cronExpr: "* * * * *" },
    });
    expect(cron).toEqual({
      ok: false,
      error: "cron is deferred in Delta Connect 0.3.0; use once/interval",
    });
    for (const bad of [
      null,
      { prompt: "", spec: { kind: "once", runAt: "2026-08-01T12:00:00Z" } },
      { prompt: "x", spec: { kind: "once", runAt: "not-a-date" } },
      { prompt: "x", spec: { kind: "interval", intervalMs: 59_999 } },
      { prompt: "x", spec: { kind: "interval", intervalMs: 60_000.5 } },
    ]) {
      expect(validateScheduleRequest(bad).ok).toBe(false);
    }
  });

  test("control URL is an explicit path-free loopback HTTP origin", () => {
    expect(controlPort("http://127.0.0.1:8322")).toBe(8322);
    for (const bad of [
      "http://localhost:8322",
      "https://127.0.0.1:8322",
      "http://0.0.0.0:8322",
      "http://127.0.0.1:8322/api",
      "http://127.0.0.1",
    ]) {
      expect(controlPort(bad)).toBeNull();
    }
  });
});

describe("durable schedule admission", () => {
  test("past once admits exactly one deterministic synthetic turn and completes", () => {
    const store = new Store(":memory:");
    const now = Date.parse("2026-08-01T12:00:00Z");
    const schedule = store.createSchedule(
      origin,
      "check the report",
      { kind: "once", runAt: new Date(now - 1_000).toISOString() },
      now,
    );
    expect(store.admitDue(now)).toBe(1);
    const row = store.nextPending();
    expect(row?.event_id).toBe(`schedule:${schedule.id}:${now - 1_000}`);
    expect(row?.text).toBe(
      `[Scheduled wake at ${new Date(now - 1_000).toISOString()}]\ncheck the report`,
    );
    expect(row?.actor_id).toBe("tg:7");
    expect(store.admitDue(now)).toBe(0);
    expect(store.listSchedules(origin)[0]?.state).toBe("completed");
  });

  test("interval uses latest-only catch-up from its prior cadence", () => {
    const store = new Store(":memory:");
    const start = 1_000_000;
    store.createSchedule(origin, "repeat", { kind: "interval", intervalMs: 60_000 }, start);
    const now = start + 190_000;
    expect(store.admitDue(now)).toBe(1);
    expect(store.nextPending()?.text).toContain(new Date(start + 60_000).toISOString());
    expect(store.listSchedules(origin)[0]?.nextRunAt).toBe(new Date(start + 240_000).toISOString());
    expect(store.admitDue(now)).toBe(0);
  });

  test("cancel wins before admission and ownership scopes list/cancel", () => {
    const store = new Store(":memory:");
    const now = Date.now();
    const schedule = store.createSchedule(
      origin,
      "soon",
      { kind: "once", runAt: new Date(now - 1).toISOString() },
      now,
    );
    const other = { conversationId: "tg:200", actorId: "tg:8", chatId: "200" };
    expect(store.listSchedules(other)).toEqual([]);
    expect(store.cancelSchedule(schedule.id, other)).toBe(false);
    expect(store.cancelSchedule(schedule.id, origin)).toBe(true);
    expect(store.cancelSchedule(schedule.id, origin)).toBe(true);
    expect(store.admitDue(now)).toBe(0);
  });
});

describe("control endpoint gates and correlation", () => {
  test("requires bearer auth and an active turn, then scopes cross-chat access", async () => {
    const store = new Store(":memory:");
    let active: ScheduleOrigin | null = null;
    const control = new ScheduleControl(store, "http://127.0.0.1:8322", "secret", () => active);
    const url = "http://127.0.0.1:8322/api/agents/self/schedules";
    expect((await control.handle(new Request(url))).status).toBe(401);
    expect(
      (await control.handle(new Request(url, { headers: { authorization: "Bearer secret" } })))
        .status,
    ).toBe(409);

    active = origin;
    const created = await control.handle(
      new Request(url, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "later",
          spec: { kind: "once", runAt: "2026-08-01T12:00:00Z" },
        }),
      }),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { schedule: { id: string } }).schedule.id;

    active = { conversationId: "tg:200", actorId: "tg:8", chatId: "200" };
    const listed = await control.handle(
      new Request(url, { headers: { authorization: "Bearer secret" } }),
    );
    expect(await listed.json()).toEqual({ schedules: [] });
    expect(
      (
        await control.handle(
          new Request(`${url}/${id}`, {
            method: "DELETE",
            headers: { authorization: "Bearer secret" },
          }),
        )
      ).status,
    ).toBe(404);
  });

  test("Connector exposes the origin of an active async task, then null once it finalizes", async () => {
    const store = new Store(":memory:");
    let connector: Connector;
    const control = new ScheduleControl(
      store,
      "http://127.0.0.1:8322",
      "secret",
      () => connector.activeOrigin,
    );
    const codec: ChannelCodec = {
      name: "test",
      async send() {
        return { ok: true, retryable: false };
      },
    };
    const supervisor: AgentSupervisor = {
      async ensureAwake() {
        return "http://agent";
      },
      async maybeSuspend() {},
      async restart() {
        return { ok: true };
      },
      async shutdown() {
        return { ok: true };
      },
    };
    // Async agent (0.3.2): the origin for schedule_self binding comes from the durable active-task
    // row, not a single in-flight window.
    connector = new Connector(
      store,
      codec,
      {
        async run() {
          return { responseId: "r", outputText: "unused" };
        },
        async startTask() {
          return { id: "task1" };
        },
        async pollTask() {
          return { status: "done", responseId: "r", outputText: "scheduled" };
        },
      },
      supervisor,
    );
    store.insertInbox({
      eventId: "tg:1",
      conversationId: origin.conversationId,
      actorId: origin.actorId,
      chatId: origin.chatId,
      text: "schedule it",
    });
    // Start the task: now a task is active, so the daemon's schedule_self resolves the origin.
    await connector.runOnce();
    expect(connector.activeOrigin).toEqual(origin);
    const response = await control.handle(
      new Request("http://127.0.0.1:8322/api/agents/self/schedules", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ prompt: "wake", spec: { kind: "interval", intervalMs: 60_000 } }),
      }),
    );
    expect(response.status).toBe(201);
    // Finalize the task: the conversation frees and the origin is null again.
    await connector.pollTasks();
    expect(connector.activeOrigin).toBeNull();
    expect(store.listSchedules(origin)).toHaveLength(1);
  });
});
