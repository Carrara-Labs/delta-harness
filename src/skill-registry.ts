// SPDX-License-Identifier: Apache-2.0
// Skill promotion (spec §F / G5b) — the DEFAULT capability backend (the skill registry). This is
// the SkillRegistryAdapter's private implementation: all the skill-registry-specific verb
// regexes, field names, JSON extraction, and the version_conflict retry live here, and
// ONLY adapter-defaults.ts imports this module. The binary talks to CapabilityAdapter, never to
// a skill-registry field name (codex P1 — the real portability seam). Skill improvements are
// PROPOSED, never asserted (same review norm as knowledge-base writes); degrades if none exists.

import type { SkillProposal, SkillRef } from "./adapters";
import type { ToolCtx, Tools } from "./tools";

// the skill registry registers create + update (+ optionally a single propose) verbs. Route to
// the one whose required args we're about to send: update needs `base_version`,
// create needs `description`. A `propose` verb (matches CREATE_RE) takes create args.
const CREATE_RE = /skill.*(create|propose)/i;
const UPDATE_RE = /skill.*update/i;
export const SKILL_WRITE_RE = /skill.*(create|update|propose)/i;
/** Find a skill-registry write tool by verb (read tools are get/list/search — excluded). */
export function findSkillTool(tools: Tools, re: RegExp) {
  return [...tools.values()].find((t) => re.test(t.name));
}

/** Read tools match by exact suffix, not regex — the skill registry also registers
 * skill_file_get / skill_versions, which a loose /skill.*get/ would catch. */
function findSkillRead(tools: Tools, suffix: string) {
  return [...tools.values()].find((t) => t.name.endsWith(suffix));
}

/** Pull `"key": value` out of a JSON-ish tool reply without trusting its envelope
 * shape (the skill registry returns JSON, but nested/wrapped shapes vary by deployment). */
function extractField(text: string, key: string): string | null {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|\\d+)`));
  if (!m?.[1]) return null;
  return m[1].startsWith('"') ? (JSON.parse(m[1]) as string) : m[1];
}

/** Latest version (+ body when present) of an existing skill by EXACT name; null
 * when the skill is absent or no skill-registry read tool is connected — the caller then
 * creates, which is today's behavior. Sprint 5: this is what makes vN+1 reachable. */
export async function findSkillBase(
  tools: Tools,
  ctx: ToolCtx,
  name: string,
): Promise<{ version: number; body: string } | null> {
  const get = findSkillRead(tools, "skill_get");
  if (!get) return null;
  try {
    const out = await get.execute({ name }, ctx);
    if (out.startsWith("[tool error]")) return null;
    // Missing field must NOT read as v0 (Number(null) === 0 is finite): a changed
    // success envelope means "can't resolve", which routes to CREATE, not a bogus
    // update against base_version 0.
    const raw = extractField(out, "version");
    if (raw === null) return null;
    const version = Number(raw);
    if (!Number.isFinite(version) || version < 1) return null;
    return { version, body: extractField(out, "body") ?? "" };
  } catch {
    return null;
  }
}

/** Structured skill directory for a task — the capability store's search surface,
 * parsed from whatever JSON shape the backend returns (name is the anchor). Empty
 * when no read tool is connected or the reply is unusable. The adapter's search(). */
export async function searchSkills(tools: Tools, ctx: ToolCtx, limit = 25): Promise<SkillRef[]> {
  const search = findSkillRead(tools, "skill_search");
  if (!search) return [];
  try {
    const out = await search.execute({ limit }, ctx);
    if (out.startsWith("[tool error]")) return [];
    const refs: SkillRef[] = [];
    for (const m of out.matchAll(
      /"name"\s*:\s*"((?:[^"\\]|\\.)*)"(?:[^{}]*?"description"\s*:\s*"((?:[^"\\]|\\.)*)")?/g,
    )) {
      if (m[1]) refs.push({ name: m[1], ...(m[2] ? { description: m[2].slice(0, 120) } : {}) });
      if (refs.length >= limit) break;
    }
    return refs;
  } catch {
    return [];
  }
}

/** Propose a new/improved skill version. Returns the tool's reply, or null when no
 * skill-registry write tool is connected (the caller then degrades to a knowledge-base learning).
 *
 * the skill registry writes land as immutable versions (no separate review queue): a create is
 * v1, an update is base_version+1 with optimistic concurrency. We send the EXACT keys
 * each verb requires — `base_version` for update, `description` for create — and route
 * to the matching tool so unknown-key-strict deployments don't reject the call. */
export async function proposeSkill(
  tools: Tools,
  ctx: ToolCtx,
  proposal: SkillProposal,
): Promise<string | null> {
  const improving = proposal.basedOnVersion !== undefined;
  const tool =
    (improving ? findSkillTool(tools, UPDATE_RE) : findSkillTool(tools, CREATE_RE)) ??
    findSkillTool(tools, SKILL_WRITE_RE);
  if (!tool) return null;

  const args: Record<string, unknown> = { name: proposal.name, body: proposal.body };
  if (proposal.note) {
    // snake + camel — the skill registry uses change_summary; another deployment may differ.
    args.change_summary = proposal.note;
    args.changeSummary = proposal.note;
  }
  if (improving) {
    const base = Number(proposal.basedOnVersion);
    if (Number.isFinite(base)) {
      args.base_version = base;
      args.baseVersion = base;
    }
  } else {
    args.description = ensureDescription(proposal.description, proposal.body);
  }
  const res = await tool.execute(args, ctx);
  // the skill registry's documented optimistic-concurrency contract: on version_conflict,
  // re-read the latest version and retry ONCE with the fresh base. A second
  // conflict → null → the caller's degrade path (a [skill-candidate] learning).
  if (improving && res.startsWith("[tool error]") && /version[_ ]conflict/i.test(res)) {
    const fresh = await findSkillBase(tools, ctx, proposal.name);
    if (fresh) {
      const retry = await tool.execute(
        {
          ...args,
          // Re-merge against the FRESH body — a stale merged body would overwrite
          // whatever the concurrent publisher just added.
          ...(proposal.rebuild ? { body: proposal.rebuild(fresh.body) } : {}),
          base_version: fresh.version,
          baseVersion: fresh.version,
        },
        ctx,
      );
      return retry.startsWith("[tool error]") ? null : retry;
    }
  }
  return res.startsWith("[tool error]") ? null : res;
}

/** the skill registry's skill_create requires a 20–1024 char description (the search surface).
 * Prefer the caller's; else derive one from the body's first non-empty line so a
 * reflection-driven create never fails validation on a too-short description. */
function ensureDescription(desc: string | undefined, body: string): string {
  const d = (desc ?? "").trim();
  if (d.length >= 20) return d.slice(0, 1024);
  const firstLine =
    body
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? body.trim();
  const derived = (d ? `${d}. ${firstLine}` : firstLine).trim();
  return (derived.length >= 20 ? derived : `${derived} — a reusable skill.`).slice(0, 1024);
}
