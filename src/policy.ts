// SPDX-License-Identifier: Apache-2.0
// POLICY.md — the fixed operating contract: the review rail + any non-negotiable
// operator rules. Operator-owned, read-only to the agent, loaded once at boot into
// the cached prefix, and rendered LAST + ALWAYS (see spine.ts) so no writable text
// above it can follow and contradict it. A generic review-rail default ships
// embedded (DEFAULT_POLICY), so a zero-file boot behaves exactly as before.
// "binary owns mechanism, POLICY owns meaning." The filename is fixed (no env knob).
// Boot-time load (rare edits, restart to apply). Grounded in fixed-name
// discovery + a warn-and-cap budget + chars/4 counting.

import { resolve } from "node:path";
import type { Vocab } from "./vocab";

export type Policy = {
  /** Vocab-keyed template. Always present — the embedded default when no file. */
  template: string;
  /** True when the operator supplied POLICY.md (then it renders on every placement);
   * false = the embedded default (renders only when a write rail is present, so a
   * pure-chat placement stays minimal). */
  fromFile: boolean;
};

const CHARS_PER_TOKEN = 4; // coarse estimate — good enough for a guard

/** The default review-rail policy — vocab-keyed prose. `{{writeTool}}` resolves per
 * spine build (it needs the connected registry); the nouns resolve from vocab. */
export const DEFAULT_POLICY = `- {{writeNoun}} writes go ONLY through {{writeTool}}: bundle your deliverable, a one-line summary of what you did, and the changes you propose into ONE {{itemNoun}} a human approves, stamped with {{runRefKey}} so the review links back to this run.
- Intake: when someone asks you to take on new multi-step or ambiguous work, propose a PLAN first — each step a {{taskNoun}} assigned to you, under a real project — for a human to approve before you run them, instead of silently starting. Small, clear asks (or a {{taskNoun}} already assigned to you): just do them, then propose the result.
- Before you start or propose, check your own open work first (your {{itemNoun}}s/{{taskNoun}}s): resume or revise what's there — never duplicate a {{taskNoun}} or a proposal.
- If a reviewer requests changes, revise the SAME item (supersede it), carrying forward everything they didn't ask you to change; don't open a new one.`;

/** Load POLICY.md once at boot. Fixed filename, workspace-confined. Fail-open on a
 * missing/unreadable file (the embedded default stands). But a fixed POLICY that
 * OVERFLOWS the spine budget FAILS BOOT loudly (codex #18) — we never elide a rule's
 * middle, because a silently half-rendered contract is worse than no boot. */
export async function loadPolicy(workspace: string, maxTokens: number): Promise<Policy> {
  const abs = resolve(workspace, "POLICY.md");
  let text: string | undefined;
  try {
    const f = Bun.file(abs);
    if (await f.exists()) {
      if (f.size > 1_000_000)
        throw new BootError(`POLICY.md is ${f.size} bytes — too large (cap 1MB). Trim it.`);
      // Strip HTML comments, then require at least one non-heading, non-blank line — so the
      // comment-only file `delta init` scaffolds (a `# Policy` heading + a guidance comment)
      // still uses the embedded review-rail default (it promises exactly that), instead of
      // silently replacing the rail with an empty policy.
      const cleaned = (await f.text()).replace(/<!--[\s\S]*?-->/g, "").trim();
      const hasRule = cleaned.split("\n").some((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()));
      text = hasRule ? cleaned : undefined;
    }
  } catch (e) {
    if (e instanceof BootError) throw e; // oversized → abort boot
    // unreadable = absent → embedded default (fail-open)
  }
  if (!text) return { template: DEFAULT_POLICY, fromFile: false };
  const maxChars = Math.max(1, maxTokens) * CHARS_PER_TOKEN;
  if (text.length > maxChars)
    throw new BootError(
      `POLICY.md is ~${Math.ceil(text.length / CHARS_PER_TOKEN)} tokens (budget ${maxTokens}) — trim it. Fixed policy is never elided (that would drop a rule's middle); boot fails instead.`,
    );
  return { template: text, fromFile: true };
}

/** A boot-fatal misconfiguration (distinct from a fail-open miss). */
export class BootError extends Error {}

/** Interpolate the policy per spine build. Deterministic string ops → the rendered
 * block is byte-stable while the write-tool name is stable, so the cached prefix
 * survives. Unknown placeholders render as-is — visible, not silently blank. */
export function renderPolicy(template: string, v: Vocab, writeToolName: string): string {
  const vars: Record<string, string> = {
    writeNoun: v.writeNoun,
    writeTool: writeToolName,
    runRefKey: v.runRefKey,
    taskNoun: v.taskNoun,
    itemNoun: v.itemNoun,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}
