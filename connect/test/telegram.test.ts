import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  markdownToHtml,
  parseUpdate,
  resolveDocumentPath,
  TelegramCodec,
  telegramChunks,
} from "../src/telegram";

// The ingress parses UNTRUSTED Telegram JSON. Every shape below must be handled
// without throwing: a valid event, a skippable-but-valid update (advance past
// it), or an unparseable item (null -> caller skips without advancing).

const open = { allowed: new Set<string>() };
const gated = { allowed: new Set<string>(["7"]) };

const msg = (over: Record<string, unknown> = {}) => ({
  update_id: 10,
  message: { text: "hi", chat: { id: 100, type: "private" }, from: { id: 7 }, ...over },
});

const originalFetch = globalThis.fetch;
const tempPaths: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Telegram Markdown HTML", () => {
  test("escapes raw HTML and converts the documented block/inline subset", () => {
    const source = [
      "# <Title>",
      "> **quoted**",
      "- one",
      "2. two",
      "`<x>&` [site](https://example.com/a?x=1&y=2) ![gone](https://x.test/i.png)",
      "[unsafe](javascript:alert) **unclosed",
      "```js",
      "if (a < b && c > d) {}",
      "```",
    ].join("\n");
    expect(markdownToHtml(source)).toBe(
      [
        "<b>&lt;Title&gt;</b>",
        "<blockquote><b>quoted</b></blockquote>",
        "• one",
        "• two",
        '<code>&lt;x&gt;&amp;</code> <a href="https://example.com/a?x=1&amp;y=2">site</a> ',
        "unsafe **unclosed",
        "<pre><code>if (a &lt; b &amp;&amp; c &gt; d) {}</code></pre>",
      ].join("\n"),
    );
  });

  test("malformed constructs stay literal and quote-bearing URLs are canonicalized", () => {
    expect(markdownToHtml("<b>forged</b> & **open `code [x](bad)")).toBe(
      "&lt;b&gt;forged&lt;/b&gt; &amp; **open `code x",
    );
    const html = markdownToHtml('[quoted](https://example.com/"x)');
    expect(html).toBe('<a href="https://example.com/%22x">quoted</a>');
    expect(html).not.toContain('href="javascript:');
    expect(markdownToHtml("")).toBe("");
    expect(markdownToHtml("Привет 🌍 _мир_")).toBe("Привет 🌍 <i>мир</i>");
  });

  test("3900-source chunks balance fenced code and render with closed tags", () => {
    const source = `before\n\`\`\`\n${"x".repeat(7900)}\n\`\`\`\nafter`;
    const chunks = telegramChunks(source);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3908);
      const html = markdownToHtml(chunk);
      expect((html.match(/<pre><code>/g) ?? []).length).toBe(
        (html.match(/<\/code><\/pre>/g) ?? []).length,
      );
    }
    expect(telegramChunks("z".repeat(4096)).map((part) => part.length)).toEqual([3900, 196]);
  });

  test("specific parse-entities 400 retries once as plain text", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? Response.json(
            { ok: false, description: "Bad Request: can't parse entities: broken" },
            { status: 400 },
          )
        : Response.json({ ok: true });
    }) as typeof fetch;
    const result = await new TelegramCodec("token").send("7", "**hello**");
    expect(result.ok).toBe(true);
    expect(bodies).toEqual([
      { chat_id: "7", text: "<b>hello</b>", parse_mode: "HTML" },
      { chat_id: "7", text: "**hello**" },
    ]);
  });

  test("other Telegram failures keep retry classification and retry_after", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { ok: false, description: "slow down", parameters: { retry_after: 3 } },
        { status: 429 },
      )) as unknown as typeof fetch;
    expect(await new TelegramCodec("token").send("7", "hello")).toEqual({
      ok: false,
      retryable: true,
      error: "slow down",
      retryAfterMs: 3000,
    });
  });
});

describe("outbound document confinement", () => {
  test("accepts regular files and in-root symlinks; rejects every escape/non-file", () => {
    const root = mkdtempSync(join(tmpdir(), "dc-doc-"));
    tempPaths.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "nested"), { recursive: true });
    writeFileSync(join(workspace, "nested", "ok.txt"), "ok");
    writeFileSync(join(root, "outside.txt"), "no");
    symlinkSync(join(workspace, "nested", "ok.txt"), join(workspace, "inside-link"));
    symlinkSync(join(root, "outside.txt"), join(workspace, "outside-link"));

    expect(resolveDocumentPath(workspace, "nested/ok.txt").ok).toBe(true);
    expect(resolveDocumentPath(workspace, "inside-link").ok).toBe(true);
    for (const bad of [
      join(workspace, "nested", "ok.txt"),
      "../outside.txt",
      "outside-link",
      "nested",
      "missing.txt",
    ]) {
      expect(resolveDocumentPath(workspace, bad).ok).toBe(false);
    }
  });

  test("sendDocument uses multipart without setting its content-type", async () => {
    const root = mkdtempSync(join(tmpdir(), "dc-doc-send-"));
    tempPaths.push(root);
    writeFileSync(join(root, "report.txt"), "report");
    let seen = false;
    globalThis.fetch = (async (url, init) => {
      seen = true;
      expect(String(url)).toContain("/sendDocument");
      expect(init?.headers).toBeUndefined();
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("chat_id")).toBe("7");
      expect(form.get("document")).toBeInstanceOf(Blob);
      return Response.json({ ok: true });
    }) as typeof fetch;
    expect((await new TelegramCodec("token", root).sendDocument("7", "report.txt")).ok).toBe(true);
    expect(seen).toBe(true);
  });
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
      msg({
        text: undefined,
        caption: "look at this",
        photo: [{ file_id: "small" }, { file_id: "big" }],
      }),
      open,
    );
    expect(r?.event?.text).toBe("look at this");
    expect(r?.event?.attachments).toEqual([
      { fileId: "big", name: "photo.jpg", mime: "image/jpeg" },
    ]);
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

describe("intra-word underscores (CommonMark)", () => {
  test("a credential name survives intact", () => {
    // Live bug: EXA_API_KEY rendered as EXA<i>API</i>KEY in the intake confirmation, so the
    // one message whose job is to name the credential misnamed it.
    expect(markdownToHtml("Saved EXA_API_KEY.")).toBe("Saved EXA_API_KEY.");
    expect(markdownToHtml("provide AWS_SECRET_ACCESS_KEY now")).toBe(
      "provide AWS_SECRET_ACCESS_KEY now",
    );
  });

  test("ordinary snake_case identifiers are left alone", () => {
    expect(markdownToHtml("call read_file then write_file")).toBe("call read_file then write_file");
  });

  test("real underscore emphasis still renders", () => {
    expect(markdownToHtml("_italic_ here")).toBe("<i>italic</i> here");
    expect(markdownToHtml("__bold__ here")).toBe("<b>bold</b> here");
  });

  test("asterisk emphasis is unaffected by the underscore rule", () => {
    expect(markdownToHtml("*i* and **b**")).toBe("<i>i</i> and <b>b</b>");
  });

  test("emphasis and an identifier can coexist on one line", () => {
    expect(markdownToHtml("_note_ about read_file")).toBe("<i>note</i> about read_file");
  });
});
