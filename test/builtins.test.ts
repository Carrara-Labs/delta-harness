import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools, chargeReportedUsage, parseReportedUsage } from "../src/builtins";
import type { Usage } from "../src/provider";
import type { ToolCtx } from "../src/tools";

const ws = mkdtempSync(join(tmpdir(), "delta-ws-"));
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const tools = builtinTools({
  workspace: ws,
  codeCli: ["echo"],
  selfCmd: ["bun", join(import.meta.dir, "..", "src", "index.ts")],
  subagentDepth: 0,
  fetchAllowPrivate: true,
});
const ctx: ToolCtx = { workspace: ws, activate: () => {} };

const run = (name: string, args: Record<string, unknown>) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(args, ctx);
};

describe("workspace file tools", () => {
  test("write → read → list roundtrip", async () => {
    expect(await run("write_file", { path: "memos/hello.md", content: "# hi\n" })).toContain(
      "wrote 5 chars",
    );
    expect(await run("read_file", { path: "memos/hello.md" })).toBe("# hi\n");
    expect(await run("list_dir", {})).toBe("memos/hello.md");
  });

  test("paths cannot escape the workspace", async () => {
    const rel = await run("write_file", { path: "../evil.txt", content: "x" }).catch((e) =>
      String(e),
    );
    expect(String(rel)).toContain("escapes the workspace");
    const abs = await run("read_file", { path: "/etc/passwd" }).catch((e) => String(e));
    expect(String(abs)).toContain("escapes the workspace");
  });
});

describe("web tools", () => {
  test("web_fetch strips HTML to text", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          "<html><head><style>.x{}</style></head><body><h1>Title</h1><p>Body &amp; soul</p><script>evil()</script></body></html>",
          {
            headers: { "content-type": "text/html" },
          },
        ),
    });
    const text = await run("web_fetch", { url: `http://localhost:${server.port}/` });
    server.stop();
    expect(text).toContain("Title");
    expect(text).toContain("Body & soul");
    expect(text).not.toContain("evil()");
    expect(text).not.toContain(".x{}");
  });

  test("web_search without a key is an error value, not a throw", async () => {
    expect(await run("web_search", { query: "anything" })).toContain("not configured");
  });
});

describe("code delegation", () => {
  test("runs the CLI with the task appended, in the workspace", async () => {
    expect(await run("code", { task: "build the thing" })).toBe("build the thing");
  });

  test("non-zero exit becomes an error value", async () => {
    const failing = builtinTools({
      workspace: ws,
      codeCli: ["false"],
      selfCmd: ["true"],
      subagentDepth: 0,
    });
    const tool = failing.get("code");
    expect(await tool?.execute({ task: "x" }, ctx)).toContain("[tool error] code CLI exited 1");
  });
});

describe("spawn_subagent", () => {
  test("usage report parsing is strict and fail-open", () => {
    const usage: Usage = {
      input: 11,
      output: 3,
      cacheRead: 4,
      cacheWrite: 2,
      total: 14,
      costUsd: 0.01,
    };
    expect(parseReportedUsage(`noise\nDELTA_USAGE ${JSON.stringify(usage)}\nmore`)).toEqual(usage);
    expect(parseReportedUsage("DELTA_USAGE not-json")).toBeNull();
    expect(parseReportedUsage("ordinary child stderr")).toBeNull();
    const charged: Usage[] = [];
    const capture = { ...ctx, chargeUsage: (value: Usage) => charged.push(value) };
    chargeReportedUsage(`DELTA_USAGE ${JSON.stringify(usage)}`, capture);
    chargeReportedUsage("DELTA_USAGE garbled", capture);
    chargeReportedUsage("no report", capture);
    expect(charged).toEqual([usage]);
  });

  test("depth cap: no subagent tool inside a subagent", () => {
    const child = builtinTools({
      workspace: ws,
      codeCli: ["echo"],
      selfCmd: ["x"],
      subagentDepth: 1,
    });
    expect(child.has("spawn_subagent")).toBe(false);
    expect(tools.has("spawn_subagent")).toBe(true);
  });

  test("oneshot child runs a real loop against a mock model and reports back", async () => {
    const mock = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "SUBAGENT DONE" }, finish_reason: "stop" }] })}\n\n` +
            // A usage chunk (include_usage) so the child reports real spend to charge back.
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })}\n\n` +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const withEnv = builtinTools({
      workspace: ws,
      codeCli: ["echo"],
      selfCmd: ["bun", join(import.meta.dir, "..", "src", "index.ts")],
      subagentDepth: 0,
    });
    process.env.MODEL_BASE_URL = `http://localhost:${mock.port}/v1`;
    process.env.MODEL_API_KEY = "test";
    process.env.DELTA_MODEL = "test/model";
    const charged: Usage[] = [];
    try {
      const out = await withEnv
        .get("spawn_subagent")
        ?.execute(
          { task: "do a side quest" },
          { ...ctx, chargeUsage: (usage) => charged.push(usage) },
        );
      expect(out).toBe("SUBAGENT DONE");
      expect(charged).toHaveLength(1);
      expect(charged[0]?.total).toBeGreaterThan(0);
    } finally {
      delete process.env.MODEL_BASE_URL;
      delete process.env.MODEL_API_KEY;
      delete process.env.DELTA_MODEL;
      mock.stop();
    }
  }, 20_000);
});
