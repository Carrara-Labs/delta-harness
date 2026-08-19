// DELTA.md — the living self-file: identity + learnings, agent-writable via `remember`.
// loadSelf reads it as a run-local snapshot (verbatim text for the spine + parsed
// identity for reflection); writeSelf replaces it atomically and snapshots the prior
// version into the DB (outside the workspace) with bounded retention + revert.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtins";
import { openDb } from "../src/db";
import { getProfile } from "../src/profiles";
import {
  currentSelf,
  listRevisions,
  loadSelf,
  looksLikeSpineEcho,
  parseCharterMarkdown,
  revertSelf,
  writeSelf,
} from "../src/self";
import { buildSpine } from "../src/spine";
import type { ToolCtx } from "../src/tools";

const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
function ws(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "delta-self-"));
  tmps.push(dir);
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
  return dir;
}

describe("parseCharterMarkdown", () => {
  test("extracts Persona/Mission/Success by heading keyword", () => {
    const c = parseCharterMarkdown(
      "# Persona\nChief of staff to the CEO.\n\n## Mission\nKeep the org moving.\n\n### What success looks like\nNothing slips.",
    );
    expect(c.persona).toBe("Chief of staff to the CEO.");
    expect(c.mission).toBe("Keep the org moving.");
    expect(c.success).toBe("Nothing slips.");
  });
  test("a headingless file is taken whole as the persona", () => {
    expect(parseCharterMarkdown("Just a sales engineer.").persona).toBe("Just a sales engineer.");
  });
});

describe("loadSelf", () => {
  test("reads DELTA.md verbatim (identity + learnings) and parses the identity fields", async () => {
    const dir = ws({
      "DELTA.md": "# Persona\nchief of staff\n# Success\nnothing slips\n# Learned\n- keep it terse",
    });
    const s = await loadSelf(dir, 800);
    expect(s.text).toContain("chief of staff");
    expect(s.text).toContain("keep it terse"); // the learned section rides the spine verbatim
    expect(s.charter.persona).toBe("chief of staff");
    expect(s.charter.success).toBe("nothing slips");
  });
  test("no DELTA.md → no identity block, empty charter", async () => {
    const s = await loadSelf(ws(), 800);
    expect(s.text).toBeUndefined();
    expect(s.charter).toEqual({});
  });
  test("over-budget content is elided (corruption recovery), keeping head + tail", async () => {
    const body = `HEAD-MARKER ${"x".repeat(8_000)} TAIL-MARKER`;
    const s = await loadSelf(ws({ "DELTA.md": body }), 200);
    expect((s.text as string).length).toBeLessThan(1_200); // 200 tokens × 4 + slack
    expect(s.text).toContain("HEAD-MARKER");
    expect(s.text).toContain("TAIL-MARKER");
  });
});

describe("writeSelf — the remember tool's hands", () => {
  test("atomic replace, snapshots the prior version, is revertible", () => {
    const dir = ws({ "DELTA.md": "v1 content" });
    const db = openDb(":memory:");
    const r = writeSelf(db, dir, "v2 content", 10_000);
    expect(r.ok).toBe(true);
    expect(currentSelf(dir)).toBe("v2 content");
    const revs = listRevisions(db);
    expect(revs.length).toBe(1);
    expect(revs[0]?.content).toBe("v1 content"); // the prior version is recoverable
    const rr = revertSelf(db, dir, revs[0]?.id as number, 10_000);
    expect(rr.ok).toBe(true);
    expect(currentSelf(dir)).toBe("v1 content"); // restored
    db.close();
  });
  test("optimistic concurrency: a diverged base is refused (lost-update guard), not clobbered", () => {
    const dir = ws({ "DELTA.md": "v1" });
    const db = openDb(":memory:");
    // Run A read v1 and wrote v2 (A's lesson). Run B ALSO read v1 and now tries to write its own
    // full doc built off v1 — which would drop A's lesson. With base='v1' but disk now 'v2', refuse.
    expect(writeSelf(db, dir, "v2 (A lesson)", 10_000, "v1").ok).toBe(true);
    const conflict = writeSelf(db, dir, "v1 + B lesson", 10_000, "v1");
    expect(conflict.ok).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(conflict.current).toBe("v2 (A lesson)"); // hands back the current version to merge from
    expect(currentSelf(dir)).toBe("v2 (A lesson)"); // A's write is NOT clobbered
    // B merges its lesson onto the current version and retries with the fresh base → succeeds.
    const retry = writeSelf(db, dir, "v2 (A lesson) + B lesson", 10_000, conflict.current);
    expect(retry.ok).toBe(true);
    expect(currentSelf(dir)).toBe("v2 (A lesson) + B lesson"); // BOTH lessons preserved
    db.close();
  });
  test("a same-content re-fire is still an idempotent no-op even against a stale base", () => {
    const dir = ws({ "DELTA.md": "v2" });
    const db = openDb(":memory:");
    // Crash-resume replays the SAME remember; base is stale ('v1') but content already equals disk.
    const r = writeSelf(db, dir, "v2", 10_000, "v1");
    expect(r.ok).toBe(true);
    expect(r.conflict).toBeUndefined();
    expect(listRevisions(db).length).toBe(0); // no duplicate revision
    db.close();
  });
  test("no base supplied → writes unconditionally (back-compat, e.g. operator cockpit edit)", () => {
    const dir = ws({ "DELTA.md": "v1" });
    const db = openDb(":memory:");
    expect(writeSelf(db, dir, "operator override", 10_000).ok).toBe(true);
    expect(currentSelf(dir)).toBe("operator override");
    db.close();
  });
  test("rejects oversized content at WRITE time (never touches the file)", () => {
    const dir = ws();
    const db = openDb(":memory:");
    const r = writeSelf(db, dir, "x".repeat(5_000), 1_000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cap");
    expect(currentSelf(dir)).toBe(""); // not written
    db.close();
  });

  test("A-4a: a cap refusal carries the numbers AND the current file, structurally", () => {
    const dir = ws({ "DELTA.md": "# Persona\nthe existing self-file body" });
    const db = openDb(":memory:");
    const r = writeSelf(db, dir, "y".repeat(5_000), 1_000);
    expect(r.ok).toBe(false);
    // The short operator string is UNCHANGED (the Cockpit renders r.error; the breaker's
    // self_cap classifier matches this exact shape).
    expect(r.error).toMatch(/DELTA\.md would be \d+ bytes \(cap /);
    expect(r.error).not.toContain("existing self-file body");
    // The structured half: only the remember tool renders these into the model's message.
    expect(r.overCap).toEqual({
      attempted: 5_000,
      cap: 1_000,
      overBy: 4_000,
      current: "# Persona\nthe existing self-file body",
    });
    db.close();
  });

  test("A-4a: remember renders headroom + merge base; classification stays self_cap", async () => {
    const dir = ws({ "DELTA.md": "# Persona\nkeep me as merge base" });
    const db = openDb(":memory:");
    const tools = builtinTools({
      workspace: dir,
      codeCli: ["echo"],
      selfCmd: ["true"],
      subagentDepth: 0,
    });
    const ctx: ToolCtx = {
      workspace: dir,
      activate: () => {},
      writeSelf: (content: string) => writeSelf(db, dir, content, 1_000),
    };
    const out = await tools.get("remember")?.execute({ content: "z".repeat(5_000) }, ctx);
    const msg = String(out);
    // The blind-loop killer: 86 of 240 remembers were refused with no headroom number and no
    // file, so the model shrank by guesswork and re-fired — three times, then the breaker.
    expect(msg).toContain("4000 bytes over");
    expect(msg).toContain("keep me as merge base");
    const { toolErrorClass } = await import("../src/run");
    expect(toolErrorClass(msg)).toBe("self_cap");
    db.close();
  });
  test("revision retention is bounded", () => {
    const dir = ws({ "DELTA.md": "v0" });
    const db = openDb(":memory:");
    for (let i = 1; i <= 25; i++) writeSelf(db, dir, `v${i}`, 10_000);
    expect(listRevisions(db, 100).length).toBeLessThanOrEqual(20);
    db.close();
  });
});

describe("the remember tool", () => {
  const tools = builtinTools({ workspace: "/t", codeCli: ["c"], selfCmd: ["d"], subagentDepth: 0 });
  test("writes DELTA.md through ctx.writeSelf; refuses empty; reports when unavailable", async () => {
    const dir = ws();
    const db = openDb(":memory:");
    const remember = tools.get("remember");
    if (!remember) throw new Error("remember tool not registered");
    const ctx: ToolCtx = {
      workspace: dir,
      activate: () => {},
      writeSelf: (c) => writeSelf(db, dir, c, 10_000),
    };
    expect(await remember.execute({ content: "# Persona\nnew me" }, ctx)).toContain(
      "updated DELTA.md",
    );
    expect(currentSelf(dir)).toContain("new me");
    expect(await remember.execute({ content: "   " }, ctx)).toContain("empty");
    // No writeSelf in ctx (bare/oneshot) → reports unavailable, never throws.
    const bare: ToolCtx = { workspace: dir, activate: () => {} };
    expect(await remember.execute({ content: "x" }, bare)).toContain("not available");
    db.close();
  });
  test("self-write is a work-profile capability — the chat profile never exposes it", () => {
    expect(getProfile("work").allowed).toBe("*"); // work sees remember
    const chat = getProfile("chat");
    expect(Array.isArray(chat.allowed) && chat.allowed.includes("remember")).toBe(false);
  });
  test("rejects a whole-spine echo and hands back the current DELTA.md to retry from", async () => {
    // gpt-5.6-sol was observed passing its ENTIRE rendered system prompt as the new file.
    const dir = ws({ "DELTA.md": "# Persona\nthe real me\n# Learned\n- prior note" });
    const db = openDb(":memory:");
    const remember = tools.get("remember");
    if (!remember) throw new Error("remember tool not registered");
    const ctx: ToolCtx = {
      workspace: dir,
      activate: () => {},
      writeSelf: (c) => writeSelf(db, dir, c, 10_000),
    };
    const echo = buildSpine({
      pinned: [],
      searchable: 0,
      self: "# Persona\nthe real me",
      policy: "- rule",
    });
    const out = await remember.execute({ content: echo }, ctx);
    expect(out).toContain("[tool error]");
    expect(out).toContain("whole system prompt");
    expect(out).toContain("the real me"); // the current file is returned so the model retries correctly
    // The guard must NOT have overwritten the file — the real identity survives untouched.
    expect(currentSelf(dir)).toContain("prior note");
    expect(looksLikeSpineEcho(currentSelf(dir))).toBe(false);
    db.close();
  });
});

describe("looksLikeSpineEcho", () => {
  test("trips on ≥2 engine-owned headers; a normal DELTA.md passes", () => {
    expect(looksLikeSpineEcho("# Persona\nx\n# Mission\ny\n# Success\nz\n# Learned\n- a")).toBe(
      false,
    );
    // A rendered spine carries # Norms + # You + # Tools (+ more) — always ≥2.
    expect(
      looksLikeSpineEcho(buildSpine({ pinned: [], searchable: 0, self: "id", policy: "r" })),
    ).toBe(true);
    // A single coincidental heading is not enough to trip it.
    expect(looksLikeSpineEcho("# Persona\nI enforce # Tools\n# Learned\n- note")).toBe(false);
    expect(looksLikeSpineEcho("# You\ndescribe\n# Tools\nmy toolbox")).toBe(true);
    // A partial echo from the top of the spine carries # Delta + # Norms (codex #1).
    expect(looksLikeSpineEcho("# Delta\nYou are Delta\n# Norms\n- work through tools")).toBe(true);
    // Space-indented headings are still Markdown headings — must not slip past (codex #2).
    expect(looksLikeSpineEcho("  # Norms\nx\n   # Tools\ny")).toBe(true);
  });
});

describe("buildSpine — the You + Policy layers", () => {
  const base = { pinned: [], searchable: 0 };
  test("renders the self block (identity + learnings) and the policy, policy LAST", () => {
    const s = buildSpine({
      ...base,
      self: "# Persona\nchief of staff\n# Learned\n- be concise",
      policy: "- writes go through the review rail",
    });
    expect(s).toContain("# You");
    expect(s).toContain("chief of staff");
    expect(s).toContain("be concise");
    expect(s).toContain("# Policy");
    expect(s).toContain("writes go through the review rail");
    // The writable self-text renders BEFORE the fixed policy (codex #12), and policy is
    // the last standing section before the tool index.
    expect(s.indexOf("# You")).toBeLessThan(s.indexOf("# Policy"));
    expect(s.indexOf("# Policy")).toBeLessThan(s.indexOf("# Tools"));
  });
  test("per-turn instructions are NOT in the spine (they ride a user message now)", () => {
    const s = buildSpine({ ...base, self: "id", policy: "rule" });
    expect(s).not.toContain("This turn's instructions");
  });
  test("neither layer present → just the engine base + norms", () => {
    const s = buildSpine(base);
    expect(s).not.toContain("# You");
    expect(s).not.toContain("# Policy");
    expect(s).toContain("# Norms");
  });
  test("deterministic — same inputs, byte-identical output (cache stability)", () => {
    const a = buildSpine({ ...base, self: "id", policy: "rule" });
    const b = buildSpine({ ...base, self: "id", policy: "rule" });
    expect(a).toBe(b);
  });
});

describe("append-append collision auto-merge (C2, 0.2.16)", () => {
  test("two runs both appending to the same base merge losslessly, engine-side", () => {
    // The measured fleet shape (48 collisions): concurrent runs each append a learned line.
    // Both edits are pure appends of the SAME base → the merge is mechanical; billing a model
    // turn to concatenate two suffixes was pure waste.
    const dir = ws({ "DELTA.md": "base\n" });
    const db = openDb(":memory:");
    expect(writeSelf(db, dir, "base\n- lesson A\n", 10_000, "base\n").ok).toBe(true);
    // Run B still holds the old base and appends its own line.
    const r = writeSelf(db, dir, "base\n- lesson B\n", 10_000, "base\n");
    expect(r.ok).toBe(true);
    expect(r.conflict).toBeUndefined();
    expect(currentSelf(dir)).toBe("base\n- lesson A\n- lesson B\n"); // BOTH lessons, no turn spent
    db.close();
  });
  test("a rewrite (non-append) still conflicts — auto-merge never guesses", () => {
    const dir = ws({ "DELTA.md": "base\n" });
    const db = openDb(":memory:");
    expect(writeSelf(db, dir, "rewritten entirely\n", 10_000, "base\n").ok).toBe(true);
    const r = writeSelf(db, dir, "base\n- lesson B\n", 10_000, "base\n");
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    db.close();
  });
  test("a merge that would blow the cap falls back to the conflict contract", () => {
    const dir = ws({ "DELTA.md": "base\n" });
    const db = openDb(":memory:");
    expect(writeSelf(db, dir, `base\n${"A".repeat(60)}\n`, 100, "base\n").ok).toBe(true);
    const r = writeSelf(db, dir, `base\n${"B".repeat(60)}\n`, 100, "base\n");
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true); // the model must shrink-and-merge; silently dropping either side would be worse
    db.close();
  });
});
