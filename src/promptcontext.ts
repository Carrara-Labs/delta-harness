// SPDX-License-Identifier: Apache-2.0
// Dynamic prompt context (PROMPT_CONTEXT.md) — a dead-simple way for a dev to inject
// live values into the prompt. Two sections, placed by the cache rule:
//   ## Stable — resolved ONCE at boot, rides the cached system prefix (boot-stable vars
//               only: engine version, agent id, profile).
//   ## Turn   — resolved PER TURN, rides a user-role message (never the cached prefix, so
//               volatile values never bust the cache): the model, date/time/timezone, and
//               request.* (the worked example — geo/ip the caller passes in metadata).
//
// A dev adds a variable with ZERO code: put it in the request's `metadata.context` and
// reference `{{request.<key>}}` in PROMPT_CONTEXT.md. For computed vars, extend
// `customTurnVars` below (the single extension point). No file ⇒ nothing rendered.

import { resolve } from "node:path";

export type PromptContext = { stable?: string; turn?: string };

/** Parse PROMPT_CONTEXT.md into its `## Stable` / `## Turn` sections. Fail-open: a
 * missing/unreadable/oversized file yields an empty context (zero cost). */
export async function loadPromptContext(workspace: string): Promise<PromptContext> {
  let raw = "";
  try {
    const f = Bun.file(resolve(workspace, "PROMPT_CONTEXT.md"));
    if ((await f.exists()) && f.size <= 100_000) raw = await f.text();
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  return { stable: section(raw, "stable"), turn: section(raw, "turn") };
}

/** Extract the body under a `## <name>` heading, up to the next `## ` heading or EOF. */
function section(text: string, name: string): string | undefined {
  const want = name.toLowerCase();
  let capturing = false;
  const buf: string[] = [];
  for (const line of text.split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      capturing = (h[1] as string).toLowerCase() === want;
      continue;
    }
    if (capturing) buf.push(line);
  }
  const body = buf.join("\n").trim();
  return body || undefined;
}

/** Interpolate `{{a.b}}` placeholders (dots allowed) from `vars`. An unknown placeholder
 * renders literally — visible, never silently blank (codex). */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

/** Boot-stable variables for the `## Stable` section (rendered once, into the cached prefix). */
export function stableVars(input: {
  engineVersion: string;
  agentId?: string;
  profile?: string;
}): Record<string, string> {
  return {
    "engine.version": scalar(input.engineVersion),
    "agent.id": scalar(input.agentId ?? ""),
    profile: scalar(input.profile ?? ""),
  };
}

/** Per-turn variables for the `## Turn` section (rendered every turn, into a user message).
 * Volatile by nature — the actual model, the clock, and request-scoped metadata. */
export function turnVars(input: {
  model?: string;
  now?: Date;
  metadata?: Record<string, unknown>;
}): Record<string, string> {
  const now = input.now ?? new Date();
  const vars: Record<string, string> = {
    model: scalar(input.model ?? ""),
    "now.iso": now.toISOString(),
    "now.date": now.toISOString().slice(0, 10),
    "now.tz": timezone(),
  };
  // request.* — the worked example: every key the caller puts in `metadata.context` is
  // exposed as `{{request.<key>}}` (city / country / ip / …). Metadata is UNTRUSTED DATA,
  // not instructions: each value is normalized to a bounded single-line scalar, and the
  // key count/shape is capped (codex #14) so a hostile caller can't inflate the prompt.
  const reqctx = (input.metadata?.context ?? {}) as Record<string, unknown>;
  if (reqctx && typeof reqctx === "object")
    for (const [k, v] of Object.entries(reqctx).slice(0, 24))
      if (/^[\w.-]{1,40}$/.test(k)) vars[`request.${k}`] = scalar(v);
  // Built-in vars WIN over custom (codex #13): a custom provider can't shadow {{model}} etc.
  return { ...customTurnVars(input), ...vars };
}

/** The single extension point for computed dynamic vars. Ships empty — add your own here
 * (e.g. a geo-IP lookup keyed off `metadata.context.ip`). Keep returns single-line scalars. */
function customTurnVars(_input: { metadata?: Record<string, unknown> }): Record<string, string> {
  return {};
}

function timezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Normalize an interpolated value to a bounded, single-line string — request metadata is
 * data, never instruction text. Strips C0/C1 control + bidi-override chars (codex #13) so a
 * value can't smuggle a newline/heading or reorder text, then collapses whitespace + caps. */
function scalar(v: unknown): string {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  // Neutralize a value so it can't reshape the template: drop C0/C1 controls (incl. the
  // newlines that could smuggle a fake heading) and bidi overrides (codex #13), turning
  // each into a space; then collapse whitespace and cap the length. Metadata is DATA.
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const bad =
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069);
    out += bad ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 200);
}
