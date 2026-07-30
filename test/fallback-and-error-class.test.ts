// 0.2.6 telemetry additions, both born in the 2026-07-30 effort lab:
// - model.fallback: served ≠ configured primary must be LOUD (27% of an arm's turns were
//   silently served by the fallback model; the lab only caught it by diffing model names).
// - error.class on tool.result: is_error alone was unclassifiable — the self-write refusal
//   storm (size cap vs conflict vs policy) cost a day on a wrong root cause.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { Queue } from "../src/queue";
import { toolErrorClass } from "../src/run";
import { writeSelf } from "../src/self";
import { makeDeps, textResult } from "./helpers";

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
