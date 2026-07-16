// SPDX-License-Identifier: Apache-2.0
// Product vocabulary — the portability seam. Everything product-specific about the
// propose → revise → execute review loop reduces to these few bindings, so the SAME
// lean spine + loop serves any review-rail product. A daemon serves ONE product (one
// placement), so vocab is a boot constant (env-overridable via DELTA_VOCAB or a
// vocab.json in the bundle), never per-run. The engine's default is NEUTRAL — a
// generic review rail that names no product; a product supplies its own vocab.
//
// What stays out of here (still config, already agnostic): which MCP servers to
// connect (DELTA_MCP_SERVERS), which read tools hydrate (DELTA_HYDRATE_TOOLS), and
// where the charter comes from (DELTA_CHARTER_TOOL/FILES). Vocab is only the loop's
// noun/tool bindings.

export type Vocab = {
  /** Everyday verbs pinned resident, matched by the `__<verb>` suffix so the
   *  product's MCP server name is irrelevant. The lean core; the rest ride search_tools. */
  coreVerbs: string[];
  /** THE single reviewed-write tool's verb suffix — the one rail every ACT goes through. */
  writeVerbSuffix: string;
  /** What to call the system of record in the norms ("Knowledge Base", "ATS", …). This is the
   *  product's IDENTITY noun, not throwaway wording: the memory namespace derives from it
   *  by default, so renaming it re-scopes memory (pin DELTA_MEMORY_NAMESPACE to change the
   *  wording without re-scoping). */
  writeNoun: string;
  /** Run-stamp key the write carries so a review links back to this run. */
  runRefKey: string;
  /** target_kind a distilled learning is proposed under. */
  learningTargetKind: string;
  /** The unit of assigned work in the playbook prose ("task", "search", …). */
  taskNoun: string;
  /** The unit a human reviews ("review item", "change request", …). */
  itemNoun: string;
  /** Metadata keys that scope hydration to a subject. Each key K is probed on run
   *  metadata as K, K_id, and KId. Empty array = never subject-scope (the
   *  task-keyed search still runs). */
  subjectKeys: string[];
  /** Declarative arg template for the write tool — the mechanism half of reuse
   *  (Sprint 6). A JSON value whose string leaves interpolate {{run_id}} {{kind}}
   *  {{content}} {{confidence}} {{target_kind}} {{summary}} {{brief}}
   *  {{run_ref_key}}. A leaf that is EXACTLY one placeholder resolves to the typed
   *  value, and its key is DROPPED when the value is absent. Absent writeShape →
   *  the built-in review envelope (output/actions_brief/items). A product owns its schema.
   *  Declarative (not a function) so DELTA_VOCAB alone retargets it — no recompile. */
  writeShape?: unknown;
};

export const NEUTRAL_VOCAB: Vocab = {
  // No product verbs pinned by default — the builtin file/web/code tools are always
  // registered regardless, so a bare agent works; a product names its own core surface.
  coreVerbs: [],
  writeVerbSuffix: "propose_change",
  writeNoun: "the record",
  runRefKey: "run_ref",
  learningTargetKind: "note",
  taskNoun: "task",
  itemNoun: "review item",
  subjectKeys: [],
  // no writeShape — the built-in review envelope is the default
};

/** Resolve the daemon's vocab: the NEUTRAL default, with any DELTA_VOCAB JSON overriding
 * the fields it names. Malformed → neutral default, logged, never fatal (config style). */
export function parseVocab(raw: string | undefined): Vocab {
  if (!raw) return NEUTRAL_VOCAB;
  try {
    const p = JSON.parse(raw) as Partial<Vocab>;
    // writeShape root must be a plain object — null/string/array roots would type-
    // confuse the MCP arguments and silently disable reflection writes (codex #6).
    const shapeOk =
      p.writeShape === undefined ||
      (typeof p.writeShape === "object" && p.writeShape !== null && !Array.isArray(p.writeShape));
    if (!shapeOk) {
      console.error("delta: DELTA_VOCAB writeShape must be a JSON object — ignoring it.");
      p.writeShape = undefined;
    }
    // Validate EVERY field, not just the containers — untrusted JSON like
    // {"writeNoun":42} or {"subjectKeys":[1]} must fall open, never crash boot later
    // (a number reaches `.toLowerCase()` in the namespace derivation; a non-string
    // subjectKey reaches hydration). Config style: guard, don't trust.
    const str = (v: unknown, fb: string) => (typeof v === "string" && v ? v : fb);
    const strArr = (v: unknown, fb: string[]) =>
      Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fb;
    return {
      writeShape: p.writeShape,
      coreVerbs: strArr(p.coreVerbs, NEUTRAL_VOCAB.coreVerbs),
      subjectKeys: strArr(p.subjectKeys, NEUTRAL_VOCAB.subjectKeys),
      writeNoun: str(p.writeNoun, NEUTRAL_VOCAB.writeNoun),
      runRefKey: str(p.runRefKey, NEUTRAL_VOCAB.runRefKey),
      learningTargetKind: str(p.learningTargetKind, NEUTRAL_VOCAB.learningTargetKind),
      taskNoun: str(p.taskNoun, NEUTRAL_VOCAB.taskNoun),
      itemNoun: str(p.itemNoun, NEUTRAL_VOCAB.itemNoun),
      // An empty suffix would endsWith-match EVERY tool — the write rail must name one
      // (codex #3: reflection would fire a learning envelope at web_search).
      writeVerbSuffix: str(p.writeVerbSuffix, NEUTRAL_VOCAB.writeVerbSuffix),
    };
  } catch {
    console.error("delta: DELTA_VOCAB is not valid JSON — using the neutral vocabulary.");
    return NEUTRAL_VOCAB;
  }
}

/** Everything reflect.ts knows when it writes a learning through the product's
 * write rail — the input to the write-args mapping. */
export type LearningWrite = {
  runId: string;
  kind: string;
  content: string;
  confidence?: number;
  /** Review-grounded provenance (Sprint 5). */
  review: boolean;
};

/** Map a distilled learning onto the product write tool's args. The default is the
 * built-in review envelope; a writeShape replaces
 * it wholesale — the product owns its schema, there is no merging. */
export function buildWriteArgs(v: Vocab, w: LearningWrite): Record<string, unknown> {
  const summary = `Reflection (${w.kind}) from run ${w.runId}`;
  const brief = `Post-${w.review ? "review (review-grounded)" : "task"} reflection. ${w.content} (self-rated confidence ${w.confidence ?? "n/a"}).`;
  if (v.writeShape === undefined) {
    // The NEUTRAL default envelope — generic review-proposal field names, no product's
    // schema baked in. A product whose write tool wants a different shape supplies a
    // writeShape (e.g. the knowledge-base bundle carries its exact output/actions_brief/items).
    return {
      summary,
      details: brief,
      [v.runRefKey]: w.runId,
      items: [
        {
          kind: v.learningTargetKind,
          content: w.content,
          ...(typeof w.confidence === "number" ? { confidence: w.confidence } : {}),
        },
      ],
    };
  }
  const vars: Record<string, string | number | undefined> = {
    run_id: w.runId,
    kind: w.kind,
    content: w.content,
    confidence: w.confidence,
    target_kind: v.learningTargetKind,
    summary,
    brief,
    run_ref_key: v.runRefKey,
  };
  return render(v.writeShape, vars) as Record<string, unknown>;
}

/** Recursive template render: an exact "{{x}}" leaf becomes the TYPED value (and
 * its key/slot is dropped when undefined); composite strings interpolate as text;
 * arrays/objects walk recursively. Hardened (codex #10): own-key lookups only
 * ({{constructor}} must not resolve Object.prototype), `__proto__`-family shape
 * keys are skipped, and absent array leaves are omitted, not serialized as null. */
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function render(node: unknown, vars: Record<string, string | number | undefined>): unknown {
  const lookup = (k: string) => (Object.hasOwn(vars, k) ? vars[k] : undefined);
  if (typeof node === "string") {
    const exact = node.match(/^\{\{(\w+)\}\}$/);
    if (exact) return lookup(exact[1] as string);
    return node.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(lookup(k) ?? ""));
  }
  if (Array.isArray(node)) return node.map((n) => render(n, vars)).filter((n) => n !== undefined);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(node)) {
      if (BANNED_KEYS.has(k)) continue;
      const r = render(val, vars);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return node;
}
