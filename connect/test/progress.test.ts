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

// The live preview (Connect 0.5.0). It is best-effort UX layered on the authoritative task poll,
// so what these lock in is mostly what it must NOT do: never outlive its turn, never speak for a
// task the daemon has not accepted yet, never land after the real reply, never grow without bound.

class DraftCodec implements ChannelCodec {
  readonly name = "test";
  sent: string[] = [];
  drafts: Array<{ chatId: string; draftId: number; activity: string }> = [];
  /** Hooks so a test can hold a draft open or observe delivery order. */
  onDraft?: (chatId: string) => Promise<void>;
  onSend?: () => void;
  async send(_chatId: string, text: string) {
    this.onSend?.();
    this.sent.push(text);
    return { ok: true, retryable: false };
  }
  async typing() {}
  async sendDraft(chatId: string, draftId: number, activity: string) {
    await this.onDraft?.(chatId);
    this.drafts.push({ chatId, draftId, activity });
    return true;
  }
  activities() {
    return this.drafts.map((d) => d.activity);
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
  beforeEvents?: () => Promise<void>;
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
      if (script.beforeEvents) await script.beforeEvents();
      const events = script.feed?.() ?? [];
      cursor += events.length;
      return { events, cursor };
    },
    async cancelTask() {},
  };
}

/** pollTasks launches a preview without awaiting it (so one slow chat cannot block another), so a
 *  test settles the in-flight call explicitly where the production loop would just carry on. */
const tick = async (c: Connector) => {
  await c.pollTasks();
  await Bun.sleep(1);
};

describe("live progress preview", () => {
  test("names the work in flight, under one draft id, without hammering the API", async () => {
    const store = new Store(":memory:");
    const codec = new DraftCodec();
    const seen: number[] = [];
    let feed: Array<Record<string, unknown>> = [];
    const agent = agentWith({
      terminal: () => ({ status: "running" }),
      feed: () => feed,
      onEvents: (_id, since) => seen.push(since),
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());

    store.insertInbox(event("e1", "research something"));
    await c.runOnce();

    // Before any event has landed there is still something honest to show.
    await tick(c);
    expect(codec.activities()).toEqual(["Thinking"]);

    feed = [{ type: "turn.start" }, { type: "tool.call", "gen_ai.tool.name": "web_search" }];
    await tick(c);
    expect(codec.activities()).toEqual(["Thinking", "Searching the web"]);

    // A tool nobody named still reads as a sentence rather than an identifier.
    feed = [{ type: "tool.call", "gen_ai.tool.name": "qs_stage_body" }];
    await tick(c);
    expect(codec.activities().at(-1)).toBe("Running qs stage body");

    // Nothing new: the line is still true, so nothing is sent. Re-sending an identical draft on
    // every 2.5s tick would be ~120 calls across a five-minute turn.
    feed = [];
    const quiet = codec.drafts.length;
    await tick(c);
    await tick(c);
    expect(codec.drafts).toHaveLength(quiet);

    // But the draft expires after 30s, so an unchanged line is still refreshed before it lapses.
    const state = (c as unknown as { progress: Map<string, { sentAt: number }> }).progress;
    const entry = state.get(store.activeTasks()[0]?.task_id ?? "");
    if (entry) entry.sentAt -= 25_000;
    await tick(c);
    expect(codec.drafts).toHaveLength(quiet + 1);
    expect(codec.activities().at(-1)).toBe("Running qs stage body");

    // The cursor advances, so the same events are never re-read and the label cannot walk backwards.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBeGreaterThan(0);

    // One draft id for the whole turn, so successive frames animate instead of stacking up.
    expect(new Set(codec.drafts.map((d) => d.draftId)).size).toBe(1);
    expect(codec.drafts[0]?.draftId).toBeGreaterThan(0); // the API rejects a zero id
    expect(codec.sent).toHaveLength(0); // a preview is not a message
  });

  test("a stale or repeated cursor never walks the line backwards", async () => {
    // The daemon is monotonic today. If it ever were not, replaying old events would regress
    // "Searching the web" to "Thinking" and re-read the same history every tick.
    const store = new Store(":memory:");
    const codec = new DraftCodec();
    let cursor = 5;
    const agent: AgentClient = {
      async run() {
        return { responseId: "s", outputText: "s" };
      },
      async startTask() {
        return { id: "task-1" };
      },
      async pollTask() {
        return { status: "running" };
      },
      async taskEvents() {
        return { events: [{ type: "tool.call", "gen_ai.tool.name": "web_search" }], cursor };
      },
    };
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "hi"));
    await c.runOnce();
    await tick(c);
    expect(codec.activities().at(-1)).toBe("Searching the web");

    cursor = 2; // went backwards
    const before = codec.drafts.length;
    await tick(c);
    await tick(c); // and stayed there
    expect(codec.drafts).toHaveLength(before); // nothing changed, so nothing was sent
    const state = (c as unknown as { progress: Map<string, { cursor: number }> }).progress;
    expect(state.get(store.activeTasks()[0]?.task_id ?? "")?.cursor).toBe(5); // read position held
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
    await tick(c);
    expect(codec.drafts).toHaveLength(0);
    expect(agent.eventReads).toBe(0);
  });

  test("once the user asks to stop, the preview stops animating", async () => {
    const store = new Store(":memory:");
    const codec = new DraftCodec();
    let n = 0;
    const agent = agentWith({
      terminal: () => ({ status: "running" }),
      // A new tool each tick, so the label would keep changing if nothing suppressed it.
      feed: () => [{ type: "tool.call", "gen_ai.tool.name": `tool_${n++}` }],
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor(), () => {}, new Set(["7"]));

    store.insertInbox(event("e1", "long thing"));
    await c.runOnce();
    await tick(c);
    expect(codec.drafts.length).toBeGreaterThan(0);
    const before = codec.drafts.length;

    // The real command, not a poke at the store: it acks and records durable cancel intent.
    store.insertInbox(event("e2", "/cancel"));
    await c.runOnce();
    expect(codec.sent.join(" ")).toContain("Stopping");

    await tick(c);
    await tick(c);
    // "Stopping that now" followed by a preview still claiming to work would be a lie.
    expect(codec.drafts).toHaveLength(before);
  });

  test("a preview in flight is abandoned when the turn ends, not waited on", async () => {
    // The interleaving that matters: the daemon finishes while the preview is still open. Waiting
    // for it would put a best-effort UX call in front of a durable reply. Cancelling it means the
    // reply goes out at once AND the stale line is never sent.
    const store = new Store(":memory:");
    const codec = new DraftCodec();
    let release: (() => void) | null = null;
    let done = false;
    const agent = agentWith({
      terminal: () =>
        done
          ? { status: "done", responseId: "r1", outputText: "the answer" }
          : { status: "running" },
      feed: () => [{ type: "tool.call", "gen_ai.tool.name": "read_file" }],
      // Hang the EVENT READ, the longer half of a refresh and the common place to be caught.
      beforeEvents: () =>
        new Promise((resolve) => {
          release = resolve as () => void;
        }),
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());

    store.insertInbox(event("e1", "read it"));
    await c.runOnce();
    await c.pollTasks(); // a preview is now open and stuck

    done = true;
    await c.pollTasks(); // must not wait for it
    expect(codec.sent).toEqual(["the answer"]);

    (release as unknown as () => void)();
    await Bun.sleep(2);
    expect(codec.drafts).toHaveLength(0); // the abandoned preview sent nothing
    const state = (c as unknown as { progress: Map<string, unknown> }).progress;
    expect(state.size).toBe(0);
  });

  test("only one preview per task is ever in flight", async () => {
    // Two overlapping refreshes both read the same cursor and label, so the slower one can
    // overwrite newer state with older values — and can still be open after its task has been
    // finalized and its state deleted, landing a stale draft beside the answer.
    const store = new Store(":memory:");
    const codec = new DraftCodec();
    let open = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    codec.onDraft = () =>
      new Promise<void>((resolve) => {
        peak = Math.max(peak, ++open);
        release.push(() => {
          open--;
          resolve();
        });
      });
    let n = 0;
    const agent = agentWith({
      terminal: () => ({ status: "running" }),
      feed: () => [{ type: "tool.call", "gen_ai.tool.name": `tool_${n++}` }],
    });
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("e1", "long thing"));
    await c.runOnce();

    await c.pollTasks();
    await c.pollTasks();
    await c.pollTasks();
    await Bun.sleep(1);
    expect(peak).toBe(1); // three ticks, one open draft

    for (const r of release.splice(0)) r();
    await Bun.sleep(1);
    await c.pollTasks(); // the slot is free again, so previews resume
    await Bun.sleep(1);
    expect(release).toHaveLength(1);
    release[0]?.();
  });

  test("a stuck preview never holds up any reply", async () => {
    // Two tasks finish in the same tick with their previews wedged. Neither reply may wait.
    const store = new Store(":memory:");
    const codec = new DraftCodec();
    codec.onDraft = () => new Promise(() => {}); // never settles
    const finished = new Set<string>();
    const agent: AgentClient = {
      async run() {
        return { responseId: "s", outputText: "s" };
      },
      async startTask(_i, o) {
        return { id: `task-${o.idempotencyKey}` };
      },
      async pollTask(id) {
        return finished.has(id)
          ? { status: "done", responseId: id, outputText: `answer for ${id}` }
          : { status: "running" };
      },
      async taskEvents() {
        return { events: [{ type: "tool.call", "gen_ai.tool.name": "web_search" }], cursor: 1 };
      },
    };
    const c = new Connector(store, codec, agent, new NoopSupervisor());
    store.insertInbox(event("eA", "one", "tg:100"));
    store.insertInbox(event("eB", "two", "tg:200"));
    await c.runOnce();
    await c.runOnce();
    await c.pollTasks(); // both previews now open and wedged forever

    finished.add("task-eA");
    finished.add("task-eB");
    await c.pollTasks();
    expect(codec.sent.sort()).toEqual(["answer for task-eA", "answer for task-eB"]);
  });

  test("a channel or daemon without the surface degrades to exactly today's behaviour", async () => {
    const store = new Store(":memory:");
    const sent: string[] = [];
    const plain: ChannelCodec = {
      name: "plain",
      async send(_c: string, text: string) {
        sent.push(text);
        return { ok: true, retryable: false };
      },
    };
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
    await tick(c);
    done = true;
    await tick(c);
    expect(sent).toEqual(["answer"]);
  });
});
