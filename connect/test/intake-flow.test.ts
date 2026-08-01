import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIntercept } from "../src/commands";
import { extractSecretRequest } from "../src/core";
import { Store } from "../src/store";

describe("the secret-request marker", () => {
  test("extracts a name and purpose and strips the marker from the delivered text", () => {
    const r = extractSecretRequest(
      "I need a search key to continue.\n[[secret-request: EXA_API_KEY | web search]]",
    );
    expect(r.name).toBe("EXA_API_KEY");
    expect(r.purpose).toBe("web search");
    expect(r.text).toBe("I need a search key to continue.");
  });

  test("works without a purpose", () => {
    const r = extractSecretRequest("Need this.\n[[secret-request: KB_TOKEN]]");
    expect(r.name).toBe("KB_TOKEN");
    expect(r.text).toBe("Need this.");
  });

  test("ignores a badly-shaped name rather than minting a session for it", () => {
    for (const bad of [
      "[[secret-request: lowercase]]",
      "[[secret-request: ../../etc/passwd]]",
      "[[secret-request: <script>alert(1)</script>]]",
      "[[secret-request: ]]",
    ]) {
      const r = extractSecretRequest(`text\n${bad}`);
      expect(r.name).toBeUndefined();
      expect(r.text).toBe(`text\n${bad}`); // left as ordinary text, nothing is offered
    }
  });

  test("only a TERMINAL marker counts, so a quoted example mid-reply is inert", () => {
    const r = extractSecretRequest("Use [[secret-request: NAME | why]] to ask.\nAnything else?");
    expect(r.name).toBeUndefined();
  });

  test("at most one request per reply (a button flood is a social-engineering surface)", () => {
    const r = extractSecretRequest(
      "a\n[[secret-request: FIRST_KEY]]\n[[secret-request: SECOND_KEY]]",
    );
    expect(r.name).toBe("SECOND_KEY");
    expect(r.text).toBe("a\n[[secret-request: FIRST_KEY]]");
  });

  test("a purpose cannot smuggle a newline or a closing bracket into the page", () => {
    const r = extractSecretRequest("x\n[[secret-request: K | evil]] extra ]]");
    expect(r.name).toBeUndefined();
  });
});

describe("intake session binding", () => {
  test("a session records the requesting conversation, chat and user", () => {
    const path = join(tmpdir(), `connect-flow-${randomUUID()}.sqlite`);
    const store = new Store(path);
    const id = randomUUID();
    store.createIntakeSession({
      id,
      name: "EXA_API_KEY",
      purpose: "web search",
      destination: "127.0.0.1:8321",
      telegramUserId: "5499639944",
      chatId: "chat-9",
      conversationId: "conv-9",
      ttlMs: 60_000,
    });
    const row = store.intakeSession(id);
    expect(row?.telegram_user_id).toBe("5499639944");
    expect(row?.chat_id).toBe("chat-9");
    expect(row?.conversation_id).toBe("conv-9");
    expect(row?.state).toBe("pending");
    rmSync(path, { force: true });
  });
});

describe("the /secret and /secrets commands", () => {
  test("both are classified as local commands at ingest", () => {
    // If the grammar misses them they are sent to the MODEL and queue behind an active turn,
    // which for a credential request is both slow and wrong (codex C-21).
    for (const t of [
      "/secrets",
      "/secret",
      "/secret EXA_API_KEY",
      "/secret EXA_API_KEY for search",
    ])
      expect(isIntercept(t)).toBe(true);
  });

  test("a lookalike is NOT intercepted (it is ordinary conversation)", () => {
    for (const t of ["/secretstuff", "tell me a /secret", "/secreta"])
      expect(isIntercept(t)).toBe(false);
  });
});

describe("capability-change note", () => {
  test("a stored credential queues exactly one agent turn, and is idempotent per key", () => {
    const path = join(tmpdir(), `connect-note-${randomUUID()}.sqlite`);
    const store = new Store(path);
    const note = {
      conversationId: "tg:1",
      actorId: "tg:1",
      chatId: "1",
      text: "[EXA_API_KEY is now available]",
      key: "EXA_API_KEY:123",
    };
    expect(store.enqueueNote(note)).toBe(true);
    // At-least-once delivery must not produce two turns for the same event.
    expect(store.enqueueNote(note)).toBe(false);
    const rows = store.db.query("SELECT text, intercept FROM inbox").all() as {
      text: string;
      intercept: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain("EXA_API_KEY");
    // It must be an ordinary agent turn, not a locally-intercepted command.
    expect(rows[0]?.intercept).toBe(0);
    rmSync(path, { force: true });
  });

  test("the note never carries a value, only the name", () => {
    const path = join(tmpdir(), `connect-note2-${randomUUID()}.sqlite`);
    const store = new Store(path);
    store.enqueueNote({
      conversationId: "c",
      actorId: "a",
      chatId: "1",
      text: "[EXA_API_KEY is now available in your vault]",
      key: "k",
    });
    const all = JSON.stringify(store.db.query("SELECT * FROM inbox").all());
    expect(all).toContain("EXA_API_KEY");
    expect(all).not.toContain("sk-");
    rmSync(path, { force: true });
  });
});
