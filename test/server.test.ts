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
