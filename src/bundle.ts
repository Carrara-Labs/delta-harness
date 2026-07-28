// SPDX-License-Identifier: Apache-2.0
// The bundle manifest — the SINGLE source of truth for the files that make an agent (`agent =
// engine + bundle + state`): each file's name, the base64 env var that seeds it, and whether
// `delta bundle apply` may re-seed it. The FIXED files (POLICY.md, vocab.json, PROMPT_CONTEXT.md)
// are operator-owned and re-seedable; the SELF file (DELTA.md) is the agent's living learned state
// and is write-if-absent ONLY — `apply` never touches it. Every other place that needs "the fixed
// operator set" (the write guard, the cockpit allowlist) derives it from here, so the set can never
// drift or accidentally include DELTA.md (A12).
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SELF_FILE } from "./self";

export { SELF_FILE };

export type BundleEntry = {
  /** Workspace-relative filename. */
  file: string;
  /** The base64 env var the entrypoint/apply decode this file from. */
  envB64: string;
  /** Fixed (operator-owned, re-seedable by `apply`) vs the self file (write-if-absent only). */
  fixed: boolean;
};

export const BUNDLE_MANIFEST: readonly BundleEntry[] = [
  { file: SELF_FILE, envB64: "DELTA_SELF_MD_B64", fixed: false },
  { file: "POLICY.md", envB64: "DELTA_POLICY_MD_B64", fixed: true },
  { file: "vocab.json", envB64: "DELTA_VOCAB_JSON_B64", fixed: true },
  { file: "PROMPT_CONTEXT.md", envB64: "DELTA_CONTEXT_MD_B64", fixed: true },
];

/** The operator-owned fixed files — derived from the manifest so it can never drift from `apply` or
 * accidentally include DELTA.md. Consumed by the write guard (builtins) and the cockpit allowlist. */
export const FIXED_OPERATOR_FILES: ReadonlySet<string> = new Set(
  BUNDLE_MANIFEST.filter((e) => e.fixed).map((e) => e.file),
);

const POLICY_BYTE_CAP = 1_000_000; // mirrors loadPolicy's hard byte cap (policy.ts)
const CHARS_PER_TOKEN = 4; // mirrors policy.ts's token estimate

/** Validate a decoded fixed-file payload the SAME way boot would, so `apply` never installs a file
 * that would boot-loop or be silently neutered. Throws with a clear message on a bad payload. */
function validateFixed(file: string, bytes: Buffer, policyMaxTokens: number): void {
  if (file === "POLICY.md") {
    if (bytes.length > POLICY_BYTE_CAP)
      throw new Error(`POLICY.md is ${bytes.length} bytes — over the 1MB boot cap`);
    // The token-budget cap is the one that would boot-LOOP (loadPolicy throws every restart), so
    // reject it here rather than knowingly install it.
    const approxTokens = Math.ceil(bytes.toString("utf8").length / CHARS_PER_TOKEN);
    if (approxTokens > policyMaxTokens)
      throw new Error(
        `POLICY.md is ~${approxTokens} tokens — over the ${policyMaxTokens}-token budget (would boot-loop)`,
      );
  }
  if (file === "vocab.json") {
    // JSON-syntax alone is not enough: parseVocab silently substitutes a non-object root with the
    // neutral vocab, so a bad payload would install a file the daemon effectively ignores. Require a
    // real JSON object (parseVocab still guards each field at boot).
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("vocab.json is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("vocab.json must be a JSON object");
  }
}

export type ApplyResult = { applied: string[]; skipped: string[] };

/** Re-seed the FIXED operator files from their base64 env vars — never DELTA.md. Validate EVERY
 * present payload first, then stage all temps and rename each into place: a validation failure
 * writes nothing (all-or-nothing at the validation boundary), and the only failure window left is
 * between the renames (microseconds) — a re-run is idempotent (same bytes in → out), so a crash
 * mid-swap self-heals on the next `apply`. Full cross-file atomicity isn't possible with plain
 * files; this is the documented contract. An empty/absent env var means "leave that file as-is". */
export function applyBundle(
  workspace: string,
  policyMaxTokens: number,
  env: Record<string, string | undefined> = process.env,
): ApplyResult {
  const pending: { file: string; bytes: Buffer }[] = [];
  const skipped: string[] = [];
  for (const e of BUNDLE_MANIFEST) {
    if (!e.fixed || e.file === SELF_FILE) continue; // DELTA.md is NEVER re-seeded here (belt + suspenders)
    const b64 = env[e.envB64];
    if (!b64) {
      skipped.push(e.file);
      continue;
    }
    const bytes = Buffer.from(b64, "base64");
    validateFixed(e.file, bytes, policyMaxTokens); // throws → nothing has been written yet
    pending.push({ file: e.file, bytes });
  }
  const staged: { tmp: string; target: string }[] = [];
  for (const p of pending) {
    const target = join(workspace, p.file);
    const tmp = `${target}.apply.${process.pid}`;
    writeFileSync(tmp, p.bytes);
    staged.push({ tmp, target });
  }
  for (const s of staged) renameSync(s.tmp, s.target);
  return { applied: pending.map((p) => p.file), skipped };
}
