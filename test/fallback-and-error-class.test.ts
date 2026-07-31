// 0.2.6 telemetry additions, both born in the 2026-07-30 effort lab:
// - model.fallback: served ≠ configured primary must be LOUD (27% of an arm's turns were
//   silently served by the fallback model; the lab only caught it by diffing model names).
// - error.class on tool.result: is_error alone was unclassifiable — the self-write refusal
//   storm (size cap vs conflict vs policy) cost a day on a wrong root cause.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync as mkdtemp, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { PROFILES } from "../src/profiles";
import { Queue } from "../src/queue";
import { breakerKey, toolErrorClass } from "../src/run";
import { writeSelf } from "../src/self";
import type { ToolDef } from "../src/tools";
import { makeDeps, textResult, toolCallResult } from "./helpers";

const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe("model.fallback telemetry", () => {
  test("served ≠ configured primary emits model.fallback and marks model.call", async () => {
    // textResult serves "test/model"; the configured primary is different → fallback.
    const deps = makeDeps(async () => textResult("done"), new Map(), {
      primaryModel: "primary/model",
    });
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "hi" }).id);
    const rows = deps.db
      .query("SELECT type, data FROM events WHERE type IN ('model.call','model.fallback')")
      .all() as { type: string; data: string }[];
    const fb = rows.filter((r) => r.type === "model.fallback");
    expect(fb.length).toBe(1);
    const attrs = JSON.parse(fb[0]?.data ?? "{}");
    expect(attrs["gen_ai.request.model"]).toBe("primary/model");
    expect(attrs["gen_ai.response.model"]).toBe("test/model");
    const call = rows.find((r) => r.type === "model.call");
    expect(JSON.parse(call?.data ?? "{}").fallback).toBe(true);
  });

  test("served == primary emits nothing extra", async () => {
    const deps = makeDeps(async () => textResult("done"), new Map(), {
      primaryModel: "test/model",
    });
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "hi" }).id);
    const fb = deps.db
      .query("SELECT COUNT(*) AS n FROM events WHERE type = 'model.fallback'")
      .get() as { n: number };
    expect(fb.n).toBe(0);
    const call = deps.db.query("SELECT data FROM events WHERE type = 'model.call'").get() as {
      data: string;
    };
    expect(JSON.parse(call.data).fallback).toBeUndefined();
  });

  test("no configured primary → never a fallback", async () => {
    const deps = makeDeps(async () => textResult("done"));
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "hi" }).id);
    const fb = deps.db
      .query("SELECT COUNT(*) AS n FROM events WHERE type = 'model.fallback'")
      .get() as { n: number };
    expect(fb.n).toBe(0);
  });
});

describe("toolErrorClass", () => {
  // Ground the two classes that mattered most in the lab on the REAL producing code, so a
  // reworded message breaks THIS test instead of silently unclassifying prod telemetry.
  test("self_cap and self_conflict classify from real writeSelf errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-errclass-"));
    tmps.push(dir);
    const db = openDb(":memory:");
    const over = writeSelf(db, dir, "x".repeat(50), 10);
    expect(over.ok).toBe(false);
    expect(toolErrorClass(`[tool error] ${over.error}`)).toBe("self_cap");
    expect(writeSelf(db, dir, "# Persona\nv1", 1000).ok).toBe(true);
    const conflict = writeSelf(db, dir, "# Persona\nv2", 1000, "stale base");
    expect(conflict.ok).toBe(false);
    expect(toolErrorClass(`[tool error] ${conflict.error}`)).toBe("self_conflict");
  });

  test("the remaining classes pin their message fragments", () => {
    expect(
      toolErrorClass("[tool error] That looks like your whole system prompt, not your DELTA.md."),
    ).toBe("self_spine_echo");
    expect(
      toolErrorClass(
        "[tool error] refusing to write an empty DELTA.md — pass the full new content",
      ),
    ).toBe("self_empty");
    expect(
      toolErrorClass("[tool error] self-write is not available in this context (no durable store)"),
    ).toBe("self_unavailable");
    expect(
      toolErrorClass(
        "[tool error] DELTA.md is your own living file — update it with the `remember` tool",
      ),
    ).toBe("self_protected");
    expect(
      toolErrorClass("[tool error] tool 'web_fetch' exceeded 60000ms timeout; it was left running"),
    ).toBe("timeout");
    expect(toolErrorClass("[tool error] fetch failed: socket hang up")).toBe("transient");
    expect(toolErrorClass("[tool error] ENOENT: no such file or directory")).toBe("categorical");
  });

  test("successes and unknown errors get no class", () => {
    expect(toolErrorClass("wrote 42 chars to notes.md")).toBeUndefined();
    expect(toolErrorClass("[tool error] something without a known shape")).toBeUndefined();
  });
});

describe("breakerKey (class-aware quarantine)", () => {
  test("storm classes aggregate on class even when messages vary", () => {
    const a = breakerKey(
      "[tool error] DELTA.md would be 3400 bytes (cap 3200) — compact your notes",
    );
    const b = breakerKey(
      "[tool error] DELTA.md would be 3377 bytes (cap 3200) — compact your notes",
    );
    expect(a).toBe("[class] self_cap");
    expect(b).toBe(a); // different byte counts, same key — this is what latches the breaker
    expect(
      breakerKey("[tool error] That looks like your whole system prompt, not your DELTA.md"),
    ).toBe("[class] self_spine_echo");
  });

  test("conflict, transient, and unknown errors never latch", () => {
    expect(
      breakerKey("[tool error] DELTA.md was updated by another run since you read it — …"),
    ).toBeNull();
    expect(breakerKey("[tool error] fetch failed: socket hang up")).toBeNull();
    expect(breakerKey("[tool error] something without a known shape")).toBeNull();
  });

  test("a conflict whose appended file body contains categorical vocabulary still never latches", () => {
    // The real conflict message appends the CURRENT DELTA.md; a technical persona's file can
    // contain words the categorical regex matches ("schema", "not found"). Classify-first must
    // win over the exact-categorical key so the documented self_conflict exclusion holds.
    const conflict =
      "[tool error] DELTA.md was updated by another run since you read it — re-apply on top of the CURRENT version below:\n\n# Persona\nI validate the JSON schema; the record was not found last run.";
    expect(toolErrorClass(conflict)).toBe("self_conflict");
    expect(breakerKey(conflict)).toBeNull();
  });

  test("self_protected does not latch (generic write_file guard must not be quarantined run-wide)", () => {
    const protectedErr =
      "[tool error] DELTA.md is your own living file — update it with the `remember` tool, not write_file/move/delete";
    expect(toolErrorClass(protectedErr)).toBe("self_protected");
    expect(breakerKey(protectedErr)).toBeNull();
  });

  test("exact categorical errors keep their pre-existing full-string key", () => {
    const key = breakerKey("[tool error] ENOENT: no such file or directory");
    expect(key).toContain("ENOENT");
  });

  test("a remember-style storm with VARYING byte counts is quarantined after 3", async () => {
    PROFILES.stormtest = {
      name: "stormtest",
      allowed: "*",
      pinned: "*",
      budget: { maxSteps: 30, maxTokens: 400_000, maxCostUsd: 1 },
    };
    let n = 0;
    const grind: ToolDef = {
      name: "grind",
      description: "fails with a self_cap message whose byte count changes every call",
      parameters: { type: "object", properties: {} },
      idempotent: true,
      execute: async () =>
        `[tool error] DELTA.md would be ${3300 + ++n} bytes (cap 3200) — compact your notes and rewrite the whole file smaller.`,
    };
    let calls = 0;
    const chat = async (req: { tools?: { function: { name: string } }[] }) => {
      if ((req.tools ?? []).some((t) => t.function.name === "grind")) {
        calls++;
        return toolCallResult("grind", {}, `c${calls}`);
      }
      return textResult("stopped grinding");
    };
    const deps = makeDeps(chat as never, new Map([["grind", grind]]));
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "keep trying", metadata: { profile: "stormtest" } }).id,
    );
    expect(done.status).toBe("done");
    expect(calls).toBe(3); // the lab storm was 100+ calls; the class key caps it at the limit
  });
});

describe("self.pressure", () => {
  function wsWithSelf(content: string): string {
    const dir = mkdtemp(join(tmpdir(), "delta-selfpressure-"));
    tmps.push(dir);
    writeFileSync(join(dir, "DELTA.md"), content);
    return dir;
  }
  const pressures = (deps: ReturnType<typeof makeDeps>) =>
    deps.db.query("SELECT data FROM events WHERE type = 'self.pressure'").all() as {
      data: string;
    }[];

  test("an over-cap self file fires the event with elided=true", async () => {
    const deps = makeDeps(async () => textResult("ok"), new Map(), {
      workspace: wsWithSelf(`# Persona\n${"x".repeat(400)}`),
      selfMaxBytes: 100,
    });
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "hi" }).id);
    const rows = pressures(deps);
    expect(rows.length).toBe(1);
    const attrs = JSON.parse(rows[0]?.data ?? "{}");
    expect(attrs.elided).toBe(true);
    expect(attrs.cap).toBe(100);
    expect(attrs.bytes).toBeGreaterThan(100);
  });

  test("a nearly-full self file (>90% of cap) fires with elided=false", async () => {
    const deps = makeDeps(async () => textResult("ok"), new Map(), {
      workspace: wsWithSelf(`# Persona\n${"x".repeat(85)}`), // 95B vs 100B cap
      selfMaxBytes: 100,
    });
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "hi" }).id);
    const rows = pressures(deps);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]?.data ?? "{}").elided).toBe(false);
  });

  test("a healthy self file stays silent", async () => {
    const deps = makeDeps(async () => textResult("ok"), new Map(), {
      workspace: wsWithSelf("# Persona\nlean"),
      selfMaxBytes: 100,
    });
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "hi" }).id);
    expect(pressures(deps).length).toBe(0);
  });

  test("a present-but-over-1MB self file fires pressure (identity fully dropped, not silent)", async () => {
    // Over 1MB loadSelf refuses to read the file at all — the agent runs with NO self-file.
    // That is the loudest integrity failure and must not stay silent (codex 0.2.6 P2).
    const deps = makeDeps(async () => textResult("ok"), new Map(), {
      workspace: wsWithSelf(`# Persona\n${"x".repeat(1_000_050)}`),
      selfMaxBytes: 3200,
    });
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "hi" }).id);
    const rows = pressures(deps);
    expect(rows.length).toBe(1);
    const attrs = JSON.parse(rows[0]?.data ?? "{}");
    expect(attrs.elided).toBe(true);
    expect(attrs.bytes).toBeGreaterThan(1_000_000);
  });
});

describe("error.message on tool.result", () => {
  test("failed results carry a bounded, whitespace-collapsed snippet; successes none", async () => {
    const boom: ToolDef = {
      name: "boom",
      description: "always fails with a long multi-line error",
      parameters: { type: "object", properties: {} },
      idempotent: true,
      execute: async () => `[tool error] line one\n  line two   spaced ${"z".repeat(500)}`,
    };
    let sent = false;
    const chat = async () => {
      if (!sent) {
        sent = true;
        return toolCallResult("boom", {}, "c1");
      }
      return textResult("done");
    };
    PROFILES.errmsg = {
      name: "errmsg",
      allowed: "*",
      pinned: "*",
      budget: { maxSteps: 10, maxTokens: 100_000, maxCostUsd: 1 },
    };
    const deps = makeDeps(chat as never, new Map([["boom", boom]]));
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "go", metadata: { profile: "errmsg" } }).id);
    const rows = deps.db.query("SELECT data FROM events WHERE type = 'tool.result'").all() as {
      data: string;
    }[];
    const attrs = rows.map((r) => JSON.parse(r.data));
    const failed = attrs.find((a) => a.is_error);
    expect(failed?.["error.message"]).toBeDefined();
    expect(failed?.["error.message"].length).toBeLessThanOrEqual(200);
    expect(failed?.["error.message"]).toContain("line one line two spaced"); // collapsed
  });
});
