// SPDX-License-Identifier: Apache-2.0
// The store-role adapters — the real portability seam (v3.1 §1.8). This module is the
// pure CONTRACT: two role interfaces + backend-neutral types/helpers, with ZERO backend
// imports. The binary talks to two ROLES, never to a backend by name:
//   • CapabilityAdapter — versioned reusable procedures (default: the skill registry).
//   • CuratedAdapter   — cross-agent, human-curated knowledge (default: the knowledge base).
// Delta's batteries-included default bindings live in adapter-defaults.ts (the only
// module that imports skill-registry.ts / vocab.ts). A product building on the harness imports
// THIS file + its own adapters and never bundles skill-registry/knowledge-base (codex P1). Reuse = an
// adapter binding + a bundle (DELTA.md/POLICY.md/vocab.json) + a few env vars.

import type { ToolCtx } from "./tools";

/** A skill the capability store can surface for a task — the structured unit the
 * binary renders. The adapter owns how it's pulled from the backend's reply. */
export type SkillRef = { name: string; description?: string; version?: number };

/** A proposed new/improved procedure — the neutral input to CapabilityAdapter.propose. */
export type SkillProposal = {
  name: string;
  /** The improved procedure body — imperative steps, not a one-liner. */
  body: string;
  /** Search-surface description for a NEW procedure (ignored when improving one). */
  description?: string;
  /** The version this improves on, when known → an UPDATE. Absent → a CREATE. */
  basedOnVersion?: number | string;
  /** Rebuild the body from a FRESH base on a version conflict, so a concurrent
   * publisher's changes survive the retry (the backend may REPLACE, not append). */
  rebuild?: (freshBody: string) => string;
  /** Why this change — carried into the backend's change summary. */
  note?: string;
};

/** v(N+1) body = v(N) body + a dated improvement section. Append, don't rewrite:
 * deterministic, lossless, zero model tokens; the backend's version history keeps
 * the evolution legible, and consolidation is a later curator concern. */
export function mergeSkillBody(prev: string, add: string): string {
  if (!prev.trim()) return add.trim();
  return `${prev.trimEnd()}\n\n## Improvement (${new Date().toISOString().slice(0, 10)})\n${add.trim()}`;
}

/** Render structured refs into the one-line-per-skill index the reflect prompt expects. */
export function renderSkillIndex(refs: SkillRef[]): string {
  return refs.map((r) => `- ${r.name}${r.description ? ` — ${r.description}` : ""}`).join("\n");
}

/** Whether a store role is usable this run. `unbound` = no backend configured (the
 * local rail absorbs the artifact); `unreachable` = configured but the backend is
 * down (surfaced to the model so it doesn't silently repeat a corrected mistake).
 * F0.2 resolves bound|unbound from tool presence; `unreachable` lands with the
 * Phase-3 registry role-health that can see a failed connection. */
export type RoleHealth = "bound" | "unbound" | "unreachable";

/** Versioned reusable procedures. `propose` reports `ok`/`error`; the tri-state widens
 * to a retryable `conflict` in Phase 2, when a promoter that can act on it exists AND
 * a backend actually surfaces one (the skill registry default folds a conflict into `error`,
 * so advertising it now would be a dead variant — codex P1). */
export interface CapabilityAdapter {
  /** Stable product binding used to keep an old outbox from crossing a rebind. */
  readonly binding?: string;
  health(): RoleHealth;
  search(query: string, ctx: ToolCtx): Promise<SkillRef[]>;
  get(name: string, ctx: ToolCtx): Promise<{ version: number; body: string } | null>;
  propose(p: SkillProposal & { idempotencyKey: string }, ctx: ToolCtx): Promise<"ok" | "error">;
}

/** What the binary knows when it proposes a curated write — the backend-neutral
 * input the adapter maps onto its own envelope. `idempotencyKey` is the Phase-2
 * promoter's dedup anchor; the knowledge-base default already dedupes on `runId` (delta_run_ref),
 * so the direct path needs no extra key today. */
export type CuratedWrite = {
  kind: string;
  content: string;
  idempotencyKey: string;
  review: boolean;
  runId: string;
  confidence?: number;
};

/** Cross-agent human-curated knowledge (a reviewed write rail). */
export interface CuratedAdapter {
  /** Stable product binding used to keep an old outbox from crossing a rebind. */
  readonly binding?: string;
  health(): RoleHealth;
  propose(a: CuratedWrite, ctx: ToolCtx): Promise<"ok" | "error">;
}
