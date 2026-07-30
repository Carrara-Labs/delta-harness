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

const commit = (s: Store, eventId: string, chunks: string[], responseId = "resp_a") =>
  s.commitTurn({
    eventId,
    conversationId: "tg:100",
    chatId: "100",
    userId: "tg:7",
    responseId,
    replyChunks: chunks,
  });

describe("durable inbox", () => {
  test("dedup: the same eventId inserts once", () => {
    const s = new Store(":memory:");
    expect(s.insertInbox(evt("tg:1"))).toBe(true);
    expect(s.insertInbox(evt("tg:1"))).toBe(false); // platform retry is a no-op
    expect(s.nextPending()?.event_id).toBe("tg:1");
  });

  test("pending drains oldest-first; commitTurn completes it", () => {
    const s = new Store(":memory:");
    s.insertInbox(evt("tg:1", "first"));
    s.insertInbox(evt("tg:2", "second"));
    expect(s.nextPending()?.text).toBe("first");
    commit(s, "tg:1", ["ok"]);
    expect(s.nextPending()?.text).toBe("second");
  });

  test("attachments round-trip; a plain message stores null", () => {
    const s = new Store(":memory:");
    s.insertInbox(evt("tg:1")); // no attachments
    expect(s.nextPending()?.attachments).toBeNull();
    s.markInboxDone("tg:1");
    s.insertInbox({
      ...evt("tg:2", "caption"),
      attachments: [{ fileId: "AAA", name: "report.pdf", mime: "application/pdf" }],
    });
    const row = s.nextPending();
    expect(row?.event_id).toBe("tg:2");
    expect(JSON.parse(row?.attachments ?? "[]")).toEqual([
      { fileId: "AAA", name: "report.pdf", mime: "application/pdf" },
    ]);
  });
});

describe("atomic turn commit", () => {
  test("threads previous_response_id, enqueues the reply, and completes inbox together", () => {
    const s = new Store(":memory:");
    s.insertInbox(evt("tg:1"));
    expect(s.getSession("tg:100")).toBeNull();
    commit(s, "tg:1", ["answer"], "resp_a");
    expect(s.getSession("tg:100")).toEqual({ prev_response_id: "resp_a", user_id: "tg:7" });
    expect(s.nextPending()).toBeNull(); // inbox marked done in the same transaction
    expect(s.nextQueuedOutbox()?.text).toBe("answer");
  });

  test("re-commit with the same eventId never doubles a reply", () => {
    const s = new Store(":memory:");
    s.insertInbox(evt("tg:1"));
    commit(s, "tg:1", ["a", "b"], "r1");
    commit(s, "tg:1", ["a", "b"], "r2"); // a crash-driven re-run
    const keys = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = s.nextQueuedOutbox();
      if (!r) break;
      keys.add(r.dedup_key);
      s.markOutboxSent(r.dedup_key);
    }
    expect(keys.size).toBe(2); // out:tg:1:0 and out:tg:1:1, once each
  });
});

describe("outbox delivery (at-least-once, ordered, grouped)", () => {
  test("sent leaves the queue", () => {
    const s = new Store(":memory:");
    commit(s, "tg:1", ["answer"]);
    const r = s.nextQueuedOutbox();
    expect(r?.text).toBe("answer");
    if (!r) throw new Error("expected a queued outbox row");
    s.markOutboxSent(r.dedup_key);
    expect(s.nextQueuedOutbox()).toBeNull();
  });

  test("retry_after backs the head off; it stays the head so the caller waits, not skips", () => {
    const s = new Store(":memory:");
    commit(s, "tg:1", ["x"]);
    s.markOutboxRetry("out:tg:1:0", 60_000); // 60s backoff
    const row = s.nextQueuedOutbox();
    expect(row?.dedup_key).toBe("out:tg:1:0"); // still the head, not skipped
    expect(row?.next_attempt_at).toBeGreaterThan(Date.now()); // flush will wait on it
  });

  test("retry dead-letters the WHOLE reply after the cap (no partial/out-of-order send)", () => {
    const s = new Store(":memory:");
    commit(s, "tg:1", ["one", "two"]);
    expect(s.nextQueuedOutbox()?.dedup_key).toBe("out:tg:1:0");
    for (let i = 0; i < 5; i++) s.markOutboxRetry("out:tg:1:0", 0);
    expect(s.nextQueuedOutbox()).toBeNull(); // chunk 1 dead-lettered the group, so chunk 2 never ships
  });

  test("a permanent failure dead-letters the group", () => {
    const s = new Store(":memory:");
    commit(s, "tg:1", ["a", "b"]);
    s.markGroupDead("out:tg:1");
    expect(s.nextQueuedOutbox()).toBeNull();
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
