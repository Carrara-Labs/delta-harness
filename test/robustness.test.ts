// Sprint 1 (harness v2): wall-clock timeouts, tool-result cap+spill, overflow retry.
// Grounded against REAL behaviour — an actual stalling HTTP server and an actual hanging
// tool — not mocks, so a green run proves the daemon can't be wedged by a stuck provider/tool.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILES } from "../src/profiles";
import { chat, type ModelResult, OVERFLOW, type ProviderConfig } from "../src/provider";
import { Queue } from "../src/queue";
import { capAndSpill, type ToolDef, type Tools } from "../src/tools";
import { makeDeps, textResult, toolCallResult } from "./helpers";

// A server that reproduces the two failure modes a wall-clock timeout must catch:
//  /hang       — accepts the POST and never sends a response (pre-first-byte stall)
//  /stall      — streams ONE SSE delta then holds the socket open forever (mid-stream stall)
const server = Bun.serve({
  port: 0,
  idleTimeout: 30,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p.includes("/hang")) return new Promise<Response>(() => {}); // never resolves
    if (p.includes("/stall")) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
            ),
          );
          // then never enqueue again and never close → a stalled stream
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

function cfg(path: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    baseUrl: `${base}${path}`,
    apiKey: "test",
    models: ["test/model"],
    maxRetries: 0,
    ...over,
  };
}

describe("model-call timeout", () => {
  test("a pre-first-token stall returns a RETRIABLE timeout, not a user cancel", async () => {
    const res = await chat(cfg("/hang", { timeoutMs: 250, streamIdleMs: 0 }), {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/timed out/i);
    expect(res.aborted).toBeFalsy(); // a timeout must NOT be classified as a cancel
    // retriable: no status (network-class) so failover/retry machinery would kick in
    expect(res.status).toBeUndefined();
  });

  test("the idle watchdog kills a mid-stream stall as a TERMINAL (non-retriable) error", async () => {
    let deltas = 0;
    const res = await chat(cfg("/stall", { timeoutMs: 10_000, streamIdleMs: 200 }), {
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {
        deltas++;
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(deltas).toBe(1); // we saw the one delta before the stall
    expect(res.error).toMatch(/stalled after first token/i); // terminal: a retry would double-render
  });

  test("a real caller cancel is reported as aborted, distinct from a timeout", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await chat(cfg("/hang", { timeoutMs: 5000 }), {
      messages: [{ role: "user", content: "hi" }],
      signal: ac.signal,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.aborted).toBe(true);
    expect(res.error).toBe("aborted");
  });
});

describe("codex-review fixes", () => {
  test("#1: once deltas streamed, an in-provider retry/next-model fallthrough is blocked (no double-render)", async () => {
    // A provider that streams one delta then dies with a RETRIABLE error; a second model
    // would answer "second". Without the guard, the consumer would see both.
    let calls = 0;
    const srv = Bun.serve({
      port: 0,
      fetch() {
        calls++;
        const first = calls === 1;
        const enc = new TextEncoder();
        if (first) {
          // Deliver one real delta, then close the connection with an unsatisfied
          // Content-Length → the CLIENT sees a genuine mid-stream network error
          // (matches RETRIABLE via "socket"/"network"), after having rendered "partial".
          const chunk = enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
          );
          const stream = new ReadableStream({
            start(c) {
              c.enqueue(chunk);
              setTimeout(() => c.close(), 50); // close well short of the declared length
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "content-length": String(chunk.length + 500_000),
            },
          });
        }
        const body =
          `data: ${JSON.stringify({ choices: [{ delta: { content: "second" } }] })}\n\n` +
          "data: [DONE]\n\n";
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      let rendered = "";
      const res = await chat(
        {
          baseUrl: `http://localhost:${srv.port}`,
          apiKey: "t",
          models: ["m1", "m2"],
          maxRetries: 2,
          streamIdleMs: 0,
        },
        { messages: [{ role: "user", content: "hi" }], onDelta: (t) => (rendered += t) },
      );
      expect(res.ok).toBe(false); // poisoned → surface the failure, do NOT retry
      expect(rendered).toBe("partial"); // "second" must never reach the consumer
      expect(calls).toBe(1);
    } finally {
      srv.stop(true);
    }
  });

  test("#4: a hostile ../ call id cannot escape the spill dir", async () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-trav-"));
    const out = await capAndSpill("y".repeat(30_000), ws, "run", "../../../../etc/evil", 1_000);
    expect(out).not.toContain("../"); // path is sanitized in the marker
    const escaped = await Bun.file(join(ws, "../../../../etc/evil.txt")).exists();
    expect(escaped).toBe(false); // nothing written outside the spill dir
  });

  test("#9: an Anthropic 413 with request_too_large in error.type (not message) is caught as overflow", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            error: { type: "request_too_large", message: "Request body too large" },
          }),
          { status: 413 },
        );
      },
    });
    try {
      const res = await chat(
        { baseUrl: `http://localhost:${srv.port}`, apiKey: "t", models: ["m"], maxRetries: 0 },
        { messages: [{ role: "user", content: "hi" }] },
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(OVERFLOW.test(res.error)).toBe(true); // error.type surfaced into the message
    } finally {
      srv.stop(true);
    }
  });

  test("#6: a credential mint that never settles is bounded by the model-call timeout", async () => {
    const res = await chat(
      {
        baseUrl: "http://localhost:1",
        apiKey: "t",
        models: ["m"],
        maxRetries: 0,
        timeoutMs: 250,
        streamIdleMs: 0,
        credential: { get: () => new Promise(() => {}) } as never, // hangs forever
      },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/timed out/i);
    expect(res.aborted).toBeFalsy();
  });
});

describe("OVERFLOW detection", () => {
  test("matches the real provider overflow strings across the three wire APIs", () => {
    expect(OVERFLOW.test("prompt is too long: 210000 tokens > 200000 maximum")).toBe(true); // Anthropic
    expect(OVERFLOW.test("This model's maximum context length is 128000 tokens")).toBe(true); // OpenRouter/OpenAI
    expect(OVERFLOW.test("Your input exceeds the context window of this model")).toBe(true); // Responses
    expect(OVERFLOW.test("request_too_large")).toBe(true);
  });
  test("does NOT match a throttle that merely mentions tokens", () => {
    expect(OVERFLOW.test("Too many tokens, please wait and try again")).toBe(false);
    expect(OVERFLOW.test("rate limit exceeded")).toBe(false);
  });
});

describe("capAndSpill", () => {
  const ws = mkdtempSync(join(tmpdir(), "delta-spill-"));

  test("small output passes through untouched", async () => {
    const out = await capAndSpill("short", ws, "run1", "call1", 50_000);
    expect(out).toBe("short");
  });

  test("oversized output is capped, keeps head+tail, and spills the full text to a re-readable file", async () => {
    const big = `START${"x".repeat(80_000)}END`;
    const out = await capAndSpill(big, ws, "run2", "call2", 10_000);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("START"); // head preserved
    expect(out).toContain("END"); // tail preserved (where the answer usually is)
    expect(out).toMatch(/full output saved to .+run2\.call2\.txt/);
    const spill = await Bun.file(join(ws, ".delta/spill/run2.call2.txt")).text();
    expect(spill).toBe(big); // the complete output is recoverable
  });

  test("a [tool error] prefix survives capping so is-error detection still works", async () => {
    const out = await capAndSpill(`[tool error] ${"z".repeat(80_000)}`, ws, "r3", "c3", 5_000);
    expect(out.startsWith("[tool error]")).toBe(true);
  });
});

describe("tool-execution timeout (integration)", () => {
  test("a hanging tool that ignores its signal still returns a clean [tool error] and the run finishes", async () => {
    PROFILES.robust = {
      name: "robust",
      allowed: "*",
      pinned: "*",
      budget: { maxSteps: 20, maxTokens: 400_000, maxCostUsd: 1 },
    };
    const hang: ToolDef = {
      name: "hang",
      description: "never returns; ignores the abort signal",
      parameters: { type: "object", properties: {} },
      idempotent: true,
      execute: () => new Promise<string>(() => {}), // never resolves, never checks ctx.signal
    };
    const tools: Tools = new Map([["hang", hang]]);
    let n = 0;
    const deps = makeDeps(
      async () => (n++ === 0 ? toolCallResult("hang", {}) : textResult("finished")),
      tools,
    );
    deps.toolTimeoutMs = 200; // guillotine the hang after 200ms
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "call the hanging tool", metadata: { profile: "robust" } }).id,
    );
    expect(done.status).toBe("done"); // the run was NOT wedged
    const toolMsgs = (
      deps.db.query("SELECT msg FROM messages WHERE run_id = ?").all(done.id) as { msg: string }[]
    )
      .map((r) => JSON.parse(r.msg))
      .filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => /exceeded 200ms timeout/.test(m.content))).toBe(true);
  });
});

describe("context-overflow retry (integration)", () => {
  test("an overflow error triggers a forced compaction + retry instead of a terminal failure", async () => {
    PROFILES.robust2 = {
      name: "robust2",
      allowed: "*",
      pinned: "*",
      budget: { maxSteps: 20, maxTokens: 400_000, maxCostUsd: 1 },
    };
    let step = 0;
    const chatStub = async (req: { messages: { role: string; content: string | null }[] }) => {
      const sys = req.messages.find((m) => m.role === "system")?.content;
      // The compaction summary call routes through the same provider — answer it as a summary.
      if (typeof sys === "string" && sys.includes("compact an agent's working transcript"))
        return textResult("Goal: g\nProgress: p\nNext: n\nArtifacts: none");
      step++;
      if (step <= 4) return toolCallResult("add", { a: 1, b: 1 }, `c${step}`); // build history
      if (step === 5)
        return {
          ok: false,
          model: "test/model",
          error: "prompt is too long: 210000 tokens > 200000 maximum",
        } as ModelResult;
      return textResult("recovered after compaction");
    };
    const { testTools } = await import("../src/tools");
    const deps = makeDeps(chatStub as never, testTools());
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "do work then overflow", metadata: { profile: "robust2" } }).id,
    );
    expect(done.status).toBe("done"); // recovered, not failed
    const payload = JSON.parse(done.result ?? "{}");
    expect(payload.output_text).toContain("recovered after compaction");
    // proof the overflow path actually compacted: a context-summary message exists
    const msgs = (
      deps.db.query("SELECT msg FROM messages WHERE session_id = ?").all(done.session_id) as {
        msg: string;
      }[]
    ).map((r) => JSON.parse(r.msg));
    expect(
      msgs.some(
        (m) => typeof m.content === "string" && m.content.includes("earlier turns compacted"),
      ),
    ).toBe(true);
  });
});
