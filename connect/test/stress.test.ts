import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Connector, chunkText } from "../src/core";
import { Store } from "../src/store";
import type { AgentClient, AgentSupervisor, ChannelCodec, Inbound } from "../src/types";

// --- fakes -------------------------------------------------------------

class FakeAgent implements AgentClient {
  calls = 0;
  constructor(
    private readonly reply: (input: string, n: number) => string = (_i, n) => `reply ${n}`,
    private readonly fail = false,
  ) {}
  async run(input: string): Promise<{ responseId: string; outputText: string }> {
    this.calls++;
    if (this.fail) throw new Error("provider boom");
    return { responseId: `resp_${this.calls}`, outputText: this.reply(input, this.calls) };
  }
}

class RecCodec implements ChannelCodec {
  readonly name = "fake";
  sent: string[] = [];
  constructor(private failTimes = 0) {}
  async send(_chatId: string, text: string) {
    if (this.failTimes > 0) {
      this.failTimes--;
      return { ok: false, retryable: true, error: "429", retryAfterMs: 0 }; // no backoff for the test
    }
    this.sent.push(text);
    return { ok: true, retryable: false };
  }
}

const noopSup: AgentSupervisor = { async ensureAwake() { return "x"; }, async maybeSuspend() {} };

const evt = (id: string, text: string): Inbound => ({
  eventId: id,
  conversationId: "tg:100",
  actorId: "tg:7",
  chatId: "100",
  text,
});

const paths: string[] = [];
function tmpDb(): string {
  const p = join(tmpdir(), `dc-stress-${Date.now()}-${Math.floor(Math.random() * 1e9)}.sqlite`);
  paths.push(p);
  return p;
}
afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(p + suffix);
      } catch {}
    }
  }
});

async function drain(c: Connector) {
  for (let i = 0; i < 1000 && (await c.runOnce()); i++) {}
}

// --- chunking ----------------------------------------------------------

describe("chunkText", () => {
  test("short text is one chunk", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
  });
  test("long text splits under the cap and preserves content", () => {
    const body = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const parts = chunkText(body, 4000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4000);
    expect(parts.join("\n")).toBe(body);
  });
  test("a single over-long line is hard-split", () => {
    const line = "y".repeat(9500);
    const parts = chunkText(line, 4000);
    expect(parts.length).toBe(3);
    expect(parts.join("")).toBe(line);
  });
});

// --- the loop under stress --------------------------------------------

describe("dispatch loop", () => {
  test("burst: 8 messages reply in order and thread the session", async () => {
    const store = new Store(tmpDb());
    const codec = new RecCodec();
    const c = new Connector(store, codec, new FakeAgent(), noopSup);
    for (let i = 1; i <= 8; i++) store.insertInbox(evt(`tg:${i}`, `msg ${i}`));
    await drain(c);
    expect(codec.sent).toEqual(["reply 1", "reply 2", "reply 3", "reply 4", "reply 5", "reply 6", "reply 7", "reply 8"]);
    expect(store.getSession("tg:100")?.prev_response_id).toBe("resp_8");
  });

  test("duplicate delivery is answered once", async () => {
    const store = new Store(tmpDb());
    const codec = new RecCodec();
    const c = new Connector(store, codec, new FakeAgent(), noopSup);
    store.insertInbox(evt("tg:1", "hi"));
    store.insertInbox(evt("tg:1", "hi")); // platform redelivery, same update_id
    await drain(c);
    expect(codec.sent.length).toBe(1);
  });

  test("a long reply is chunked, ordered, and fully delivered", async () => {
    const store = new Store(tmpDb());
    const codec = new RecCodec();
    const big = Array.from({ length: 500 }, (_, i) => `paragraph ${i} ${"z".repeat(20)}`).join("\n");
    const c = new Connector(store, codec, new FakeAgent(() => big), noopSup);
    store.insertInbox(evt("tg:1", "tell me a lot"));
    await drain(c);
    expect(codec.sent.length).toBeGreaterThan(1);
    expect(codec.sent.join("\n")).toBe(big); // reassembles exactly, in order
  });

  test("retryable send failures recover without dropping or doubling", async () => {
    const store = new Store(tmpDb());
    const codec = new RecCodec(2); // first two sends fail retryably (retry_after 0)
    const c = new Connector(store, codec, new FakeAgent(() => "answer"), noopSup);
    store.insertInbox(evt("tg:1", "hi"));
    await drain(c);
    await c.flushOutbox();
    await c.flushOutbox();
    expect(codec.sent).toEqual(["answer"]);
  });

  test("a backed-off first chunk never lets a later chunk overtake it", async () => {
    const store = new Store(tmpDb());
    const sent: string[] = [];
    let failFirst = true;
    const codec: ChannelCodec = {
      name: "f",
      async send(_c: string, text: string) {
        if (failFirst) {
          failFirst = false;
          return { ok: false, retryable: true, retryAfterMs: 60_000 };
        }
        sent.push(text);
        return { ok: true, retryable: false };
      },
    };
    const big = "A".repeat(5000); // one long line -> hard-split into 2 chunks
    const c = new Connector(store, codec, new FakeAgent(() => big), noopSup);
    store.insertInbox(evt("tg:1", "go"));
    await drain(c);
    expect(sent).toEqual([]); // chunk 1 backed off 60s -> nothing delivered; chunk 2 did NOT overtake
  });

  test("a failed agent turn surfaces a friendly reply, not a loop", async () => {
    const store = new Store(tmpDb());
    const codec = new RecCodec();
    const c = new Connector(store, codec, new FakeAgent(undefined, true), noopSup);
    store.insertInbox(evt("tg:1", "hi"));
    await drain(c);
    expect(codec.sent.length).toBe(1);
    expect(codec.sent[0]).toContain("Something went wrong");
    expect(store.nextPending()).toBeNull();
  });
});

// --- crash resume: the durable spine's whole reason to exist ----------

describe("crash resume", () => {
  test("a reply committed before a crash is delivered exactly once on restart", async () => {
    const db = tmpDb();
    // process A: the atomic turn commit lands (session + reply + inbox-done), then "crash" before send
    const a = new Store(db);
    a.insertInbox(evt("tg:1", "hi"));
    a.commitTurn({ eventId: "tg:1", conversationId: "tg:100", chatId: "100", userId: "tg:7", responseId: "r", replyChunks: ["the answer"] });
    a.db.close();

    // process B: restart on the same file, deliver
    const b = new Store(db);
    const codec = new RecCodec();
    const c = new Connector(b, codec, new FakeAgent(), noopSup);
    await c.flushOutbox();
    expect(codec.sent).toEqual(["the answer"]);
    await c.flushOutbox(); // a second restart must not re-send
    expect(codec.sent.length).toBe(1);
  });

  test("a crash before the turn commits re-runs, and dedup stops a double", async () => {
    const db = tmpDb();
    const a = new Store(db);
    a.insertInbox(evt("tg:1", "hi")); // accepted, but process dies before the turn runs
    a.db.close();

    const b = new Store(db);
    const codec = new RecCodec();
    const agent = new FakeAgent(() => "recovered answer");
    const c = new Connector(b, codec, agent, noopSup);
    await drain(c); // inbox still pending -> runs the turn now
    expect(agent.calls).toBe(1);
    expect(codec.sent).toEqual(["recovered answer"]);
    b.insertInbox(evt("tg:1", "hi")); // platform redelivers -> dedup, no double
    await drain(c);
    expect(codec.sent.length).toBe(1);
  });
});
