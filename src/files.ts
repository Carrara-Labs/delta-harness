// SPDX-License-Identifier: Apache-2.0
// Files & multimodal (Sprint 8). The lean thesis:
// the models already read images — the harness's job is a byte path (user → disk),
// image blocks on the wire, and a prune budget. Everything meets on ONE claim-check
// marker: `[delta:image <relpath>]`. read_file on an image emits it, MCP image
// parts are saved to disk and emit it, and expandImageMarkers() attaches the
// RECENT ones as real wire blocks at request-build time. Old markers stay plain
// text — pruning is free (the model re-reads the file to re-attach), storage stays
// strings, and an un-pruned screenshot never re-bills ~1.5k tokens every turn.
// No local resize dep: providers downscale server-side and bill the resized size;
// the harness only enforces the wire byte cap (~4.5MB-base64 headroom).

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ChatMsg, UserPart } from "./provider";

export const IMAGE_MARKER_RE = /\[delta:image ([^\]\n]+)\]/g;
export const MAX_IMAGE_BYTES = 3_400_000; // ≈4.5MB base64 — Anthropic's 5MB with headroom
const MAX_IMAGES_PER_REQUEST = 4; // image replay cap
const MARKER_WINDOW_USER_TURNS = 2; // markers older than this many user turns stay text

// ── workspace confinement (shared by every path that touches model-named files) ─

/** Resolve `path` inside `workspace`, hard against BOTH traversal and symlinks:
 * the lexical check catches `..`; the realpath check catches a symlinked ancestor
 * or target pointing outside — reads AND writes follow symlinks (a dangling one
 * too, which is why those are rejected outright). Returns the canonical path
 * re-expressed under the caller's `workspace` spelling, so an in-workspace alias
 * (`root -> .`) can't dodge downstream prefix checks like the operator guard. */
export function confine(workspace: string, path: string): string {
  const fail = (): never => {
    throw new Error(`path escapes the workspace: ${path}`);
  };
  let wsReal = workspace;
  try {
    wsReal = realpathSync(workspace);
  } catch {
    // workspace not created yet — lexical check is all we have
  }
  const abs = resolve(workspace, path);
  if (abs !== workspace && !abs.startsWith(`${workspace}/`)) fail();
  // Canonicalize the nearest EXISTING component (deeper ones can't be symlinks yet).
  let probe = wsReal + abs.slice(workspace.length);
  let real = wsReal;
  for (;;) {
    try {
      lstatSync(probe); // exists — even as a dangling symlink
    } catch {
      if (probe === wsReal) break;
      probe = dirname(probe);
      continue;
    }
    try {
      real = realpathSync(probe);
    } catch {
      fail(); // dangling symlink — a write would follow it blind
    }
    break;
  }
  if (real !== wsReal && !real.startsWith(`${wsReal}/`)) fail();
  const canonical = real + (wsReal + abs.slice(workspace.length)).slice(probe.length);
  return workspace + canonical.slice(wsReal.length);
}

// ── image provenance (which markers may become wire blocks) ─────────────────────

// Markers are claim checks, and a claim check anyone can forge is an injection
// vector: a web page or MCP reply containing `[delta:image some/path.png]` must
// NOT silently ship that file to the provider (codex S8 #2). Only paths OUR code
// verified and pointed at — read_file, MCP image saves, inbox arrivals — expand.
// Process-local by design: after a restart the model just re-reads the file (the
// marker text says so), re-registering it.
const attachable = new Set<string>();

export function registerImage(workspace: string, rel: string): void {
  try {
    attachable.add(confine(workspace, rel));
  } catch {
    // an escaping path never becomes attachable
  }
}

// ── mime sniffing (magic bytes first, extension as a hint) ──────────────────────

const MAGIC: Array<[RegExp | null, (b: Uint8Array) => boolean, string]> = [
  [null, (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, "image/png"],
  [null, (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, "image/jpeg"],
  [null, (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38, "image/gif"],
  [
    null,
    (b) =>
      b[0] === 0x52 && // "RIFF" prefix required — WEBP at 8-11 alone misfires on text
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
    "image/webp",
  ],
  [
    null,
    (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
    "application/pdf",
  ],
];

/** Sniff a file's mime from magic bytes; zip containers disambiguate by extension
 * (docx/xlsx/pptx are all zips); otherwise a control-char heuristic splits text
 * from opaque binary. */
export function sniffMime(bytes: Uint8Array, name: string): string {
  // OOB Uint8Array reads are undefined → every comparison is safely false on short files.
  for (const [, test, mime] of MAGIC) if (test(bytes)) return mime;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // zip container — the extension names the flavor
    const ext = name.toLowerCase().split(".").pop() ?? "";
    if (ext === "docx")
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return "application/zip";
  }
  // Text vs binary: any NUL (or a high density of control chars) in the head = binary.
  const head = bytes.subarray(0, 4096);
  let controls = 0;
  for (const b of head) {
    if (b === 0) return "application/octet-stream";
    // 0xfe/0xff never appear in valid UTF-8 — count them with the control chars,
    // else an all-0xff blob sails through as "text" (codex S8 #18).
    if (b < 9 || (b > 13 && b < 32) || b >= 0xfe) controls++;
  }
  return controls > head.length * 0.05 ? "application/octet-stream" : "text/plain";
}

export const isImageMime = (mime: string) => mime.startsWith("image/");

// ── inbox (the byte path: control plane → /v1/files → here) ─────────────────────

const sanitizeName = (name: string) => {
  const clean = basename(name)
    .replace(/[^\w.\- ]/g, "_")
    .trim()
    .slice(0, 120);
  // "." and ".." survive basename+charset — and `inbox/<date>/..` would normalize
  // to the inbox dir itself, bricking later uploads with ENOTDIR (codex S8 #15).
  return !clean || /^\.+$/.test(clean) ? "unnamed" : clean;
};

const FILES_MD_STARTER = `# Files — conventions

- \`inbox/\` is a LANDING ZONE, not a home. File everything that arrives there.
- Organize by topic: \`clients/<name>/\`, \`projects/<name>/\`, \`reference/\`.
- Rename to descriptive kebab-case on filing.
- Keep THIS file the map of the repo: one line per area, update it as you file.
- Deletions go to trash (recoverable ~7 days) via delete_file.
`;

/** Save an uploaded file into the inbox (durable — not a short-TTL
 * store, the agent is expected to FILE it; trash covers deletion instead).
 * Collision → `---<shortid>` suffix (short-id suffix). First save also
 * seeds FILES.md so organization conventions exist from day one. */
export async function saveInbox(
  workspace: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ path: string; size: number; mime: string }> {
  const day = new Date().toISOString().slice(0, 10);
  const clean = sanitizeName(name);
  const dot = clean.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
  // Exclusive create (`wx`), not check-then-write: two concurrent same-name uploads
  // must land as two files, never one silently clobbering the other (codex S8 #14).
  let rel = `inbox/${day}/${clean}`;
  for (;;) {
    const abs = resolve(workspace, rel);
    mkdirSync(dirname(abs), { recursive: true });
    try {
      writeFileSync(abs, bytes, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      rel = `inbox/${day}/${stem}---${crypto.randomUUID().slice(0, 8)}${ext}`;
    }
  }
  const filesMd = resolve(workspace, "FILES.md");
  if (!existsSync(filesMd)) await Bun.write(filesMd, FILES_MD_STARTER);
  const mime = sniffMime(bytes, clean);
  if (isImageMime(mime)) registerImage(workspace, rel); // inbox images are attachable
  return { path: rel, size: bytes.length, mime };
}

// ── trash (reversible delete; hard rm stays in the code CLI) ────────────────────

export function trashFile(workspace: string, rel: string, abs: string): string {
  // uuid slice: two same-basename deletes in the same millisecond must not merge
  // (rename would replace the first recoverable copy — codex S8 #14).
  const dest = resolve(
    workspace,
    `.delta/trash/${Date.now()}-${crypto.randomUUID().slice(0, 6)}-${sanitizeName(rel)}`,
  );
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(abs, dest);
  return dest;
}

/** Boot sweep: trash older than 7 days is gone for good. Best-effort. */
export function sweepTrash(workspace: string, ttlMs = 7 * 24 * 3_600_000): void {
  try {
    const dir = resolve(workspace, ".delta/trash");
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - ttlMs;
    for (const name of readdirSync(dir)) {
      const ts = Number(name.split("-")[0]);
      if (Number.isFinite(ts) && ts < cutoff)
        rmSync(resolve(dir, name), { recursive: true, force: true });
    }
  } catch {
    // sweep is hygiene, never fatal
  }
}

// ── document text extraction (zip+xml extraction is enough) ───────────

const stripXml = (xml: string) =>
  xml
    .replace(/<\/(w:p|si|row)>/g, "\n") // paragraph/cell boundaries → newlines
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) =>
      m === "&amp;" ? "&" : m === "&lt;" ? "<" : m === "&gt;" ? ">" : m === "&quot;" ? '"' : "'",
    )
    .replace(/[ \t]+\n/g, "\n")
    .trim();

/** Extract readable text from a docx/xlsx via the VM's `unzip` (no zip dep in the
 * binary); .ipynb via plain JSON. Returns null when the format isn't extractable
 * here — the caller then points at the code CLI. */
export async function extractDocText(abs: string, mime: string): Promise<string | null> {
  const inner = mime.endsWith("wordprocessingml.document")
    ? "word/document.xml"
    : mime.endsWith("spreadsheetml.sheet")
      ? "xl/sharedStrings.xml"
      : null;
  if (inner) {
    try {
      // Bounded read: a zip bomb decompresses to gigabytes, so cap the stream and
      // kill on overrun/timeout instead of buffering whatever unzip emits
      // (codex S8 #6). stderr is discarded — an undrained pipe deadlocks the child.
      const proc = Bun.spawn(["unzip", "-p", abs, inner], { stdout: "pipe", stderr: "ignore" });
      const kill = setTimeout(() => proc.kill(), 15_000);
      let out = "";
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout) {
        out += dec.decode(chunk as Uint8Array, { stream: true });
        if (out.length > 5_000_000) {
          proc.kill();
          break;
        }
      }
      const code = await proc.exited;
      clearTimeout(kill);
      if (code === 0 && out)
        return (
          stripXml(out) +
          (inner === "xl/sharedStrings.xml"
            ? "\n\n[xlsx: shared TEXT cells only — numbers/formulas/layout need the code tool]"
            : "")
        );
    } catch {
      // unzip absent → fall through to null
    }
    return null;
  }
  if (abs.endsWith(".ipynb")) {
    try {
      const nb = JSON.parse(await Bun.file(abs).text()) as {
        cells?: Array<{ cell_type?: string; source?: string[] | string }>;
      };
      return (nb.cells ?? [])
        .map((c) => {
          const src = Array.isArray(c.source) ? c.source.join("") : (c.source ?? "");
          return `# [${c.cell_type ?? "cell"}]\n${src}`;
        })
        .join("\n\n");
    } catch {
      return null;
    }
  }
  return null;
}

// ── image markers → wire blocks (the multimodal path) ───────────────────────────

/** Expand recent `[delta:image <path>]` markers into ONE trailing user message of
 * real image parts. Ephemeral + derived — never persisted, deterministic given the
 * same transcript+files (resume-safe). Markers OUTSIDE the recent window stay
 * plain text: that IS the prune (an image re-billed every turn is where the token
 * money goes); the model re-reads the file to re-attach. Non-vision models skip
 * expansion entirely — the marker text is its own placeholder. */
export async function expandImageMarkers(
  messages: ChatMsg[],
  workspace: string,
): Promise<ChatMsg[]> {
  // Collect markers from messages within the last N user turns. Tool + user text
  // only: an assistant echoing a marker every answer would otherwise renew the
  // attachment forever, defeating the prune window (codex S8 #10).
  let userTurns = 0;
  const paths: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userTurns < MARKER_WINDOW_USER_TURNS; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user" && typeof m.content === "string") userTurns++;
    const text =
      m.role === "tool" || (m.role === "user" && typeof m.content === "string")
        ? String(m.content)
        : "";
    for (const match of text.matchAll(IMAGE_MARKER_RE)) {
      const p = match[1] as string;
      if (!paths.includes(p)) paths.push(p);
    }
  }
  if (paths.length === 0) return messages;

  // Validate → dedupe on the CANONICAL path → cap. Capping the raw list would let
  // four junk markers suppress a real fifth image, and `a.png` vs `./a.png` would
  // attach the same bytes twice (codex S8 #16).
  const parts: UserPart[] = [];
  const attached: string[] = [];
  const seen = new Set<string>();
  for (const rel of paths) {
    if (parts.length >= MAX_IMAGES_PER_REQUEST) break;
    try {
      const abs = confine(workspace, rel); // symlink-hard; throws on escape
      if (!attachable.has(abs) || seen.has(abs)) continue; // provenance gate (codex S8 #2)
      seen.add(abs);
      if (!existsSync(abs) || statSync(abs).size > MAX_IMAGE_BYTES) continue;
      const bytes = new Uint8Array(await Bun.file(abs).arrayBuffer());
      const mime = sniffMime(bytes, rel);
      if (!isImageMime(mime)) continue;
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` },
      });
      attached.push(rel);
    } catch {
      // unreadable or escaping image → the marker stays a text pointer
    }
  }
  if (parts.length === 0) return messages;
  return [
    ...messages,
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `[attached: ${attached.join(", ")} — the image file(s) referenced above]`,
        },
        ...parts,
      ],
    },
  ];
}
