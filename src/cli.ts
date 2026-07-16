// SPDX-License-Identifier: Apache-2.0
// The two local conveniences (spec §2–3). Deliberately thin — they add NO
// execution behavior:
//   delta dev <dir>  — a launcher: load the project's delta.env, bind loopback,
//                      boot the ORDINARY daemon (byte-identical to prod) as a child,
//                      open the browser at /dev.
//   delta send "…"   — a pure HTTP client over the seam: POST /v1/tasks, then tail
//                      /v1/dev/stream as JSONL (what a coding agent parses directly).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NEUTRAL_VOCAB } from "./vocab";

type Argv = { flags: Set<string>; opts: Record<string, string>; positional: string[] };

/** Minimal argv parser: `--flag`, `--key value` / `--key=value`, and positionals. */
function parseArgv(argv: string[]): Argv {
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  const valued = new Set(["port", "run", "since"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const key = k as string;
      if (inline !== undefined) opts[key] = inline;
      else if (valued.has(key) && i + 1 < argv.length) opts[key] = argv[++i] as string;
      else flags.add(key);
    } else positional.push(a);
  }
  return { flags, opts, positional };
}

/** Parse a `KEY=value` env file — quotes stripped, `#` comments and blanks skipped.
 *  A value may itself contain `=`. Never throws (a missing/garbled line is skipped). */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

/** Grab an ephemeral free port by binding :0 and releasing it. A tiny TOCTOU
 *  window remains before the daemon binds — acceptable for local dev. */
function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // best-effort — print the URL either way (the caller does)
  }
}

/** `delta dev <dir> [--port N] [--open|--no-open]` (spec §2.2). Spawns the ordinary
 *  daemon with the project env applied; parity holds because the child IS `delta`. */
export async function cliDev(argv: string[], selfCmd: string[]): Promise<number> {
  const { flags, opts, positional } = parseArgv(argv);
  const dir = resolve(positional[0] ?? ".");
  const port = opts.port ? Number(opts.port) : freePort();
  const shouldOpen = !flags.has("no-open");

  // Load the project's delta.env, then overlay the launcher's resolved defaults.
  // process.env is the base so PATH/HOME/etc. survive; the env file configures the agent.
  const envFile = resolve(dir, "delta.env");
  const fileEnv = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...fileEnv };
  // Defaults relative to the project dir (spec §2.1); an explicit delta.env value wins.
  // The workspace root IS the project dir — that's where the daemon reads DELTA.md /
  // POLICY.md / vocab.json and writes inbox/outbox (matches the bundle loading).
  env.DELTA_WORKSPACE = fileEnv.DELTA_WORKSPACE ? resolve(dir, fileEnv.DELTA_WORKSPACE) : dir;
  // Daemon state lives in a hidden .delta/ subdir, NOT the workspace root — so the Files
  // tab (and the agent's own list_dir) show only the agent's real files, not delta.db/-wal/
  // -shm. Mirrors prod, where DELTA_DB (data/) and DELTA_WORKSPACE (workspace/) are separate.
  env.DELTA_DB = fileEnv.DELTA_DB
    ? resolve(dir, fileEnv.DELTA_DB)
    : resolve(dir, ".delta/delta.db");
  env.PORT = String(port);
  env.DELTA_BIND = env.DELTA_BIND ?? "127.0.0.1"; // loopback — the only difference from prod
  env.DELTA_INSPECT_WRITE = env.DELTA_INSPECT_WRITE ?? "1"; // enable in-browser editing locally
  env.DELTA_CAPTURE_CALLS = env.DELTA_CAPTURE_CALLS ?? "1"; // capture true-to-life per-call input

  const url = `http://localhost:${port}/dev`;
  console.error(`delta dev · ${dir} · Cockpit → ${url}`);
  const child = Bun.spawn([...selfCmd], { env, stdout: "inherit", stderr: "inherit" });
  // Give the daemon a beat to bind before opening the browser at /dev.
  if (shouldOpen) {
    await Bun.sleep(400);
    openBrowser(url);
  }
  const onSignal = () => child.kill();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return await child.exited;
}

/** `delta send [--port N] [--json] "<input>"` (spec §3.2). Streams the firehose as
 *  JSONL by default (one envelope per line); `--json` prints just the terminal answer. */
export async function cliSend(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const { flags, opts, positional } = parseArgv(argv);
  const input = positional.join(" ").trim();
  if (!input) {
    console.error('usage: delta send [--port N] [--json] "<input>"');
    return 2;
  }
  const port = opts.port ?? env.PORT ?? "8080";
  const url = (p: string) => `http://localhost:${port}${p}`;
  const controlAuth: Record<string, string> = env.DELTA_CONTROL_TOKEN
    ? { authorization: `Bearer ${env.DELTA_CONTROL_TOKEN}` }
    : {};
  const inspectAuth: Record<string, string> = env.DELTA_INSPECT_TOKEN
    ? { authorization: `Bearer ${env.DELTA_INSPECT_TOKEN}` }
    : {};

  try {
    if (flags.has("json")) {
      // Sync: one terminal Responses payload.
      const res = await fetch(url("/v1/responses"), {
        method: "POST",
        headers: { "content-type": "application/json", ...controlAuth },
        body: JSON.stringify({ input }),
      });
      const body = (await res.json()) as { output_text?: string };
      if (!res.ok) {
        console.error(JSON.stringify(body));
        return 1;
      }
      console.log(body.output_text ?? "");
      return 0;
    }

    // Async + stream: start the task, then tail its firehose as JSONL.
    const started = await fetch(url("/v1/tasks"), {
      method: "POST",
      headers: { "content-type": "application/json", ...controlAuth },
      body: JSON.stringify({ input }),
    });
    const task = (await started.json()) as { id?: string; error?: { message: string } };
    if (!started.ok || !task.id) {
      console.error(task.error?.message ?? `failed to start task (${started.status})`);
      return 1;
    }
    console.error(`run ${task.id} → streaming`);
    const stream = await fetch(url(`/v1/dev/stream?run=${task.id}&live=1`), {
      headers: { ...inspectAuth },
    });
    if (!stream.ok || !stream.body) {
      console.error(`stream failed (${stream.status})`);
      return 1;
    }
    // The server closes the stream on this run's run.finished, so tailing ends on its own.
    return await tailSSE(stream.body, task.id);
  } catch (e) {
    console.error(`delta send: ${String(e)}`);
    return 1;
  }
}

/** Read an SSE body and print each `data:` payload as one JSONL line. Returns a nonzero
 *  code if a watched run finished non-`done` (`untilRun` scopes that check to one run). */
async function tailSSE(body: ReadableStream<Uint8Array>, untilRun?: string): Promise<number> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let failed = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const data = part
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      console.log(data);
      try {
        const ev = JSON.parse(data) as {
          type?: string;
          run_id?: string;
          data?: { status?: string };
        };
        if (
          ev.type === "run.finished" &&
          (!untilRun || ev.run_id === untilRun) &&
          ev.data?.status &&
          ev.data.status !== "done"
        )
          failed = true;
      } catch {}
    }
  }
  return failed ? 1 : 0;
}

/** `delta watch [--port N] [--run <id>] [--since <n>]` — tail the global firehose as
 *  JSONL without starting a run (the "follow everything" companion to `delta send`). */
export async function cliWatch(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const { opts } = parseArgv(argv);
  const port = opts.port ?? env.PORT ?? "8080";
  const inspectAuth: Record<string, string> = env.DELTA_INSPECT_TOKEN
    ? { authorization: `Bearer ${env.DELTA_INSPECT_TOKEN}` }
    : {};
  const params = new URLSearchParams({ since: opts.since ?? "0", live: "1" });
  if (opts.run) params.set("run", opts.run);
  try {
    const res = await fetch(`http://localhost:${port}/v1/dev/stream?${params}`, {
      headers: inspectAuth,
    });
    if (!res.ok || !res.body) {
      console.error(`watch failed (${res.status})`);
      return 1;
    }
    console.error(`watching :${port}${opts.run ? ` run ${opts.run}` : ""} — Ctrl-C to stop`);
    return await tailSSE(res.body, opts.run);
  } catch (e) {
    console.error(`delta watch: ${String(e)}`);
    return 1;
  }
}

/** `delta init <dir>` — scaffold a bundle: a commented delta.env, a starter vocab.json,
 *  DELTA.md (the living self-file: identity + a ## Learned section the agent extends),
 *  and POLICY.md (the fixed operating contract). Never overwrites an existing file. */
export async function cliInit(argv: string[]): Promise<number> {
  const { positional } = parseArgv(argv);
  const dir = positional[0];
  if (!dir) {
    console.error("usage: delta init <dir>");
    return 2;
  }
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const wrote: string[] = [];
  let failed = false;
  const put = (name: string, body: string) => {
    try {
      // Exclusive create ("wx"): atomically refuses if the file exists (no TOCTOU) and
      // won't follow a dangling symlink out of the bundle.
      writeFileSync(resolve(root, name), body, { flag: "wx" });
      wrote.push(name);
    } catch (e) {
      // An existing file is expected (never clobber). ANY other error (perms, disk,
      // bad path) is real — report it and fail, don't claim a scaffold that didn't land.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        console.error(`delta init: could not write ${name} — ${String(e)}`);
        failed = true;
      }
    }
  };
  put("delta.env", DELTA_ENV_TEMPLATE);
  put("vocab.json", `${JSON.stringify(NEUTRAL_VOCAB, null, 2)}\n`);
  put("DELTA.md", DELTA_MD_TEMPLATE);
  put("POLICY.md", POLICY_MD_TEMPLATE);
  put("PROMPT_CONTEXT.md", PROMPT_CONTEXT_MD_TEMPLATE);
  if (failed) return 1;
  console.error(
    wrote.length
      ? `delta init · ${dir} — wrote ${wrote.join(", ")}. Edit delta.env + DELTA.md + POLICY.md, then: delta dev ${dir}`
      : `delta init · ${dir} — already scaffolded (nothing overwritten).`,
  );
  return 0;
}

const DELTA_ENV_TEMPLATE = `# delta bundle — the local config for ONE agent. Fill these, then: delta dev .
# delta dev reads this file; the direct daemon does not. Local state defaults to .delta/.

# Model (required to think). An OpenRouter key, or your own OpenAI-compatible endpoint.
OPENROUTER_API_KEY=
# DELTA_MODEL_PRIMARY=anthropic/claude-sonnet-5
# MODEL_BASE_URL=https://openrouter.ai/api/v1

# A stable id so this agent's local memory never bleeds into another's.
DELTA_AGENT_ID=

# Your product's backends (the tools the agent acts through), as an MCP server array.
# The vocab.json coreVerbs bind by the <server>__<verb> suffix.
# DELTA_MCP_SERVERS=[{"name":"myproduct","transport":"http","url":"https://mcp.example/rpc","headers":{"authorization":"Bearer …"}}]

# Turn on the reflect/learning loop once your backends are wired.
# DELTA_REFLECT=1
`;

// DELTA.md — the living self-file. Human- AND agent-editable: the agent extends the
// ## Learned section via the `remember` tool as it gets feedback. Identity on top.
const DELTA_MD_TEMPLATE = `# Persona

You are <Name>, a <role> operator. You <what you do and for whom>.

# Mission

<the standing goal this agent exists to advance>

# Success

<the concrete outcome that means you did well>

# Learned

<!-- You maintain this section yourself. When feedback teaches you something durable,
     record it here (via the remember tool) so your next run is better. Keep it lean. -->
`;

// POLICY.md is fixed, highest-priority prompt guidance. Normal file tools and `remember`
// cannot edit its workspace-root path, but it is not an authorization boundary or an OS
// sandbox. Starts empty so the embedded review-rail guidance can apply when available.
const POLICY_MD_TEMPLATE = `# Policy

<!-- Highest-priority prompt guidance for this agent. It renders last in the system prompt.
     Enforce real permissions in tools, gateways, and approval systems. Leave this file
     comment-only to use the embedded review-rail guidance when that rail is available.
     Example guidance:

- Never send external email without a human approving the draft first.
- Escalate anything involving a refund over $500 instead of acting.
-->
`;

// PROMPT_CONTEXT.md — optional dynamic context. Two sections; ## Stable rides the cached
// spine (boot-stable vars), ## Turn is re-rendered every turn (volatile vars). Built-in
// vars: {{engine.version}} {{agent.id}} {{profile}} (stable); {{model}} {{now.iso}}
// {{now.date}} {{now.tz}} and any {{request.<key>}} the caller passes in metadata.context
// (turn). Delete this file to inject nothing.
const PROMPT_CONTEXT_MD_TEMPLATE = `## Stable
Engine delta {{engine.version}} · agent {{agent.id}} · profile {{profile}}

## Turn
Current model: {{model}} · now: {{now.iso}} ({{now.tz}})
Requester (when provided): {{request.city}}, {{request.country}} · IP {{request.ip}}
`;
