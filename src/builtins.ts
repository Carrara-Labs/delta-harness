// SPDX-License-Identifier: Apache-2.0
// The small built-in toolset (spec §D): web fetch/search + workspace file r/w —
// no coding kit. `code` delegates to a CLI (codex / claude-code); `spawn_subagent`
// re-runs this same binary as a child for context isolation. Every tool returns
// error text as a value; nothing here throws past the loop.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  confine,
  extractDocText,
  isImageMime,
  MAX_IMAGE_BYTES,
  registerImage,
  sniffMime,
  trashFile,
} from "./files";
import type { Usage } from "./provider";
import { currentSelf, looksLikeSpineEcho } from "./self";
import { assertPublicUrl } from "./ssrf";
import { elide, type TodoItem, type ToolCtx, type ToolDef, type Tools } from "./tools";
import { HARNESS_VERSION } from "./version";

export type BuiltinConfig = {
  workspace: string;
  /** The daemon's model reads images — shapes read_file's image reply so a
   * non-vision model is TOLD it can't see the pixels (else it confabulates
   * contents from the filename — observed live on glm-5.2). */
  vision?: boolean;
  exaKey?: string;
  /** Local-development escape hatch. Never enable on a model-facing deployment. */
  fetchAllowPrivate?: boolean;
  /** Command prefix for code delegation; the task is appended as one arg. */
  codeCli: string[];
  /** Command prefix that re-invokes this binary; `run <task>` gets appended. */
  selfCmd: string[];
  subagentDepth: number;
  /** Control-plane base URL + this VM's gateway token — enables the self-scheduling tools
   * (Sprint 4). Both absent → the tools aren't registered (graceful-off for dev binaries). */
  controlUrl?: string;
  controlToken?: string;
};

// Truncation is centralized: run.ts caps EVERY tool result via capAndSpill (inline cap +
// full output spilled to a re-readable file), so builtins return their result RAW — a
// pre-elide here would silently bypass the spill and make the full output unrecoverable
// (codex #7). `clip` remains only for short error snippets inside messages.
const clip = (text: string, max = 2000): string => elide(text, max);

// Resolve a user-supplied path inside the workspace; refuses `..` escapes AND
// symlinks pointing outside (confine is realpath-hard — codex S8 #3).
const inside = confine;

// The write-authorization boundary for the model's OWN file tools (codex #3/#5/#6/#8).
// One classifier below EVERY mutation surface (write/move/delete), so a reserved file is
// blocked whichever tool tries it. A guardrail against the model's hands, not a security
// boundary — the microVM stays the boundary (§6); delegated `code`/subagents run outside
// this guard by design (a code runner is already "run arbitrary code").
//   • POLICY.md + vocab.json are OPERATOR-owned (fixed contract + write rail): the model
//     must not rewrite its own authority and have a fresh boot obey it (self-escalation).
//   • DELTA.md is the SELF-file: writable, but ONLY through the `remember` tool (atomic +
//     snapshotted + size-checked) — the generic tools refuse it so it can't be truncated
//     or deleted without a backup (codex #8).
//   • .env* / delta.env / .delta hold secrets + daemon state (incl. the revision store) —
//     off-limits to file tools entirely (codex #6).
const SELF_FILE = "DELTA.md";
const FIXED_OPERATOR_FILES = new Set(["POLICY.md", "vocab.json", "PROMPT_CONTEXT.md"]);
const OPERATOR_FILE_ERROR =
  "[tool error] that file is operator-owned (it steers your system prompt) — propose the change to your operator instead of writing it yourself";
const SELF_FILE_ERROR =
  "[tool error] DELTA.md is your own living file — update it with the `remember` tool (it snapshots the old version and size-checks it), not write_file/move/delete";
const RESERVED_FILE_ERROR =
  "[tool error] that path holds secrets or daemon state (.env / .delta) — off-limits to file tools";

/** Classify a workspace path for the write guard. Paths outside the workspace are already
 * rejected by `confine`, so anything here starting with the workspace prefix is in-tree. */
function fileClass(workspace: string, abs: string): "self" | "operator" | "reserved" | "ok" {
  if (abs !== workspace && !abs.startsWith(`${workspace}/`)) return "ok";
  const rel = abs === workspace ? "" : abs.slice(workspace.length + 1);
  if (rel === SELF_FILE) return "self";
  if (FIXED_OPERATOR_FILES.has(rel)) return "operator";
  if (
    rel === ".env" ||
    rel.startsWith(".env.") ||
    rel === "delta.env" ||
    rel === ".delta" ||
    rel.startsWith(".delta/")
  )
    return "reserved";
  return "ok";
}

/** The error a mutation tool returns for `abs`, or null when the write is allowed. */
function guardWrite(workspace: string, abs: string): string | null {
  switch (fileClass(workspace, abs)) {
    case "self":
      return SELF_FILE_ERROR;
    case "operator":
      return OPERATOR_FILE_ERROR;
    case "reserved":
      return RESERVED_FILE_ERROR;
    default:
      return null;
  }
}

export type ChildEnvKind = "code" | "subagent";

// These daemon credentials are never inherited by model-directed children. Provider
// access is the sole exception: childEnv("subagent") delegates only the primary key
// needed for that nested Delta to make model calls; the code CLI uses ~/.codex auth.
//
// Accepted residuals (named, not hidden — codex H4 challenge):
//  • The forwarded provider key IS reachable by a model-directed subagent. It's the
//    minimal grant: a nested Delta can't think without a model credential, and this is
//    the LOWEST-value one — knowledge-base/broker/control/telemetry are all denied, so an
//    injected child can't rewrite the knowledge graph, spend the subscription, schedule
//    work, or forge telemetry. Fully removing it needs the parent to PROXY model calls
//    (no key in the child) — a later hardening, tracked separately.
//  • A broker/subscription-only daemon's subagent gets no usable model credential and
//    fails cleanly ([tool error] non-zero exit), by design — a subscription token must
//    never cross to a model-directed child.
//  • HOME is forwarded (the code CLI needs ~/.codex; Bun needs it too). Home-dir file
//    secrets are a FILESYSTEM-isolation concern, a separate layer from this env allowlist.
// Bun.spawn REPLACES the child env with what we pass (verified) — omitted vars are NOT
// merged back from process.env, so default-deny here actually governs the child.
export const CHILD_ENV_SECRET_DENYLIST = new Set([
  "DELTA_MCP_REFRESH_TOKEN",
  "DELTA_MCP_REFRESH_FILE", // grants access to the rotating refresh credential
  "DELTA_BROKER_AUTH",
  "DELTA_CONTROL_TOKEN",
  "TELEMETRY_TOKEN",
  "EXA_API_KEY",
  "DELTA_MCP_SERVERS", // server definitions may contain bearer tokens
  "DELTA_PROVIDERS", // fallback definitions may contain inline provider/broker keys
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
]);

// Safe process plumbing only: executable/home discovery, temp files, and terminal/locale
// behavior. No credential namespace wildcards are allowed.
const SAFE_PROCESS_ENV = /^(PATH|HOME|SHELL|TMPDIR|LANG|LC_.*|TERM)$/;
// A oneshot Delta needs only its primary provider route/model and execution ceilings.
// Other DELTA_* settings intentionally fall back to defaults rather than widening access.
const SUBAGENT_CONFIG_ENV = new Set([
  "MODEL_BASE_URL",
  "MODEL_API",
  "DELTA_MODEL_PRIMARY", // current model env; config aliases DELTA_MODEL_PRIMARY → DELTA_MODEL
  "DELTA_MODEL", // legacy alias, kept for back-compat

  "DELTA_MODEL_FALLBACKS",
  "DELTA_UTILITY_MODEL",
  "DELTA_PROFILE",
  "DELTA_MODEL_TIMEOUT_MS",
  "DELTA_STREAM_IDLE_MS",
  "DELTA_TOOL_TIMEOUT_MS",
  "DELTA_TOOL_RESULT_MAX_BYTES",
]);

/** Build a default-deny environment for a model-directed child process. */
export function childEnv(
  kind: ChildEnvKind,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || CHILD_ENV_SECRET_DENYLIST.has(k)) continue;
    if (SAFE_PROCESS_ENV.test(k) || (kind === "subagent" && SUBAGENT_CONFIG_ENV.has(k))) env[k] = v;
  }
  // Delegate exactly one provider credential. MODEL_API_KEY is the configured
  // primary; OPENROUTER_API_KEY is used only when that primary key is absent.
  if (kind === "subagent") {
    if (source.MODEL_API_KEY !== undefined) env.MODEL_API_KEY = source.MODEL_API_KEY;
    else if (source.OPENROUTER_API_KEY !== undefined)
      env.OPENROUTER_API_KEY = source.OPENROUTER_API_KEY;
  }
  return env;
}

/** Read the last child usage marker from noisy stderr. Missing/malformed is fail-open. */
export function parseReportedUsage(stderr: string): Usage | null {
  let usage: Usage | null = null;
  for (const match of stderr.matchAll(/^DELTA_USAGE (.+)$/gm)) {
    try {
      const value = JSON.parse(match[1] ?? "") as Partial<Usage>;
      const fields = ["input", "output", "cacheRead", "cacheWrite", "total", "costUsd"] as const;
      if (fields.every((field) => Number.isFinite(value[field]) && (value[field] as number) >= 0))
        usage = value as Usage;
    } catch {}
  }
  return usage;
}

/** Parse and charge once; deliberately ignores absent/garbled child reports. */
export function chargeReportedUsage(stderr: string, ctx: ToolCtx): void {
  const usage = parseReportedUsage(stderr);
  if (usage) ctx.chargeUsage?.(usage);
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) =>
      m === "&amp;" ? "&" : m === "&lt;" ? "<" : m === "&gt;" ? ">" : m === "&quot;" ? '"' : " ",
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

export function builtinTools(cfg: BuiltinConfig): Tools {
  const tools: Tools = new Map();
  const add = (t: ToolDef) => tools.set(t.name, t);

  add({
    name: "web_search",
    description: "Search the web (Exa). Returns titles, URLs, and text snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        num_results: { type: "number", description: "default 5, max 10" },
      },
      required: ["query"],
    },
    idempotent: true,
    execute: async (args, ctx) => {
      if (!cfg.exaKey) return "[tool error] web_search is not configured (no EXA_API_KEY)";
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "x-api-key": cfg.exaKey, "content-type": "application/json" },
        body: JSON.stringify({
          query: String(args.query),
          numResults: Math.min(Number(args.num_results) || 5, 10),
          contents: { text: { maxCharacters: 1500 } },
        }),
        signal: ctx.signal ?? AbortSignal.timeout(30_000),
      });
      if (!res.ok) return `[tool error] exa ${res.status}: ${clip(await res.text(), 500)}`;
      const data = (await res.json()) as {
        results?: Array<{ title?: string; url?: string; text?: string }>;
      };
      const results = data.results ?? [];
      if (results.length === 0) return "no results";
      return results
        .map((r, i) => `${i + 1}. ${r.title ?? "(untitled)"}\n${r.url}\n${r.text ?? ""}`)
        .join("\n\n");
    },
  });

  add({
    name: "web_fetch",
    description: "Fetch a URL and return its text content (HTML is stripped to text).",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    idempotent: true,
    execute: async (args, ctx) => {
      const allowPrivate = cfg.fetchAllowPrivate ?? process.env.DELTA_FETCH_ALLOW_PRIVATE === "1";
      const guard = async (rawUrl: string): Promise<URL> => {
        if (!allowPrivate) return assertPublicUrl(rawUrl);
        const candidate = new URL(rawUrl);
        if (candidate.protocol !== "http:" && candidate.protocol !== "https:")
          throw new Error(`scheme ${candidate.protocol || "(missing)"} is not allowed`);
        return candidate;
      };
      let url: URL;
      try {
        url = await guard(String(args.url));
      } catch (error) {
        return `[tool error] blocked: ${error instanceof Error ? error.message : String(error)}`;
      }

      let res: Response;
      const signal = ctx.signal ?? AbortSignal.timeout(30_000);
      for (let redirects = 0; ; redirects++) {
        res = await fetch(url, {
          redirect: "manual",
          headers: { "user-agent": `delta/${HARNESS_VERSION}` },
          signal,
        });
        if (res.status < 300 || res.status >= 400) break;
        const location = res.headers.get("location");
        if (!location) break;
        if (redirects >= 5) return "[tool error] blocked: too many redirects (max 5)";
        try {
          url = await guard(new URL(location, url).href);
        } catch (error) {
          return `[tool error] blocked: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (!res.ok) return `[tool error] HTTP ${res.status} fetching ${args.url}`;
      const type = res.headers.get("content-type") ?? "";
      const body = await res.text();
      return type.includes("html") ? stripHtml(body) : body; // capped+spilled centrally
    },
  });

  add({
    name: "read_file",
    description:
      "Read a file from the workspace. Text pages with offset/limit; images attach to your context; docx/xlsx/ipynb extract to text.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "1-based start line (text files)" },
        limit: { type: "number", description: "max lines (default 2000)" },
      },
      required: ["path"],
    },
    idempotent: true,
    execute: async (args, ctx) => {
      const rel = String(args.path);
      const abs = inside(ctx.workspace, rel);
      const f = Bun.file(abs);
      if (!(await f.exists())) return `[tool error] no such file: ${rel}`;
      // Sniff from the head, decide from the stat — materializing the whole file
      // before knowing what it is can OOM the daemon (codex S8 #6).
      const size = f.size;
      const head = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
      const mime = sniffMime(head, rel);
      const kb = Math.max(1, Math.round(size / 1024));
      // Images ride the claim-check marker — expandImageMarkers() attaches recent
      // ones as real wire blocks. A non-vision daemon says so PLAINLY: a placeholder
      // that implies attachment invites the model to confabulate contents from the
      // filename (observed live on glm-5.2). Over the wire cap = say so, don't lie
      // that it's attached (codex S8 #9).
      if (isImageMime(mime)) {
        if (size > MAX_IMAGE_BYTES)
          return `[tool error] ${rel} is an image too large to attach (${kb}KB > ~3.3MB wire cap) — downscale it via the code tool, then read the smaller file`;
        registerImage(ctx.workspace, rel); // provenance: this marker may expand
        return cfg.vision
          ? `[delta:image ${rel}]\n(image ${mime}, ${kb}KB — attached to your context while recent; re-read this file to re-attach it)`
          : `[delta:image ${rel}]\n(image ${mime}, ${kb}KB. Your current model CANNOT view images — you know only this file's name and size. Never guess or describe its contents; delegate visual analysis or say you can't see it.)`;
      }
      if (mime === "application/pdf")
        return `[tool error] ${rel} is a PDF (${kb}KB) — extract it via the code tool (e.g. pdftotext), then read the result`;
      if (mime.startsWith("application/vnd.openxmlformats") || rel.endsWith(".ipynb")) {
        const text = await extractDocText(abs, mime);
        if (text !== null) return text; // capped+spilled centrally
        return `[tool error] could not extract ${rel} (${mime}) locally — delegate to the code tool`;
      }
      if (mime === "application/octet-stream" || mime === "application/zip")
        return `[tool error] ${rel} is binary (${mime}, ${kb}KB) — not readable as text`;
      if (size > 20_000_000)
        return `[tool error] ${rel} is ${kb}KB of text — too large to page here; grep it, or slice it via the code tool`;
      // Text: dual line/char cap with an offset continuation hint —
      // pagination beats amputation, and a targeted re-read beats a spill file.
      const text = await f.text();
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.max(1, Math.min(Number(args.limit) || 2000, 2000));
      const lines = text.split("\n");
      const total = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      // The whole file fits → return it byte-exact (no pagination artifacts).
      if (offset === 1 && total <= limit && text.length <= 50_000) return text;
      let out = "";
      let end = offset - 1;
      for (let i = offset - 1; i < total && i < offset - 1 + limit; i++) {
        const line = lines[i] ?? "";
        if (out.length + line.length + 1 > 50_000) {
          // An oversized single line must still ADVANCE, else every continuation
          // returns the same empty page forever (codex S8 #19).
          if (out.length === 0) {
            out = `${line.slice(0, 50_000)}\n…[line ${i + 1} truncated — it exceeds the 50KB page]\n`;
            end = i + 1;
          }
          break;
        }
        out += `${line}\n`;
        end = i + 1;
      }
      return `${out}\n[Showing lines ${offset}-${end} of ${total}. Use offset=${end + 1} to continue.]`;
    },
  });

  add({
    name: "move_file",
    description:
      "Move/rename a file inside the workspace (creates parent dirs). Refuses to overwrite unless overwrite=true. Use this to FILE inbox arrivals per FILES.md.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["from", "to"],
    },
    idempotent: false,
    execute: async (args, ctx) => {
      const from = inside(ctx.workspace, String(args.from));
      const to = inside(ctx.workspace, String(args.to));
      const err = guardWrite(ctx.workspace, from) ?? guardWrite(ctx.workspace, to);
      if (err) return err;
      if (!existsSync(from)) return `[tool error] no such file: ${args.from}`;
      if (existsSync(to) && args.overwrite !== true)
        return `[tool error] ${args.to} exists — pass overwrite=true to replace it`;
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      return `moved ${args.from} → ${args.to}`;
    },
  });

  add({
    name: "delete_file",
    description:
      "Delete a workspace file (moved to trash, recoverable ~7 days). Directories need recursive=true.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"],
    },
    idempotent: false,
    execute: async (args, ctx) => {
      const rel = String(args.path);
      const abs = inside(ctx.workspace, rel);
      const err = guardWrite(ctx.workspace, abs);
      if (err) return err;
      if (!existsSync(abs)) return `[tool error] no such file: ${rel}`;
      if (statSync(abs).isDirectory() && args.recursive !== true)
        return `[tool error] ${rel} is a directory — pass recursive=true to trash it`;
      trashFile(ctx.workspace, rel, abs);
      return `trashed ${rel} (recoverable ~7 days in .delta/trash)`;
    },
  });

  add({
    name: "grep",
    description:
      "Search workspace files for a regex. Returns path:line matches. This is the workspace index — grep first, read second.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "dir or file to search; default workspace root" },
        ignore_case: { type: "boolean" },
      },
      required: ["pattern"],
    },
    idempotent: true,
    execute: async (args, ctx) => {
      const root = inside(ctx.workspace, String(args.path ?? "."));
      if (!existsSync(root)) return `[tool error] no such path: ${args.path}`;
      // System grep, not a JS RegExp: a model-supplied pattern like `(a+)+$`
      // backtracks catastrophically, and a synchronous JS regex blocks the whole
      // event loop PAST any tool timeout (codex S8 #7). grep matches DFA-first in
      // its own process — killable, bounded, and it skips binaries (-I) natively.
      const proc = Bun.spawn(
        [
          "grep",
          "-rHInE",
          ...(args.ignore_case === true ? ["-i"] : []),
          "--exclude-dir=.delta",
          "-e",
          String(args.pattern),
          root,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const kill = setTimeout(() => proc.kill(), 10_000);
      let out = "";
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout) {
        out += dec.decode(chunk as Uint8Array, { stream: true });
        if (out.length > 100_000) {
          proc.kill(); // plenty past the 100-hit cap — stop the child, keep what we have
          break;
        }
      }
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(kill);
      if (code > 1 && !out) return `[tool error] grep failed: ${clip(err, 300)}`;
      const hits = out
        .split("\n")
        .filter(Boolean)
        .slice(0, 100)
        .map((l) => {
          const s = l.startsWith(`${ctx.workspace}/`) ? l.slice(ctx.workspace.length + 1) : l;
          return s.length > 600 ? `${s.slice(0, 600)}…` : s;
        });
      return hits.length ? hits.join("\n") : "(no matches)";
    },
  });

  add({
    name: "recall",
    description:
      "Search this conversation's earlier turns — including ones compacted out of the live window — for text/results you saw before. Returns matching snippets + the disk path of any spilled result. Use to pull back context that scrolled off before you finish.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "keywords to search earlier turns for" },
        limit: { type: "number", description: "max hits, 1-25 (default 10)" },
      },
      required: ["query"],
    },
    idempotent: true,
    execute: async (args, ctx) => {
      const hits = ctx.history?.search(String(args.query ?? ""), Number(args.limit) || 10) ?? [];
      if (hits.length === 0) return "(nothing earlier in this thread matches)";
      return hits
        .map((h) => {
          const where = `${h.role} · run seq ${h.runSeq ?? "?"} · ${h.active ? "live" : "compacted"}`;
          const path = h.spillPath
            ? `\n  → full result on disk: ${h.spillPath} (read_file it)`
            : "";
          return `[${where}] ${h.snippet}${path}`;
        })
        .join("\n\n");
    },
  });

  add({
    name: "todo",
    description:
      "Read or update your working plan for this task. Pass `items` to replace the whole list (send every item + status); omit to read. It's re-shown each turn and survives compaction — keep it current to stay on-goal over a long run.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "the full plan (replaces the current list); omit to just read",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "doing", "done", "dropped"] },
            },
            required: ["text"],
          },
        },
      },
    },
    idempotent: true,
    execute: async (args, ctx) => {
      if (!ctx.todo) return "[tool error] no plan store in this context";
      // Distinguish read (omitted) / clear ([]) / write (array) from garbage — a non-array must
      // NOT silently erase the plan (codex).
      let list: TodoItem[];
      let requested = 0;
      if (args.items === undefined) list = ctx.todo.read();
      else if (Array.isArray(args.items)) {
        // Count VALID items (trimmed non-empty string) — matches writeTodo's own validity filter so
        // the dropped-count is accurate (codex).
        requested = args.items.filter(
          (i) =>
            typeof (i as { text?: unknown })?.text === "string" &&
            (i as { text: string }).text.trim(),
        ).length;
        list = ctx.todo.write(args.items as TodoItem[]);
      } else return "[tool error] `items` must be an array (the full plan); omit it to read";
      // Non-silent truncation, computed BEFORE the empty-plan return so an all-dropped write still
      // warns instead of looking like an empty plan (codex).
      const dropped = Math.max(0, requested - list.length);
      const note =
        dropped > 0
          ? `\n[note: ${dropped} item(s) didn't fit the plan budget — keep items terse, or save long findings to a workspace file (write_file) and recall/read them later]`
          : "";
      if (list.length === 0)
        return note ? `(nothing fit)${note}` : "(plan is empty — add items to track your steps)";
      return `${list.map((it) => `[${it.status}] ${it.text}`).join("\n")}${note}`;
    },
  });

  add({
    name: "write_file",
    description: "Write (overwrite) a file in the workspace. Creates parent dirs.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    // Full-content overwrite with the same args lands the same bytes — safe to re-fire.
    idempotent: true,
    execute: async (args, ctx) => {
      const abs = inside(ctx.workspace, String(args.path));
      const err = guardWrite(ctx.workspace, abs);
      if (err) return err;
      await Bun.write(abs, String(args.content), { createPath: true });
      return `wrote ${String(args.content).length} chars to ${args.path}`;
    },
  });

  add({
    name: "remember",
    description:
      "Update your own DELTA.md — your durable identity and what you've learned. Pass the FULL new content of DELTA.md ONLY — its Persona/Mission/Success/Learned sections. Do NOT include the # Norms, # Context, # You, # Policy, or # Tools sections you see in your prompt; the engine wraps those around your DELTA.md, they are not part of the file. Your content REPLACES DELTA.md; the previous version is snapshotted so it can be reverted. Use this to record a lesson from human feedback so your next run is better. Keep it lean: it rides in every prompt. Takes effect on your NEXT run.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "the full new DELTA.md body ONLY (Persona/Mission/Success/Learned) — not the surrounding # Norms/# You/# Tools spine sections",
        },
      },
      required: ["content"],
    },
    // Full-content replace with the same content lands the same bytes — safe to re-fire.
    idempotent: true,
    execute: async (args, ctx) => {
      if (!ctx.writeSelf)
        return "[tool error] self-write is not available in this context (no durable store)";
      const content = String(args.content ?? "");
      if (!content.trim())
        return "[tool error] refusing to write an empty DELTA.md — pass the full new content";
      // Spine-echo guard: some models (seen with gpt-5.6-sol) return the WHOLE rendered
      // system prompt as "the new file", which would nest the spine inside DELTA.md and
      // compound every run. Reject and hand back the current file so the model retries
      // with only the DELTA.md body.
      if (looksLikeSpineEcho(content))
        return `[tool error] That looks like your whole system prompt, not your DELTA.md. Pass ONLY the DELTA.md body — its # Persona / # Mission / # Success / # Learned sections. Drop the # Norms, # Context, # You, # Policy, and # Tools sections; the engine adds those. Your current DELTA.md is:\n\n${currentSelf(ctx.workspace)}`;
      const r = ctx.writeSelf(content);
      return r.ok
        ? `updated DELTA.md (${r.bytes} bytes) — takes effect on your next run`
        : `[tool error] ${r.error}`;
    },
  });

  add({
    name: "list_dir",
    description: "List files in a workspace directory (recursive, relative paths).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "default: workspace root" } },
    },
    idempotent: true,
    execute: async (args, ctx) => {
      const abs = inside(ctx.workspace, String(args.path ?? "."));
      const entries = readdirSync(abs, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => resolve(e.parentPath, e.name).slice(ctx.workspace.length + 1));
      return entries.length ? entries.sort().join("\n") : "(empty)";
    },
  });

  add({
    name: "code",
    description:
      "Delegate a coding task to a sandboxed coding CLI working in the workspace. Describe the task fully; returns the CLI's final output.",
    parameters: {
      type: "object",
      properties: { task: { type: "string" } },
      required: ["task"],
    },
    idempotent: false,
    timeoutMs: 0, // the coding CLI legitimately runs long — never guillotine it
    execute: async (args, ctx) => {
      mkdirSync(ctx.workspace, { recursive: true });
      const proc = Bun.spawn([...cfg.codeCli, String(args.task)], {
        cwd: ctx.workspace,
        stdout: "pipe",
        stderr: "pipe",
        env: childEnv("code"),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) return `[tool error] code CLI exited ${code}: ${clip(err || out)}`;
      return out.trim() || "(no output)";
    },
  });

  // One sub-agent run (a oneshot child of this binary). Shared by spawn_subagent
  // and eval_n; returns the child's final answer or a [tool error] value.
  const runSubagent = async (task: string, ctx: ToolCtx, budgetDivisor = 1): Promise<string> => {
    const remaining = ctx.remainingBudget?.();
    const proc = Bun.spawn([...cfg.selfCmd, "run", task], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...childEnv("subagent"),
        DELTA_SUBAGENT_DEPTH: String(cfg.subagentDepth + 1),
        DELTA_WORKSPACE: ctx.workspace,
        ...(remaining
          ? {
              DELTA_MAX_TOKENS: String(
                Math.max(0, Math.floor(remaining.maxTokens / budgetDivisor)),
              ),
              DELTA_MAX_COST_USD: String(Math.max(0, remaining.maxCostUsd / budgetDivisor)),
            }
          : {}),
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    chargeReportedUsage(err, ctx);
    if (code !== 0) return `[tool error] subagent exited ${code}: ${clip(err || out)}`;
    return out.trim() || "(no output)";
  };

  if (cfg.subagentDepth < 1) {
    add({
      name: "research",
      description:
        "Run 1–3 read-only research questions as parallel sub-agents. Each explores in its own context (web + file reads + allowed data tools), writes full findings to a file, and returns a short summary + that path — offload exploration without bloating this run, and finish faster. Read-only: no writing, code, or actions.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: { type: "string" },
            description: "1–3 independent research questions",
          },
        },
        required: ["tasks"],
      },
      idempotent: false, // fan-out — never silently re-fire on resume
      timeoutMs: 0, // runs N bounded child loops
      execute: async (args, ctx) => {
        if (!ctx.research) return "[tool error] research is not available in this context";
        const tasks = Array.isArray(args.tasks) ? args.tasks.map(String).filter(Boolean) : [];
        if (!tasks.length) return "[tool error] `tasks` must be a non-empty array of questions";
        return ctx.research(tasks);
      },
    });

    add({
      name: "spawn_subagent",
      description:
        "Run a self-contained task in a fresh sub-agent (own context, same tools) and get its final answer back. Use for big side-quests that would bloat this run's context.",
      parameters: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
      },
      idempotent: false,
      timeoutMs: 0, // a sub-agent runs a whole task — unbounded, like the code CLI
      execute: async (args, ctx) => runSubagent(String(args.task), ctx),
    });

    add({
      name: "eval_n",
      description:
        "Run a task N independent ways (fresh sub-agents), then a judge picks the best result. Use when the solution space is wide and quality matters more than latency — drafting, design, tricky reasoning. Returns the winning answer.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string" },
          n: { type: "number", description: "variants, 2-5 (default 3)" },
          rubric: { type: "string", description: "optional judging criteria" },
        },
        required: ["task"],
      },
      idempotent: false,
      timeoutMs: 0, // fans out N sub-agents + a judge — unbounded
      execute: async (args, ctx) => {
        if (!ctx.chat)
          return "[tool error] eval_n needs a model for judging (no provider in context)";
        const n = Math.max(2, Math.min(Number(args.n) || 3, 5));
        const task = String(args.task);
        // Fan out N independent attempts. Vary each so they don't collapse to one.
        const variants = await Promise.all(
          Array.from({ length: n }, (_, i) =>
            runSubagent(
              `${task}\n\n(Independent attempt ${i + 1} of ${n} — take your own approach.)`,
              ctx,
              n,
            ),
          ),
        );
        const valid = variants
          .map((v, i) => ({ i, v }))
          .filter((c) => !c.v.startsWith("[tool error]"));
        if (valid.length === 0) return `[tool error] all ${n} eval_n variants failed`;
        if (valid.length === 1) return valid[0]?.v as string;

        const rubric = args.rubric
          ? `Judge by: ${String(args.rubric)}.`
          : "Judge by correctness, completeness, and how well it follows the task.";
        const candidates = valid
          .map((c) => `### Candidate ${c.i}\n${c.v.slice(0, 8000)}`)
          .join("\n\n");
        const judged = await (ctx.chatUtility ?? ctx.chat)({
          messages: [
            {
              role: "system",
              content: `You are judging ${valid.length} candidate answers to a task. ${rubric} Reply with ONLY JSON: {"winner": <candidate number>, "reason": "<one sentence>"}.`,
            },
            { role: "user", content: `TASK:\n${task}\n\n${candidates}` },
          ],
          maxTokens: 400,
        });
        let winnerIdx = valid[0]?.i ?? 0;
        if (judged.ok) {
          try {
            const parsed = JSON.parse(
              (judged.message.content ?? "").replace(/^```(json)?|```$/g, "").trim(),
            ) as { winner?: number };
            if (valid.some((c) => c.i === parsed.winner)) winnerIdx = parsed.winner as number;
          } catch {}
        }
        const winner = valid.find((c) => c.i === winnerIdx)?.v ?? (valid[0]?.v as string);
        return `[eval_n: ${valid.length}/${n} variants, winner #${winnerIdx}]\n${winner}`;
      },
    });
  }

  // ── Self-scheduling (Sprint 4) ────────────────────────────────────────────────
  // The control plane owns the clock — this VM autosuspends, so an in-VM timer dies on
  // suspend. These tools register a durable schedule at the CP (authed by this VM's own
  // gateway token, hash-matched server-side); a 60s CP ticker fires due schedules as wake
  // turns. Only registered when CP-wired: a bare dev binary boots without them.
  if (cfg.controlUrl && cfg.controlToken) {
    const cp = (path: string, init: RequestInit): Promise<Response> =>
      fetch(`${cfg.controlUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${cfg.controlToken}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      });

    add({
      name: "schedule_self",
      description:
        "Schedule a future wake for yourself: when it fires, you get a new turn with your prompt. spec.kind: 'once' (runAt ISO timestamp), 'interval' (intervalMs ≥ 60000), or 'cron' (cronExpr 5-field, optional tz). Use for recurring checks, follow-ups, and deferred work. Never schedule a prompt that restarts or kills you.",
      parameters: {
        type: "object",
        properties: {
          spec: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["once", "interval", "cron"] },
              runAt: { type: "string", description: "ISO timestamp (kind=once)" },
              intervalMs: {
                type: "number",
                description: "ms between runs, >=60000 (kind=interval)",
              },
              cronExpr: { type: "string", description: "5-field cron (kind=cron)" },
              tz: { type: "string", description: "IANA timezone for cron; default UTC" },
            },
            required: ["kind"],
          },
          prompt: { type: "string", description: "what to do when the wake fires" },
        },
        required: ["spec", "prompt"],
      },
      idempotent: false, // each call creates a distinct schedule
      execute: async (args) => {
        const res = await cp("/api/agents/self/schedules", {
          method: "POST",
          body: JSON.stringify({ spec: args.spec, prompt: args.prompt }),
        });
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok)
          return `[tool error] schedule_self ${res.status}: ${clip(String(j.error ?? ""), 300)}`;
        const s = (j.schedule ?? {}) as Record<string, unknown>;
        return `scheduled ${s.id} — next run ${s.nextRunAt}`;
      },
    });

    add({
      name: "list_schedules",
      description: "List your schedules (id, kind, state, next run, prompt).",
      parameters: { type: "object", properties: {} },
      idempotent: true,
      execute: async () => {
        const res = await cp("/api/agents/self/schedules", { method: "GET" });
        if (!res.ok) return `[tool error] list_schedules ${res.status}`;
        const j = (await res.json().catch(() => ({}))) as {
          schedules?: Array<Record<string, unknown>>;
        };
        const rows = j.schedules ?? [];
        if (rows.length === 0) return "(no schedules)";
        return rows
          .map(
            (s) =>
              `${s.id} [${s.state}] ${s.specKind} → next ${s.nextRunAt}: ${String(s.prompt).slice(0, 80)}`,
          )
          .join("\n");
      },
    });

    add({
      name: "cancel_schedule",
      description: "Cancel one of your schedules by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      idempotent: true, // cancelling an already-cancelled id is a no-op
      execute: async (args) => {
        const res = await cp(`/api/agents/self/schedules/${encodeURIComponent(String(args.id))}`, {
          method: "DELETE",
        });
        if (res.status === 404) return `[tool error] no such schedule ${args.id}`;
        if (!res.ok) return `[tool error] cancel_schedule ${res.status}`;
        return `cancelled ${args.id}`;
      },
    });
  }

  return tools;
}
