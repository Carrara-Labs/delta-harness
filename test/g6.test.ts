// G6: real kb auth in production — the refreshing agent credential with ONE-SHOT
// rotating refresh handling (§E). Built + tested ONLY against a MOCK OAuth endpoint
// that mirrors rotation-on-use + reuse-detection; the real one-shot token is never
// touched (reuse revokes the whole agent family). Also proves the MCP transport
// rotates on a 401 and that a per-run act-as-user override is NOT refreshed.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpRegistry } from "../src/mcp";
import { fileRefreshStore, RefreshingMcpCredential } from "../src/mcp-refresh";
import type { ToolCtx, Tools } from "../src/tools";

const stops: Array<() => void> = [];
const tmps: string[] = [];
afterAll(() => {
  for (const s of stops) s();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe("fileRefreshStore one-shot safety (codex P1)", () => {
  function tmpFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "delta-refresh-"));
    tmps.push(dir);
    return join(dir, "refresh.token");
  }

  test("first boot uses the seed; after a rotation the file is authoritative and the seed is NEVER reused", () => {
    const path = tmpFile();
    const store = fileRefreshStore(path, "SEED");
    expect(store.loadRefresh()).toBe("SEED"); // no file yet → the Fly-secret seed
    store.saveRefresh("R1"); // a rotation lands
    expect(store.loadRefresh()).toBe("R1"); // file wins
    expect(readFileSync(path, "utf8")).toBe("R1"); // atomically written
    // Even though the seed is still passed, a spent seed must never resurface.
    expect(fileRefreshStore(path, "SEED").loadRefresh()).toBe("R1");
  });

  test("an empty/corrupt token file returns null (fail loud) rather than the spent seed", () => {
    const path = tmpFile();
    writeFileSync(path, "   "); // corrupt/empty
    expect(fileRefreshStore(path, "SEED").loadRefresh()).toBeNull();
  });
});

/** A mock OAuth token endpoint mirroring the REAL kb contract: form-encoded body
 * (not JSON), a REQUIRED client_id (400 without it), and one-shot rotation — each
 * valid refresh token is consumed and reissued once; presenting a spent token
 * invalid_grants (reuse-detection). */
function mockOAuth(seed = "R0") {
  let valid = new Set([seed]);
  let n = 0;
  const posts: string[] = [];
  const clientIds: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      // Real endpoint is application/x-www-form-urlencoded — parse the form, not JSON.
      const form = new URLSearchParams(await req.text());
      const rt = form.get("refresh_token") ?? "";
      const clientId = form.get("client_id") ?? "";
      posts.push(rt);
      clientIds.push(clientId);
      if (!clientId)
        return new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 });
      if (!valid.has(rt))
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      valid = new Set([`R${++n}`]); // consume the old, issue the next (one-shot)
      return new Response(
        JSON.stringify({
          access_token: `A${n}`,
          token_type: "Bearer",
          refresh_token: `R${n}`,
          expires_in: 3600,
          scope: "kb",
        }),
      );
    },
  });
  stops.push(() => server.stop());
  return {
    url: `http://localhost:${server.port}/token`,
    posts,
    clientIds,
    rotations: () => n,
  };
}

describe("RefreshingMcpCredential (mock rotating OAuth)", () => {
  test("mints, rotates, and persists the new refresh token the instant it arrives", async () => {
    const oauth = mockOAuth("R0");
    let stored: string | null = "R0";
    const cred = new RefreshingMcpCredential({
      tokenUrl: oauth.url,
      clientId: "delta-agent",
      loadRefresh: () => stored,
      saveRefresh: (t) => {
        stored = t;
      },
    });
    expect(await cred.get()).toBe("A1");
    expect(stored).toBe("R1"); // rotated token persisted
    expect(oauth.rotations()).toBe(1); // one mint, cached thereafter
    expect(await cred.get()).toBe("A1"); // cached — no second rotation
    expect(oauth.rotations()).toBe(1);
  });

  test("sends the required client_id form-encoded (real kb contract — JSON/no client_id → 400)", async () => {
    const oauth = mockOAuth("R0");
    let stored: string | null = "R0";
    const cred = new RefreshingMcpCredential({
      tokenUrl: oauth.url,
      clientId: "delta-agent",
      loadRefresh: () => stored,
      saveRefresh: (t) => {
        stored = t;
      },
    });
    expect(await cred.get()).toBe("A1"); // succeeds → client_id was present + form-encoded
    expect(oauth.clientIds).toEqual(["delta-agent"]);
  });

  test("survives a restart mid-life: a fresh instance loads the persisted token, no double-spend", async () => {
    const oauth = mockOAuth("R0");
    let stored: string | null = "R0";
    const store = { loadRefresh: () => stored, saveRefresh: (t: string) => (stored = t) };
    const a = new RefreshingMcpCredential({
      tokenUrl: oauth.url,
      clientId: "delta-agent",
      ...store,
    });
    await a.get(); // R0 → A1, stored R1
    // "Restart": a brand-new credential loads the persisted (rotated) token.
    const b = new RefreshingMcpCredential({
      tokenUrl: oauth.url,
      clientId: "delta-agent",
      ...store,
    });
    expect(await b.get()).toBe("A2"); // rotates R1 → A2, never re-spends R0
    expect(oauth.posts).toEqual(["R0", "R1"]); // each token spent exactly once
  });

  test("coalesces concurrent refreshes onto ONE rotation (never double-spends)", async () => {
    const oauth = mockOAuth("R0");
    let stored: string | null = "R0";
    const cred = new RefreshingMcpCredential({
      tokenUrl: oauth.url,
      clientId: "delta-agent",
      loadRefresh: () => stored,
      saveRefresh: (t) => {
        stored = t;
      },
    });
    const [a, b, c] = await Promise.all([cred.get(), cred.get(), cred.get()]);
    expect([a, b, c]).toEqual(["A1", "A1", "A1"]); // one token for all three
    expect(oauth.rotations()).toBe(1); // exactly one refresh_token spent
    expect(oauth.posts).toEqual(["R0"]);
  });

  test("a spent token 401s (reuse-detection is real in the mock)", async () => {
    const oauth = mockOAuth("R0");
    const cred = new RefreshingMcpCredential({
      tokenUrl: oauth.url,
      clientId: "delta-agent",
      loadRefresh: () => "R0",
      saveRefresh: () => {}, // never persist → next call re-presents the spent R0
    });
    expect(await cred.get()).toBe("A1");
    // Re-presenting the now-spent R0 (saveRefresh was a no-op) trips reuse-detection.
    expect(cred.refresh()).rejects.toThrow(/401|invalid_grant|refresh/);
  });
});

describe("MCP transport rotates the agent credential on a 401 (§E / G6b)", () => {
  const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

  test("a 401 triggers exactly one rotation + retry; the override token is never refreshed", async () => {
    let refreshes = 0;
    let accepted = "A2"; // the server currently accepts this bearer
    const credential = {
      get: async () => accepted,
      refresh: async () => {
        refreshes++;
        accepted = "A2"; // "rotate" back to the accepted token
      },
    };
    const authSeen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const rpc = (await req.json()) as { id?: number; method: string };
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        const auth = req.headers.get("authorization") ?? "";
        // On the initial connect handshake, force a 401 the FIRST time to trigger a
        // rotation; act-as-user overrides (Bearer user-*) are honored, never refreshed.
        if (rpc.method !== "initialize" && rpc.method !== "tools/list") authSeen.push(auth);
        if (auth === "Bearer A1") return new Response("unauthorized", { status: 401 });
        const result =
          rpc.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {} }
            : rpc.method === "tools/list"
              ? { tools: [{ name: "act", description: "do", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: "ok" }] };
        return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    stops.push(() => server.stop());

    const registry: Tools = new Map();
    await new McpRegistry(registry).add({
      name: "kb",
      transport: "http",
      url: `http://localhost:${server.port}/mcp`,
      credential,
    });
    // A normal agent call: credential provides A2 → accepted, no refresh needed.
    expect(await registry.get("kb__act")?.execute({}, ctx)).toBe("ok");

    // Now force the stale-token path: the credential returns A1 (rejected) until it
    // rotates. The transport must retry ONCE after refresh, then succeed.
    accepted = "A2";
    let handed = "A1";
    credential.get = async () => handed;
    credential.refresh = async () => {
      refreshes++;
      handed = "A2";
    };
    expect(await registry.get("kb__act")?.execute({}, ctx)).toBe("ok");
    expect(refreshes).toBe(1); // exactly one rotation

    // An act-as-user override that 401s is NOT refreshed (it's the caller's token).
    refreshes = 0;
    handed = "A1"; // agent token would 401, but the override should win and be used as-is
    const asUser: ToolCtx = { workspace: "/tmp", activate: () => {}, authToken: "user-bob" };
    await registry.get("kb__act")?.execute({}, asUser);
    expect(refreshes).toBe(0); // never refreshed the user's token
    expect(authSeen.some((a) => a === "Bearer user-bob")).toBe(true);
  });
});
