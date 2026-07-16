// M7: the OpenAI-subscription consumer path. A mock broker mint endpoint stands
// in for the control plane's GET /api/broker/openai-token, and a mock OpenAI-
// compatible model endpoint asserts the minted bearer + chatgpt-account-id header
// arrive on the model call. Caching, refresh-on-expiry, and concurrent coalescing
// are all proven without any live subscription creds.

import { afterEach, describe, expect, test } from "bun:test";
import { BrokerCredential, NoServableToken, StaticCredential } from "../src/broker";
import { chat, chatVia } from "../src/provider";

let stop: Array<() => void> = [];
afterEach(() => {
  for (const s of stop) s();
  stop = [];
});

function mockMint(tokens: MintToken[]) {
  let i = 0;
  let mints = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      mints++;
      const authed = req.headers.get("authorization") === "Bearer gw-token";
      if (!authed) return new Response("unauthorized", { status: 401 });
      const t = tokens[Math.min(i++, tokens.length - 1)] as MintToken;
      return Response.json({
        accessToken: t.token,
        accountId: t.accountId,
        planType: "pro",
        expiresAt: new Date(Date.now() + t.ttlMs).toISOString(),
      });
    },
  });
  stop.push(() => server.stop());
  return { url: `http://localhost:${server.port}/api/broker/openai-token`, mints: () => mints };
}

type MintToken = { token: string; accountId: string; ttlMs: number };

function mockModel() {
  const seen: Array<{ auth: string | null; account: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      seen.push({
        auth: req.headers.get("authorization"),
        account: req.headers.get("chatgpt-account-id"),
      });
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  stop.push(() => server.stop());
  return { url: `http://localhost:${server.port}/v1`, seen };
}

describe("BrokerCredential", () => {
  test("mints a token, presents it as bearer + chatgpt-account-id on the model call", async () => {
    const mint = mockMint([{ token: "sub-access-1", accountId: "acct-42", ttlMs: 3_600_000 }]);
    const model = mockModel();
    const cred = new BrokerCredential(mint.url, "gw-token");
    const res = await chat(
      { baseUrl: model.url, apiKey: "", models: ["gpt-5"], maxRetries: 0, credential: cred },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(true);
    expect(model.seen[0]?.auth).toBe("Bearer sub-access-1");
    expect(model.seen[0]?.account).toBe("acct-42");
  });

  test("caches within TTL — a second call does not re-mint", async () => {
    const mint = mockMint([{ token: "sub-access-1", accountId: "a", ttlMs: 3_600_000 }]);
    const model = mockModel();
    const cred = new BrokerCredential(mint.url, "gw-token");
    const cfg = {
      baseUrl: model.url,
      apiKey: "",
      models: ["gpt-5"],
      maxRetries: 0,
      credential: cred,
    };
    await chat(cfg, { messages: [{ role: "user", content: "1" }] });
    await chat(cfg, { messages: [{ role: "user", content: "2" }] });
    expect(mint.mints()).toBe(1); // one mint served both calls
  });

  test("re-mints when the cached token ages within the refresh skew of expiry", async () => {
    // Both tokens are healthy at mint (> skew); we age the CACHE to within the skew to force
    // the re-mint (a sub-skew token straight from the broker is now rejected by H1, tested below).
    const mint = mockMint([
      { token: "sub-1", accountId: "a", ttlMs: 3_600_000 },
      { token: "sub-2", accountId: "a", ttlMs: 3_600_000 },
    ]);
    const cred = new BrokerCredential(mint.url, "gw-token");
    const first = await cred.get();
    expect(first.token).toBe("sub-1");
    // Simulate the cached token aging to within the 5-min refresh skew.
    (cred as unknown as { cached: { expiresAt: number } }).cached.expiresAt = Date.now() + 60_000;
    const second = await cred.get();
    expect(second.token).toBe("sub-2"); // aged cache → re-mint picked up the fresh token
    expect(mint.mints()).toBe(2);
  });

  test("concurrent misses coalesce onto one mint call", async () => {
    const mint = mockMint([{ token: "sub-1", accountId: "a", ttlMs: 3_600_000 }]);
    const cred = new BrokerCredential(mint.url, "gw-token");
    await Promise.all([cred.get(), cred.get(), cred.get()]);
    expect(mint.mints()).toBe(1);
  });

  test("a mint failure surfaces as an error (provider returns it as a value)", async () => {
    const model = mockModel();
    // Wrong auth → the mint 401s.
    const mint = mockMint([{ token: "x", accountId: "a", ttlMs: 1000 }]);
    const cred = new BrokerCredential(mint.url, "wrong-token");
    const res = await chat(
      { baseUrl: model.url, apiKey: "", models: ["gpt-5"], maxRetries: 0, credential: cred },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("broker mint 401");
  });

  test("409 (no servable token) is a distinct NoServableToken → caller can fall back", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { error: "no servable subscription token", servable: false },
          { status: 409 },
        ),
    });
    stop.push(() => server.stop());
    const cred = new BrokerCredential(`http://localhost:${server.port}/mint`, "gw-token");
    await expect(cred.get()).rejects.toBeInstanceOf(NoServableToken);
  });

  test("a near-expiry or invalid-expiry mint is unusable → NoServableToken, not cached (codex H1)", async () => {
    // (a) unparseable expiry — a broker fault; must not be cached as fresh-forever.
    const s1 = Bun.serve({
      port: 0,
      fetch: () => Response.json({ accessToken: "t", accountId: "a", expiresAt: "not-a-date" }),
    });
    stop.push(() => s1.stop());
    const c1 = new BrokerCredential(`http://localhost:${s1.port}/mint`, "gw");
    await expect(c1.get()).rejects.toBeInstanceOf(NoServableToken);
    expect((c1 as unknown as { cached: unknown }).cached).toBeNull();
    // (b) already within the refresh skew (would 401 mid-call) — reject, don't use once.
    const s2 = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          accessToken: "t",
          accountId: "a",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
    });
    stop.push(() => s2.stop());
    const c2 = new BrokerCredential(`http://localhost:${s2.port}/mint`, "gw");
    await expect(c2.get()).rejects.toBeInstanceOf(NoServableToken);
  });

  test("penalize() cools the credential down → NoServableToken during the window (codex H4)", async () => {
    const mint = mockMint([{ token: "sub-1", accountId: "a", ttlMs: 3_600_000 }]);
    const cred = new BrokerCredential(mint.url, "gw-token");
    await cred.get(); // mints once, cached
    cred.penalize(60_000); // 429 cooldown
    await expect(cred.get()).rejects.toBeInstanceOf(NoServableToken);
    // Cooldown lapses → serves again (no extra mint needed, token still cached).
    (cred as unknown as { cooldownUntil: number }).cooldownUntil = Date.now() - 1;
    const after = await cred.get();
    expect(after.token).toBe("sub-1");
  });

  test("invalidate() drops the cache so the next get() re-mints (codex H2)", async () => {
    const mint = mockMint([
      { token: "sub-1", accountId: "a", ttlMs: 3_600_000 },
      { token: "sub-2", accountId: "a", ttlMs: 3_600_000 },
    ]);
    const cred = new BrokerCredential(mint.url, "gw-token");
    expect((await cred.get()).token).toBe("sub-1");
    cred.invalidate();
    expect((await cred.get()).token).toBe("sub-2"); // re-minted, picked up the rotated token
    expect(mint.mints()).toBe(2);
  });

  test("broker 409 surfaces on the model result with status 409 (codex P2)", async () => {
    const model = mockModel();
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("{}", { status: 409 }),
    });
    stop.push(() => server.stop());
    const cred = new BrokerCredential(`http://localhost:${server.port}/mint`, "gw");
    const res = await chat(
      { baseUrl: model.url, apiKey: "", models: ["gpt-5"], maxRetries: 0, credential: cred },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(409); // caller can detect → fall back to metered
    expect(model.seen.length).toBe(0); // never hit the model with a bad token
  });

  test("StaticCredential just returns the key (no account header)", async () => {
    const model = mockModel();
    await chat(
      {
        baseUrl: model.url,
        apiKey: "",
        models: ["x"],
        maxRetries: 0,
        credential: new StaticCredential("sk-static"),
      },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(model.seen[0]?.auth).toBe("Bearer sk-static");
    expect(model.seen[0]?.account).toBeNull();
  });

  test("no credential → the static apiKey path is unchanged", async () => {
    const model = mockModel();
    await chat(
      { baseUrl: model.url, apiKey: "sk-plain", models: ["x"], maxRetries: 0 },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(model.seen[0]?.auth).toBe("Bearer sk-plain");
  });
});

describe("config guard: subscription token only goes to an allowlisted host (codex H3)", () => {
  test("mint URL + non-allowlisted base → NO broker credential (static key stands)", async () => {
    const { loadConfig } = await import("../src/config");
    // Absent MODEL_BASE_URL defaults to OpenRouter → not on the allowlist → refuse.
    const absent = loadConfig({
      DELTA_BROKER_MINT_URL: "https://cp/mint",
      OPENROUTER_API_KEY: "sk",
    });
    expect(absent.provider.credential).toBeUndefined();
    // Explicit OpenRouter base → refused.
    const openrouter = loadConfig({
      DELTA_BROKER_MINT_URL: "https://cp/mint",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_API_KEY: "sk",
    });
    expect(openrouter.provider.credential).toBeUndefined();
    // A typo'd / hostile host that isn't on the allowlist → refused (the key H3 case).
    const hostile = loadConfig({
      DELTA_BROKER_MINT_URL: "https://cp/mint",
      DELTA_BROKER_AUTH: "gw",
      MODEL_BASE_URL: "https://chatgpt.evil.com/backend-api",
    });
    expect(hostile.provider.credential).toBeUndefined();
  });

  test("the real Codex backend host IS allowlisted → broker credential is built", async () => {
    const { loadConfig } = await import("../src/config");
    const sub = loadConfig({
      DELTA_BROKER_TOKEN_URL: "https://cp/api/broker/openai-token", // T2 canonical name
      DELTA_BROKER_AUTH: "gw",
      MODEL_BASE_URL: "https://chatgpt.com/backend-api/codex",
    });
    expect(sub.provider.credential).toBeDefined();
  });

  test("DELTA_BROKER_ALLOWED_HOSTS extends the allowlist for a custom Codex host", async () => {
    const { loadConfig } = await import("../src/config");
    const sub = loadConfig({
      DELTA_BROKER_MINT_URL: "https://cp/mint",
      DELTA_BROKER_AUTH: "gw",
      MODEL_BASE_URL: "https://codex.internal.corp/v1",
      DELTA_BROKER_ALLOWED_HOSTS: "codex.internal.corp",
    });
    expect(sub.provider.credential).toBeDefined();
  });
});

/** A scriptable mock model: each request pops the next status from `seq` (default 200 SSE),
 * capturing the auth + originator + account headers seen. */
function mockModelSeq(seq: Array<{ status: number; retryAfter?: string }> = []) {
  let i = 0;
  const seen: Array<{ auth: string | null; account: string | null; originator: string | null }> =
    [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      seen.push({
        auth: req.headers.get("authorization"),
        account: req.headers.get("chatgpt-account-id"),
        originator: req.headers.get("originator"),
      });
      const s = seq[i++] ?? { status: 200 };
      if (s.status !== 200) {
        const headers: Record<string, string> = {};
        if (s.retryAfter) headers["retry-after"] = s.retryAfter;
        return new Response("err", { status: s.status, headers });
      }
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  stop.push(() => server.stop());
  return { url: `http://localhost:${server.port}/v1`, seen };
}

describe("subscription hardening (codex H1-H4, T1)", () => {
  test("H4: a 429 fails over immediately and cools the credential down (no next-model hammering)", async () => {
    const mint = mockMint([{ token: "sub-1", accountId: "a", ttlMs: 3_600_000 }]);
    const model = mockModelSeq([{ status: 429, retryAfter: "30" }]);
    const cred = new BrokerCredential(mint.url, "gw-token");
    const res = await chat(
      // Two models: the OLD behavior would try BOTH against the sub on a 429.
      {
        baseUrl: model.url,
        apiKey: "",
        models: ["gpt-5", "gpt-5-mini"],
        maxRetries: 2,
        credential: cred,
      },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(429);
    expect(model.seen.length).toBe(1); // exactly ONE hit — no retries, no second model
    // Retry-After (30s) parked the credential in a cooldown.
    expect((cred as unknown as { cooldownUntil: number }).cooldownUntil).toBeGreaterThan(
      Date.now(),
    );
  });

  test("H2: a pre-stream 401 invalidates + re-mints + retries once, then succeeds", async () => {
    const mint = mockMint([
      { token: "sub-1", accountId: "a", ttlMs: 3_600_000 },
      { token: "sub-2", accountId: "a", ttlMs: 3_600_000 },
    ]);
    const model = mockModelSeq([{ status: 401 }]); // first call 401s, second (retry) → 200
    const cred = new BrokerCredential(mint.url, "gw-token");
    const res = await chat(
      { baseUrl: model.url, apiKey: "", models: ["gpt-5"], maxRetries: 0, credential: cred },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(true);
    expect(model.seen[0]?.auth).toBe("Bearer sub-1");
    expect(model.seen[1]?.auth).toBe("Bearer sub-2"); // re-minted after invalidate
    expect(mint.mints()).toBe(2);
  });

  test("H2: a persistent 401 gives up after one re-auth (fails over, not infinite)", async () => {
    const mint = mockMint([{ token: "sub-1", accountId: "a", ttlMs: 3_600_000 }]);
    const model = mockModelSeq([{ status: 401 }, { status: 401 }, { status: 401 }]);
    const cred = new BrokerCredential(mint.url, "gw-token");
    const res = await chat(
      { baseUrl: model.url, apiKey: "", models: ["gpt-5"], maxRetries: 2, credential: cred },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(401);
    expect(model.seen.length).toBe(2); // one original + exactly one re-auth retry
  });

  test("T1: MODEL_HEADERS static headers ride the request (e.g. Codex originator)", async () => {
    const model = mockModelSeq();
    const { loadConfig } = await import("../src/config");
    const cfg = loadConfig({
      MODEL_BASE_URL: model.url,
      OPENROUTER_API_KEY: "sk",
      MODEL_HEADERS: JSON.stringify({ originator: "codex_cli_rs" }),
    });
    await chat({ ...cfg.provider, maxRetries: 0 }, { messages: [{ role: "user", content: "hi" }] });
    expect(model.seen[0]?.originator).toBe("codex_cli_rs");
  });

  test("T1: malformed or reserved MODEL_HEADERS fails config loudly (throws)", async () => {
    const { loadConfig } = await import("../src/config");
    expect(() => loadConfig({ MODEL_HEADERS: "{not json" })).toThrow(/not valid JSON/);
    expect(() => loadConfig({ MODEL_HEADERS: JSON.stringify(["a"]) })).toThrow(/JSON object/);
    expect(() =>
      loadConfig({ MODEL_HEADERS: JSON.stringify({ Authorization: "Bearer x" }) }),
    ).toThrow(/reserved header 'authorization'/);
    expect(() => loadConfig({ MODEL_HEADERS: JSON.stringify({ originator: 5 }) })).toThrow(
      /must be a string/,
    );
  });

  test("T5: a broker provider with no metered fallback warns at boot", async () => {
    const { loadConfig } = await import("../src/config");
    const warnings: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => warnings.push(a.join(" "));
    try {
      loadConfig({
        DELTA_BROKER_TOKEN_URL: "https://cp/api/broker/openai-token",
        DELTA_BROKER_AUTH: "gw",
        MODEL_BASE_URL: "https://chatgpt.com/backend-api/codex",
      });
    } finally {
      console.error = orig;
    }
    expect(warnings.some((w) => w.includes("non-subscription fallback"))).toBe(true);
  });

  test("T2: DELTA_MODEL_PRIMARY is honored (control-plane env name)", async () => {
    const { loadConfig } = await import("../src/config");
    const cfg = loadConfig({ DELTA_MODEL_PRIMARY: "openai/gpt-5.6", OPENROUTER_API_KEY: "sk" });
    expect(cfg.provider.models[0]).toBe("openai/gpt-5.6");
  });

  test("H1: a mint without accountId is unusable → NoServableToken (Codex backend needs the header)", async () => {
    const s = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          accessToken: "t",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
    });
    stop.push(() => s.stop());
    const cred = new BrokerCredential(`http://localhost:${s.port}/mint`, "gw");
    await expect(cred.get()).rejects.toBeInstanceOf(NoServableToken);
  });

  test("a broker mint 401 surfaces as status 401 and fails over immediately (bounded mints)", async () => {
    let mints = 0;
    const s = Bun.serve({
      port: 0,
      fetch: () => {
        mints++;
        return new Response("nope", { status: 401 });
      },
    });
    stop.push(() => s.stop());
    const model = mockModelSeq();
    const cred = new BrokerCredential(`http://localhost:${s.port}/mint`, "gw");
    const res = await chat(
      {
        baseUrl: model.url,
        apiKey: "",
        models: ["m1", "m2", "m3"],
        maxRetries: 2,
        credential: cred,
      },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(401); // broker status surfaced, not a generic error
    expect(model.seen.length).toBe(0); // never hit a model with a bad credential
    expect(mints).toBeLessThanOrEqual(2); // one + one H2 re-auth — NOT once per model
  });

  test("H4: a 429 with an unparseable Retry-After still applies a default cooldown", async () => {
    const mint = mockMint([{ token: "sub-1", accountId: "a", ttlMs: 3_600_000 }]);
    const model = mockModelSeq([{ status: 429, retryAfter: "garbage" }]);
    const cred = new BrokerCredential(mint.url, "gw-token");
    await chat(
      { baseUrl: model.url, apiKey: "", models: ["gpt-5"], maxRetries: 0, credential: cred },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect((cred as unknown as { cooldownUntil: number }).cooldownUntil).toBeGreaterThan(
      Date.now(),
    );
  });

  test("H2/P1: a MID-STREAM 401 (SSE error after a delta) still invalidates the credential", async () => {
    // Model streams one delta, then emits an OpenAI-compat error chunk signalling auth failure.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\n` +
            `data: ${JSON.stringify({ error: { message: "invalid token: unauthorized (401)" } })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    stop.push(() => server.stop());
    const mint = mockMint([{ token: "sub-1", accountId: "a", ttlMs: 3_600_000 }]);
    const cred = new BrokerCredential(mint.url, "gw-token");
    let invalidations = 0;
    const orig = cred.invalidate.bind(cred);
    cred.invalidate = () => {
      invalidations++;
      orig();
    };
    // onDelta makes the first chunk a real streamed delta → the poisoned-stream guard forbids a
    // retry, so the credential side-effect must fire BEFORE that guard (the P1 fix). Exactly one.
    const res = await chat(
      {
        baseUrl: `http://localhost:${server.port}/v1`,
        apiKey: "",
        models: ["gpt-5"],
        maxRetries: 0,
        credential: cred,
      },
      { messages: [{ role: "user", content: "hi" }], onDelta: () => {} },
    );
    expect(res.ok).toBe(false);
    expect(invalidations).toBe(1); // classified the streamed 401 → dropped the cache, did NOT retry
  });

  test("chatVia: a subscription 409 fails over to the metered provider, which serves", async () => {
    const broker409 = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 409 }) });
    stop.push(() => broker409.stop());
    const model = mockModelSeq(); // the metered fallback serves 200
    const sub = {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKey: "",
      models: ["gpt-5"],
      maxRetries: 0,
      api: "responses" as const,
      label: "sub",
      credential: new BrokerCredential(`http://localhost:${broker409.port}/mint`, "gw"),
    };
    const metered = {
      baseUrl: model.url,
      apiKey: "sk-or",
      models: ["gpt-5"],
      maxRetries: 0,
      label: "openrouter",
    };
    const res = await chatVia([sub, metered], { messages: [{ role: "user", content: "hi" }] });
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("openrouter"); // failed over from the sub (never hit chatgpt.com)
  });
});

describe("Responses wire (Codex backend)", () => {
  test("sends store:false — the ChatGPT/Codex backend requires it (found in live test)", async () => {
    let sawStore: unknown = "UNSET";
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        sawStore = ((await req.json()) as { store?: unknown }).store;
        return new Response(
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
            `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    stop.push(() => server.stop());
    const res = await chat(
      {
        baseUrl: `http://localhost:${server.port}`,
        apiKey: "k",
        models: ["gpt-5.6-sol"],
        api: "responses" as const,
        maxRetries: 0,
      },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(true);
    expect(sawStore).toBe(false);
  });
});

describe("allowlist edges (codex P1)", () => {
  test("plaintext http, subdomain, and non-https mint URL are all refused", async () => {
    const { loadConfig } = await import("../src/config");
    // Plaintext base — a bearer must never cross the wire unencrypted.
    const httpBase = loadConfig({
      DELTA_BROKER_TOKEN_URL: "https://cp/mint",
      DELTA_BROKER_AUTH: "gw",
      MODEL_BASE_URL: "http://chatgpt.com/backend-api/codex",
    });
    expect(httpBase.provider.credential).toBeUndefined();
    // Subdomain of an allowlisted host — exact-match only, no implicit wildcard.
    const subdomain = loadConfig({
      DELTA_BROKER_TOKEN_URL: "https://cp/mint",
      DELTA_BROKER_AUTH: "gw",
      MODEL_BASE_URL: "https://evil.chatgpt.com/x",
    });
    expect(subdomain.provider.credential).toBeUndefined();
    // Non-https, non-loopback mint URL — would send the gateway token in plaintext.
    const httpMint = loadConfig({
      DELTA_BROKER_TOKEN_URL: "http://cp-not-local/mint",
      DELTA_BROKER_AUTH: "gw",
      MODEL_BASE_URL: "https://chatgpt.com/backend-api/codex",
    });
    expect(httpMint.provider.credential).toBeUndefined();
  });
});
