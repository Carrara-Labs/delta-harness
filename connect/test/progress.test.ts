import { describe, expect, test } from "bun:test";

import { Connector } from "../src/core";
import { Store } from "../src/store";
import type {
  AgentClient,
  AgentSupervisor,
  ChannelCodec,
  DraftPreview,
  Inbound,
  OperationResult,
} from "../src/types";

// The live preview (Connect 0.5.0). It is best-effort UX layered on the authoritative task poll,
// so what these lock in is mostly what it must NOT do: never outlive its turn, never speak for a
// task the daemon has not accepted yet, never land after the real reply, never grow without bound.

class DraftCodec implements ChannelCodec {
  readonly name = "test";
  sent: string[] = [];
  drafts: Array<{ chatId: string; draftId: number; draft: DraftPreview }> = [];
  async send(_chatId: string, text: string) {
    this.sent.push(text);
    return { ok: true, retryable: false };
  }
  async typing() {}
  async sendDraft(chatId: string, draftId: number, draft: DraftPreview) {
    this.drafts.push({ chatId, draftId, draft });
    return true;
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

const event = (eventId: string, text: string, conv = "tg:100"): Inbound => ({
  eventId,
  conversationId: conv,
  actorId: "tg:7",
  chatId: conv.replace("tg:", ""),
  text,
});

/** An agent whose task status and event feed the test drives explicitly. */
function agentWith(script: {
  terminal: () => { status: string; responseId?: string; outputText?: string } | null;
  feed?: () => Array<Record<string, unknown>>;
  onEvents?: (id: string, since: number) => void;
  startFails?: boolean;
}): AgentClient & { eventReads: number } {
  let cursor = 0;
  let reads = 0;
  return {
    get eventReads() {
      return reads;
    },
    async run() {
      return { responseId: "sync", outputText: "sync" };
    },
    async startTask(_input, _opts) {
      return script.startFails ? { error: "daemon down" } : { id: "task-1" };
    },
    async pollTask() {
      return script.terminal();
    },
    async taskEvents(id, _userId, since) {
      reads++;
      script.onEvents?.(id, since);
      const events = script.feed?.() ?? [];
      cursor += events.length;
      return { events, cursor };
    },
    async cancelTask() {},
  };
}

describe("live progress preview", () => {
  test("names the work in flight, and keeps the ephemeral draft alive under one id", async () => {
    const store = new Store(":memory:");
    const codec = new DraftCodec();
    let feed: Array<Record<string, unknown>> = [];
    const agent = agentWith({ terminal: () => ({ status: "running" }), feed: () => feed });
    const c = new Connector(store, codec, agent, new NoopSupervisor());

    store.insertInbox(event("e1", "research something"));
    await c.runOnce();

    // Before any event has landed there is still something honest to show.
    await c.pollTasks();
    expect(codec.drafts.at(-1)?.draft).toEqual({ kind: "thinking", text: "Thinking" });

    feed = [{ type: "turn.start" }, { type: "tool.call", "gen_ai.tool.name": "web_search" }];
    await c.pollTasks();
    expect(codec.drafts.at(-1)?.draft).toEqual({ kind: "thinking", text: "Searching the web" });

    // A tool nobody named still reads as a sentence rather than an identifier.
    feed = [{ type: "tool.call", "gen_ai.tool.name": "qs_stage_body" }];
    await c.pollTasks();
    expect(codec.drafts.at(-1)?.draft).toEqual({ kind: "thinking", text: "Running qs stage body" });

    // Nothing new: the last thing shown is still true, and re-sending is what stops the 30-second
    // preview from lapsing mid-turn.
    feed = [];
    await c.pollTasks();
    expect(codec.drafts.at(-1)?.draft).toEqual({ kind: "thinking", text: "Running qs stage body" });

    // One draft id for the whole turn, so successive frames animate instead of stacking up.
    expect(new Set(codec.drafts.map((d) => d.draftId)).size).toBe(1);
    expect(codec.drafts[0]?.draftId).toBeGreaterThan(0); // the API rejects a zero id
    expect(codec.sent).toHaveLength(0); // a preview is not a message
  });

  test("the draft id is derived from the event, so a placeholder re-key does not split it", () => {
    // A start whose 202 is lost is re-keyed from `pending:e1` to a real run id mid-turn. Keying the
    // preview on the task id would abandon the first draft and start a second one on screen.
    const idFor = (eventId: string) =>
      (Connector as unknown as { draftId: (e: string) => number }).draftId(eventId);
    expect(idFor("tg:42")).toBe(idFor("tg:42"));
    expect(idFor("tg:42")).not.toBe(idFor("tg:43"));
    expect(idFor("")).toBeGreaterThan(0);
  });

  test("a task the daemon has not accepted yet is never previewed", async () => {
    // A placeholder id is not a daemon run: asking for its events would 404 every tick, and a
    // preview would claim work that may not have started.
    const store = new Store(":memory:");
    const codec = new DraftCodec();
    const agent = agentWith({ startFails: true, terminal: () => ({ status: "running" }) });
    const c = new Connector(store, codec, agent, new NoopSupervisor());

    store.insertInbox(event("e1", "hi"));
    await c.runOnce();
    expect(store.activeTasks()[0]?.task_id).toStartWith("pending:");
    await c.pollTasks();
    expect(codec.drafts).toHaveLength(0);
    expect(agent.eventReads).toBe(0);
  });

  test("once the user asks to stop, the preview stops animating", async () => {
    const store = new Store(":memory:");
    const codec = new DraftCodec();
    const agent = agentWith({
      terminal: () => ({ status: "running" }),
      feed: () => [{ type: "tool.call", "gen_ai.tool.name": "web_search" }],
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());

    store.insertInbox(event("e1", "long thing"));
    await c.runOnce();
    await c.pollTasks();
    expect(codec.drafts.length).toBeGreaterThan(0);

    const before = codec.drafts.length;
    store.requestCancel(store.activeTasks()[0]?.task_id ?? "");
    await c.pollTasks();
    // "Stopping that now" followed by a preview still claiming to search would be a lie.
    expect(codec.drafts).toHaveLength(before);
  });

  test("no preview survives its turn, and none can land after the real reply", async () => {
    const store = new Store(":memory:");
    const codec = new DraftCodec();
    let done = false;
    const agent = agentWith({
      terminal: () =>
        done
          ? { status: "done", responseId: "r1", outputText: "the answer" }
          : { status: "running" },
      feed: () => [{ type: "tool.call", "gen_ai.tool.name": "read_file" }],
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());

    store.insertInbox(event("e1", "read it"));
    await c.runOnce();
    await c.pollTasks();
    const duringTurn = codec.drafts.length;
    expect(duringTurn).toBeGreaterThan(0);

    done = true;
    await c.pollTasks(); // terminal → finalize + deliver
    expect(codec.sent).toEqual(["the answer"]);
    // A terminal task is not in the still-running set, so the tick that delivers sends no preview.
    expect(codec.drafts).toHaveLength(duringTurn);

    // And the per-task state is gone with it — the map tracks work in flight, nothing more.
    const state = (c as unknown as { progress: Map<string, unknown> }).progress;
    expect(state.size).toBe(0);

    await c.pollTasks();
    expect(codec.drafts).toHaveLength(duringTurn);
  });

  test("a channel or daemon without the surface degrades to exactly today's behaviour", async () => {
    const store = new Store(":memory:");
    // No sendDraft on the codec, no taskEvents on the agent.
    const plain: ChannelCodec = {
      name: "plain",
      sent: [] as string[],
      async send(_c: string, text: string) {
        (this as unknown as { sent: string[] }).sent.push(text);
        return { ok: true, retryable: false };
      },
    } as ChannelCodec & { sent: string[] };
    let done = false;
    const agent: AgentClient = {
      async run() {
        return { responseId: "sync", outputText: "sync" };
      },
      async startTask() {
        return { id: "task-1" };
      },
      async pollTask() {
        return done
          ? { status: "done", responseId: "r1", outputText: "answer" }
          : { status: "running" };
      },
    };
    const c = new Connector(store, plain, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "hi"));
    await c.runOnce();
    await c.pollTasks();
    done = true;
    await c.pollTasks();
    expect((plain as unknown as { sent: string[] }).sent).toEqual(["answer"]);
  });
});
