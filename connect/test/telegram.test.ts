import { describe, expect, test } from "bun:test";

import { parseUpdate } from "../src/telegram";

// The ingress parses UNTRUSTED Telegram JSON. Every shape below must be handled
// without throwing: a valid event, a skippable-but-valid update (advance past
// it), or an unparseable item (null -> caller skips without advancing).

const open = { allowed: new Set<string>() };
const gated = { allowed: new Set<string>(["7"]) };

const msg = (over: Record<string, unknown> = {}) => ({
  update_id: 10,
  message: { text: "hi", chat: { id: 100, type: "private" }, from: { id: 7 }, ...over },
});

describe("parseUpdate (untrusted input)", () => {
  test("valid private text -> normalized event", () => {
    const r = parseUpdate(msg(), open);
    expect(r?.updateId).toBe(10);
    expect(r?.event).toEqual({
      eventId: "tg:10",
      conversationId: "tg:100",
      actorId: "tg:7",
      chatId: "100",
      text: "hi",
      raw: msg(),
    });
  });

  test("a document message -> event carrying the attachment ref", () => {
    const r = parseUpdate(
      msg({
        text: undefined,
        document: { file_id: "AAA", file_name: "report.pdf", mime_type: "application/pdf" },
      }),
      open,
    );
    expect(r?.event?.text).toBe(""); // no caption
    expect(r?.event?.attachments).toEqual([
      { fileId: "AAA", name: "report.pdf", mime: "application/pdf" },
    ]);
  });

  test("a photo message -> the largest size, caption becomes the text", () => {
    const r = parseUpdate(
      msg({ text: undefined, caption: "look at this", photo: [{ file_id: "small" }, { file_id: "big" }] }),
      open,
    );
    expect(r?.event?.text).toBe("look at this");
    expect(r?.event?.attachments).toEqual([{ fileId: "big", name: "photo.jpg", mime: "image/jpeg" }]);
  });

  test("a message with neither text nor a file (sticker) -> skip (event null)", () => {
    const r = parseUpdate(msg({ text: undefined, sticker: { file_id: "z" } }), open);
    expect(r?.event).toBeNull();
  });

  test("a plain text message still has no attachments key", () => {
    const r = parseUpdate(msg(), open);
    expect(r?.event && "attachments" in r.event).toBe(false);
  });

  test("allowlist: allowed user passes, others become a no-event skip", () => {
    expect(parseUpdate(msg(), gated)?.event?.text).toBe("hi");
    const other = {
      update_id: 11,
      message: { text: "hi", chat: { id: 9, type: "private" }, from: { id: 999 } },
    };
    const r = parseUpdate(other, gated);
    expect(r?.updateId).toBe(11);
    expect(r?.event).toBeNull(); // advance past it, don't process
  });

  test("garbage that can't yield a usable update_id -> null (caller skips)", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "x",
      {},
      { update_id: "nope" },
      { update_id: Number.NaN },
    ]) {
      expect(parseUpdate(bad, open)).toBeNull();
    }
  });

  test("valid update_id but not a private text message -> skip (event null), still advances", () => {
    const cases: Record<string, unknown>[] = [
      { update_id: 12 }, // no message
      { update_id: 13, message: { chat: { id: 1, type: "private" }, from: { id: 7 } } }, // no text
      { update_id: 14, message: { text: 5, chat: { id: 1, type: "private" }, from: { id: 7 } } }, // text not string
      { update_id: 15, message: { text: "y", chat: { id: 1, type: "group" }, from: { id: 7 } } }, // not private
      { update_id: 16, message: { text: "y", chat: { type: "private" }, from: { id: 7 } } }, // chat.id missing
      { update_id: 17, message: { text: "y", chat: { id: 1, type: "private" } } }, // from missing
    ];
    for (const c of cases) {
      const r = parseUpdate(c, open);
      expect(r?.updateId).toBe(c.update_id as number);
      expect(r?.event).toBeNull();
    }
  });

  test("a malformed update never throws", () => {
    expect(() =>
      parseUpdate({ update_id: 1, message: { text: {}, chat: null, from: [] } }, open),
    ).not.toThrow();
  });
});
