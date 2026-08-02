import { describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIntercept } from "../src/commands";
import { extractSecretRequest } from "../src/core";
import { IntakeServer } from "../src/intake";
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
  test("a redelivered callback cannot queue the turn twice", () => {
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

  test("two genuine stores of the same name each get their own turn", () => {
    // Production keys on `${name}:${Date.now()}`, so re-providing a credential later is a new
    // event and MUST notify again. The idempotency above must not swallow it.
    const path = join(tmpdir(), `connect-note2-${randomUUID()}.sqlite`);
    const store = new Store(path);
    const at = (t: number) => ({
      conversationId: "tg:1",
      actorId: "tg:1",
      chatId: "1",
      text: "[EXA_API_KEY is now available]",
      key: `EXA_API_KEY:${t}`,
    });
    expect(store.enqueueNote(at(1))).toBe(true);
    expect(store.enqueueNote(at(2))).toBe(true);
    expect(store.db.query("SELECT event_id FROM inbox").all()).toHaveLength(2);
    rmSync(path, { force: true });
  });
});

describe("intake, end to end over HTTP", () => {
  const BOT_TOKEN = "424242:test-bot-token";
  const OPERATOR = "111";
  const SUBMITTER = "222";
  // Credential-shaped, but built from ordinary words so no secret scanner trips on it.
  const VALUE = "prawn-lantern-varnish-88213-quilt";

  const signInitData = (fields: Record<string, string>) => {
    const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const check = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
    const params = new URLSearchParams(fields);
    params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
    return params.toString();
  };

  test("the value reaches the vault, is attributed to the submitter, and never lands in the DB", async () => {
    const path = join(tmpdir(), `connect-e2e-${randomUUID()}.sqlite`);
    const store = new Store(path);
    const sessionId = randomUUID().replaceAll("-", "");
    store.createIntakeSession({
      id: sessionId,
      name: "EXA_API_KEY",
      purpose: "web search",
      destination: "api.exa.ai",
      // The session was minted for the SECOND allowlisted user, so "first entry in the
      // allowlist" would attribute the turn to the wrong person.
      telegramUserId: SUBMITTER,
      chatId: "chat-1",
      conversationId: "conv-1",
      ttlMs: 300_000,
    });

    const vaultSaw: { name: string; value: string }[] = [];
    let stored: { name: string; telegramUserId: string; conversationId: string } | undefined;
    const server = new IntakeServer({
      store,
      botToken: BOT_TOKEN,
      publicUrl: "https://example.test",
      port: 0,
      allowedUsers: new Set([OPERATOR, SUBMITTER]),
      writeVault: async (name, value) => {
        vaultSaw.push({ name, value });
        return { ok: true, status: 201 };
      },
      log: () => {},
      onStored: (session) => {
        stored = session;
        store.enqueueNote({
          conversationId: session.conversationId,
          actorId: `tg:${session.telegramUserId}`,
          chatId: session.chatId,
          key: `${session.name}:1`,
          text: `[${session.name} is now available in your vault.]`,
        });
      },
    });
    server.start();
    const port = (server as unknown as { server: { port: number } }).server.port;

    const initData = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: "q1",
      user: JSON.stringify({ id: Number(SUBMITTER) }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/intake/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.test" },
      body: JSON.stringify({ initData, value: VALUE }),
    });
    server.stop();

    expect(res.status).toBe(200);
    // It got to the vault intact...
    expect(vaultSaw).toEqual([{ name: "EXA_API_KEY", value: VALUE }]);
    // ...attributed to whoever actually submitted it...
    expect(stored?.telegramUserId).toBe(SUBMITTER);
    const rows = store.db.query("SELECT actor_id, text FROM inbox").all() as {
      actor_id: string;
      text: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_id).toBe(`tg:${SUBMITTER}`);
    // ...and the value itself is nowhere in the connector's own state, in any encoding.
    // The store runs in WAL mode, so a committed row may live in the -wal file rather than the
    // database proper: scan both, or this proves nothing.
    const raw = Buffer.concat([path, `${path}-wal`].filter(existsSync).map((f) => readFileSync(f)));
    expect(raw.includes("EXA_API_KEY")).toBe(true); // control: we ARE looking at live rows
    for (const form of [VALUE, encodeURIComponent(VALUE), JSON.stringify(VALUE).slice(1, -1)])
      expect(raw.includes(form)).toBe(false);
    rmSync(path, { force: true });
  });
});
