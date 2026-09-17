// SPDX-License-Identifier: Apache-2.0
// The judge lane, slice 1 (shadow). Three layers: the policy file validator (shared by boot and
// `bundle apply`), the pure request/answer plumbing, and the run-loop integration through a fake
// client — where the load-bearing assertions are "byte-identical result", "the tool outcome is
// durable before the judge runs", "the key and the unprojected fields never leave the box", and
// "nothing the lane does can delay a turn past its deadline".

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBundle } from "../src/bundle";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Events } from "../src/events";
import { Exporter } from "../src/exporter";
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
      ask: { from: "run.input", after: "QUESTION:", until: "\n\n" },
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
const withRows = (over: Record<string, unknown>) =>
  raw({ ...POLICY, policies: { rows: { ...POLICY.policies.rows, ...over } } });

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
    bad((p) => {
      p.on = "loop";
    }, "reserved for a later slice");
    bad((p) => {
      p.tool = "aperture__*";
    }, "exact tool name");
    bad((p) => {
      p.rows = "__proto__.x";
    }, "dot path");
    bad((p) => {
      p.row_fields = [];
    }, "non-empty array");
    bad((p) => {
      p.row_fields = ["a.constructor"];
    }, "non-empty array of dot paths");
    bad((p) => {
      p.ask = { from: "history" };
    }, 'ask.from must be "run.input"');
    bad((p) => {
      p.ask = { from: "run.input" };
    }, "ask.after is required"); // never the whole input
    bad((p) => {
      p.questions = {};
    }, "non-empty object");
    bad((p) => {
      p.questions = { constructor: { instructions: "x" } };
    }, "must be an identifier");
    bad((p) => {
      p.questions = { fits: { type: "choice", instructions: "x", criteria: {} } };
    }, "only type noul");
    bad((p) => {
      p.mode = "filter";
    }, "mode must be shadow");
    bad((p) => {
      p.threshold = { nope: 0.5 };
    }, "unknown question");
    bad((p) => {
      p.threshold = { fits: 1 };
    }, "in (0,1)");
    bad((p) => {
      p.batch = 21;
    }, "1..20");
    bad((p) => {
      p.max_rows = 0;
    }, "1..500");
    bad((p) => {
      p.extra = 1;
    }, 'unknown key "extra"');
  });

  test("an empty threshold is absent, never 'every question' (which would filter everything)", () => {
    const [p] = parseJudgeFile(withRows({ threshold: {} })).policies;
    expect(p?.threshold).toBeUndefined();
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
    expect((p.roles as string[])[0]?.length).toBeLessThanOrEqual(301);
    expect(typeof p.nested).toBe("string"); // clipped JSON, never a live object
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(4_100);
    const big = projectRow(
      { a: "x".repeat(3_000), b: "y".repeat(3_000), c: "z".repeat(3_000), d: "w".repeat(3_000) },
      ["a", "b", "c", "d"],
    );
    expect(big.c).toBeDefined();
    expect(big.d).toBeUndefined(); // over the row cap: the field is dropped whole, and flagged
    expect(big._truncated).toBe(true);
  });

  test("resolveAsk: literal, marker, end marker; marker absent or empty → undefined (abstain)", () => {
    expect(resolveAsk({ literal: "find PMs" }, undefined)).toBe("find PMs");
    const a = { from: "run.input" as const, after: "QUESTION:", until: "\n\n" };
    expect(resolveAsk(a, "Token: abc\nQUESTION: find PMs\n\nRouting: nlp-search")).toBe("find PMs");
    expect(
      resolveAsk({ from: "run.input", after: "QUESTION:" }, "QUESTION: find PMs\n\nmore"),
    ).toBe("find PMs\n\nmore");
    expect(resolveAsk(a, "Token: abc")).toBeUndefined();
    expect(resolveAsk(a, "QUESTION:   \n\nRouting")).toBeUndefined();
    expect(resolveAsk(a, "")).toBeUndefined();
    // linear: a pathological input costs nothing more than its length
    const t0 = performance.now();
    resolveAsk(a, `${"a".repeat(200_000)}QUESTION:${"b".repeat(200_000)}`);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  test("buildRequest rewrites `row` per index and scrubs every leaf, the ask included, even a newline-bearing secret", () => {
    resetSecretRegistry();
    registerSecretValue("RUN_TOKEN", "tok_abc123secret");
    registerSecretValue("MULTI", "line1\nline2secret");
    const [policy] = parseJudgeFile(raw()).policies;
    if (!policy) throw new Error("policy");
    const req = buildRequest(policy, "find PMs tok_abc123secret", [
      {
        headline: "PM at X, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ",
        roles: [{ title: "PM", note: "line1\nline2secret" }],
      },
      { headline: "Eng" },
    ]);
    const s = JSON.stringify(req);
    expect(s).not.toContain("tok_abc123secret");
    expect(s).not.toContain("sk-ant-api03");
    expect(s).not.toContain("line2secret");
    expect((req.questions[qid("fits", 1)] as { instructions: string }).instructions).toContain(
      "`rows[1]`",
    );
    expect(Object.keys(req.questions)).toEqual([qid("fits", 0), qid("fits", 1)]);
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

function hangFetch(): typeof fetch {
  return ((_: string, init: RequestInit) =>
    new Promise((_, rej) =>
      init.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
    )) as never;
}

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
    expect(seen?.url).toBe(cfg.url);
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe("Bearer KEY-XYZ");
    expect(String(seen?.init.body)).not.toContain("KEY-XYZ");
    expect(JSON.parse(String(seen?.init.body)).model).toBe("jev-1.13.0");
  });

  test("an echoing or hostile endpoint cannot land the key, a fake model id, or a poisoned usage figure", async () => {
    resetSecretRegistry();
    registerSecretValue("DELTA_JUDGE_KEY", "KEY-XYZ");
    const echo = makeJudgeClient({
      ...cfg,
      fetch: (async (_: string, init: RequestInit) =>
        new Response(`bad: ${(init.headers as Record<string, string>).Authorization}`, {
          status: 400,
        })) as never,
    });
    const e = await echo({}, {});
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).not.toContain("KEY-XYZ");
    const hostile = makeJudgeClient({
      ...cfg,
      fetch: (async () =>
        new Response(
          '{"model":"Bearer KEY-XYZ","answers":{},"usage":{"input_tokens":1e309}}',
        )) as never,
    });
    const h = await hostile({}, {});
    expect(h.ok).toBe(true);
    if (h.ok) {
      expect(h.model).toBe("jev-1.13.0"); // not a plain identifier → the configured id
      expect(h.inputTokens).toBe(0); // Infinity is not a count
    }
    resetSecretRegistry();
  });

  test("timeouts, cancellation, non-2xx and non-JSON come back as classified failures, never throws", async () => {
    const hang = makeJudgeClient({ ...cfg, fetch: hangFetch() });
    const t = await hang({}, {});
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.class).toBe("timeout");
    const ac = new AbortController();
    const p = makeJudgeClient({ ...cfg, timeoutMs: 10_000, fetch: hangFetch() })({}, {}, ac.signal);
    ac.abort();
    const c = await p;
    if (!c.ok) expect(c.class).toBe("timeout"); // the run's cancellation reaches the request
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
  opts: { fail?: (n: number) => boolean; delayMs?: number } = {},
) {
  const calls: {
    state: { ask: string; rows: Record<string, unknown>[] };
    questions: Record<string, unknown>;
  }[] = [];
  let inFlight = 0;
  let peak = 0;
  const client = async (
    state: unknown,
    questions: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JudgeResult> => {
    const s = state as { ask: string; rows: Record<string, unknown>[] };
    calls.push({ state: s, questions });
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      if (opts.delayMs) {
        const aborted = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), opts.delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            resolve(true);
          });
        });
        if (aborted) return { ok: false, error: "aborted", class: "timeout", latencyMs: 1 };
      }
      if (opts.fail?.(calls.length))
        return { ok: false, error: "boom", class: "transient", status: 500, latencyMs: 1 };
      const answers: Record<string, unknown> = {};
      for (let j = 0; j < s.rows.length; j++)
        answers[qid("fits", j)] = { type: "noul", noul: score(s.rows[j] ?? {}) };
      return { ok: true, answers, inputTokens: 100, model: "jev-1.13.0", latencyMs: 1 };
    } finally {
      inFlight--;
    }
  };
  return { client, calls, peak: () => peak };
}

const policy1 = () => {
  const [p] = parseJudgeFile(raw()).policies;
  if (!p) throw new Error("policy");
  return p;
};
const result = (rows: unknown[]) => JSON.stringify({ output: { data: rows, next: 2 } });
const rowsN = (n: number) => Array.from({ length: n }, (_, i) => ({ headline: `h${i}` }));

describe("JudgeLane.judge (shadow)", () => {
  test("scores rows in batches, counts would-filter against the threshold, never touches the result", async () => {
    const { client, calls } = fakeClient((r) => (String(r.headline).includes("PM") ? 0.9 : 0.1));
    const policy = policy1();
    const lane = new JudgeLane({ policies: [policy], client, pricePerMtok: 0.042, model: "m" });
    const rows = [
      { headline: "PM" },
      { headline: "Eng" },
      { headline: "PM lead" },
      { headline: "Sales" },
      { headline: "PM" },
    ];
    const events: unknown[] = [];
    const d = await lane.judge(
      policy,
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
    expect(calls[0]?.state.ask).toBe("find PMs");
  });

  test("a failed batch abstains for its rows only; no ask / bad shape / non-JSON skip cleanly", async () => {
    const { client } = fakeClient(() => 0.5, { fail: (n) => n === 1 });
    const policy = policy1();
    const lane = new JudgeLane({ policies: [policy], client, pricePerMtok: 0.042, model: "m" });
    const d = await lane.judge(
      policy,
      { result: result(rowsN(3)), runInput: "QUESTION: x", callId: "c" },
      () => {},
    );
    expect(d.rows_abstained).toBe(2);
    expect(d.rows_judged).toBe(1);
    const noAsk = await lane.judge(
      policy,
      { result: result(rowsN(1)), runInput: "no marker here", callId: "c" },
      () => {},
    );
    expect(noAsk.skipped).toBe("no_ask");
    expect(noAsk.calls).toBe(0);
    const shape = await lane.judge(
      policy,
      {
        result: JSON.stringify({ output: { data: "not rows" } }),
        runInput: "QUESTION: x",
        callId: "c",
      },
      () => {},
    );
    expect(shape.skipped).toBe("shape");
    const text = await lane.judge(
      policy,
      { result: "plain text result", runInput: "QUESTION: x", callId: "c" },
      () => {},
    );
    expect(text.skipped).toBe("shape");
  });

  test("three consecutive failures put the lane in cooldown — mid-result too — and it lifts after a minute", async () => {
    const { client, calls } = fakeClient(() => 0.5, { fail: () => true });
    let t = 0;
    const policy = policy1();
    const lane = new JudgeLane({
      policies: [policy],
      client,
      pricePerMtok: 0.042,
      model: "m",
      now: () => t,
    });
    // 20 rows at batch 2 = 10 requests; the lane must stop sending after the third failure
    const d = await lane.judge(
      policy,
      { result: result(rowsN(20)), runInput: "QUESTION: x", callId: "c" },
      () => {},
    );
    expect(calls.length).toBeLessThanOrEqual(4); // 3 failures + at most the batches already in flight
    expect(d.rows_abstained).toBe(20);
    const again = await lane.judge(
      policy,
      { result: result(rowsN(1)), runInput: "QUESTION: x", callId: "c" },
      () => {},
    );
    expect(again.skipped).toBe("cooldown");
    const n = calls.length;
    t = 61_000;
    await lane.judge(
      policy,
      { result: result(rowsN(1)), runInput: "QUESTION: x", callId: "c" },
      () => {},
    );
    expect(calls.length).toBe(n + 1);
  });

  test("max_rows caps what is judged and counts the rest; the deadline abstains rows with a request still outstanding", async () => {
    const [p] = parseJudgeFile(withRows({ max_rows: 3 })).policies;
    if (!p) throw new Error("policy");
    const { client } = fakeClient(() => 0.5);
    const lane = new JudgeLane({ policies: [p], client, pricePerMtok: 0.042, model: "m" });
    const d = await lane.judge(
      p,
      { result: result(rowsN(5)), runInput: "QUESTION: x", callId: "c" },
      () => {},
    );
    expect(d.rows_judged).toBe(3);
    expect(d.rows_capped).toBe(2);
    expect(d.skipped).toBe("max_rows");
    expect(d.rows_judged + d.rows_abstained + d.rows_capped).toBe(d.rows_in);
    // real elapsed time: each request takes 200 ms, the deadline is 60 ms → nothing completes,
    // and the whole call returns near the deadline, not after every request finished
    const slowC = fakeClient(() => 0.5, { delayMs: 200 });
    const slow = new JudgeLane({
      policies: [policy1()],
      client: slowC.client,
      pricePerMtok: 0.042,
      model: "m",
    });
    const t0 = performance.now();
    const e = await slow.judge(
      policy1(),
      { result: result(rowsN(10)), runInput: "QUESTION: x", callId: "c", deadlineMs: 60 },
      () => {},
    );
    expect(performance.now() - t0).toBeLessThan(180);
    expect(e.rows_judged).toBe(0);
    expect(e.rows_abstained).toBe(10);
    expect(e.skipped).toBe("deadline");
  });

  test("the run's cancellation stops judging; the in-flight bound holds across parallel results (no barging)", async () => {
    const c = fakeClient(() => 0.5, { delayMs: 30 });
    const policy = policy1();
    const lane = new JudgeLane({
      policies: [policy],
      client: c.client,
      pricePerMtok: 0.042,
      model: "m",
    });
    // 6 results × 5 batches each, all at once: never more than 4 requests in flight
    const all = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        lane.judge(
          policy,
          { result: result(rowsN(10)), runInput: "QUESTION: x", callId: `c${i}` },
          () => {},
        ),
      ),
    );
    expect(c.peak()).toBeLessThanOrEqual(4);
    expect(all.every((d) => d.rows_judged === 10)).toBe(true);
    const ac = new AbortController();
    const pending = lane.judge(
      policy,
      { result: result(rowsN(10)), runInput: "QUESTION: x", callId: "x", signal: ac.signal },
      () => {},
    );
    ac.abort();
    const d = await pending;
    expect(d.rows_judged).toBe(0);
    expect(d.skipped).toBe("deadline");
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
    expect(parseJudgeFile(readFileSync(join(ws, "judge.json"), "utf8")).policies).toHaveLength(1);
    expect(() =>
      applyBundle(ws, 4_000, {
        DELTA_JUDGE_JSON_B64: Buffer.from('{"version":1,"policies":{"x":{}}}').toString("base64"),
      }),
    ).toThrow("policies.x: on must be");
    expect(parseJudgeFile(readFileSync(join(ws, "judge.json"), "utf8")).policies).toHaveLength(1); // untouched
  });
});

describe("exporter consent", () => {
  test("without payload consent a judge.decision exports counters and enums only: no scores, no percentiles", async () => {
    const db = openDb(":memory:");
    const events = new Events(db);
    events.emit(
      "judge.decision",
      { runId: "r1" },
      {
        policy: "rows",
        mode: "shadow",
        tool: "search",
        call_id: "c1",
        rows_in: 1,
        rows_judged: 1,
        rows_abstained: 0,
        rows_capped: 0,
        rows_would_filter: 0,
        scores: "[[0,0.731]]",
        p10: 0.731,
        p50: 0.731,
        calls: 1,
        cost_usd: 0.00001,
        input_tokens: 120,
        latency_ms: 300,
        model: "jev-1.13.0",
      },
    );
    const received: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        for (const line of (await req.text()).split("\n").filter(Boolean))
          received.push(JSON.parse(line));
        return new Response("ok");
      },
    });
    try {
      await new Exporter(db, {
        url: `http://localhost:${server.port}/`,
        capturePayloads: false,
      }).flush();
    } finally {
      server.stop();
    }
    const rec = received.find((r) => r["event.name"] === "judge.decision");
    expect(rec?.attributes).toEqual({
      policy: "rows",
      mode: "shadow",
      rows_in: 1,
      rows_judged: 1,
      rows_abstained: 0,
      rows_would_filter: 0,
      calls: 1,
      input_tokens: 120,
      latency_ms: 300,
      model: "jev-1.13.0",
    });
  });
});

describe("run-loop integration", () => {
  const search = (payload: string): ToolDef => ({
    name: "search",
    description: "search",
    parameters: { type: "object", properties: {} },
    idempotent: true,
    execute: async () => payload,
  });
  // Deliberately awkward JSON: whitespace, integer-like keys, escaped unicode, a huge integer,
  // exponent notation — every shape JSON.stringify would normalize.
  const payload =
    '{"output": {"data": [{"headline":"PM \\u00e9","location":"Paris","email":"x@y.z","id":12345678901234567890,"n":1e2,"roles":["a"]},{"9":"int-key","headline":"Eng","location":"Lyon"}], "next": 7}}';

  test("shadow: byte-identical result, durable checkpoint, projected fields only, both events, cost charged once", async () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-judge-run-"));
    let turn = 0;
    const chat = async () =>
      turn++ === 0 ? toolCallResult("search", {}, "call_s1") : textResult("done");
    const { client, calls } = fakeClient((r) => (String(r.headline).startsWith("PM") ? 0.8 : 0.2));
    const judge = new JudgeLane({ policies: [policy1()], client, pricePerMtok: 1_000, model: "m" });
    const deps = makeDeps(chat as never, new Map([["search", search(payload)]]), {
      workspace: ws,
      judge,
    });
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: "run token abc\nQUESTION: find PMs in Paris\n\nRouting: nlp-search" })
        .id,
    );
    expect(done.status).toBe("done");
    // 1. byte-identical tool result in the message row AND the journal
    const toolRows = (
      deps.db.query("SELECT msg FROM messages WHERE run_id = ?").all(done.id) as { msg: string }[]
    )
      .map((r) => JSON.parse(r.msg))
      .filter((m) => m.role === "tool");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0].content).toBe(payload);
    const journal = deps.db
      .query("SELECT status, result FROM journal WHERE run_id = ? AND call_id = 'call_s1'")
      .get(done.id) as { status: string; result: string };
    expect(journal.status).toBe("done");
    expect(journal.result).toBe(payload);
    // 2. the judge saw the ask (not the token line, not the routing card) and only the allowlisted fields
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state.ask).toBe("find PMs in Paris");
    const sent = JSON.stringify(calls[0]?.state);
    expect(sent).not.toContain("x@y.z");
    expect(sent).not.toContain("run token");
    expect(sent).not.toContain("Routing");
    expect(calls[0]?.state.rows[0]).toEqual({ headline: "PM é", location: "Paris", roles: ["a"] });
    // 3. events: one judge.call, one judge.decision with the per-row scores, after the tool.result
    const ev = (
      deps.db
        .query(
          "SELECT type, data FROM events WHERE run_id = ? AND type IN ('tool.result','judge.call','judge.decision') ORDER BY id",
        )
        .all(done.id) as { type: string; data: string }[]
    ).map((r) => ({ type: r.type, data: JSON.parse(r.data) }));
    expect(ev.map((e) => e.type)).toEqual(["tool.result", "judge.call", "judge.decision"]);
    const dec = ev[2]?.data;
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

  test("a replayed journal row (crash after execution) is never re-judged; an unmatched tool is never judged", async () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-judge-run2-"));
    let turn = 0;
    const chat = async () =>
      turn++ === 0 ? toolCallResult("search", {}, "call_r1") : textResult("done");
    const { client, calls } = fakeClient(() => 0.5);
    const deps = makeDeps(chat as never, new Map([["search", search(payload)]]), {
      workspace: ws,
      judge: new JudgeLane({ policies: [policy1()], client, pricePerMtok: 0.042, model: "m" }),
    });
    const queue = new Queue(deps);
    const run = queue.enqueue({ input: "QUESTION: x" });
    // The crash shape: the tool already executed and journaled `done`, the message row never landed.
    deps.db
      .query(
        "INSERT INTO journal (run_id, call_id, tool, args, status, result, created_at, finished_at) VALUES (?, 'call_r1', 'search', '{}', 'done', ?, ?, ?)",
      )
      .run(run.id, payload, Date.now(), Date.now());
    const done = await queue.wait(run.id);
    expect(done.status).toBe("done");
    expect(calls).toHaveLength(0);

    const other: ToolDef = { ...search(payload), name: "other" };
    let t2 = 0;
    const chat2 = async () => (t2++ === 0 ? toolCallResult("other", {}, "c1") : textResult("done"));
    const c2 = fakeClient(() => 0.5);
    const deps2 = makeDeps(chat2 as never, new Map([["other", other]]), {
      workspace: mkdtempSync(join(tmpdir(), "delta-judge-run3-")),
      judge: new JudgeLane({
        policies: [policy1()],
        client: c2.client,
        pricePerMtok: 0.042,
        model: "m",
      }),
    });
    const q2 = new Queue(deps2);
    expect((await q2.wait(q2.enqueue({ input: "QUESTION: x" }).id)).status).toBe("done");
    expect(c2.calls).toHaveLength(0);
  });
});
