import { afterAll, describe, expect, test } from "bun:test";
import { Queue } from "../src/queue";
import { createServer } from "../src/server";
import { HARNESS_VERSION } from "../src/version";
import { makeDeps, textResult } from "./helpers";

const deps = makeDeps(async (req) => {
  const last = req.messages.at(-1) as { content: string };
  return textResult(`[delta] ${last.content}`);
});
const server = createServer(new Queue(deps), deps.events, 0);
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop());

// Mirrors a control-plane driver's text extraction — the real consumer of this API.
// If these pass, an OpenAI-Responses-compatible driver can drive us.
function extractTextLikeDriver(raw: Record<string, unknown>): string {
  if (typeof raw.output_text === "string") return raw.output_text;
  const output = raw.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const content = (item as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const text = (c as { text?: unknown }).text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  return "";
}

describe("GET /healthz", () => {
  test("returns ok + the running harness version (fleet probe)", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(HARNESS_VERSION);
  });
});

describe("POST /v1/responses", () => {
  test("runs a real turn through the queue in a driver-compatible shape", async () => {
    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello delta", store: true }),
    });
    expect(res.status).toBe(200);
    const raw = (await res.json()) as Record<string, unknown>;

    expect(raw.id).toMatch(/^resp_[0-9a-f]{32}$/);
    expect(raw.output_text).toBe("[delta] hello delta");
    // The driver's fallback path (output[].content[].text) must yield the same text.
    expect(extractTextLikeDriver({ ...raw, output_text: undefined })).toBe("[delta] hello delta");
    // Driver's extractUsage requires numeric token fields.
    const usage = raw.usage as Record<string, unknown>;
    expect(typeof usage.input_tokens).toBe("number");
    expect(typeof usage.output_tokens).toBe("number");
    expect(typeof usage.total_tokens).toBe("number");
  });

  test("threads previous_response_id", async () => {
    const first = (await (
      await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "turn one" }),
      })
    ).json()) as { id: string };
    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "turn two", previous_response_id: first.id }),
    });
    const raw = (await res.json()) as Record<string, unknown>;
    expect(raw.previous_response_id).toBe(first.id);
  });

  test("rejects invalid JSON with 400", async () => {
    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing input with 400", async () => {
    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ store: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe("unknown route", () => {
  test("404s", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});

// GET /v1/busy — the scale-to-zero lifecycle signal a host polls before suspending.
// Reports the durable queued-OR-running truth so a host never suspends with work owed.
describe("GET /v1/busy", () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // A chat handler that blocks on `gate` keeps a run in flight deterministically, so the
  // busy transition is observable without racing a fast handler.
  const gatedDeps = makeDeps(async (req) => {
    await gate;
    const last = req.messages.at(-1) as { content: string };
    return textResult(`[delta] ${last.content}`);
  });
  const gatedServer = createServer(new Queue(gatedDeps), gatedDeps.events, 0);
  const gatedBase = `http://localhost:${gatedServer.port}`;
  afterAll(() => {
    release(); // let any in-flight run finish so the process can exit cleanly
    gatedServer.stop();
  });

  const poll = async (want: boolean) => {
    let body = { busy: !want, running: 0, queued: 0 };
    for (let i = 0; i < 100; i++) {
      body = (await (await fetch(`${gatedBase}/v1/busy`)).json()) as typeof body;
      if (body.busy === want) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return body;
  };

  test("an idle daemon reports busy:false with zero counts", async () => {
    const body = await poll(false);
    expect(body).toEqual({ busy: false, running: 0, queued: 0 });
  });

  test("running + queued both hold busy, then it settles to false", async () => {
    const res = await fetch(`${gatedBase}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hold" }),
    });
    expect(res.status).toBe(202); // async: returns immediately, run stays in flight on the gate
    const first = (await res.json()) as { id: string };
    // A second task on the SAME session stays QUEUED behind the gated first (runs are
    // serial within a session) — so this exercises the queued arm of the busy signal,
    // not just running. A host must not suspend while this is pending.
    await fetch(`${gatedBase}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hold-too", previous_response_id: first.id }),
    });
    const busy = await poll(true);
    expect(busy.busy).toBe(true);
    expect(busy.running).toBeGreaterThanOrEqual(1);
    expect(busy.queued).toBeGreaterThanOrEqual(1);
    release();
    const idle = await poll(false);
    expect(idle.busy).toBe(false);
  });
});

// /v1/busy rides the same /v1/ control-token gate as the rest of the seam: a host holds
// the token, an anonymous caller learns nothing about the agent's workload.
describe("GET /v1/busy auth gate", () => {
  const TOKEN = "control-token-under-test";
  const authedDeps = makeDeps(async (req) => {
    const last = req.messages.at(-1) as { content: string };
    return textResult(`[delta] ${last.content}`);
  });
  const authedServer = createServer(new Queue(authedDeps), authedDeps.events, 0, {
    authToken: TOKEN,
  });
  const authedBase = `http://localhost:${authedServer.port}`;
  afterAll(() => authedServer.stop());

  test("401 without a bearer", async () => {
    const res = await fetch(`${authedBase}/v1/busy`);
    expect(res.status).toBe(401);
  });

  test("401 with the wrong bearer", async () => {
    const res = await fetch(`${authedBase}/v1/busy`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(res.status).toBe(401);
  });

  test("200 + the signal with the right bearer", async () => {
    const res = await fetch(`${authedBase}/v1/busy`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ busy: false, running: 0, queued: 0 });
  });

  test("/healthz stays open (no bearer needed)", async () => {
    const res = await fetch(`${authedBase}/healthz`);
    expect(res.status).toBe(200);
  });
});
