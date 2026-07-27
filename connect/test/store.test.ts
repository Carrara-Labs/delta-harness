import { describe, expect, test } from "bun:test";

import { Store } from "../src/store";
import type { Inbound } from "../src/types";

const evt = (id: string, text = "hi"): Inbound => ({
  eventId: id,
  conversationId: "tg:100",
  actorId: "tg:7",
  chatId: "100",
  text,
});

describe("durable inbox", () => {
  test("dedup: the same eventId inserts once", () => {
    const s = new Store(":memory:");
    expect(s.insertInbox(evt("tg:1"))).toBe(true);
    expect(s.insertInbox(evt("tg:1"))).toBe(false); // platform retry is a no-op
    expect(s.nextPending()?.event_id).toBe("tg:1");
  });

  test("pending drains oldest-first and marks done", () => {
    const s = new Store(":memory:");
    s.insertInbox(evt("tg:1", "first"));
    s.insertInbox(evt("tg:2", "second"));
    const a = s.nextPending();
    expect(a?.text).toBe("first");
    s.markInboxDone(a!.event_id);
    expect(s.nextPending()?.text).toBe("second");
  });
});

describe("sessions", () => {
  test("threads previous_response_id per conversation", () => {
    const s = new Store(":memory:");
    expect(s.getSession("tg:100")).toBeNull();
    s.setSession("tg:100", "resp_a", "tg:7");
    expect(s.getSession("tg:100")).toEqual({ prev_response_id: "resp_a", user_id: "tg:7" });
    s.setSession("tg:100", "resp_b", "tg:7"); // next turn advances the pointer
    expect(s.getSession("tg:100")?.prev_response_id).toBe("resp_b");
  });
});

describe("durable outbox", () => {
  test("idempotent enqueue: a re-run never doubles a reply", () => {
    const s = new Store(":memory:");
    expect(s.enqueueOutbox("out:tg:1", "tg:100", "100", "answer")).toBe(true);
    expect(s.enqueueOutbox("out:tg:1", "tg:100", "100", "answer")).toBe(false);
    expect(s.nextQueuedOutbox()?.text).toBe("answer");
  });

  test("sent leaves the queue", () => {
    const s = new Store(":memory:");
    s.enqueueOutbox("out:tg:1", "tg:100", "100", "answer");
    s.markOutboxSent("out:tg:1");
    expect(s.nextQueuedOutbox()).toBeNull();
  });

  test("retryable failures dead-letter after the cap", () => {
    const s = new Store(":memory:");
    s.enqueueOutbox("out:tg:1", "tg:100", "100", "answer");
    for (let i = 0; i < 5; i++) s.bumpOutboxAttempt("out:tg:1");
    expect(s.nextQueuedOutbox()).toBeNull(); // status flipped to 'dead', off the queue
  });
});

describe("meta (durable long-poll offset)", () => {
  test("round-trips the offset", () => {
    const s = new Store(":memory:");
    expect(s.getMeta("tg_offset")).toBeNull();
    s.setMeta("tg_offset", 42);
    expect(s.getMeta("tg_offset")).toBe("42");
  });
});
