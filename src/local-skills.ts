// SPDX-License-Identifier: Apache-2.0
// Read-only local capability binding: direct skills/<name>/SKILL.md entries, loaded at boot.

import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import type { CapabilityAdapter, RoleHealth, SkillRef } from "./adapters";
import type { ToolCtx } from "./tools";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONT_MAX = 8_192;
const FILE_MAX = 1_000_000;

function prefix(path: string): string {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(FRONT_MAX);
    return bytes.subarray(0, readSync(fd, bytes)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function metadata(text: string): { name: string; description: string } | null {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!block) return null;
  const name = block.match(/^name:\s*([^\r\n]+)\s*$/m)?.[1]?.trim() ?? "";
  let description = block.match(/^description:\s*([^\r\n]*)\s*$/m)?.[1]?.trim() ?? "";
  // D-4: a YAML folded/literal block scalar (`description: >` / `|`, with chomping/indent
  // suffixes) captures only the indicator — the skill then REGISTERS but search() can never
  // surface it, because scoring reads name+description only. No YAML parser (zero runtime
  // deps): accept the block form by joining the indented continuation lines. Claude Code
  // parses real YAML, so the identical file works on a laptop and was invisible here.
  if (description === "" || /^[>|][+\-0-9]*$/.test(description)) {
    const after = block.slice(block.indexOf("description:"));
    const kept: string[] = [];
    // Stop at the first non-indented, non-blank line — that is the NEXT top-level YAML key,
    // and collecting past it would fold unrelated nested metadata into the searchable text.
    for (const l of after.split(/\r?\n/).slice(1)) {
      if (/^\s+\S/.test(l)) kept.push(l.trim());
      else if (l.trim() !== "") break;
    }
    description = kept.join(" ").trim();
  }
  if (NAME.test(name) && description.length > 0 && description.length < 10)
    // The warning matters more than the parse: a real description is never under ten
    // characters, and this defect class is defined by its silence.
    console.error(
      `delta: skill '${name}' has a ${description.length}-char description — it will be nearly unretrievable by search. Write a real one.`,
    );
  return NAME.test(name) && description ? { name, description: description.slice(0, 200) } : null;
}

export class LocalSkillsAdapter implements CapabilityAdapter {
  readonly binding = "local-skills-v1";
  private readonly root: string;
  private readonly refs = new Map<string, SkillRef>();
  private bound = false;

  private fingerprint = "";

  constructor(workspace: string) {
    this.root = resolve(workspace, "skills");
    this.scan();
  }

  /** Stat each skill dir's own SKILL.md, not the parent directory — a mutated file inside an
   * existing dir does not reliably move the parent's mtime, and re-description is exactly the
   * case operators expect a re-scan to catch (D-5, review-corrected). A handful of stats. */
  private stamp(): string {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.isSymbolicLink())
        .map((e) => {
          try {
            const st = lstatSync(resolve(this.root, e.name, "SKILL.md"));
            // mtime AND size: a same-timestamp rewrite (metadata-preserving deploys) would
            // otherwise stay stale forever.
            return `${e.name}:${st.mtimeMs}:${st.size}`;
          } catch {
            return `${e.name}:-`;
          }
        })
        .sort()
        .join("|");
    } catch {
      return "";
    }
  }

  private scan(): void {
    this.refs.clear();
    this.bound = false;
    try {
      const root = lstatSync(this.root);
      if (!root.isDirectory() || root.isSymbolicLink()) return;
      accessSync(this.root, constants.R_OK);
      this.bound = true;
      this.fingerprint = this.stamp();
      for (const entry of readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try {
          const file = resolve(this.root, entry.name, "SKILL.md");
          const stat = lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_MAX) continue;
          const meta = metadata(prefix(file));
          if (!meta || meta.name !== entry.name) continue;
          this.refs.set(meta.name, {
            ...meta,
            version: 1,
            location: `skills/${entry.name}/SKILL.md`,
          });
        } catch {}
      }
    } catch {
      // Missing/unreadable/malformed trees are simply unbound or sparse.
    }
  }

  health(): RoleHealth {
    return this.bound ? "bound" : "unbound";
  }

  async search(query: string, _ctx?: ToolCtx): Promise<SkillRef[]> {
    // D-5: the index was built once, in the constructor — a skill added, renamed, or
    // re-described afterwards loaded by NAME but was invisible to search until a daemon
    // restart (one deployment ran a 2-minute external restart timer to work around it).
    // Re-scan behind a per-file mtime fingerprint; never a watcher — a watcher is a timer
    // by another name and this daemon must be able to suspend.
    if (this.stamp() !== this.fingerprint) this.scan();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.refs.values()].sort((a, b) => {
      const score = (r: SkillRef) =>
        words.filter((w) => `${r.name} ${r.description ?? ""}`.toLowerCase().includes(w)).length;
      return score(b) - score(a) || a.name.localeCompare(b.name);
    });
  }

  async get(name: string, _ctx: ToolCtx): Promise<{ version: number; body: string } | null> {
    if (!this.refs.has(name)) return null;
    try {
      const dir = lstatSync(resolve(this.root, name));
      const file = resolve(this.root, name, "SKILL.md");
      const stat = lstatSync(file);
      if (
        !dir.isDirectory() ||
        dir.isSymbolicLink() ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > FILE_MAX
      )
        return null;
      const raw = readFileSync(file, "utf8");
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
      return { version: 1, body };
    } catch {
      return null;
    }
  }
}
