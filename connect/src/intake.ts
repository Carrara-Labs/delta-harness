// Secure secret intake (0.4.0) — the novel piece.
//
// Neither OpenClaw nor Hermes can take a credential FROM a user IN a chat safely: they
// provision secrets operator-side, and pasting a key as chat text parks it on Telegram's
// servers forever. This module is a one-time secure drop box rendered natively inside the
// Telegram client:
//
//   1. A button (Telegram `web_app` inline keyboard) opens OUR page inside Telegram.
//   2. The page POSTs the value DIRECTLY to us over TLS — explicitly NOT `sendData()`,
//      which would route the value through Telegram's servers as a service message.
//   3. We authenticate the POST with the Mini App's `initData` (HMAC-SHA256 keyed by
//      HMAC(bot_token, "WebAppData")), bind it to the intake session, and write it
//      straight to the harness vault. Connect never persists the value.
//
// The narrow, honest guarantee: the value never crosses Telegram's bot-message transport
// and is never stored in Connect's chat records. The Telegram client still owns the
// WebView and the keyboard, as it does for anything typed on a phone.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store";

const MAX_BODY_BYTES = 8_192;
const MAX_VALUE_BYTES = 4_096;
/** initData is minted when the Mini App OPENS, so a legitimate submit is minutes old at most. */
const MAX_AUTH_AGE_MS = 300_000;
export const SESSION_TTL_MS = 15 * 60_000;

/** Names must be env-var shaped — the same rail the harness vault enforces. */
export const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Hardened headers for every response this listener emits. The page holds a credential in an
 *  input box, so its CSP names a per-response NONCE rather than blanket `unsafe-inline`: if HTML
 *  injection ever reached this page, injected script still would not run. Everything else is
 *  denied outright — no external origin of any kind, no form posts, no framing except Telegram. */
const pageHeaders = (nonce: string) => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
  "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors https://web.telegram.org https://telegram.org`,
});

const JSON_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: JSON_HEADERS });

/** Constant-time compare of two hex strings of equal length. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export type InitDataCheck =
  | { ok: true; userId: string; digest: string }
  | { ok: false; reason: string };

/**
 * Validate a Telegram Mini App `initData` string against the bot token.
 *
 * Per Telegram: secret_key = HMAC_SHA256(bot_token, key="WebAppData"); the data-check-string
 * is every field EXCEPT `hash` and `signature`, sorted by key, joined by \n as `key=value`;
 * the hash is hex HMAC_SHA256(data_check_string, secret_key).
 *
 * Stricter than the docs require, because this authenticates a credential drop:
 *  - duplicate `hash` / `auth_date` / `user` parameters are rejected outright (a duplicated
 *    key would otherwise let one copy sign and another be read),
 *  - the hash must be exactly 64 hex characters before any comparison,
 *  - auth_date must be an integer, not in the future beyond small skew, and within the window.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  now = Date.now(),
): InitDataCheck {
  if (!initData || initData.length > MAX_BODY_BYTES) return { ok: false, reason: "malformed" };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  for (const key of ["hash", "auth_date", "user", "signature"]) {
    if (params.getAll(key).length > 1) return { ok: false, reason: "duplicate field" };
  }
  const hash = params.get("hash") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: "bad hash" };

  // The check string is EVERY received field except `hash`, sorted, LF-joined.
  //
  // `signature` (Telegram's newer Ed25519 field) belongs IN it. Only the third-party Ed25519
  // algorithm removes `signature`; the bot-token HMAC uses "all received fields". Excluding it
  // here silently broke every real submission from a modern client while unit tests — which
  // signed the same way they verified — passed happily.
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const checkString = (drop: (k: string) => boolean) =>
    [...params]
      .filter(([k]) => !drop(k))
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
  const digestOf = (text: string) => createHmac("sha256", secret).update(text).digest("hex");

  const want = hash.toLowerCase();
  let matched = hexEqual(digestOf(checkString((k) => k === "hash")), want);
  // Fallback for any client that signs the Ed25519 way. Not a weakening: an attacker cannot
  // forge a valid hash for EITHER construction without the bot token. Logged when it fires so
  // the fallback can be dropped once we know it is never used.
  if (!matched && params.has("signature")) {
    matched = hexEqual(digestOf(checkString((k) => k === "hash" || k === "signature")), want);
    if (matched) console.error("[delta-connect] initData verified via the signature-excluded form");
  }
  if (!matched) {
    // Field NAMES only — never a value. Makes the next failure diagnosable in one tap.
    console.error(
      `[delta-connect] initData hash mismatch; fields present: ${[...params.keys()].sort().join(",")}`,
    );
    return { ok: false, reason: "bad signature" };
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate <= 0)
    return { ok: false, reason: "bad auth_date" };
  const ageMs = now - authDate * 1000;
  if (ageMs > MAX_AUTH_AGE_MS || ageMs < -60_000) return { ok: false, reason: "stale" };

  let userId = "";
  try {
    const user = JSON.parse(params.get("user") ?? "{}") as { id?: unknown };
    // Telegram ids exceed 32 bits; keep them as a string end-to-end, never parseInt.
    if (typeof user.id === "number" && Number.isSafeInteger(user.id)) userId = String(user.id);
    else if (typeof user.id === "string" && /^\d{1,20}$/.test(user.id)) userId = user.id;
  } catch {
    return { ok: false, reason: "bad user" };
  }
  if (!userId) return { ok: false, reason: "no user" };

  // The digest identifies THIS Telegram authorization. Consuming it globally is what stops a
  // single valid initData blob from being replayed against a second live session (the blob
  // signs Telegram's own fields, not our session id — so session binding alone is not enough).
  //
  // It MUST be derived from a canonical form. Keying on the raw string would be trivially
  // bypassed: field order and hash case do not affect validity (the check string is sorted and
  // the comparison is lowercased), so a reordered copy of the same authorization would look new.
  // Telegram's own `hash` is exactly the per-authorization identity, so key on that.
  const digest = createHmac("sha256", secret).update(`consume:${hash.toLowerCase()}`).digest("hex");
  return { ok: true, userId, digest };
}

/** Escape for HTML text context. Only ever applied to charset-validated names, but the
 *  encoder stays in place so no future caller can turn this page into an injection sink. */
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

/**
 * The form page. Deliberately self-contained: it does NOT load Telegram's
 * `telegram-web-app.js`. The launch data we need is already in the URL fragment as
 * `tgWebAppData`, so parsing it ourselves keeps every third-party script out of the origin
 * that holds the credential — the one page where an external script would be indefensible.
 *
 * Nothing model-authored is interpolated: the agent supplies only a NAME (validated against
 * NAME_RE) and the destination shown is the operator's configured one.
 */
export function intakePage(name: string, destination: string, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Provide ${esc(name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px;
         background: #fff; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #17212b; color: #f5f5f5; } }
  h1 { font-size: 19px; margin: 0 0 4px; }
  p { margin: 0 0 18px; opacity: .75; font-size: 14px; }
  code { font-size: 13px; }
  input { width: 100%; box-sizing: border-box; padding: 13px; font-size: 16px; font-family: ui-monospace, monospace;
          border: 1px solid #8884; border-radius: 10px; background: #8881; color: inherit; }
  button { width: 100%; margin-top: 14px; padding: 13px; font-size: 16px; font-weight: 600;
           border: 0; border-radius: 10px; background: #2f81f7; color: #fff; }
  button[disabled] { opacity: .5; }
  #msg { margin-top: 14px; font-size: 14px; min-height: 20px; }
  .ok { color: #2ea043; } .err { color: #f85149; }
</style></head>
<body>
  <h1>Provide <code>${esc(name)}</code></h1>
  <p>This value is sent straight to your agent over an encrypted connection and stored
     encrypted. It is never sent as a chat message, and your agent can never read it back.
     Destination: <code>${esc(destination)}</code></p>
  <input id="v" type="password" autocomplete="off" autocorrect="off" autocapitalize="off"
         spellcheck="false" placeholder="Paste the credential">
  <button id="b">Save securely</button>
  <div id="msg"></div>
<script nonce="${esc(nonce)}">
(function () {
  var input = document.getElementById('v'), button = document.getElementById('b'), msg = document.getElementById('msg');
  // Telegram puts the signed launch data in the URL fragment; read it here rather than
  // pulling in Telegram's SDK, so no third-party script runs in this origin.
  var initData = new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || '';
  function say(text, cls) { msg.textContent = text; msg.className = cls || ''; }
  button.addEventListener('click', async function () {
    var value = input.value;
    if (!value) { say('Paste the credential first.', 'err'); return; }
    button.disabled = true; say('Saving…');
    try {
      var res = await fetch(location.pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData: initData, value: value })
      });
      // Clear the field the instant the request settles, whatever the outcome.
      input.value = ''; value = null;
      if (res.ok) {
        say('Saved. You can close this window.', 'ok');
        button.style.display = 'none';
        if (window.Telegram && window.Telegram.WebApp) setTimeout(function () { window.Telegram.WebApp.close(); }, 1200);
      } else {
        var body = await res.json().catch(function () { return {}; });
        say(body && body.error ? body.error : 'That did not work. Ask for a new link.', 'err');
        button.disabled = false;
      }
    } catch (e) {
      input.value = '';
      say('Network error. Ask for a new link.', 'err');
      button.disabled = false;
    }
  });
})();
</script>
</body></html>`;
}

const deadPage = (message: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link expired</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#fff;color:#111}
@media (prefers-color-scheme: dark){body{background:#17212b;color:#f5f5f5}}</style></head>
<body><h1 style="font-size:19px">Link expired</h1><p style="opacity:.75;font-size:14px">${esc(message)}</p></body></html>`;

export type VaultWriter = (
  name: string,
  value: string,
  purpose: string,
) => Promise<{ ok: boolean; status: number; error?: string }>;

export type IntakeOptions = {
  store: Store;
  botToken: string;
  /** Public origin this listener is reachable at, e.g. https://agent.fly.dev. */
  publicUrl: string;
  port: number;
  /** Telegram user ids permitted to use intake. MUST be non-empty — an empty allowlist
   *  here would mean "anybody with a session URL", which is not a defensible default even
   *  though the chat surface itself tolerates an open allowlist in development. */
  allowedUsers: Set<string>;
  /** Writes to the harness vault over the loopback seam. */
  writeVault: VaultWriter;
  log: (message: string) => void;
  /** Told when a secret lands, so the connector can confirm in chat and nudge the agent. */
  onStored?: (session: { name: string; chatId: string; conversationId: string }) => void;
};

/** A short, non-reversible tag for logs — the raw session id is a live capability. */
const tag = (sessionId: string) =>
  createHmac("sha256", "intake-log").update(sessionId).digest("hex").slice(0, 8);

/**
 * The ONLY public listener Connect runs. Two routes; everything else is an empty 404.
 */
export class IntakeServer {
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private readonly opts: IntakeOptions) {}

  /** The URL a Telegram `web_app` button points at for a minted session. */
  url(sessionId: string): string {
    return `${this.opts.publicUrl.replace(/\/+$/, "")}/intake/${sessionId}`;
  }

  start(): void {
    const { store, botToken, allowedUsers, writeVault, log, onStored, publicUrl } = this.opts;
    const expectedOrigin = new URL(publicUrl).origin;
    this.server = Bun.serve({
      port: this.opts.port,
      idleTimeout: 30,
      fetch: async (request) => {
        const url = new URL(request.url);
        const match = url.pathname.match(/^\/intake\/([A-Za-z0-9_-]{16,64})$/);
        if (!match) return new Response(null, { status: 404 });
        const sessionId = match[1] as string;
        const session = store.intakeSession(sessionId);

        if (request.method === "GET") {
          const nonce = randomBytes(16).toString("base64");
          if (!session || session.used_at || session.expires_at < Date.now())
            return new Response(deadPage("Ask your agent for a new link."), {
              status: 410,
              headers: pageHeaders(nonce),
            });
          return new Response(intakePage(session.name, session.destination, nonce), {
            status: 200,
            headers: pageHeaders(nonce),
          });
        }

        if (request.method !== "POST") return new Response(null, { status: 404 });

        // Same-origin enforcement. Not authentication (initData is), but it stops a leaked
        // session URL from being driven by a cross-site page.
        const origin = request.headers.get("origin");
        if (origin && origin !== expectedOrigin) return json({ error: "forbidden" }, 403);
        if (!(request.headers.get("content-type") ?? "").includes("application/json"))
          return json({ error: "forbidden" }, 403);

        const declared = Number(request.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
          return json({ error: "too large" }, 413);
        let body: { initData?: unknown; value?: unknown };
        try {
          const text = await request.text();
          if (text.length > MAX_BODY_BYTES) return json({ error: "too large" }, 413);
          body = JSON.parse(text) as typeof body;
        } catch {
          return json({ error: "malformed request" }, 400);
        }
        if (typeof body.initData !== "string" || typeof body.value !== "string")
          return json({ error: "malformed request" }, 400);
        const value = body.value;
        if (!value || Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES)
          return json({ error: "value must be 1-4096 bytes" }, 400);

        const check = verifyInitData(body.initData, botToken);
        // One generic failure shape: a prober learns nothing about which check failed.
        if (!check.ok) {
          log(`intake ${tag(sessionId)} rejected (${check.reason})`);
          return json({ error: "this link is no longer valid" }, 403);
        }
        if (!allowedUsers.has(check.userId)) {
          log(`intake ${tag(sessionId)} rejected (user not allowed)`);
          return json({ error: "this link is no longer valid" }, 403);
        }
        if (!session || session.telegram_user_id !== check.userId) {
          log(`intake ${tag(sessionId)} rejected (session/user mismatch)`);
          return json({ error: "this link is no longer valid" }, 403);
        }

        // Two atomic claims, both before the value goes anywhere:
        //  • the Telegram authorization (its digest) — globally single-use, so one valid
        //    initData blob cannot be replayed against a second live session;
        //  • the session itself, moved pending → submitting, so two concurrent POSTs cannot
        //    both write (the loser gets a clean rejection rather than a last-write-wins race).
        if (!store.consumeIntakeAuth(check.digest, session.expires_at + SESSION_TTL_MS))
          return json({ error: "this link is no longer valid" }, 403);
        if (!store.claimIntakeSession(sessionId)) {
          // Nothing was written, so give the authorization back rather than burning it on a
          // session that turned out to be spent or expired.
          store.releaseIntakeAuth(check.digest);
          return json({ error: "this link is no longer valid" }, 409);
        }

        let wrote: Awaited<ReturnType<VaultWriter>>;
        try {
          wrote = await writeVault(session.name, value, session.purpose);
        } catch (e) {
          // Nothing landed: hand BOTH the session and the Telegram authorization back, so the
          // user can simply tap again rather than reopening the app for a fresh initData.
          store.releaseIntakeSession(sessionId);
          store.releaseIntakeAuth(check.digest);
          // The error NAME only: an exception string can quote the request that produced it.
          log(
            `intake ${tag(sessionId)} vault write failed: ${e instanceof Error ? e.name : "error"}`,
          );
          return json({ error: "could not reach the vault — try again" }, 502);
        }
        if (!wrote.ok) {
          // A 409 means the credential already exists: that is terminal, not retryable, and
          // deliberately cannot be overwritten from here. Anything else left nothing stored,
          // so release the session AND the authorization for a clean retry.
          if (wrote.status !== 409) {
            store.releaseIntakeSession(sessionId);
            store.releaseIntakeAuth(check.digest);
          } else store.finishIntakeSession(sessionId);
          log(`intake ${tag(sessionId)} vault rejected (${wrote.status})`);
          return json(
            {
              error:
                wrote.status === 409
                  ? "that credential is already stored; ask your operator to rotate it"
                  : "the vault rejected that value",
            },
            wrote.status === 409 ? 409 : 400,
          );
        }
        store.finishIntakeSession(sessionId);
        log(`intake ${tag(sessionId)} stored ${session.name}`);
        onStored?.({
          name: session.name,
          chatId: session.chat_id,
          conversationId: session.conversation_id,
        });
        return json({ ok: true });
      },
    });
    log(`intake listening on :${this.opts.port} (public ${expectedOrigin})`);
  }

  stop(): void {
    this.server?.stop(true);
  }
}
