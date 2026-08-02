import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  escapeRichMarkdown,
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
    // rich off, so this exercises the legacy HTML funnel on its own
    const result = await new TelegramCodec("token", undefined, false).send("7", "**hello**");
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

  test("a DOUBLE underscore inside a word is literal too", () => {
    // Rejecting the run then advancing one character leaves the second underscore preceded by
    // `_`, which is not a word character, so it opened emphasis after all. MCP tool names are
    // exactly this shape.
    expect(markdownToHtml("mcp__brain__authenticate")).toBe("mcp__brain__authenticate");
    expect(markdownToHtml("A__B__C")).toBe("A__B__C");
    expect(markdownToHtml("foo__bar__baz")).toBe("foo__bar__baz");
  });

  test("an uneven run renders literally — an accepted trade, not an accident", () => {
    // CommonMark would emphasise from partway inside the run (`___<em>foo</em>`). Matching that
    // needs full delimiter-run bookkeeping, which is more code than the case is worth; a renderer
    // whose job is to leave identifiers alone should fail toward literal. Locked in so that
    // changing it is a decision rather than a surprise.
    expect(markdownToHtml("____foo_")).toBe("____foo_");
  });

  test("the word test sees whole characters, not UTF-16 halves", () => {
    // A combining mark and an astral letter are both "inside a word" as far as a reader is
    // concerned, but neither is a `\p{L}` single code unit.
    expect(markdownToHtml("á_b_")).toBe("á_b_"); // a + combining acute
    expect(markdownToHtml("\u{10400}_b_")).toBe("\u{10400}_b_"); // astral letter
    expect(markdownToHtml("א_ב_ג")).toBe("א_ב_ג");
    expect(markdownToHtml("键_值_对")).toBe("键_值_对");
  });
});

describe("Rich messages", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Telegram's own parser is the renderer on this path, so these lock in the boundary that was
  // measured against the live API rather than assumed.
  test("an underscore run inside a word is escaped; real emphasis and code are not", () => {
    // The bug this exists for: Telegram reads `__` as bold even mid-identifier.
    expect(escapeRichMarkdown("mcp__brain__auth")).toBe("mcp\\_\\_brain\\_\\_auth");
    expect(escapeRichMarkdown("EXA_API_KEY")).toBe("EXA\\_API\\_KEY");
    // Emphasis at a word boundary is the author's intent — untouched.
    expect(escapeRichMarkdown("_italic_ and __bold__")).toBe("_italic_ and __bold__");
    expect(escapeRichMarkdown("**bold** stays")).toBe("**bold** stays");
    // Telegram already treats code as literal, so escaping there would show the backslashes.
    expect(escapeRichMarkdown("call `mcp__brain__auth` now")).toBe("call `mcp__brain__auth` now");
    expect(escapeRichMarkdown("```\nmcp__brain__auth\n```")).toBe("```\nmcp__brain__auth\n```");
    expect(escapeRichMarkdown("```ts\nconst a__b = 1;\n```")).toBe("```ts\nconst a__b = 1;\n```");
  });

  test("code stays untouched across the delimiter shapes an agent actually writes", () => {
    // The promise is that Telegram already treats code as literal, so we must not write into it.
    // Pairing backticks one character at a time broke every one of these.
    expect(escapeRichMarkdown("a ``x__y`` b")).toBe("a ``x__y`` b"); // multi-backtick span
    expect(escapeRichMarkdown("`` ` a__b ``")).toBe("`` ` a__b ``"); // a lone tick inside a span
    // A four-backtick fence wrapping a three-backtick one: the inner markers are content, so the
    // block runs to the closing four and everything between it stays exactly as written.
    const nested = "````\n```\na__b\n```\n````";
    expect(escapeRichMarkdown(nested)).toBe(nested);
    expect(escapeRichMarkdown("~~~\na__b\n~~~")).toBe("~~~\na__b\n~~~"); // tilde fence
    expect(escapeRichMarkdown("```ts x\na__b\n```")).toBe("```ts x\na__b\n```"); // info string
    // A fence marker with trailing content cannot CLOSE a block, so what follows is still code.
    expect(escapeRichMarkdown("```\na__b\n``` trailing\nc__d\n```")).toBe(
      "```\na__b\n``` trailing\nc__d\n```",
    );
    // An unclosed backtick run is ordinary text, and must not swallow or re-scan the rest.
    expect(escapeRichMarkdown("a ` b__c")).toBe("a ` b\\_\\_c");
    // A fence inside a block quote is still a fence.
    expect(escapeRichMarkdown("> ```\n> a__b\n> ```")).toBe("> ```\n> a__b\n> ```");
    // Known limits, recorded rather than claimed fixed: the scan is per line, so a code span
    // broken across lines is escaped, and a fence whose info string contains a backtick is read
    // as a fence rather than a span. Both are rare in agent output and fail toward a visible
    // backslash, never toward a mangled identifier.
    expect(escapeRichMarkdown("`a__b\nc__d`")).toBe("`a\\_\\_b\nc\\_\\_d`");
  });

  test("escaping leaves structure alone", () => {
    expect(escapeRichMarkdown("| a__b | c |\n|---|---|\n| 1 | 2 |")).toBe(
      "| a\\_\\_b | c |\n|---|---|\n| 1 | 2 |",
    );
    expect(escapeRichMarkdown("see [my_link](https://x.test/a_b)")).toBe(
      "see [my\\_link](https://x.test/a\\_b)",
    );
    expect(escapeRichMarkdown("text[^note_1]")).toBe("text[^note\\_1]");
    expect(escapeRichMarkdown("a\r\nb__c")).toBe("a\r\nb\\_\\_c"); // CRLF survives
    expect(escapeRichMarkdown("____")).toBe("____"); // a line of only underscores
    expect(escapeRichMarkdown("")).toBe("");
  });

  test("the word test sees whole characters here too", () => {
    expect(escapeRichMarkdown("á__b__c")).toBe("á\\_\\_b\\_\\_c");
    expect(escapeRichMarkdown("\u{10400}__b__c")).toBe("\u{10400}\\_\\_b\\_\\_c");
  });

  test("a reply goes out as rich markdown, not the flattened HTML subset", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch;
    const result = await new TelegramCodec("token").send("7", "# Title\n\n| a | b |\n|---|---|");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1); // no second, downgraded send
    expect(calls[0]?.url).toContain("/sendRichMessage");
    expect(calls[0]?.body).toEqual({
      chat_id: "7",
      rich_message: { markdown: "# Title\n\n| a | b |\n|---|---|" },
    });
  });

  test("a rich rejection falls back to HTML so the reply still lands", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      return urls.length === 1
        ? Response.json(
            { ok: false, description: "Bad Request: RICH_MESSAGE_EMPTY" },
            { status: 400 },
          )
        : Response.json({ ok: true });
    }) as typeof fetch;
    const codec = new TelegramCodec("token");
    expect((await codec.send("7", "**hi**")).ok).toBe(true);
    expect(urls[0]).toContain("/sendRichMessage");
    expect(urls[1]).toContain("/sendMessage");
    // A content rejection says nothing about the server: rich stays on for the next message.
    expect(codec.richEnabled).toBe(true);
  });

  test("a 429 on the rich call backs off instead of silently downgrading", async () => {
    // Downgrading here would send the flattened version of a message Telegram never refused.
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      return Response.json(
        { ok: false, description: "slow down", parameters: { retry_after: 3 } },
        { status: 429 },
      );
    }) as typeof fetch;
    expect(await new TelegramCodec("token").send("7", "hi")).toEqual({
      ok: false,
      retryable: true,
      error: "slow down",
      retryAfterMs: 3000,
    });
    expect(urls).toHaveLength(1);
  });

  test("an API server without Rich Messages is asked exactly once", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      return String(url).includes("Rich")
        ? Response.json({ ok: false, description: "Not Found" }, { status: 404 })
        : Response.json({ ok: true });
    }) as typeof fetch;
    const codec = new TelegramCodec("token");
    expect((await codec.send("7", "hi")).ok).toBe(true);
    expect((await codec.send("7", "again")).ok).toBe(true);
    expect(codec.richEnabled).toBe(false);
    expect(urls.filter((u) => u.includes("sendRichMessage"))).toHaveLength(1);
  });

  test("an ambiguous success is retried, never re-sent down the fallback path", async () => {
    // Telegram accepted the message but the body was truncated. Calling that a content rejection
    // would deliver the reply twice - once rich, once HTML.
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      return new Response("{tru", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await new TelegramCodec("token").send("7", "hi");
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(urls).toHaveLength(1); // no HTML copy
  });

  test("transient statuses stay retryable so a reply is never dropped", async () => {
    // flushOutbox kills the whole reply group on a permanent failure, so misclassifying a timeout
    // as permanent is message loss.
    for (const status of [408, 425, 500, 503]) {
      globalThis.fetch = (async () =>
        Response.json({ ok: false, description: "later" }, { status })) as unknown as typeof fetch;
      const r = await new TelegramCodec("token").send("7", "hi");
      expect({ status, retryable: r.retryable }).toEqual({ status, retryable: true });
    }
  });

  test("an unrelated 404 costs one fallback, not the whole feature", async () => {
    const codec = new TelegramCodec("token");
    globalThis.fetch = (async (url) =>
      String(url).includes("Rich")
        ? Response.json({ ok: false, description: "Not Found: chat not found" }, { status: 404 })
        : Response.json({ ok: true })) as typeof fetch;
    expect((await codec.send("7", "hi")).ok).toBe(true);
    expect(codec.richEnabled).toBe(true); // only a genuine method-not-found latches it off
  });

  test("a draft is a thinking block, private chats only, and never throws", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: true });
    }) as typeof fetch;
    const codec = new TelegramCodec("token");
    expect(await codec.sendDraft("7", 42, "Searching the web")).toBe(true);
    expect(bodies[0]).toEqual({
      chat_id: 7,
      draft_id: 42,
      rich_message: { blocks: [{ type: "thinking", text: "Searching the web" }] },
    });
    // A supergroup id is negative: the API takes private chats only, so we do not even ask.
    expect(await codec.sendDraft("-100123", 42, "x")).toBe(false);
    expect(bodies).toHaveLength(1);
    // A transport failure is a missing preview, never a thrown turn.
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await codec.sendDraft("7", 42, "x")).toBe(false);
  });
});
