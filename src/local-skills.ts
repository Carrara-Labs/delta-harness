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
  const description = block.match(/^description:\s*([^\r\n]+)\s*$/m)?.[1]?.trim() ?? "";
  return NAME.test(name) && description ? { name, description: description.slice(0, 200) } : null;
}

export class LocalSkillsAdapter implements CapabilityAdapter {
  readonly binding = "local-skills-v1";
  private readonly root: string;
  private readonly refs = new Map<string, SkillRef>();
  private bound = false;

  constructor(workspace: string) {
    this.root = resolve(workspace, "skills");
    try {
      const root = lstatSync(this.root);
      if (!root.isDirectory() || root.isSymbolicLink()) return;
      accessSync(this.root, constants.R_OK);
      this.bound = true;
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
