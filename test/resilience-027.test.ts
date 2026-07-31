import { describe, expect, test } from "bun:test";
import {
  chat,
  chatVia,
  failoverWorthy,
  type ModelResult,
  type ProviderConfig,
  providerErrorClass,
} from "../src/provider";
import { Queue } from "../src/queue";
import { breakerKey, executeRun, parseToolArgs, toolErrorClass } from "../src/run";
import type { ToolDef, Tools } from "../src/tools";
import { makeDeps, textResult, usage1 } from "./helpers";

const tool = (name: string, execute: ToolDef["execute"]): ToolDef => ({
  name,
  description: name,
  parameters: { type: "object" },
  idempotent: true,
  execute,
});

const capped = (
  calls: NonNullable<Extract<ModelResult, { ok: true }>["message"]["tool_calls"]>,
  finishReason = "length",
): ModelResult => ({
  ok: true,
  model: "test/model",
  message: { role: "assistant", content: null, tool_calls: calls },
  finishReason,
  usage: { ...usage1 },
  latencyMs: 1,
});

describe("0.2.7 output-cap guard", () => {
  test("parseable capped calls, including a parallel batch, are persisted but never executed", async () => {
    let executed = 0;
    const tools: Tools = new Map([
      ["a", tool("a", async () => `${++executed}`)],
      ["b", tool("b", async () => `${++executed}`)],
    ]);
    let turn = 0;
    const deps = makeDeps(
      async () =>
        turn++ === 0
          ? capped([
              { id: "ca", type: "function", function: { name: "a", arguments: '{"x":1}' } },
              { id: "cb", type: "function", function: { name: "b", arguments: '{"x":2}' } },
            ])
          : textResult("done"),
      tools,
    );
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "go" }).id);

    expect(done.status).toBe("done");
    expect(executed).toBe(0);
    const journal = deps.db
      .query("SELECT call_id, status, result FROM journal ORDER BY call_id")
      .all() as { call_id: string; status: string; result: string }[];
    expect(journal.map((r) => [r.call_id, r.status])).toEqual([
      ["ca", "done"],
      ["cb", "done"],
    ]);
    expect(journal.every((r) => r.result.includes("Reissue a smaller/chunked call"))).toBe(true);
    expect(toolErrorClass(journal[0]?.result ?? "")).toBe("tool_args_truncated");
    expect(breakerKey(journal[0]?.result ?? "")).toBeNull();
  });

  test("resume sees capped calls as answered and never fires them", async () => {
    let executed = 0;
    const tools: Tools = new Map([["mutate", tool("mutate", async () => `${++executed}`)]]);
    let turn = 0;
    const deps = makeDeps(
      async () =>
        turn++ === 0
          ? capped([
              {
                id: "capped",
                type: "function",
                function: { name: "mutate", arguments: '{"sideEffect":true}' },
              },
            ])
          : textResult("done"),
      tools,
    );
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "go" }).id);
    deps.db
      .query("DELETE FROM messages WHERE id = (SELECT max(id) FROM messages WHERE run_id = ?)")
      .run(done.id);
    deps.db
      .query(
        "UPDATE runs SET status='running', result=NULL, error=NULL, finished_at=NULL WHERE id=?",
      )
      .run(done.id);

    const resumed = await executeRun(deps, done.id, { resuming: true });
    expect(resumed.status).toBe("done");
    expect(executed).toBe(0);
  });
});

describe("0.2.7 bounded argument repair", () => {
  test("repairs literal controls and trailing commas in one pass", () => {
    const parsed = parseToolArgs('{"text":"a\nb","items":[1,2,],}');
    expect(parsed).toEqual({ args: { text: "a\nb", items: [1, 2] }, repaired: true });
  });

  test("does not close braces, repair over 64K, or accept non-object JSON", () => {
    expect(parseToolArgs('{"x":1').args).toBeUndefined();
    expect(parseToolArgs(`{"x":"${"a".repeat(64_001)}`).args).toBeUndefined();
    expect(parseToolArgs("[]").args).toBeUndefined();
    expect(parseToolArgs("null").args).toBeUndefined();
  });

  test("invalid JSON is a tool-error value and never executes", async () => {
    let executed = 0;
    let turn = 0;
    const deps = makeDeps(
      async () =>
        turn++ === 0
          ? capped(
              [
                {
                  id: "bad",
                  type: "function",
                  function: { name: "mutate", arguments: '{"x":' },
                },
              ],
              "tool_calls",
            )
          : textResult("recovered"),
      new Map([["mutate", tool("mutate", async () => `${++executed}`)]]),
    );
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "go" }).id);
    const row = deps.db.query("SELECT result FROM journal WHERE call_id='bad'").get() as {
      result: string;
    };
    expect(done.status).toBe("done");
    expect(executed).toBe(0);
    expect(row.result).toContain("arguments failed to parse");
    expect(toolErrorClass(row.result)).toBe("tool_args_invalid");
    expect(breakerKey(row.result)).toBeNull();
  });
});

describe("0.2.7 provider classification", () => {
  test("uses narrow precedence and drives failover eligibility", () => {
    expect(providerErrorClass(429, "content_filter triggered")).toBe("moderation");
    expect(providerErrorClass(429, "insufficient_quota")).toBe("quota");
    expect(providerErrorClass(403, "forbidden")).toBe("auth");
    expect(providerErrorClass(503, "down")).toBe("transient");
    expect(providerErrorClass(400, "policy document is malformed")).toBe("request");
    expect(
      failoverWorthy({ ok: false, model: "m", status: 429, error: "insufficient_quota" }),
    ).toBe(true);
    expect(failoverWorthy({ ok: false, model: "m", status: 429, error: "content_filter" })).toBe(
      false,
    );
  });

  test("quota skips retries/models and fails over; moderation is terminal", async () => {
    let mode: "quota" | "moderation" = "quota";
    let primary = 0;
    let backup = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes("backup.test")) {
        backup++;
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      primary++;
      return Response.json(
        { error: { message: mode === "quota" ? "quota exceeded" : "content_filter" } },
        { status: 429 },
      );
    }) as unknown as typeof fetch;
    const cfg = (path: string): ProviderConfig => ({
      baseUrl: `https://${path}.test/v1`,
      apiKey: "x",
      models: ["a", "b"],
      maxRetries: 2,
    });
    try {
      const quota = await chatVia([cfg("primary"), cfg("backup")], {
        messages: [{ role: "user", content: "hi" }],
      });
      expect(quota.ok).toBe(true);
      expect(primary).toBe(1);
      expect(backup).toBe(1);

      mode = "moderation";
      primary = 0;
      backup = 0;
      const moderation = await chatVia([cfg("primary"), cfg("backup")], {
        messages: [{ role: "user", content: "hi" }],
      });
      expect(moderation.ok).toBe(false);
      expect(primary).toBe(1);
      expect(backup).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retry and terminal telemetry carry the same provider classes", async () => {
    const retryDeps = makeDeps(async (req) => {
      req.onRetry?.({
        kind: "retry",
        model: "m",
        attempt: 1,
        status: 503,
        error: "overloaded",
        nextDelayMs: 1,
      });
      return textResult("done");
    });
    const retryQueue = new Queue(retryDeps);
    await retryQueue.wait(retryQueue.enqueue({ input: "go" }).id);
    const retry = retryDeps.db.query("SELECT data FROM events WHERE type='model.retry'").get() as {
      data: string;
    };
    expect(JSON.parse(retry.data)["error.class"]).toBe("transient");

    const terminalDeps = makeDeps(async () => ({
      ok: false,
      model: "m",
      status: 400,
      error: "content_filter",
    }));
    const terminalQueue = new Queue(terminalDeps);
    await terminalQueue.wait(terminalQueue.enqueue({ input: "go" }).id);
    const terminal = terminalDeps.db
      .query("SELECT data FROM events WHERE type='error' ORDER BY id DESC LIMIT 1")
      .get() as { data: string };
    expect(JSON.parse(terminal.data)["error.class"]).toBe("moderation");
  });
});

describe("Responses incomplete metadata", () => {
  test("max_output_tokens reaches the run guard", async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      const events =
        calls === 1
          ? [
              {
                type: "response.output_item.added",
                item: { type: "function_call", id: "item", call_id: "rc", name: "mutate" },
              },
              {
                type: "response.function_call_arguments.delta",
                item_id: "item",
                delta: '{"x":1}',
              },
              {
                type: "response.incomplete",
                response: {
                  incomplete_details: { reason: "max_output_tokens" },
                  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
                },
              },
            ]
          : [
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: {} } },
            ];
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    let executed = 0;
    const cfg: ProviderConfig = {
      baseUrl: "https://responses.test/v1",
      apiKey: "x",
      models: ["m"],
      api: "responses",
      maxRetries: 0,
    };
    try {
      const deps = makeDeps(
        (req) => chat(cfg, req),
        new Map([["mutate", tool("mutate", async () => `${++executed}`)]]),
      );
      const queue = new Queue(deps);
      const done = await queue.wait(queue.enqueue({ input: "go" }).id);
      expect(done.status).toBe("done");
      expect(executed).toBe(0);
      const journal = deps.db.query("SELECT result FROM journal WHERE call_id='rc'").get() as {
        result: string;
      };
      expect(journal.result).toContain("max_output_tokens");
      const event = deps.db
        .query("SELECT data FROM events WHERE type='model.call' ORDER BY id LIMIT 1")
        .get() as { data: string };
      expect(JSON.parse(event.data)["gen_ai.response.finish_reasons"]).toEqual([
        "max_output_tokens",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
