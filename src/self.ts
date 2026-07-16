// SPDX-License-Identifier: Apache-2.0
// DELTA.md — the living self-file: the agent's identity (persona/mission/success)
// AND what it has learned. Human- AND agent-editable. This is the self-learning
// surface: after feedback, the agent rewrites its own DELTA.md (via the `remember`
// tool) so the next run is better. Loaded as a RUN-LOCAL snapshot (run.ts) — read
// once at run start, so a self-edit takes effect on the NEXT run and never mutates
// a run mid-flight. Writes are atomic (temp+rename); a successful self-write snapshots
// the prior version into the `self_revisions` table (in the DB — prod: outside the
// workspace; dev: under the reserved `.delta/` dir) with bounded retention, so a bad
// self-edit is revertible. No CAS: concurrent runs are last-writer-wins (a lost note,
// never corruption).

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { elide } from "./tools";

export type Charter = { persona?: string; mission?: string; success?: string };

/** The one fixed filename — no env knob (codex #23: the convention fixes the name). */
export const SELF_FILE = "DELTA.md";
const CHARS_PER_TOKEN = 4;
/** How many prior versions to keep for revert. Bounded so the table can't grow forever. */
const REVISION_RETAIN = 20;

export function selfPath(workspace: string): string {
  return resolve(workspace, SELF_FILE);
}

/** Read DELTA.md into a run-local snapshot: the verbatim text for the spine (capped
 * only as corruption recovery — write-time rejection is the real size guard) plus its
 * parsed persona/mission/success for reflection's success rubric. Fail-open: no file →
 * no identity block (the neutral base persona stands). */
export async function loadSelf(
  workspace: string,
  maxTokens: number,
): Promise<{ text?: string; charter: Charter }> {
  let raw = "";
  try {
    const f = Bun.file(selfPath(workspace));
    if ((await f.exists()) && f.size <= 1_000_000) raw = (await f.text()).trim();
  } catch {
    // unreadable = absent
  }
  if (!raw) return { charter: {} };
  const maxChars = Math.max(1, maxTokens) * CHARS_PER_TOKEN;
  const text = raw.length > maxChars ? elide(raw, maxChars) : raw;
  // Parse the CAPPED text (codex #6): an oversized Success section must not slip into the
  // reflection rubric uncapped — the spine cap has to bound the identity fields too.
  return { text, charter: parseCharterMarkdown(text) };
}

/** The engine-owned spine section headers (see buildSpine). A hand-authored DELTA.md
 * never contains these: the engine wraps DELTA.md's body UNDER `# You` and renders
 * `# Delta` / `# Norms` / `# Tools` / `# Policy` / `# Context` itself. If a `remember`
 * payload carries ≥2 of them, the model has echoed its whole system prompt back as "the new
 * file" — a real failure seen with gpt-5.6-sol (it copied the entire spine into DELTA.md,
 * which would then nest the spine inside itself next run). Two-header threshold so a
 * legit persona that happens to use one of these words as a heading isn't a false trip. */
const SPINE_HEADERS = ["# Delta", "# Norms", "# Context", "# You", "# Policy", "# Tools"];
export function looksLikeSpineEcho(content: string): boolean {
  // trim() (not trimEnd): Markdown allows a heading indented up to 3 spaces, so an echo
  // that arrives space-indented must still be caught (codex #2).
  const lines = new Set(content.split("\n").map((l) => l.trim()));
  return SPINE_HEADERS.filter((h) => lines.has(h)).length >= 2;
}

export type WriteSelfResult = { ok: boolean; error?: string; bytes?: number };

/** Atomically replace DELTA.md with `content`, after snapshotting the current version.
 * Rejects oversized content at WRITE time (codex #16) — the always-on file can't be
 * allowed to grow the spine unbounded. Temp-file + rename means a crash mid-write can
 * never leave a truncated/empty DELTA.md (codex #7). */
export function writeSelf(
  db: Database,
  workspace: string,
  content: string,
  maxBytes: number,
): WriteSelfResult {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes)
    return {
      ok: false,
      error: `DELTA.md would be ${bytes} bytes (cap ${maxBytes}) — compact your notes and rewrite the whole file smaller. It rides in every prompt, so it must stay lean.`,
    };
  const abs = selfPath(workspace);
  const before = existsSync(abs) ? safeRead(abs) : "";
  // Idempotent (codex #2): a same-content re-fire (e.g. crash-resume of the `remember`
  // tool) is a no-op — no rewrite, no duplicate revision.
  if (before === content) return { ok: true, bytes };
  // Collision-resistant temp (codex #4): Date.now() alone collides under a same-ms double
  // write; add randomness and create it EXCLUSIVELY so two writers can't share a temp.
  const tmp = `${abs}.${Date.now()}.${Math.floor(Math.random() * 1e9)}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, abs); // atomic on the same filesystem — never a partial file
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    return { ok: false, error: `could not write DELTA.md: ${String(e)}` };
  }
  // Snapshot the prior version only AFTER a successful rename (codex #3): a failed write
  // must not evict a good old revision via retention pruning.
  if (before) snapshot(db, before);
  return { ok: true, bytes };
}

export type Revision = { id: number; ts: number; content: string };

/** Current DELTA.md content (for the Cockpit diff). */
export function currentSelf(workspace: string): string {
  const abs = selfPath(workspace);
  return existsSync(abs) ? safeRead(abs) : "";
}

/** Prior versions, newest first (for the Cockpit revert UI). */
export function listRevisions(db: Database, limit = REVISION_RETAIN): Revision[] {
  return db
    .query("SELECT id, ts, content FROM self_revisions ORDER BY id DESC LIMIT ?")
    .all(limit) as Revision[];
}

/** Restore a prior version. Goes through writeSelf, so the current (pre-revert) text is
 * itself snapshotted first — revert is undoable. */
export function revertSelf(
  db: Database,
  workspace: string,
  revisionId: number,
  maxBytes: number,
): WriteSelfResult {
  const row = db.query("SELECT content FROM self_revisions WHERE id = ?").get(revisionId) as {
    content: string;
  } | null;
  if (!row) return { ok: false, error: `no such revision: ${revisionId}` };
  return writeSelf(db, workspace, row.content, maxBytes);
}

function snapshot(db: Database, content: string): void {
  db.query("INSERT INTO self_revisions (ts, content) VALUES (?, ?)").run(Date.now(), content);
  // Bounded retention — keep only the most recent REVISION_RETAIN rows.
  db.query(
    "DELETE FROM self_revisions WHERE id NOT IN (SELECT id FROM self_revisions ORDER BY id DESC LIMIT ?)",
  ).run(REVISION_RETAIN);
}

function safeRead(abs: string): string {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

/** Parse DELTA.md's identity sections (persona / mission / success) for reflection's
 * success rubric. Sections are keyed by heading keyword; a headingless file is taken
 * whole as the persona. Learned-notes sections are simply ignored here (they ride the
 * spine verbatim via loadSelf's `text`, not parsed). */
export function parseCharterMarkdown(text: string): Charter {
  const buf: Record<keyof Charter, string[]> = { persona: [], mission: [], success: [] };
  let cur: keyof Charter | null = null;
  let sawHeading = false;
  for (const line of text.split("\n")) {
    const h = line.match(/^#{1,4}\s*(.+?)\s*$/);
    if (h) {
      const t = (h[1] as string).toLowerCase();
      cur = /persona|role|who/.test(t)
        ? "persona"
        : /mission|goal|objective/.test(t)
          ? "mission"
          : /success|done|winning/.test(t)
            ? "success"
            : null;
      sawHeading = true;
      continue;
    }
    if (cur) buf[cur].push(line);
  }
  if (!sawHeading) {
    const whole = text.trim();
    return whole ? { persona: whole } : {};
  }
  const out: Charter = {};
  for (const k of ["persona", "mission", "success"] as const) {
    const v = buf[k].join("\n").trim();
    if (v) out[k] = v;
  }
  return out;
}
