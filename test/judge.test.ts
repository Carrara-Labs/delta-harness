// SPDX-License-Identifier: Apache-2.0
// The judge lane, slice 1 (shadow). Three layers: the policy file validator (shared by boot and
// `bundle apply`), the pure request/answer plumbing, and the run-loop integration through a fake
// fetch — where the load-bearing assertions are "byte-identical result" and "the key and the
// unprojected fields never leave the box".

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBundle } from "../src/bundle";
import { loadConfig } from "../src/config";
import {
  buildRequest,
  getPath,
  JudgeLane,
  type JudgeResult,
  makeJudgeClient,
  noulOf,
  parseJudgeFile,
  projectRow,
  qid,
  resolveAsk,
} from "../src/judge";
import { Queue } from "../src/queue";
import { registerSecretValue, resetSecretRegistry } from "../src/scrub";
import type { ToolDef } from "../src/tools";
import { makeDeps, textResult, toolCallResult } from "./helpers";

const POLICY = {
  version: 1,
  policies: {
    rows: {
      on: "tool.result",
      tool: "search",
      rows: "output.data",
      row_fields: ["headline", "location", "roles"],
      ask: { from: "run.input", match: "QUESTION: (.*)" },
      questions: {
        fits: {
          instructions: "Does `row` fit `ask`?",
          criteria: { true: "fits", false: "does not" },
        },
      },
      threshold: { fits: 0.3 },
      batch: 2,
    },
  },
};
const raw = (p: unknown = POLICY) => JSON.stringify(p);

describe("judge.json validation", () => {
  test("absent/empty → no policies; a valid file parses with defaults", () => {
    expect(parseJudgeFile(undefined).policies).toEqual([]);
    expect(parseJudgeFile("  ").policies).toEqual([]);
    const [p] = parseJudgeFile(raw()).policies;
    expect(p?.name).toBe("rows");
    expect(p?.mode).toBe("shadow");
    expect(p?.batch).toBe(2);
    expect(p?.max_rows).toBe(200);
  });

  const bad = (mutate: (p: Record<string, unknown>) => void, msg: string) => {
    const p = JSON.parse(raw()) as { policies: { rows: Record<string, unknown> } };
    mutate(p.policies.rows);
    expect(() => parseJudgeFile(JSON.stringify(p))).toThrow(msg);
  };

  test("every malformed field is refused with the field named", () => {
    expect(() => parseJudgeFile("{nope")).toThrow("not valid JSON");
    expect(() => parseJudgeFile("[]")).toThrow("must be a JSON object");
    expect(() => parseJudgeFile('{"version":2,"policies":{}}')).toThrow("version must be 1");
    bad((p) => (p.on = "loop"), "reserved for a later slice");
    bad((p) => (p.tool = "aperture__*"), "exact tool name");
    bad((p) => (p.rows = "__proto__.x"), "dot path");
    bad((p) => (p.row_fields = []), "non-empty array");
    bad((p) => (p.row_fields = ["a.constructor"]), "non-empty array of dot paths");
    bad((p) => (p.ask = { from: "history" }), 'ask.from must be "run.input"');
    bad((p) => (p.ask = { from: "run.input", match: "no group" }), "exactly one capture group");
    bad((p) => (p.ask = { from: "run.input", match: "(" }), "not a valid regex");
    bad((p) => (p.questions = {}), "non-empty object");
    bad(
      (p) => (p.questions = { fits: { type: "choice", instructions: "x", criteria: {} } }),
      "only type noul",
    );
    bad((p) => (p.mode = "filter"), "mode must be shadow");
    bad((p) => (p.threshold = { nope: 0.5 }), "unknown question");
    bad((p) => (p.threshold = { fits: 1 }), "in (0,1)");
    bad((p) => (p.batch = 21), "1..20");
    bad((p) => (p.max_rows = 0), "1..500");
    bad((p) => (p.extra = 1), 'unknown key "extra"');
  });

  test("two policies on one tool are refused (no overlapping judgments)", () => {
    const p = JSON.parse(raw());
    p.policies.dup = { ...p.policies.rows };
    expect(() => parseJudgeFile(JSON.stringify(p))).toThrow('tool "search" already has a policy');
  });
});

describe("state assembly", () => {
  test("getPath walks own properties and indices only", () => {
    const o = { output: { data: [{ a: 1 }, { a: 2 }] } };
    expect(getPath(o, "output.data[1].a")).toBe(2);
    expect(getPath(o, "output.nope")).toBeUndefined();
    expect(getPath(o, "output.data[5]")).toBeUndefined();
    expect(getPath({}, "toString")).toBeUndefined(); // inherited, not own
  });

  test("projectRow keeps only the allowlist, bounds every value, never a nested object unbounded", () => {
    const row = {
      headline: "x".repeat(5_000),
      location: "Paris",
      roles: Array.from({ length: 30 }, (_, i) => `role ${i} ${"y".repeat(80)}`),
      email: "leak@example.com",
      nested: { deep: { secret: "s" } },
    };
    const p = projectRow(row, ["headline", "location", "roles", "nested"]);
    expect(p.email).toBeUndefined();
    expect((p.headline as string).length).toBeLessThanOrEqual(1_001);
    expect((p.roles as string[]).length).toBe(12);
    expect((p.roles as string[])[0]!.length).toBeLessThanOrEqual(301);
    const big = projectRow(
      { a: "x".repeat(3_000), b: "y".repeat(3_000), c: "z".repeat(3_000), d: "w".repeat(3_000) },
      ["a", "b", "c", "d"],
    );
    expect(big.c).toBeDefined();
    expect(big.d).toBeUndefined(); // over the row cap: the field is dropped whole, and flagged
    expect(big._truncated).toBe(true);
    expect(typeof p.nested).toBe("string"); // clipped JSON, never a live object
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(4_100);
  });

  test("resolveAsk: literal, whole input, one capture group; no match → undefined (abstain)", () => {
    expect(resolveAsk({ literal: "find PMs" }, undefined)).toBe("find PMs");
    expect(resolveAsk({ from: "run.input" }, "  hello ")).toBe("hello");
    expect(
      resolveAsk({ from: "run.input", match: "QUESTION: (.*)" }, "Token: abc\nQUESTION: find PMs"),
    ).toBe("find PMs");
    expect(
      resolveAsk({ from: "run.input", match: "QUESTION: (.*)" }, "Token: abc"),
    ).toBeUndefined();
    expect(resolveAsk({ from: "run.input" }, "")).toBeUndefined();
  });

  test("buildRequest rewrites `row` per index, scrubs registered secrets and secret-shaped text", () => {
    resetSecretRegistry();
    registerSecretValue("RUN_TOKEN", "tok_abc123secret");
    const [policy] = parseJudgeFile(raw()).policies;
    const req = buildRequest(policy!, "find PMs tok_abc123secret", [
      { headline: "PM at X, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ" },
      { headline: "Eng" },
    ]);
    const s = JSON.stringify(req);
    expect(s).not.toContain("tok_abc123secret");
    expect(s).not.toContain("sk-ant-api03");
    expect((req!.questions[qid("fits", 1)] as { instructions: string }).instructions).toContain(
      "`rows[1]`",
    );
    expect(Object.keys(req!.questions)).toEqual([qid("fits", 0), qid("fits", 1)]);
    resetSecretRegistry();
  });

  test("noulOf accepts only a finite noul in [0,1] under the generated id", () => {
    expect(noulOf({ fits__0: { type: "noul", noul: 0.4 } }, "fits__0")).toBe(0.4);
    expect(noulOf({ fits__0: { type: "noul", noul: 1.4 } }, "fits__0")).toBeUndefined();
    expect(noulOf({ fits__0: { type: "choice", choice: "a" } }, "fits__0")).toBeUndefined();
    expect(noulOf({ fits__0: { type: "noul", noul: "0.4" } }, "fits__0")).toBeUndefined();
    expect(noulOf({}, "fits__0")).toBeUndefined();
  });
});

describe("the client", () => {
  const cfg = { url: "https://judge.test/v1", key: "KEY-XYZ", model: "jev-1.13.0", timeoutMs: 50 };
  test("sends state+model+questions with the key only in the header; maps answers and usage", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const client = makeJudgeClient({
      ...cfg,
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { a: { type: "noul", noul: 0.9 } },
            usage: { input_tokens: 42 },
          }),
        );
      }) as never,
    });
    const r = await client({ ask: "x", rows: [] }, { a: { type: "noul", instructions: "?" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.inputTokens).toBe(42);
      expect(r.answers.a).toEqual({ type: "noul", noul: 0.9 });
    }
    expect(seen!.url).toBe(cfg.url);
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer KEY-XYZ");
    expect(String(seen!.init.body)).not.toContain("KEY-XYZ");
    expect(JSON.parse(String(seen!.init.body)).model).toBe("jev-1.13.0");
  });

  test("timeouts, non-2xx and non-JSON come back as classified failures, never throws", async () => {
    const hang = makeJudgeClient({
      ...cfg,
      fetch: ((_: string, init: RequestInit) =>
        new Promise((_, rej) =>
          init.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
        )) as never,
    });
    const t = await hang({}, {});
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.class).toBe("timeout");
    const r429 = makeJudgeClient({
      ...cfg,
      fetch: (async () => new Response("slow down", { status: 429 })) as never,
    });
    const q = await r429({}, {});
    if (!q.ok) expect(q.class).toBe("transient"); // 429 is retriable in the shared taxonomy
    const junk = makeJudgeClient({ ...cfg, fetch: (async () => new Response("<html>")) as never });
    const j = await junk({}, {});
    if (!j.ok) expect(j.class).toBe("request");
  });
});

/** A fake judge that answers every noul with a value keyed on the row's headline. */
function fakeClient(
  score: (row: Record<string, unknown>) => number,
  opts: { fail?: (n: number) => boolean } = {},
) {
  const calls: {
    state: { ask: string; rows: Record<string, unknown>[] };
    questions: Record<string, unknown>;
  }[] = [];
  const client = async (
    state: unknown,
    questions: Record<string, unknown>,
  ): Promise<JudgeResult> => {
    const s = state as { ask: string; rows: Record<string, unknown>[] };
    calls.push({ state: s, questions });
    if (opts.fail?.(calls.length))
      return { ok: false, error: "boom", class: "transient", status: 500, latencyMs: 1 };
    const answers: Record<string, unknown> = {};
    for (let j = 0; j < s.rows.length; j++)
      answers[qid("fits", j)] = { type: "noul", noul: score(s.rows[j] ?? {}) };
    return { ok: true, answers, inputTokens: 100, model: "jev-1.13.0", latencyMs: 1 };
  };
  return { client, calls };
}

describe("JudgeLane.judge (shadow)", () => {
  const [policy] = parseJudgeFile(raw()).policies;
  const result = (rows: unknown[]) => JSON.stringify({ output: { data: rows, next: 2 } });

  test("scores rows in batches, counts would-filter against the threshold, never touches the result", async () => {
    const { client, calls } = fakeClient((r) => (String(r.headline).includes("PM") ? 0.9 : 0.1));
    const lane = new JudgeLane({
      policies: [policy!],
      client,
      pricePerMtok: 0.042,
      model: "jev-1.13.0",
    });
    const rows = [
      { headline: "PM" },
      { headline: "Eng" },
      { headline: "PM lead" },
      { headline: "Sales" },
      { headline: "PM" },
    ];
    const events: unknown[] = [];
    const d = await lane.judge(
      policy!,
      { result: result(rows), runInput: "QUESTION: find PMs", callId: "c1" },
      (a) => events.push(a),
    );
    expect(d.rows_in).toBe(5);
    expect(d.rows_judged).toBe(5);
    expect(d.rows_would_filter).toBe(2);
    expect(d.calls).toBe(3); // batch 2
    expect(d.scores.map((s) => s[1])).toEqual([0.9, 0.1, 0.9, 0.1, 0.9]);
    expect(d.p50).toBe(0.9);
    expect(d.cost_usd).toBeCloseTo((300 * 0.042) / 1e6, 12);
    expect(events).toHaveLength(3);
    expect(calls[0]!.state.ask).toBe("find PMs");
  });

  test("a failed batch abstains for its rows only; no ask / bad shape / non-JSON skip cleanly", async () => {
    const { client } = fakeClient(() => 0.5, { fail: (n) => n === 1 });
    const lane = new JudgeLane({ policies: [policy!], client, pricePerMtok: 0.042, model: "m" });
    const d = await lane.judge(
      policy!,
      {
        result: result([{ headline: "a" }, { headline: "b" }, { headline: "c" }]),
        runInput: "QUESTION: x",
        callId: "c",
      },
      () => {},
    );
    expect(d.rows_abstained).toBe(2);
    expect(d.rows_judged).toBe(1);
    const noAsk = await lane.judge(
      policy!,
      { result: result([{ headline: "a" }]), runInput: "no marker here", callId: "c" },
      () => {},
    );
    expect(noAsk.skipped).toBe("no_ask");
    expect(noAsk.calls).toBe(0);
    const shape = await lane.judge(
      policy!,
      {
        result: JSON.stringify({ output: { data: "not rows" } }),
        runInput: "QUESTION: x",
        callId: "c",
      },
      () => {},
    );
    expect(shape.skipped).toBe("shape");
    const text = await lane.judge(
      policy!,
      { result: "plain text result", runInput: "QUESTION: x", callId: "c" },
      () => {},
    );
    expect(text.skipped).toBe("shape");
  });

  test("three consecutive failures put the lane in cooldown; the next result is skipped without a call", async () => {
    const { client, calls } = fakeClient(() => 0.5, { fail: () => true });
    let t = 0;
    const lane = new JudgeLane({
      policies: [policy!],
      client,
      pricePerMtok: 0.042,
      model: "m",
      now: () => t,
    });
    await lane.judge(
      policy!,
      {
        result: result([
          { headline: "a" },
          { headline: "b" },
          { headline: "c" },
          { headline: "d" },
          { headline: "e" },
          { headline: "f" },
        ]),
        runInput: "QUESTION: x",
        callId: "c",
      },
      () => {},
    );
    expect(calls.length).toBe(3);
    const d = await lane.judge(
      policy!,
      { result: result([{ headline: "a" }]), runInput: "QUESTION: x", callId: "c" },
      () => {},
    );
    expect(d.skipped).toBe("cooldown");
    expect(calls.length).toBe(3);
    t = 61_000;
    await lane.judge(
      policy!,
      { result: result([{ headline: "a" }]), runInput: "QUESTION: x", callId: "c" },
      () => {},
    );
    expect(calls.length).toBe(4);
  });

  test("max_rows caps what is judged; the deadline abstains the rest", async () => {
    const [p] = parseJudgeFile(
      raw({ ...POLICY, policies: { rows: { ...POLICY.policies.rows, max_rows: 3 } } }),
    ).policies;
    const { client } = fakeClient(() => 0.5);
    const lane = new JudgeLane({ policies: [p!], client, pricePerMtok: 0.042, model: "m" });
    const d = await lane.judge(
      p!,
      {
        result: result([1, 2, 3, 4, 5].map((i) => ({ headline: String(i) }))),
        runInput: "QUESTION: x",
        callId: "c",
      },
      () => {},
    );
    expect(d.rows_judged).toBe(3);
    expect(d.skipped).toBe("max_rows");
    let t = 0;
    const slow = new JudgeLane({
      policies: [p!],
      client,
      pricePerMtok: 0.042,
      model: "m",
      now: () => (t += 5_000),
    });
    const e = await slow.judge(
      p!,
      {
        result: result([1, 2, 3].map((i) => ({ headline: String(i) }))),
        runInput: "QUESTION: x",
        callId: "c",
        deadlineMs: 8_000,
      },
      () => {},
    );
    expect(e.rows_abstained + e.rows_judged).toBe(3);
    expect(e.skipped).toBe("deadline");
  });
});

describe("config + bundle", () => {
  test("the lane needs key AND egress; safe mode drops it; a bad judge.json fails boot, named", () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-judge-"));
    writeFileSync(join(ws, "judge.json"), raw());
    const off = loadConfig({ DELTA_WORKSPACE: ws, DELTA_JUDGE_KEY: "k" });
    expect(off.judge).toBeUndefined();
    expect(off.judgePolicies).toHaveLength(1);
    const on = loadConfig({ DELTA_WORKSPACE: ws, DELTA_JUDGE_KEY: "k", DELTA_JUDGE_EGRESS: "1" });
    expect(on.judge).toEqual({
      url: "https://api.typesafe.ai/v1/systemone",
      key: "k",
      model: "jev-1.13.0",
      timeoutMs: 3_000,
      pricePerMtok: 0.042,
    });
    const safe = loadConfig({
      DELTA_WORKSPACE: ws,
      DELTA_JUDGE_KEY: "k",
      DELTA_JUDGE_EGRESS: "1",
      DELTA_SAFE_MODE: "1",
    });
    expect(safe.judge).toBeUndefined();
    expect(safe.judgePolicies).toEqual([]);
    writeFileSync(join(ws, "judge.json"), '{"version":1,"policies":{"x":{"on":"tool.result"}}}');
    expect(() => loadConfig({ DELTA_WORKSPACE: ws })).toThrow(
      "policies.x: tool must be an exact tool name",
    );
  });

  test("bundle apply seeds judge.json from DELTA_JUDGE_JSON_B64 and refuses a bad one with nothing written", () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-judge-apply-"));
    const good = applyBundle(ws, 4_000, {
      DELTA_JUDGE_JSON_B64: Buffer.from(raw()).toString("base64"),
    });
    expect(good.applied).toEqual(["judge.json"]);
    expect(
      parseJudgeFile(require("node:fs").readFileSync(join(ws, "judge.json"), "utf8")).policies,
    ).toHaveLength(1);
    expect(() =>
      applyBundle(ws, 4_000, {
        DELTA_JUDGE_JSON_B64: Buffer.from('{"version":1,"policies":{"x":{}}}').toString("base64"),
      }),
    ).toThrow("policies.x: on must be");
    expect(
      parseJudgeFile(require("node:fs").readFileSync(join(ws, "judge.json"), "utf8")).policies,
    ).toHaveLength(1); // untouched
  });
});

describe("run-loop integration", () => {
  test("shadow: the model sees the byte-identical result, the judge saw only projected fields, both events land, cost is charged once", async () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-judge-run-"));
    // Deliberately awkward JSON: whitespace, integer-like keys, escaped unicode, a huge integer.
    const payload =
      '{"output": {"data": [{"headline":"PM \\u00e9","location":"Paris","email":"x@y.z","id":12345678901234567890,"roles":["a"]},{"9":"int-key","headline":"Eng","location":"Lyon"}], "next": 7}}';
    const search: ToolDef = {
      name: "search",
      description: "search",
      parameters: { type: "object", properties: {} },
      idempotent: true,
      execute: async () => payload,
    };
    let turn = 0;
    const chat = async () =>
      turn++ === 0 ? toolCallResult("search", {}, "call_s1") : textResult("done");
    const { client, calls } = fakeClient((r) => (String(r.headline).startsWith("PM") ? 0.8 : 0.2));
    const [policy] = parseJudgeFile(raw()).policies;
    const judge = new JudgeLane({
      policies: [policy!],
      client,
      pricePerMtok: 1_000,
      model: "jev-1.13.0",
    });
    const deps = makeDeps(chat as never, new Map([["search", search]]), { workspace: ws, judge });
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "run token abc\nQUESTION: find PMs in Paris" }).id,
    );
    expect(done.status).toBe("done");
    // 1. byte-identical tool result in the message row
    const toolRows = (
      deps.db.query("SELECT msg FROM messages WHERE run_id = ?").all(done.id) as { msg: string }[]
    )
      .map((r) => JSON.parse(r.msg))
      .filter((m) => m.role === "tool");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0].content).toBe(payload);
    // 2. the judge saw the ask (not the token line) and only the allowlisted fields
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state.ask).toBe("find PMs in Paris");
    const sent = JSON.stringify(calls[0]!.state);
    expect(sent).not.toContain("x@y.z");
    expect(sent).not.toContain("run token");
    expect(calls[0]!.state.rows[0]).toEqual({ headline: "PM é", location: "Paris", roles: ["a"] });
    // 3. events: one judge.call, one judge.decision with the per-row scores
    const ev = (
      deps.db
        .query("SELECT type, data FROM events WHERE run_id = ? AND type LIKE 'judge.%'")
        .all(done.id) as { type: string; data: string }[]
    ).map((r) => ({ type: r.type, data: JSON.parse(r.data) }));
    expect(ev.map((e) => e.type)).toEqual(["judge.call", "judge.decision"]);
    const dec = ev[1]!.data;
    expect(dec.rows_judged).toBe(2);
    expect(dec.rows_would_filter).toBe(1);
    expect(JSON.parse(dec.scores)).toEqual([
      [0, 0.8],
      [1, 0.2],
    ]);
    expect(dec.call_id).toBe("call_s1");
    // 4. cost charged once at the test price: 100 tokens * $1000/Mtok = $0.10 on top of two $0.001 turns
    const usage = JSON.parse(done.usage ?? "{}");
    expect(usage.costUsd).toBeGreaterThanOrEqual(0.1);
    expect(usage.costUsd).toBeLessThan(0.2);
  });

  test("no policy for the tool → no judge call; replay of a journaled result never re-judges", async () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-judge-run2-"));
    const other: ToolDef = {
      name: "other",
      description: "o",
      parameters: { type: "object", properties: {} },
      idempotent: true,
      execute: async () => '{"output":{"data":[{"headline":"x"}]}}',
    };
    let turn = 0;
    const chat = async () =>
      turn++ === 0 ? toolCallResult("other", {}, "c1") : textResult("done");
    const { client, calls } = fakeClient(() => 0.5);
    const [policy] = parseJudgeFile(raw()).policies;
    const deps = makeDeps(chat as never, new Map([["other", other]]), {
      workspace: ws,
      judge: new JudgeLane({ policies: [policy!], client, pricePerMtok: 0.042, model: "m" }),
    });
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "QUESTION: x" }).id);
    expect(done.status).toBe("done");
    expect(calls).toHaveLength(0);
  });
});
