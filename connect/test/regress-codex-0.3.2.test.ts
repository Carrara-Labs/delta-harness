import { describe, expect, test } from "bun:test";

import { Connector } from "../src/core";
import { Store } from "../src/store";
import type {
  AgentClient,
  AgentSupervisor,
  ChannelCodec,
  Inbound,
  OperationResult,
} from "../src/types";

// Regression tests for the codex findings on the 0.3.2 async path (three review passes). The final
// design: dispatch keys on an ingest-time `intercept` classification (oldest-first, unbounded); a
// lost-202 start becomes a durable PLACEHOLDER task that pollTasks resolves via the harness's
// terminal-aware idempotency; schedule origin binds by the daemon-asserted user.

class RecordingCodec implements ChannelCodec {
  readonly name = "test";
  sent: string[] = [];
  typingCalls = 0;
  async send(_chatId: string, text: string) {
    this.sent.push(text);
    return { ok: true, retryable: false };
  }
  async typing() {
    this.typingCalls++;
  }
}

class NoopSupervisor implements AgentSupervisor {
  async ensureAwake() {
    return "http://agent";
  }
  async maybeSuspend() {}
  async restart(): Promise<OperationResult> {
    return { ok: true };
  }
  async shutdown(): Promise<OperationResult> {
    return { ok: true };
  }
}

const event = (eventId: string, text: string, conv = "tg:100", actor = "tg:7"): Inbound => ({
  eventId,
  conversationId: conv,
  actorId: actor,
  chatId: conv.replace("tg:", ""),
  text,
});

/** A configurable async agent. startResult/terminal are callbacks so a test can flip behaviour
 *  mid-run (e.g. a start that fails then succeeds, a run that finishes on the 2nd poll). */
function agentRig(opts: {
  startResult?: () => { id: string } | { error: string };
  terminal: () => {
    status: string;
    responseId?: string;
    outputText?: string;
    error?: string;
  } | null;
  pollDelayMs?: number;
}): AgentClient & { started: string[]; cancelled: string[]; startCalls: number } {
  const started: string[] = [];
  const cancelled: string[] = [];
  let startCalls = 0;
  return {
    started,
    cancelled,
    get startCalls() {
      return startCalls;
    },
    async run() {
      return { responseId: "sync", outputText: "sync" };
    },
    async status() {
      return { version: "0.3.2", model: { model: "m", provider: "anthropic-native" } };
    },
    async startTask(_input, o) {
      startCalls++;
      const r = opts.startResult?.() ?? { id: `task-${startCalls}` };
      if ("id" in r) started.push(o.idempotencyKey);
      return r;
    },
    async pollTask() {
      if (opts.pollDelayMs) await Bun.sleep(opts.pollDelayMs);
      return opts.terminal();
    },
    async cancelTask(id) {
      cancelled.push(id);
    },
  };
}

const PH = "pending:"; // placeholder task-id prefix (mirrors Connector.PLACEHOLDER)

describe("codex 0.3.2 findings — final design", () => {
  // ---- dispatch (intercept column) ----

  test("dispatch is oldest-first: an earlier ordinary message runs before a later /new", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = agentRig({ terminal: () => ({ status: "running" }) });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    // Same batch, same conversation: an ordinary message THEN /new. The ordinary one is older, so it
    // must start first (become the turn); /new must NOT jump ahead of it (codex P1 ordering).
    store.insertInbox(event("e1", "first, ordinary"));
    store.insertInbox(event("e2", "/new"));
    await c.runOnce();
    expect(agent.started).toEqual(["e1"]); // the ordinary message started, not /new
    await c.runOnce();
    expect(codec.sent.at(-1)).toContain("Fresh"); // /new handled after
  });

  test("a /cancel is found regardless of queue depth, flood, or leading whitespace", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = agentRig({ terminal: () => ({ status: "running" }) });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("t1", "long thing")); // busy tg:100
    await c.runOnce();
    // 40 ordinary + 20 non-intercept /bogus messages queue behind the busy conversation...
    for (let i = 0; i < 40; i++) store.insertInbox(event(`q${i}`, `message ${i}`));
    for (let i = 0; i < 20; i++) store.insertInbox(event(`b${i}`, `/bogus${i}`));
    store.insertInbox(event("cx", "  /cancel")); // leading whitespace, far at the back
    await c.runOnce();
    expect(agent.cancelled).toHaveLength(1); // classified as an intercept at ingest → found at once
    expect(codec.sent.at(-1)).toBe("Stopping that now.");
  });

  test("a newline-arg operator command is dispatched (not stuck)", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = agentRig({ terminal: () => ({ status: "running" }) });
    const c = new Connector(store, codec, agent, new NoopSupervisor(), () => {}, new Set(["7"]));
    store.insertInbox(event("t1", "long thing"));
    await c.runOnce();
    store.insertInbox(event("tg:cx", "/restart\nfoo")); // \s+ split → intercept; must dispatch
    await c.runOnce();
    expect(codec.sent.at(-1)).toContain("Usage");
  });

  test("a ready conversation is not starved by another's deep backlog", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = agentRig({ terminal: () => ({ status: "running" }) });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("a0", "long A", "tg:A", "tg:1")); // A busy
    await c.runOnce();
    for (let i = 0; i < 40; i++)
      store.insertInbox(event(`a${i + 1}`, `more A ${i}`, "tg:A", "tg:1"));
    store.insertInbox(event("b1", "hello B", "tg:B", "tg:2")); // B free, far back
    await c.runOnce();
    expect(agent.started).toContain("b1");
    expect(store.activeTasks().some((t) => t.conversation_id === "tg:B")).toBe(true);
  });

  // ---- placeholder (lost-202) family ----

  test("a lost-202 start becomes a durable placeholder, then resolves and delivers (no orphan)", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    let started = false;
    let done = false;
    const agent = agentRig({
      startResult: () => (started ? { id: "task-real" } : { error: "dropped 202" }),
      terminal: () =>
        done
          ? { status: "done", responseId: "r1", outputText: "delivered" }
          : { status: "running" },
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "do a thing"));

    await c.runOnce(); // start fails → placeholder task
    const active = store.activeTasks();
    expect(active).toHaveLength(1);
    expect(active[0]?.task_id).toBe(`${PH}e1`); // conversation is durably busy, nothing delivered
    expect(codec.sent).toHaveLength(0);

    started = true;
    await c.pollTasks(); // re-POST resolves the placeholder to the real run id
    expect(store.activeTasks()[0]?.task_id).toBe("task-real");
    done = true;
    await c.pollTasks(); // real run completes → delivered
    expect(codec.sent).toEqual(["delivered"]);
    expect(store.activeTasks()).toHaveLength(0);
  });

  test("/cancel during the placeholder window carries over and stops the resolved run", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    let started = false;
    let cancelled = false;
    const agent = agentRig({
      startResult: () => (started ? { id: "task-real" } : { error: "dropped 202" }),
      terminal: () => (cancelled ? { status: "cancelled" } : { status: "running" }),
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "do a thing"));
    await c.runOnce(); // placeholder
    store.insertInbox(event("e2", "/cancel"));
    await c.runOnce(); // /cancel sees the placeholder, records intent + acks
    expect(codec.sent.at(-1)).toBe("Stopping that now.");

    started = true;
    await c.pollTasks(); // resolves placeholder → real id, carrying cancel_requested
    cancelled = true;
    await c.pollTasks(); // the carried cancel takes → Stopped
    expect(agent.cancelled).toContain("task-real"); // the REAL run was cancelled, not orphaned
    expect(codec.sent.at(-1)).toBe("Stopped.");
    expect(store.activeTasks()).toHaveLength(0);
  });

  test("/new during the placeholder window does not resurrect the old thread on completion", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    let started = false;
    let done = false;
    const agent = agentRig({
      startResult: () => (started ? { id: "task-real" } : { error: "dropped 202" }),
      terminal: () =>
        done
          ? { status: "done", responseId: "r-old", outputText: "old answer" }
          : { status: "running" },
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "long thing"));
    await c.runOnce(); // placeholder
    store.insertInbox(event("e2", "/new"));
    await c.runOnce(); // /new detaches the placeholder's head
    started = true;
    await c.pollTasks(); // resolve → real id (advance_head carried = 0)
    done = true;
    await c.pollTasks(); // completes: delivers, but must NOT re-head the fresh thread
    expect(codec.sent).toContain("old answer");
    expect(store.getSession("tg:100")).toBeNull();
  });

  test("a placeholder that never resolves is finalized as an error after the deadline", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = agentRig({
      startResult: () => ({ error: "daemon down" }),
      terminal: () => ({ status: "running" }),
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    // @ts-expect-error shorten the private deadline so the test doesn't wait 60s
    c.PLACEHOLDER_DEADLINE_MS = -1;
    store.insertInbox(event("e1", "do a thing"));
    await c.runOnce(); // placeholder
    expect(store.activeTasks()).toHaveLength(1);
    await c.pollTasks(); // re-POST still fails + past deadline → finalize error
    expect(codec.sent.at(-1)).toContain("couldn't start");
    expect(store.activeTasks()).toHaveLength(0);
  });

  // ---- schedule origin (P0) ----

  test("schedule origin binds by the daemon-asserted user, even with concurrent conversations", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = agentRig({ terminal: () => ({ status: "running" }) });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("a1", "long A", "tg:A", "tg:1"));
    await c.runOnce();
    store.insertInbox(event("b1", "long B", "tg:B", "tg:2"));
    await c.runOnce();
    expect(store.activeTasks()).toHaveLength(2);
    // With an asserted user, bind to THAT user's task — not a guess.
    expect(c.resolveScheduleOrigin("tg:1")?.conversationId).toBe("tg:A");
    expect(c.resolveScheduleOrigin("tg:2")?.conversationId).toBe("tg:B");
    // Without an asserted identity (older daemon), fail closed while ≥2 run concurrently.
    expect(c.resolveScheduleOrigin(null)).toBeNull();
  });

  test("schedule origin fails closed when ONE user has turns in two conversations (codex P0)", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = agentRig({ terminal: () => ({ status: "running" }) });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    // Same user (tg:1), two conversations (a DM and a group). The daemon asserts only the user, so
    // binding to either could cross-route the schedule → refuse rather than leak.
    store.insertInbox(event("a1", "long A", "tg:A", "tg:1"));
    await c.runOnce();
    store.insertInbox(event("g1", "long G", "tg:G", "tg:1"));
    await c.runOnce();
    expect(store.activeTasks()).toHaveLength(2);
    expect(c.resolveScheduleOrigin("tg:1")).toBeNull(); // ambiguous → 409, no leak
  });

  // ---- /new ordering ----

  test("/new drops only messages that arrived BEFORE it, not one from the same batch after it", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = agentRig({ terminal: () => ({ status: "running" }) });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("t1", "long thing")); // active turn on tg:100
    await c.runOnce();
    // A long-poll batch: a question BEFORE /new (belongs to the old thread), /new, then a NEW
    // question AFTER /new (belongs to the fresh thread and must survive).
    store.insertInbox(event("m1", "old-thread question"));
    store.insertInbox(event("n1", "/new"));
    store.insertInbox(event("m2", "fresh-thread question"));
    await c.runOnce(); // handle /new: drop m1 (before), keep m2 (after)
    expect(codec.sent.at(-1)).toContain("Fresh");
    // m1 (before /new) is dropped; m2 (after /new) survives — it will run in the fresh thread once
    // the busy turn t1 finishes (both are for the same, still-busy conversation).
    expect(store.getInboxByEvent("m1")?.status).toBe("dropped");
    expect(store.getInboxByEvent("m2")?.status).toBe("pending");
  });

  // ---- pollTasks robustness ----

  test("an unresolved placeholder is NOT reported as progress (no tight retry loop)", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = agentRig({
      startResult: () => ({ error: "still down" }),
      terminal: () => ({ status: "running" }),
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "do a thing"));
    await c.runOnce(); // placeholder (start failed)
    expect(store.activeTasks()[0]?.task_id).toBe(`${PH}e1`);
    // A poll that fails to resolve the placeholder returns false → the loop will sleep, not spin.
    expect(await c.pollTasks()).toBe(false);
    expect(store.activeTasks()).toHaveLength(1); // still a placeholder, not finalized (deadline not hit)
  });

  // ---- pollTasks robustness ----

  test("pollTasks polls all in-flight tasks concurrently, not serially", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = agentRig({ terminal: () => ({ status: "running" }), pollDelayMs: 120 });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    for (let i = 0; i < 5; i++) {
      store.insertInbox(event(`e${i}`, "long", `tg:${i}`, `tg:${i}`));
      await c.runOnce();
    }
    expect(store.activeTasks()).toHaveLength(5);
    const t0 = Bun.nanoseconds();
    await c.pollTasks();
    const ms = (Bun.nanoseconds() - t0) / 1e6;
    expect(ms).toBeLessThan(300); // concurrent (~120ms), not serial (~600ms)
  });

  test("a finalized task row is deleted, not accumulated", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    let done = false;
    const agent = agentRig({
      terminal: () =>
        done ? { status: "done", responseId: "r", outputText: "ok" } : { status: "running" },
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "do it"));
    await c.runOnce();
    done = true;
    await c.pollTasks();
    expect(codec.sent).toContain("ok");
    expect(store.allTasksCount()).toBe(0);
  });
});
