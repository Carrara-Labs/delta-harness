import { describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intakePage, NAME_RE, SESSION_TTL_MS, verifyInitData } from "../src/intake";
import { Store } from "../src/store";

const BOT_TOKEN = "123456:test-bot-token-value";
const USER_ID = "5499639944";

/** Build a correctly-signed initData blob, the way Telegram would. */
function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

const freshFields = (over: Record<string, string> = {}) => ({
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: "AAf",
  user: JSON.stringify({ id: Number(USER_ID), first_name: "Nic" }),
  ...over,
});

const freshStore = () => {
  const path = join(tmpdir(), `connect-intake-${randomUUID()}.sqlite`);
  return { store: new Store(path), cleanup: () => rmSync(path, { force: true }) };
};

describe("initData verification", () => {
  test("accepts a correctly-signed blob and extracts the user id as a string", () => {
    const res = verifyInitData(signInitData(freshFields()), BOT_TOKEN);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.userId).toBe(USER_ID);
      expect(res.digest).toHaveLength(64);
    }
  });

  test("rejects a tampered payload (the hash no longer covers the fields)", () => {
    const signed = signInitData(freshFields());
    const tampered = signed.replace(/query_id=[^&]*/, "query_id=AAf-tampered");
    expect(verifyInitData(tampered, BOT_TOKEN).ok).toBe(false);
  });

  test("rejects a blob signed with a different bot token", () => {
    const signed = signInitData(freshFields(), "999999:someone-elses-token");
    expect(verifyInitData(signed, BOT_TOKEN)).toMatchObject({ ok: false, reason: "bad signature" });
  });

  test("rejects a stale auth_date and one implausibly in the future", () => {
    const stale = signInitData(
      freshFields({ auth_date: String(Math.floor(Date.now() / 1000) - 3600) }),
    );
    expect(verifyInitData(stale, BOT_TOKEN)).toMatchObject({ ok: false, reason: "stale" });
    const future = signInitData(
      freshFields({ auth_date: String(Math.floor(Date.now() / 1000) + 600) }),
    );
    expect(verifyInitData(future, BOT_TOKEN)).toMatchObject({ ok: false, reason: "stale" });
  });

  test("rejects malformed, non-integer and missing auth_date", () => {
    for (const bad of ["not-a-number", "1.5", "-1", ""]) {
      const signed = signInitData(freshFields({ auth_date: bad }));
      expect(verifyInitData(signed, BOT_TOKEN).ok).toBe(false);
    }
  });

  test("rejects a duplicated hash parameter", () => {
    // A duplicate key would let one copy be signed and another be read.
    const signed = `${signInitData(freshFields())}&hash=${"0".repeat(64)}`;
    expect(verifyInitData(signed, BOT_TOKEN)).toMatchObject({
      ok: false,
      reason: "duplicate field",
    });
  });

  test("rejects a hash that is not 64 hex characters, before any comparison", () => {
    const params = new URLSearchParams(signInitData(freshFields()));
    params.set("hash", "abc");
    expect(verifyInitData(params.toString(), BOT_TOKEN)).toMatchObject({
      ok: false,
      reason: "bad hash",
    });
  });

  test("rejects a blob with no user, and one whose user json is broken", () => {
    const noUser = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)) });
    expect(verifyInitData(noUser, BOT_TOKEN).ok).toBe(false);
    const badUser = signInitData(freshFields({ user: "{not json" }));
    expect(verifyInitData(badUser, BOT_TOKEN).ok).toBe(false);
  });

  test("handles a Telegram id beyond 32 bits without truncation", () => {
    const big = "7123456789012345";
    const res = verifyInitData(
      signInitData(freshFields({ user: JSON.stringify({ id: big }) })),
      BOT_TOKEN,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.userId).toBe(big);
  });

  test("the signature field is excluded from the check string", () => {
    // Telegram's newer Ed25519 `signature` must not break bot-token HMAC validation.
    const fields = freshFields();
    const signed = `${signInitData(fields)}&signature=abc123`;
    expect(verifyInitData(signed, BOT_TOKEN).ok).toBe(true);
  });

  test("the same blob always yields the same digest (so it can be consumed once)", () => {
    const signed = signInitData(freshFields());
    const a = verifyInitData(signed, BOT_TOKEN);
    const b = verifyInitData(signed, BOT_TOKEN);
    expect(a.ok && b.ok && a.digest === b.digest).toBe(true);
  });
});

describe("intake session lifecycle", () => {
  const mint = (store: Store, over: Record<string, unknown> = {}) =>
    store.createIntakeSession({
      id: randomUUID(),
      name: "EXA_API_KEY",
      purpose: "web search",
      destination: "api.exa.ai",
      telegramUserId: USER_ID,
      chatId: "chat-1",
      conversationId: "conv-1",
      ttlMs: SESSION_TTL_MS,
      ...over,
    });

  test("a session can be claimed exactly once (concurrent POSTs cannot both write)", () => {
    const { store, cleanup } = freshStore();
    const id = mint(store);
    expect(store.claimIntakeSession(id)).toBe(true);
    expect(store.claimIntakeSession(id)).toBe(false);
    cleanup();
  });

  test("a finished session can never be claimed again", () => {
    const { store, cleanup } = freshStore();
    const id = mint(store);
    store.claimIntakeSession(id);
    store.finishIntakeSession(id);
    expect(store.claimIntakeSession(id)).toBe(false);
    expect(store.intakeSession(id)?.used_at).toBeGreaterThan(0);
    cleanup();
  });

  test("a released session (the vault write failed) can be retried", () => {
    const { store, cleanup } = freshStore();
    const id = mint(store);
    store.claimIntakeSession(id);
    store.releaseIntakeSession(id);
    expect(store.claimIntakeSession(id)).toBe(true);
    cleanup();
  });

  test("release cannot resurrect a session that already succeeded", () => {
    const { store, cleanup } = freshStore();
    const id = mint(store);
    store.claimIntakeSession(id);
    store.finishIntakeSession(id);
    store.releaseIntakeSession(id);
    expect(store.claimIntakeSession(id)).toBe(false);
    cleanup();
  });

  test("an expired session cannot be claimed and is swept", () => {
    const { store, cleanup } = freshStore();
    const id = mint(store, { ttlMs: -1 });
    expect(store.claimIntakeSession(id)).toBe(false);
    store.sweepIntake();
    expect(store.intakeSession(id)).toBeNull();
    cleanup();
  });

  test("a Telegram authorization is consumable exactly once, globally", () => {
    const { store, cleanup } = freshStore();
    const digest = "d".repeat(64);
    expect(store.consumeIntakeAuth(digest, Date.now() + 60_000)).toBe(true);
    // The replay attempt: same valid blob, a DIFFERENT live session.
    expect(store.consumeIntakeAuth(digest, Date.now() + 60_000)).toBe(false);
    cleanup();
  });

  test("no session row ever holds a credential value", () => {
    const { store, cleanup } = freshStore();
    const id = mint(store);
    expect(JSON.stringify(store.intakeSession(id))).not.toContain("secret");
    cleanup();
  });
});

describe("the form page", () => {
  test("loads no third-party script (nothing else may run in the credential's origin)", () => {
    const html = intakePage("EXA_API_KEY", "api.exa.ai");
    expect(html).not.toContain("telegram-web-app.js");
    expect(html).not.toContain("<script src");
    expect(html).toContain("tgWebAppData"); // parsed from the fragment ourselves
  });

  test("names are charset-validated and HTML-escaped on the way in", () => {
    // NAME_RE is the gate; escaping is the second line so the page can never become a sink.
    expect(NAME_RE.test("</script><img src=x onerror=alert(1)>")).toBe(false);
    expect(NAME_RE.test("EXA_API_KEY")).toBe(true);
    const html = intakePage("EXA_API_KEY", '"><script>alert(1)</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the input is a password field with autocomplete and spellcheck off", () => {
    const html = intakePage("K", "d");
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain('spellcheck="false"');
  });

  test("it POSTs to its own path rather than using Telegram's sendData", () => {
    const html = intakePage("K", "d");
    expect(html).toContain("location.pathname");
    expect(html).not.toContain("sendData");
  });
});

describe("retry after a transient failure", () => {
  test("a released authorization can be used again (but a spent one cannot)", () => {
    const path = join(tmpdir(), `connect-retry-${randomUUID()}.sqlite`);
    const store = new Store(path);
    const digest = "e".repeat(64);
    expect(store.consumeIntakeAuth(digest, Date.now() + 60_000)).toBe(true);
    expect(store.consumeIntakeAuth(digest, Date.now() + 60_000)).toBe(false);
    // Our own vault write failed and nothing was stored: hand the authorization back so the
    // user can tap again instead of reopening the Mini App for a fresh initData.
    store.releaseIntakeAuth(digest);
    expect(store.consumeIntakeAuth(digest, Date.now() + 60_000)).toBe(true);
    rmSync(path, { force: true });
  });
});
