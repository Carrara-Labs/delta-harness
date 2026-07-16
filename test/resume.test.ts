// The M1 proof: kill -9 a real daemon mid-run and mid-tool-call, restart it,
// and watch the run complete from the journal — non-idempotent tools never
// silently re-fire. A scripted mock stands in for the model; the daemon, queue,
// SQLite WAL state, and recovery path are all real.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "delta-resume-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Script = (call: number, body: Record<string, unknown>) => Response | Promise<Response>;
let script: Script = () => new Response("unset", { status: 500 });
let modelCalls = 0;
const mock = Bun.serve({
  port: 0,
  fetch: async (req) => {
    modelCalls++;
    return script(modelCalls, (await req.json()) as Record<string, unknown>);
  },
});
afterAll(() => mock.stop());

function sse(...chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const text = (t: string) => sse({ choices: [{ delta: { content: t }, finish_reason: "stop" }] });
const toolCall = (name: string, args: unknown) =>
  sse({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_kill",
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });

function spawnDaemon(dbPath: string, port: number) {
  return Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DELTA_DB: dbPath,
      MODEL_BASE_URL: `http://localhost:${mock.port}/v1`,
      MODEL_API_KEY: "test",
      DELTA_MODEL: "test/model",
      DELTA_TEST_TOOLS: "1",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
}

async function until<T>(fn: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await Bun.sleep(100);
  }
}

async function waitHealthy(port: number) {
  await until(() => true, 1); // yield once
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.ok) return;
    } catch {}
    if (Date.now() - start > 10_000) throw new Error("daemon never became healthy");
    await Bun.sleep(100);
  }
}

describe("kill -9 and resume (real daemon, real WAL)", () => {
  test("mid-tool-call: journal intent survives, non-idempotent tool is not re-fired", async () => {
    const dbPath = join(dir, "a.db");
    const scratch = join(dir, "a-scratch.txt");
    const port = 30000 + Math.floor(Math.random() * 20000);
    modelCalls = 0;
    script = (call) =>
      call === 1
        ? toolCall("slow_append", { path: scratch, line: "SIDE-EFFECT", ms: 8000 })
        : text("recovered after restart");

    let proc = spawnDaemon(dbPath, port);
    await waitHealthy(port);
    fetch(`http://localhost:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "append the line" }),
    }).catch(() => {}); // the daemon dies mid-flight; the socket error is expected

    // Wait until the tool is armed (intent journaled), then kill mid-execution.
    const db = () => new Database(dbPath, { readonly: true });
    await until(() => {
      try {
        return db().query("SELECT 1 AS x FROM journal WHERE status = 'intent'").get() as
          | { x: number }
          | undefined;
      } catch {
        return undefined;
      }
    });
    proc.kill("SIGKILL");
    await proc.exited;
    expect(existsSync(scratch)).toBe(false); // killed mid-sleep, before the side effect

    proc = spawnDaemon(dbPath, port);
    const run = await until(() => {
      const row = db().query("SELECT * FROM runs LIMIT 1").get() as {
        status: string;
        result: string | null;
      };
      return row.status !== "running" && row.status !== "queued" ? row : undefined;
    });
    proc.kill();
    await proc.exited;

    expect(run.status).toBe("done");
    expect(JSON.parse(run.result ?? "{}").output_text).toBe("recovered after restart");
    expect(modelCalls).toBe(2);
    // The non-idempotent tool never re-fired: no side effect, journal holds the synthetic.
    expect(existsSync(scratch)).toBe(false);
    const journal = db()
      .query("SELECT status, result FROM journal WHERE call_id = 'call_kill'")
      .get() as { status: string; result: string };
    expect(journal.status).toBe("done");
    expect(journal.result).toContain("[interrupted]");
  }, 30_000);

  test("mid-model-call: safe re-fire after restart", async () => {
    const dbPath = join(dir, "b.db");
    const port = 30000 + Math.floor(Math.random() * 20000);
    modelCalls = 0;
    script = (call) => {
      if (call === 1) {
        // Stall forever — the daemon dies while streaming.
        return new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return text("clean re-fire");
    };

    let proc = spawnDaemon(dbPath, port);
    await waitHealthy(port);
    fetch(`http://localhost:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    }).catch(() => {});

    await until(() => (modelCalls >= 1 ? true : undefined));
    await Bun.sleep(200); // ensure the daemon is truly mid-stream
    proc.kill("SIGKILL");
    await proc.exited;

    proc = spawnDaemon(dbPath, port);
    const db = new Database(dbPath, { readonly: true });
    const run = await until(() => {
      const row = db.query("SELECT * FROM runs LIMIT 1").get() as {
        status: string;
        result: string | null;
      };
      return row.status !== "running" && row.status !== "queued" ? row : undefined;
    });
    proc.kill();
    await proc.exited;

    expect(run.status).toBe("done");
    expect(JSON.parse(run.result ?? "{}").output_text).toBe("clean re-fire");
    expect(modelCalls).toBe(2);
  }, 30_000);
});
