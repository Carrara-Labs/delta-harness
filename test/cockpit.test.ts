import { afterAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devConfigView, loadConfig } from "../src/config";
import { Queue } from "../src/queue";
import { createServer, redactSecrets } from "../src/server";
import type { ToolDef } from "../src/tools";
import { makeDeps, ok, textResult } from "./helpers";

// An echo tool that records whatever args it was called with — used to prove the
// journal redactor scrubs a secret the model happened to pass in a tool call.
const echo: ToolDef = {
  name: "echo",
  description: "echo",
  parameters: {},
  idempotent: true,
  execute: async (args) => JSON.stringify(args),
};

// A workspace on disk for the /files sandbox tests.
const ws = mkdtempSync(join(tmpdir(), "delta-cockpit-"));
mkdirSync(join(ws, "sub"), { recursive: true });
// Daemon state dir at the workspace root (as `delta dev` places it) — must be hidden.
mkdirSync(join(ws, ".delta"), { recursive: true });
writeFileSync(join(ws, ".delta", "delta.db"), "SQLITE");
writeFileSync(join(ws, "notes.txt"), "hello workspace");
writeFileSync(join(ws, "sub", "nested.md"), "# nested");
writeFileSync(join(ws, "DELTA.md"), "# persona");
writeFileSync(join(ws, "secret-outside-target"), "should never be served");
// A real PNG (magic bytes) the agent "saved", and an HTML file it could have authored —
// the raw path must render the former inline and neutralize the latter.
writeFileSync(
  join(ws, "shot.png"),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]),
);
writeFileSync(join(ws, "evil.html"), "<script>alert(document.domain)</script>");
writeFileSync(join(ws, "delta.env"), "OPENROUTER_API_KEY=sk-must-never-be-served");
// A symlink pointing outside the workspace — realpath containment must reject it.
const outside = mkdtempSync(join(tmpdir(), "delta-outside-"));
writeFileSync(join(outside, "leak.txt"), "SENSITIVE");
symlinkSync(join(outside, "leak.txt"), join(ws, "link-to-leak"));
// A HARD link (same inode) to the env file under an innocent name — the basename check
// can't see it, so the nlink guard must (codex P1). Both names now have nlink=2.
linkSync(join(ws, "delta.env"), join(ws, "innocent-hardlink.txt"));

// One turn: first model call requests the echo tool with a secret arg, second returns text.
let call = 0;
const deps = makeDeps(
  async () => {
    call++;
    if (call % 2 === 1)
      return ok({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "echo", arguments: JSON.stringify({ authToken: "SEKRET", q: "hi" }) },
          },
        ],
      });
    return textResult("done");
  },
  new Map([["echo", echo]]),
);

const config = {
  version: "1.2.3",
  agent_id: "test-agent",
  model: { model: "anthropic/claude-sonnet-5", base_url: "https://openrouter.ai/api/v1" },
  secrets_present: { MODEL_API_KEY: true, DELTA_INSPECT_TOKEN: false },
  tools: { mcp: ["ashby__search"], builtin: ["web_search"] },
};

const queue = new Queue(deps);
const server = createServer(queue, deps.events, 0, {
  workspace: ws,
  db: deps.db,
  config,
  operatorFiles: ["DELTA.md"],
  cockpitHtml: "<!doctype html><title>t</title>REAL_COCKPIT",
  inspectWrite: true,
});
const base = `http://localhost:${server.port}`;
afterAll(() => {
  server.stop();
});

// Drive one real run so runs/journal/messages/events tables are populated.
async function seedRun(input = "screen the applicant"): Promise<string> {
  const run = queue.enqueue({ input, metadata: { authToken: "RUN-SECRET-abc" } });
  await queue.wait(run.id);
  return run.id;
}

describe("GET /dev — public, inert", () => {
  test("serves the embedded HTML without auth and carries no secret", async () => {
    const res = await fetch(`${base}/dev`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("REAL_COCKPIT");
    expect(html).not.toContain("SEKRET");
  });
});

describe("GET /v1/dev/config", () => {
  test("open on loopback with no inspect token; returns the allowlisted view", async () => {
    const res = await fetch(`${base}/v1/dev/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof config;
    expect(body.agent_id).toBe("test-agent");
    expect(body.secrets_present.MODEL_API_KEY).toBe(true);
    // The whole serialized config must contain no secret VALUE, only presence booleans.
    expect(JSON.stringify(body)).not.toMatch(/sk-|SEKRET|RUN-SECRET/);
  });
});

describe("DELTA_INSPECT_TOKEN gate", () => {
  const tokened = createServer(new Queue(deps), deps.events, 0, {
    db: deps.db,
    config,
    inspectToken: "s3cr3t-inspect",
  });
  const tbase = `http://localhost:${tokened.port}`;
  afterAll(() => tokened.stop());

  test("401 without the bearer", async () => {
    expect((await fetch(`${tbase}/v1/dev/config`)).status).toBe(401);
  });
  test("401 with a wrong bearer", async () => {
    const res = await fetch(`${tbase}/v1/dev/config`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });
  test("200 with the right bearer", async () => {
    const res = await fetch(`${tbase}/v1/dev/config`, {
      headers: { authorization: "Bearer s3cr3t-inspect" },
    });
    expect(res.status).toBe(200);
  });
  test("the inert /dev page is served even with a token set (no auth)", async () => {
    expect((await fetch(`${tbase}/dev`)).status).toBe(200);
  });
});

describe("GET /v1/dev/runs — safe projection", () => {
  test("lists runs with safe columns only; never leaks request/authToken/result", async () => {
    await seedRun("triage the newest applicant");
    const res = await fetch(`${base}/v1/dev/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Record<string, unknown>[] };
    expect(body.runs.length).toBeGreaterThan(0);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("RUN-SECRET"); // metadata.authToken from the request
    expect(raw).not.toContain("authToken");
    const r0 = body.runs[0] as Record<string, unknown>;
    expect(r0).not.toHaveProperty("request");
    expect(r0).not.toHaveProperty("result"); // result column is read but never echoed raw
    expect(r0.model).toBe("test/model"); // lifted from the result payload
    expect(r0).toHaveProperty("last_input_preview");
    expect(r0).toHaveProperty("tokens");
    expect(r0).toHaveProperty("cost_usd");
  });

  test("detail returns the journal (secret args redacted) + transcript", async () => {
    const id = await seedRun("do a tool call");
    const res = await fetch(`${base}/v1/dev/runs/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      journal: { tool: string; args: Record<string, unknown> }[];
      transcript: { role: string }[];
    };
    const echoCall = body.journal.find((j) => j.tool === "echo");
    expect(echoCall).toBeDefined();
    expect(echoCall?.args.q).toBe("hi");
    expect(echoCall?.args.authToken).toBe("[redacted]"); // the secret the model passed
    expect(JSON.stringify(body)).not.toContain("SEKRET");
    expect(body.transcript.some((m) => m.role === "user")).toBe(true);
    expect(body.transcript.some((m) => m.role === "assistant")).toBe(true);
  });

  test("404 on an unknown run id", async () => {
    expect((await fetch(`${base}/v1/dev/runs/nope`)).status).toBe(404);
  });
});

describe("GET /v1/dev/files — realpath sandbox", () => {
  test("lists the workspace root", async () => {
    const res = await fetch(`${base}/v1/dev/files?path=workspace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; entries: { name: string }[] };
    expect(body.type).toBe("dir");
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("notes.txt");
    expect(names).toContain("sub");
    expect(names).not.toContain("link-to-leak"); // symlink entries are skipped
    expect(names).not.toContain(".delta"); // daemon state dir hidden from the workspace view
  });

  test("reads a text file", async () => {
    const res = await fetch(`${base}/v1/dev/files?path=workspace/notes.txt`);
    const body = (await res.json()) as { type: string; content: string };
    expect(body.type).toBe("file");
    expect(body.content).toBe("hello workspace");
  });

  test("reads a nested file", async () => {
    const res = await fetch(`${base}/v1/dev/files?path=workspace/sub/nested.md`);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe("# nested");
  });

  test("operator namespace serves only allowlisted names", async () => {
    const okRes = await fetch(`${base}/v1/dev/files?path=operator/DELTA.md`);
    expect(okRes.status).toBe(200);
    expect(((await okRes.json()) as { content: string }).content).toBe("# persona");
    // Not on the allowlist → 403, even though the file exists in the workspace.
    const bad = await fetch(`${base}/v1/dev/files?path=operator/secret-outside-target`);
    expect(bad.status).toBe(403);
  });

  test("rejects .. traversal, absolute paths, and unknown namespaces", async () => {
    expect((await fetch(`${base}/v1/dev/files?path=workspace/../../etc/passwd`)).status).toBe(403);
    expect((await fetch(`${base}/v1/dev/files?path=nonsense/x`)).status).toBe(400);
  });

  test("rejects a symlink that escapes the workspace", async () => {
    const res = await fetch(`${base}/v1/dev/files?path=workspace/link-to-leak`);
    expect(res.status).toBe(403);
  });

  test("refuses to READ a hard-linked file (can't leak delta.env under an alias)", async () => {
    const res = await fetch(`${base}/v1/dev/files?path=workspace/innocent-hardlink.txt`);
    expect(res.status).toBe(403);
  });

  test("never serves a credential env file, and hides it from the listing", async () => {
    // The workspace root IS the project dir under `delta dev`, so delta.env with API
    // keys sits here — it must be 403 on read and absent from the directory listing.
    const read = await fetch(`${base}/v1/dev/files?path=workspace/delta.env`);
    expect(read.status).toBe(403);
    const list = (await (await fetch(`${base}/v1/dev/files?path=workspace`)).json()) as {
      entries: { name: string }[];
    };
    expect(list.entries.map((e) => e.name)).not.toContain("delta.env");
  });
});

describe("GET /v1/dev/files?raw=1 — inline previews, hardened", () => {
  test("a binary's JSON meta carries its mime but never the bytes", async () => {
    const body = (await (await fetch(`${base}/v1/dev/files?path=workspace/shot.png`)).json()) as {
      binary?: boolean;
      mime?: string;
      content?: string;
    };
    expect(body.binary).toBe(true);
    expect(body.mime).toBe("image/png");
    expect(body.content).toBeUndefined();
  });

  test("raw serves an image inline with its real content-type + nosniff", async () => {
    const res = await fetch(`${base}/v1/dev/files?path=workspace/shot.png&raw=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())[0]).toBe(0x89); // real bytes
  });

  test("raw neutralizes agent-authored HTML — inert octet-stream download, never text/html", async () => {
    const res = await fetch(`${base}/v1/dev/files?path=workspace/evil.html&raw=1`);
    expect(res.status).toBe(200);
    // The single most important assertion: nothing agent-authored comes back with a
    // script-executing content-type in the Cockpit's own origin.
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("raw still refuses a credential env file and a directory", async () => {
    expect((await fetch(`${base}/v1/dev/files?path=workspace/delta.env&raw=1`)).status).toBe(403);
    expect((await fetch(`${base}/v1/dev/files?path=workspace&raw=1`)).status).toBe(400);
  });
});

describe("GET /v1/dev/stream — replay + envelope", () => {
  test("backfills persisted events for a run with the full envelope; live=0 closes", async () => {
    const id = await seedRun("stream me");
    const res = await fetch(`${base}/v1/dev/stream?run=${id}&since=0&live=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text(); // live=0 → stream ends, so this resolves
    // Every data frame is the envelope with id/run_id/type.
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)) as Record<string, unknown>);
    expect(dataLines.length).toBeGreaterThan(0);
    for (const f of dataLines) {
      expect(f).toHaveProperty("id");
      expect(f).toHaveProperty("type");
      expect(f.run_id).toBe(id);
    }
    // The run lifecycle is present.
    expect(dataLines.some((f) => f.type === "run.finished")).toBe(true);
  });

  test("since=<high> filters out already-seen events", async () => {
    const id = await seedRun("since filter");
    const hi = (deps.db.query("SELECT max(id) AS h FROM events").get() as { h: number }).h;
    const res = await fetch(`${base}/v1/dev/stream?run=${id}&since=${hi}&live=0`);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
    expect(dataLines.length).toBe(0); // nothing after the high-water mark
  });

  test("per-run filter never leaks another run's events", async () => {
    const a = await seedRun("run A");
    const b = await seedRun("run B");
    const res = await fetch(`${base}/v1/dev/stream?run=${a}&since=0&live=0`);
    const text = await res.text();
    const frames = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)) as { run_id: string });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.run_id === a)).toBe(true);
    expect(frames.some((f) => f.run_id === b)).toBe(false);
  });
});

describe("devConfigView — allowlist, no secret values", () => {
  test("emits presence booleans, never a credential value, and strips MCP URLs", () => {
    // A workspace where DELTA.md + POLICY.md exist but vocab.json does NOT — so
    // operator_files must list only the real, on-disk two (never a phantom that 404s).
    const cfgWs = mkdtempSync(join(tmpdir(), "delta-cfg-"));
    writeFileSync(join(cfgWs, "DELTA.md"), "# persona");
    writeFileSync(join(cfgWs, "POLICY.md"), "# policy");
    const env = {
      MODEL_API_KEY: "sk-super-secret-value",
      DELTA_INSPECT_TOKEN: "inspect-secret",
      DELTA_CONTROL_TOKEN: "control-secret",
      DELTA_WORKSPACE: cfgWs,
      DELTA_MCP_SERVERS: JSON.stringify([
        {
          name: "kb",
          transport: "http",
          url: "https://kb.example/mcp",
          headers: { authorization: "Bearer H" },
        },
      ]),
      // A credential smuggled into the base URL's userinfo + query must not surface.
      MODEL_BASE_URL: "https://user:sk-url-secret@gateway.example/api/v1?sig=sk-query-secret",
      DELTA_AGENT_ID: "aperture",
    };
    const cfg = loadConfig(env);
    const view = devConfigView(cfg, ["web_search", "kb__search_text"], env);
    const raw = JSON.stringify(view);
    // No secret VALUE anywhere in the serialized view.
    expect(raw).not.toContain("sk-super-secret-value");
    expect(raw).not.toContain("inspect-secret");
    expect(raw).not.toContain("control-secret");
    expect(raw).not.toContain("Bearer H"); // MCP header stripped
    expect(raw).not.toContain("kb.example"); // MCP URL stripped
    expect(raw).not.toContain("sk-url-secret"); // base_url userinfo stripped
    expect(raw).not.toContain("sk-query-secret"); // base_url query stripped
    expect((view.model as { base_url: string }).base_url).toBe("https://gateway.example");
    // Presence booleans, not values.
    const sp = view.secrets_present as Record<string, boolean>;
    expect(sp.MODEL_API_KEY).toBe(true);
    expect(sp.DELTA_INSPECT_TOKEN).toBe(true);
    // Safe fields present.
    expect(view.agent_id).toBe("aperture");
    expect((view.tools as { mcp: string[]; builtin: string[] }).mcp).toEqual(["kb__search_text"]);
    expect((view.tools as { builtin: string[] }).builtin).toEqual(["web_search"]);
    expect((view.mcp_servers as { name: string; transport: string }[])[0]).toEqual({
      name: "kb",
      transport: "http",
    });
    // Only the bundle files that exist on disk — phantom vocab.json (not present) is
    // filtered, so the Cockpit never pins a ★ that 404s.
    expect(view.operator_files).toEqual(["DELTA.md", "POLICY.md"]);
  });
});

describe("GET /v1/dev/runs/:id/calls — true-to-life per-call capture", () => {
  test("captures the assembled request (system spine + messages + tools) + response", async () => {
    const d = makeDeps(async () => textResult("captured answer"));
    d.captureCalls = true;
    d.agentId = "cap-agent";
    const q = new Queue(d);
    const s = createServer(q, d.events, 0, { db: d.db });
    const sb = `http://localhost:${s.port}`;
    const run = q.enqueue({ input: "hello capture", metadata: { authToken: "CALL-SECRET-xyz" } });
    await q.wait(run.id);
    const { calls } = (await (await fetch(`${sb}/v1/dev/runs/${run.id}/calls`)).json()) as {
      calls: {
        turn: number;
        request: { messages: { role: string; content: string }[]; tools: unknown[] };
        response: { message: { content: string } };
      }[];
    };
    expect(calls.length).toBeGreaterThan(0);
    const c0 = calls[0];
    if (!c0) throw new Error("unreachable");
    expect(c0.request.messages[0]?.role).toBe("system"); // the spine leads the input
    expect(
      c0.request.messages.some(
        (m) => m.role === "user" && (m.content || "").includes("hello capture"),
      ),
    ).toBe(true);
    expect(Array.isArray(c0.request.tools)).toBe(true);
    expect(c0.response.message.content).toContain("captured answer");
    // The run request's metadata.authToken must NOT leak through the calls view either.
    expect(JSON.stringify(calls)).not.toContain("CALL-SECRET-xyz");
    s.stop();
  });

  test("empty when capture is disabled (no DELTA_CAPTURE_CALLS)", async () => {
    const id = await seedRun("no capture here");
    const { calls } = (await (await fetch(`${base}/v1/dev/runs/${id}/calls`)).json()) as {
      calls: unknown[];
    };
    expect(calls.length).toBe(0);
  });
});

describe("recall provenance", () => {
  test("a run that recalls a learning emits a `recall` event with the item", async () => {
    // Seed an agent-audience memory the run's input will match, then drive a fresh run.
    deps.db
      .query(
        `INSERT INTO memory (namespace, agent_id, audience, artifact_kind, content, created_at, confidence, hash, source)
         VALUES ('default','','agent','pitfall',?,?,0.9,'h-recall','review')`,
      )
      .run("Always deploy with the release CLI, never git push", Date.now());
    const run = queue.enqueue({ input: "how should I deploy the harness?" });
    await queue.wait(run.id);
    const ev = deps.db
      .query("SELECT data FROM events WHERE run_id = ? AND type = 'recall'")
      .get(run.id) as { data: string } | null;
    expect(ev).toBeTruthy();
    const data = JSON.parse((ev as { data: string }).data) as {
      count: number;
      items: { kind: string; audience: string; content: string }[];
    };
    expect(data.count).toBeGreaterThan(0);
    expect(data.items.some((i) => i.content.includes("the release CLI"))).toBe(true);
    expect(data.items[0]?.audience).toBe("agent");
  });

  test("a secret in a recalled learning is scrubbed before the (persisted, exported) event", async () => {
    deps.db
      .query(
        `INSERT INTO memory (namespace, agent_id, audience, artifact_kind, content, created_at, confidence, hash, source)
         VALUES ('default','','agent','fact',?,?,0.9,'h-secret-recall','review')`,
      )
      .run("the deploy key is sk-abcdef0123456789LEAK do not share", Date.now());
    const run = queue.enqueue({ input: "what is the deploy key?" });
    await queue.wait(run.id);
    const ev = deps.db
      .query("SELECT data FROM events WHERE run_id = ? AND type = 'recall'")
      .get(run.id) as { data: string } | null;
    expect(ev).toBeTruthy();
    expect((ev as { data: string }).data).not.toContain("sk-abcdef0123456789LEAK");
    expect((ev as { data: string }).data).toContain("[redacted]");
  });
});

describe("DELTA_INSPECT=off kill-switch", () => {
  const offServer = createServer(new Queue(deps), deps.events, 0, {
    db: deps.db,
    config,
    cockpitHtml: "x",
    inspectDisabled: true,
  });
  const ob = `http://localhost:${offServer.port}`;
  afterAll(() => offServer.stop());

  test("/dev and /v1/dev/* both 404 as if not compiled in", async () => {
    expect((await fetch(`${ob}/dev`)).status).toBe(404);
    expect((await fetch(`${ob}/v1/dev/config`)).status).toBe(404);
    expect((await fetch(`${ob}/v1/dev/runs`)).status).toBe(404);
    // The seam itself still works.
    expect((await fetch(`${ob}/healthz`)).status).toBe(200);
  });

  test("stays a uniform 404 even behind a control token (doesn't fall to a 401)", async () => {
    const s = createServer(new Queue(deps), deps.events, 0, {
      db: deps.db,
      config,
      inspectDisabled: true,
      authToken: "ctl", // a control-token daemon must still 404 /v1/dev/*, not 401
    });
    expect((await fetch(`http://localhost:${s.port}/v1/dev/config`)).status).toBe(404);
    s.stop();
  });
});

describe("PUT /v1/dev/files — write-through editing (opt-in)", () => {
  test("editing DELTA.md routes through writeSelf (snapshotted, next-run); workspace file restart-to-apply", async () => {
    // DELTA.md is the self-file — a Cockpit edit goes through writeSelf (codex #20), so it
    // is snapshotted + size-checked and takes effect on the NEXT run, not on restart.
    const put = await fetch(`${base}/v1/dev/files?path=operator/DELTA.md`, {
      method: "PUT",
      body: "# edited persona",
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { ok: boolean; note: string };
    expect(body.ok).toBe(true);
    expect(body.note).toContain("next run");
    // Read it back through the read endpoint.
    const read = (await (await fetch(`${base}/v1/dev/files?path=operator/DELTA.md`)).json()) as {
      content: string;
    };
    expect(read.content).toBe("# edited persona");
    // …and that edit produced a revision, reachable via the self-revisions endpoint.
    const revs = (await (await fetch(`${base}/v1/dev/self/revisions`)).json()) as {
      current: string;
      revisions: { id: number }[];
    };
    expect(revs.current).toBe("# edited persona");
    // A brand-new workspace file.
    const nw = await fetch(`${base}/v1/dev/files?path=workspace/created.txt`, {
      method: "PUT",
      body: "fresh",
    });
    expect(nw.status).toBe(200);
    const back = (await (
      await fetch(`${base}/v1/dev/files?path=workspace/created.txt`)
    ).json()) as {
      content: string;
    };
    expect(back.content).toBe("fresh");
  });

  test("self-revert restores a prior DELTA.md version (POST /v1/dev/self/revert is reachable)", async () => {
    await fetch(`${base}/v1/dev/files?path=operator/DELTA.md`, {
      method: "PUT",
      body: "version ONE",
    });
    await fetch(`${base}/v1/dev/files?path=operator/DELTA.md`, {
      method: "PUT",
      body: "version TWO",
    });
    const revs = (await (await fetch(`${base}/v1/dev/self/revisions`)).json()) as {
      revisions: { id: number; preview: string }[];
    };
    const one = revs.revisions.find((r) => r.preview.includes("version ONE"));
    expect(one).toBeTruthy();
    const rv = await fetch(`${base}/v1/dev/self/revert?id=${one?.id}`, { method: "POST" });
    expect(rv.status).toBe(200); // reachable — not a 405 (the isWrite gate accepts it)
    const read = (await (await fetch(`${base}/v1/dev/files?path=operator/DELTA.md`)).json()) as {
      content: string;
    };
    expect(read.content).toBe("version ONE");
  });

  test("refuses env files, traversal, and non-allowlisted operator names", async () => {
    const env = await fetch(`${base}/v1/dev/files?path=workspace/delta.env`, {
      method: "PUT",
      body: "OPENROUTER_API_KEY=sk-x",
    });
    expect(env.status).toBe(403);
    const trav = await fetch(`${base}/v1/dev/files?path=workspace/../escape.txt`, {
      method: "PUT",
      body: "no",
    });
    expect(trav.status).toBe(403);
    const notOp = await fetch(`${base}/v1/dev/files?path=operator/AGENTS.md`, {
      method: "PUT",
      body: "no",
    });
    expect(notOp.status).toBe(403); // only DELTA.md is on this server's allowlist
    // A hard-linked file must not be writable (would truncate delta.env through the link).
    const hl = await fetch(`${base}/v1/dev/files?path=workspace/innocent-hardlink.txt`, {
      method: "PUT",
      body: "overwrite",
    });
    expect(hl.status).toBe(403);
  });

  test("writes are refused when inspectWrite is off (read stays available)", async () => {
    const ro = createServer(new Queue(deps), deps.events, 0, {
      workspace: ws,
      db: deps.db,
      operatorFiles: ["DELTA.md"],
    });
    const rb = `http://localhost:${ro.port}`;
    const put = await fetch(`${rb}/v1/dev/files?path=operator/DELTA.md`, {
      method: "PUT",
      body: "nope",
    });
    expect(put.status).toBe(403);
    expect((await fetch(`${rb}/v1/dev/files?path=workspace`)).status).toBe(200); // read still works
    ro.stop();
  });
});

describe("GET /v1/dev/tables — raw peek behind root ack", () => {
  test("lists peekable tables with counts", async () => {
    await seedRun("populate tables");
    const body = (await (await fetch(`${base}/v1/dev/tables`)).json()) as {
      tables: { name: string; rows: number }[];
    };
    const names = body.tables.map((t) => t.name);
    expect(names).toContain("sessions");
    expect(names).toContain("memory");
    expect(names).toContain("events");
  });

  test("requires ?ack=root, rejects non-whitelisted tables, scrubs cells", async () => {
    expect((await fetch(`${base}/v1/dev/tables/sessions`)).status).toBe(400); // no ack
    expect((await fetch(`${base}/v1/dev/tables/runs?ack=root`)).status).toBe(404); // not peekable
    const ev = await fetch(`${base}/v1/dev/tables/events?ack=root&limit=5`);
    expect(ev.status).toBe(200);
    const body = (await ev.json()) as { table: string; rows: Record<string, unknown>[] };
    expect(body.table).toBe("events");
    expect(Array.isArray(body.rows)).toBe(true);
  });

  test("inherited prop names (constructor) 404, not 500", async () => {
    expect((await fetch(`${base}/v1/dev/tables/constructor?ack=root`)).status).toBe(404);
    expect((await fetch(`${base}/v1/dev/tables/hasOwnProperty?ack=root`)).status).toBe(404);
  });

  test("meta.value is shown only for safe keys; anything else is hidden", async () => {
    deps.db
      .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('some_secret', ?)")
      .run("sekret-meta-value-xyz");
    const body = (await (await fetch(`${base}/v1/dev/tables/meta?ack=root`)).json()) as {
      rows: { key: string; value: string }[];
    };
    const secret = body.rows.find((r) => r.key === "some_secret");
    expect(secret?.value).toBe("[hidden]");
    // A known-safe key (schema_version) still shows its value.
    const safe = body.rows.find((r) => r.key === "schema_version");
    expect(safe?.value).not.toBe("[hidden]");
  });
});

describe("free-text secret scrubbing", () => {
  test("a tool result carrying a token in prose is scrubbed in the transcript + journal", async () => {
    // The echo tool returns its args as JSON; feed it a value that LOOKS like a plain
    // string with an embedded key (not a secret KEY name), so only text-scrubbing catches it.
    let seen = 0;
    const chat = async () => {
      seen++;
      if (seen % 2 === 1)
        return ok({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "echo",
                arguments: JSON.stringify({ note: "token is sk-abcdef0123456789XYZ done" }),
              },
            },
          ],
        });
      return textResult("ok");
    };
    const d2 = makeDeps(chat, new Map([["echo", echo]]));
    const q2 = new Queue(d2);
    const s2 = createServer(q2, d2.events, 0, { db: d2.db });
    const b2 = `http://localhost:${s2.port}`;
    const run = q2.enqueue({ input: "go" });
    await q2.wait(run.id);
    const detail = await (await fetch(`${b2}/v1/dev/runs/${run.id}`)).text();
    expect(detail).not.toContain("sk-abcdef0123456789XYZ");
    expect(detail).toContain("[redacted]");
    s2.stop();
  });
});

describe("redactSecrets (unit)", () => {
  test("scrubs credential-shaped keys at any depth, keeps the rest", () => {
    const out = redactSecrets({
      q: "keep",
      authToken: "x",
      nested: { api_key: "y", ok: 1, deeper: [{ password: "z" }] },
    }) as Record<string, unknown>;
    expect(out.q).toBe("keep");
    expect(out.authToken).toBe("[redacted]");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.api_key).toBe("[redacted]");
    expect(nested.ok).toBe(1);
    const deeper = nested.deeper as Record<string, unknown>[];
    expect(deeper[0]?.password).toBe("[redacted]");
  });

  test("fails CLOSED at the depth limit — a secret past depth 8 never slips through raw", () => {
    // Build a chain 12 levels deep with an authToken at the very bottom.
    let leaf: Record<string, unknown> = { authToken: "DEEP-SECRET" };
    for (let i = 0; i < 12; i++) leaf = { n: leaf };
    const out = JSON.stringify(redactSecrets(leaf));
    expect(out).not.toContain("DEEP-SECRET");
    expect(out).toContain("[truncated]");
  });
});
