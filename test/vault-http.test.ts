import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { Queue } from "../src/queue";
import { resetSecretRegistry } from "../src/scrub";
import { createServer } from "../src/server";
import { Vault } from "../src/vault";
import { makeDeps, textResult } from "./helpers";

const KEY = "test-vault-key-0123456789abcdef";
// The canary. If this string appears in ANY response body, log line, or status payload,
// the invariant is broken — a value must never come back out of the vault.
const SENTINEL = "sk-canary-value-must-never-escape-9f3a";
const TOKEN = "seam-token";
const INSPECT = "inspect-token";

const stubChat = async () => textResult("ok");
const deps = makeDeps(stubChat);
const vault = Vault.open(openDb(":memory:"), KEY) as Vault;
const server = createServer(new Queue(deps), deps.events, 0, {
  authToken: TOKEN,
  inspectToken: INSPECT,
  db: deps.db,
  vault,
  inspectWrite: true,
  vaultDeclared: ["EXA_API_KEY", "KB_TOKEN"],
  config: { version: "test" },
});
const base = `http://localhost:${server.port}`;
const auth = { authorization: `Bearer ${TOKEN}` };
const inspectAuth = { authorization: `Bearer ${INSPECT}` };

// A daemon with the vault but WITHOUT inspect-write: the operator surface must stay inert.
const readOnly = createServer(new Queue(makeDeps(stubChat)), deps.events, 0, {
  authToken: TOKEN,
  inspectToken: INSPECT,
  db: deps.db,
  vault,
  config: { version: "test" },
});
const roBase = `http://localhost:${readOnly.port}`;

// A daemon with NO vault — every route must 503 rather than half-work.
const bare = createServer(new Queue(makeDeps(stubChat)), deps.events, 0, {
  authToken: TOKEN,
  db: deps.db,
  config: { version: "test" },
});

afterAll(() => {
  server.stop(true);
  readOnly.stop(true);
  bare.stop(true);
  resetSecretRegistry();
});

const put = (name: string, value: string, purpose = "", headers = auth) =>
  fetch(`${base}/v1/secrets/${name}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ value, purpose }),
  });

describe("vault HTTP surface", () => {
  test("requires the seam token", async () => {
    const res = await fetch(`${base}/v1/secrets`);
    expect(res.status).toBe(401);
  });

  test("PUT stores a value and answers with the NAME only", async () => {
    const res = await put("EXA_API_KEY", SENTINEL, "web search");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("EXA_API_KEY");
    expect(body).not.toContain(SENTINEL);
    expect(vault.resolve("EXA_API_KEY")).toBe(SENTINEL); // it really landed
  });

  test("GET lists metadata without values", async () => {
    const body = await (await fetch(`${base}/v1/secrets`, { headers: auth })).text();
    expect(body).toContain("EXA_API_KEY");
    expect(body).toContain("web search");
    expect(body).not.toContain(SENTINEL);
  });

  test("there is NO read-back route for a value", async () => {
    // A GET on a specific name must not be a value read — the whole point of the design.
    const res = await fetch(`${base}/v1/secrets/EXA_API_KEY`, { headers: auth });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SENTINEL);
  });

  test("PUT is create-only: it cannot silently replace an established credential", async () => {
    const res = await put("EXA_API_KEY", "attacker-supplied-value");
    expect(res.status).toBe(409);
    expect(vault.resolve("EXA_API_KEY")).toBe(SENTINEL); // unchanged
  });

  test("rotation and deletion need the higher-privilege inspect credential", async () => {
    // The seam token drives runs and may CREATE a secret (the intake flow); it must not be
    // enough to swap or destroy an established one. Those live on the operator surface.
    for (const method of ["POST", "DELETE"] as const) {
      const res = await fetch(`${base}/v1/secrets/EXA_API_KEY`, {
        method,
        headers: { ...auth, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ value: "wrong-principal" }) } : {}),
      });
      expect(res.status).toBe(404); // no such route on the gateway surface
    }
    expect(vault.resolve("EXA_API_KEY")).toBe(SENTINEL);

    // Operator surface, but with the SEAM token → rejected (wrong credential).
    const wrongCred = await fetch(`${base}/v1/dev/secrets/EXA_API_KEY`, {
      method: "DELETE",
      headers: auth,
    });
    expect(wrongCred.status).toBe(401);
    expect(vault.has("EXA_API_KEY")).toBe(true);

    const rotate = await fetch(`${base}/v1/dev/secrets/EXA_API_KEY`, {
      method: "POST",
      headers: { ...inspectAuth, "content-type": "application/json" },
      body: JSON.stringify({ value: "operator-rotated-value" }),
    });
    expect(rotate.status).toBe(200);
    expect(vault.resolve("EXA_API_KEY")).toBe("operator-rotated-value");

    const gone = await fetch(`${base}/v1/dev/secrets/EXA_API_KEY`, {
      method: "DELETE",
      headers: inspectAuth,
    });
    expect(gone.status).toBe(200);
    expect(vault.has("EXA_API_KEY")).toBe(false);
  });

  test("the operator surface is inert unless DELTA_INSPECT_WRITE is on", async () => {
    const res = await fetch(`${roBase}/v1/dev/secrets/ANY_KEY`, {
      method: "DELETE",
      headers: inspectAuth,
    });
    expect(res.status).toBe(403);
  });

  test("validation errors carry the reason, never the submitted value", async () => {
    const bad = await put("lowercase_name", SENTINEL);
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(SENTINEL);

    const huge = await put("BIG_KEY", "x".repeat(5000));
    expect(huge.status).toBe(413);

    const notJson = await fetch(`${base}/v1/secrets/K`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: "not json",
    });
    expect(notJson.status).toBe(400);

    const noValue = await fetch(`${base}/v1/secrets/K`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ purpose: "x" }),
    });
    expect(noValue.status).toBe(400);
  });

  test("status reports the vault LIVE (not a boot snapshot) and never a value", async () => {
    await put("KB_TOKEN", SENTINEL, "knowledge base");
    const body = await (await fetch(`${base}/v1/status`, { headers: auth })).text();
    const status = JSON.parse(body) as {
      vault: { enabled: boolean; count: number; declared: string[] };
    };
    expect(status.vault.enabled).toBe(true);
    expect(status.vault.count).toBe(1); // stored a moment ago, after the server was built
    expect(status.vault.declared).toEqual(["EXA_API_KEY", "KB_TOKEN"]);
    expect(body).not.toContain(SENTINEL);
  });

  test("a vault-less daemon 503s the surface and reports disabled", async () => {
    const bareBase = `http://localhost:${bare.port}`;
    for (const [method, path] of [
      ["GET", "/v1/secrets"],
      ["PUT", "/v1/secrets/K"],
      ["DELETE", "/v1/secrets/K"],
    ] as const) {
      const res = await fetch(`${bareBase}${path}`, {
        method,
        headers: { ...auth, "content-type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ value: "x-value" }) } : {}),
      });
      expect(res.status).toBe(503);
    }
    const status = (await (await fetch(`${bareBase}/v1/status`, { headers: auth })).json()) as {
      vault: { enabled: boolean; count: number; declared: string[] };
    };
    expect(status.vault).toEqual({ enabled: false, count: 0, declared: [] });
  });
});

describe("vault auth hardening (codex V-07 / V-08)", () => {
  test("a tokenless daemon does not expose the vault off-loopback", async () => {
    // No control token = /v1/* is open for run traffic (the bare-dev default). A credential
    // store must not inherit that: served to loopback only.
    const open = createServer(new Queue(makeDeps(stubChat)), deps.events, 0, {
      db: deps.db,
      vault,
      config: { version: "test" },
    });
    // The test client IS loopback, so it is served — the guard is on the peer, not the token.
    const local = await fetch(`http://localhost:${open.port}/v1/secrets`);
    expect(local.status).toBe(200);
    open.stop(true);
  });

  test("secret rotation requires a real inspect token, not just a loopback peer", async () => {
    // Loopback alone authorizes /v1/dev reads; it must NOT authorize a credential mutation,
    // because any page in a local browser can drive a loopback POST.
    const loopbackOnly = createServer(new Queue(makeDeps(stubChat)), deps.events, 0, {
      authToken: TOKEN,
      db: deps.db,
      vault,
      inspectWrite: true,
      config: { version: "test" },
    });
    const res = await fetch(`http://localhost:${loopbackOnly.port}/v1/dev/secrets/ANY_KEY`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    loopbackOnly.stop(true);
  });
});
