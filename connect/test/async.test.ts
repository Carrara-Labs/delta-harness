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

// A codec that records sends + typing pings so we can assert the streaming/typing UX.
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
  suspends = 0;
  async ensureAwake() {
    return "http://agent";
  }
  async maybeSuspend() {
    this.suspends++;
  }
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

/** An async agent whose task lifecycle the test drives explicitly: startTask records the id and a
 *  scripted terminal state that pollTask returns once `ready` flips. */
function scriptedAgent(script: {
  onStart?: (input: string, opts: { idempotencyKey: string; previousResponseId?: string }) => void;
  terminal: () => {
    status: string;
    responseId?: string;
    outputText?: string;
    error?: string;
  } | null;
}): AgentClient & { started: string[]; cancelled: string[]; polls: number } {
  const started: string[] = [];
  const cancelled: string[] = [];
  let n = 0;
  return {
    started,
    cancelled,
    get polls() {
      return n;
    },
    async run() {
      return { responseId: "sync", outputText: "sync" };
    },
    async startTask(input, opts) {
      script.onStart?.(input, opts);
      const id = `task-${started.length + 1}`;
      started.push(opts.idempotencyKey);
      return { id };
    },
    async pollTask() {
      n++;
      return script.terminal();
    },
    async cancelTask(id) {
      cancelled.push(id);
    },
  };
}

/** Drive the connector like the real loop: dispatch new work AND poll in-flight tasks, until quiet. */
async function drain(c: Connector) {
  for (let i = 0; i < 50; i++) {
    const polled = await c.pollTasks();
    const did = await c.runOnce();
    if (!polled && !did) break;
  }
}

describe("0.3.2 async dispatch", () => {
  test("an agent turn dispatches a durable task and delivers only after it completes", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    let done = false;
    const agent = scriptedAgent({
      terminal: () =>
        done
          ? { status: "done", responseId: "r1", outputText: "the answer" }
          : { status: "running" },
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());

    store.insertInbox(event("e1", "do a long thing"));
    await c.runOnce(); // starts the task, does NOT block
    expect(agent.started).toEqual(["e1"]); // idempotency_key = the event id
    expect(store.activeTasks()).toHaveLength(1);
    expect(codec.sent).toHaveLength(0); // nothing delivered yet — the turn is still running

    await c.pollTasks(); // still running
    expect(codec.sent).toHaveLength(0);
    expect(codec.typingCalls).toBeGreaterThan(0); // typing kept alive while working

    done = true;
    await c.pollTasks(); // terminal → finalize + deliver
    expect(codec.sent).toEqual(["the answer"]);
    expect(store.activeTasks()).toHaveLength(0);
    expect(store.getSession("tg:100")?.prev_response_id).toBe("r1"); // thread advanced
  });

  test("per-conversation serialization: a busy conversation is skipped, others flow", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    let done = false;
    const agent = scriptedAgent({
      terminal: () =>
        done ? { status: "done", responseId: "r", outputText: "ok" } : { status: "running" },
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());

    store.insertInbox(event("a1", "first for A", "tg:A"));
    store.insertInbox(event("a2", "second for A", "tg:A")); // queues behind A's task
    store.insertInbox(event("b1", "first for B", "tg:B"));

    await c.runOnce(); // starts A's task (a1)
    await c.runOnce(); // A is busy → must start B's task (b1), NOT a2
    expect(agent.started).toEqual(["a1", "b1"]);
    expect(store.activeTasks()).toHaveLength(2);
    // a2 is still pending (A busy); nothing else eligible
    await c.runOnce();
    expect(agent.started).toEqual(["a1", "b1"]);

    // Finish both tasks; now a2 becomes eligible.
    done = true;
    await c.pollTasks();
    await c.runOnce();
    expect(agent.started).toEqual(["a1", "b1", "a2"]);
  });

  test("durable re-attach: a fresh Connector over the same store finalizes an in-flight task", async () => {
    const store = new Store(":memory:");
    const codec1 = new RecordingCodec();
    let done = false;
    const mkAgent = () =>
      scriptedAgent({
        terminal: () =>
          done
            ? { status: "done", responseId: "r", outputText: "recovered" }
            : { status: "running" },
      });
    const c1 = new Connector(store, codec1, mkAgent(), new NoopSupervisor());
    store.insertInbox(event("e1", "long task"));
    await c1.runOnce(); // task started + recorded durably
    expect(store.activeTasks()).toHaveLength(1);

    // Simulate a Connect restart: brand-new Connector, same durable store.
    const codec2 = new RecordingCodec();
    const c2 = new Connector(store, codec2, mkAgent(), new NoopSupervisor());
    done = true;
    await c2.pollTasks(); // the tracker re-attaches from the tasks table and finalizes
    expect(codec2.sent).toEqual(["recovered"]);
    expect(store.activeTasks()).toHaveLength(0);
  });

  test("a failed task frees the conversation and reports the error", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = scriptedAgent({
      terminal: () => ({ status: "failed", error: "quota exhausted" }),
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "do it"));
    await drain(c);
    expect(codec.sent[0]).toContain("could not finish");
    expect(codec.sent[0]).toContain("quota exhausted");
    expect(store.activeTasks()).toHaveLength(0); // conversation freed
    expect(store.getSession("tg:100")).toBeNull(); // no thread advance on failure
  });

  test("a cancelled task reports 'Stopped.' and frees the conversation", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = scriptedAgent({ terminal: () => ({ status: "cancelled" }) });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "do it"));
    await drain(c);
    expect(codec.sent).toEqual(["Stopped."]);
    expect(store.activeTasks()).toHaveLength(0);
  });

  test("a local command flows even while the conversation has a task in-flight (codex P1)", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const agent = scriptedAgent({ terminal: () => ({ status: "running" }) }); // never finishes
    // give it a status read so /status has something to render
    (agent as unknown as { status: () => Promise<Record<string, unknown>> }).status = async () => ({
      version: "0.3.2",
      model: { model: "m", provider: "anthropic-native" },
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "long task")); // starts a task for tg:100
    await c.runOnce();
    expect(store.activeTasks()).toHaveLength(1);
    // A /status for the SAME (busy) conversation must still be answered, not blocked.
    store.insertInbox(event("e2", "/status"));
    await c.runOnce();
    expect(codec.sent.at(-1)).toContain("anthropic-native");
    // ...and the task is still running (the command didn't disturb it).
    expect(store.activeTasks()).toHaveLength(1);
  });

  test("/cancel stops an in-flight task; pollTasks then finalizes it as Stopped", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    let cancelled = false;
    const agent = scriptedAgent({
      terminal: () => (cancelled ? { status: "cancelled" } : { status: "running" }),
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "long task"));
    await c.runOnce(); // task active
    store.insertInbox(event("e2", "/cancel"));
    await c.runOnce();
    expect(agent.cancelled).toHaveLength(1); // DELETE fired
    expect(codec.sent.at(-1)).toBe("Stopping that now.");
    cancelled = true;
    await c.pollTasks();
    expect(codec.sent.at(-1)).toBe("Stopped.");
    expect(store.activeTasks()).toHaveLength(0);
  });

  test("a transient poll failure keeps the task active (no false completion)", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    let phase = 0;
    const agent = scriptedAgent({
      // first poll: transient null; second: done
      terminal: () =>
        phase++ === 0 ? null : { status: "done", responseId: "r", outputText: "eventually" },
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "do it"));
    await c.runOnce();
    await c.pollTasks(); // transient → stays active
    expect(store.activeTasks()).toHaveLength(1);
    expect(codec.sent).toHaveLength(0);
    await c.pollTasks(); // done
    expect(codec.sent).toEqual(["eventually"]);
  });
});
