// The four load-bearing hosting contracts (Aperture field report, Part 2), promoted from
// observed behavior to documented guarantee in docs/hosting.md. This file is their single
// NAMED tripwire: a refactor that weakens one fails a test whose name says "you broke a
// hosting contract", not just some incidentally-related unit test elsewhere.
//
// DO NOT weaken any assertion here without a major-version note — external hosts build
// their reconcilers on exactly these promises. (The /v1/busy HTTP wire itself is covered
// in server.test.ts; here we pin the durable-truth semantics behind it.)

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBundle, FIXED_OPERATOR_FILES } from "../src/bundle";
import { cliInit } from "../src/cli";
import { Queue } from "../src/queue";
import { testTools } from "../src/tools";
import { makeDeps, textResult } from "./helpers";

describe("hosting contracts (do not weaken without a major bump)", () => {
  test("1. idempotency keys are freed on EVERY terminal state (done and cancelled)", async () => {
    const deps = makeDeps(async () => textResult("filed"));
    const queue = new Queue(deps);
    // Two dispatches in the same tick: the first is still queued when the second arrives,
    // so the key dedupes onto the live run — no duplicate work.
    const a = queue.enqueue({ input: "process t", idempotency_key: "k" });
    const b = queue.enqueue({ input: "process t", idempotency_key: "k" });
    expect(b.id).toBe(a.id);
    await queue.wait(a.id); // → done (a terminal state)
    // The key is now free: a later dispatch is a NEW run, not a dedup ghost.
    const c = queue.enqueue({ input: "process t", idempotency_key: "k" });
    expect(c.id).not.toBe(a.id);

    // "Terminal" means ALL terminal states, not just `done`: a cancelled run must free the
    // key too, or a host that cancels + retries would be silently deduped onto a dead run.
    queue.cancel(c.id); // catches it queued → cancelled (terminal) before the pump runs
    const d = queue.enqueue({ input: "process t", idempotency_key: "k" });
    expect(d.id).not.toBe(c.id); // cancelled also frees the key
    await queue.wait(d.id);
  });

  test("2. recover() resumes a mid-flight run AND continues from its last checkpoint", async () => {
    // Craft the on-disk state of a daemon killed mid-run: one session, one run stuck
    // 'running', with a PRIOR turn already checkpointed (an assistant tool_call whose result
    // is recorded 'done' in the journal). Recovery must (a) pick the running row up and
    // (b) continue from that checkpoint — replay the recorded result, NOT restart the turn.
    const deps = makeDeps(async (req) => {
      const toolMsg = req.messages.findLast((m) => m.role === "tool") as
        | { content: string }
        | undefined;
      return textResult(`final: ${toolMsg?.content ?? "NO-CHECKPOINT"}`);
    }, testTools());
    const now = Date.now();
    deps.db
      .query("INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES (?, NULL, ?, ?)")
      .run("sess_r", now, now);
    deps.db
      .query(
        "INSERT INTO runs (id, session_id, seq, status, request, created_at, started_at) VALUES (?, ?, 1, 'running', ?, ?, ?)",
      )
      .run("resp_r", "sess_r", JSON.stringify({ input: "do it" }), now, now);
    const msg = deps.db.query(
      "INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('resp_r', 'sess_r', ?, ?)",
    );
    msg.run(JSON.stringify({ role: "user", content: "do it" }), now);
    msg.run(
      JSON.stringify({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_z", type: "function", function: { name: "add", arguments: '{"a":1,"b":1}' } },
        ],
      }),
      now,
    );
    // The checkpoint: the tool already ran before the crash; its result is recorded 'done'.
    deps.db
      .query(
        "INSERT INTO journal (run_id, call_id, tool, args, status, result, created_at, finished_at) VALUES ('resp_r', 'call_z', 'add', '{\"a\":1,\"b\":1}', 'done', 'CHECKPOINT_KEPT', ?, ?)",
      )
      .run(now, now);

    const queue = new Queue(deps);
    queue.recover(); // boot path
    const done = await queue.wait("resp_r");
    expect(done.status).toBe("done"); // the crashed run was continued, not stranded
    // Proof it continued FROM the checkpoint: the recorded result was replayed into the next
    // model call rather than the 'add' turn being re-run from scratch.
    expect(JSON.parse(done.result ?? "{}").output_text).toBe("final: CHECKPOINT_KEPT");
  });

  test("3. /v1/busy reports durable truth: queued OR running holds it, terminal never does", () => {
    // activity() is exactly what GET /v1/busy returns (server.ts:399). It must read the runs
    // table, not the in-memory session set, so a queued-but-not-yet-dispatched run still holds
    // the machine awake. Insert rows in each state and assert the math directly (race-free).
    const deps = makeDeps(async () => textResult("x"));
    const queue = new Queue(deps);
    const now = Date.now();
    deps.db
      .query("INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s', NULL, ?, ?)")
      .run(now, now);
    const addRun = (id: string, status: string, seq: number) =>
      deps.db
        .query(
          "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES (?, 's', ?, ?, '{}', ?)",
        )
        .run(id, seq, status, now);

    expect(queue.activity()).toEqual({ busy: false, running: 0, queued: 0 }); // idle
    addRun("r_q", "queued", 1);
    expect(queue.activity()).toEqual({ busy: true, running: 0, queued: 1 }); // queued holds it
    addRun("r_r", "running", 2);
    expect(queue.activity()).toEqual({ busy: true, running: 1, queued: 1 });
    // No terminal state counts toward busy — not done, not failed, not cancelled.
    addRun("r_done", "done", 3);
    addRun("r_failed", "failed", 4);
    addRun("r_cancelled", "cancelled", 5);
    expect(queue.activity()).toEqual({ busy: true, running: 1, queued: 1 });
    deps.db.query("UPDATE runs SET status = 'done' WHERE id IN ('r_q','r_r')").run();
    expect(queue.activity()).toEqual({ busy: false, running: 0, queued: 0 }); // all settled
  });

  test("4. seeding never touches an existing DELTA.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-contract-"));
    expect(await cliInit([dir])).toBe(0);
    expect(existsSync(join(dir, "DELTA.md"))).toBe(true);
    // The agent has since edited its self-file (its learned state lives here).
    const learned = "# My learned persona\n\n## Learned\n- prod insight the agent earned";
    writeFileSync(join(dir, "DELTA.md"), learned);
    // A re-seed (as a POLICY/vocab refresh would trigger) must leave DELTA.md byte-identical.
    expect(await cliInit([dir])).toBe(0);
    expect(readFileSync(join(dir, "DELTA.md"), "utf8")).toBe(learned);
  });
});

describe("bundle apply (A12) — the fixed files reconcile, DELTA.md never does", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  test("re-seeds the fixed files from env and leaves a learned DELTA.md byte-identical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-bundle-"));
    expect(await cliInit([dir])).toBe(0);
    const learned = "# Learned self\n\n## Learned\n- an insight the agent earned in prod";
    writeFileSync(join(dir, "DELTA.md"), learned);

    const newPolicy = "# Policy\n\n- the updated operating contract";
    const newVocab = JSON.stringify({ writeNoun: "candidate" });
    const res = applyBundle(dir, 100_000, {
      DELTA_POLICY_MD_B64: b64(newPolicy),
      DELTA_VOCAB_JSON_B64: b64(newVocab),
      // A DIFFERENT self payload in the env must NOT overwrite the agent's learned DELTA.md.
      DELTA_SELF_MD_B64: b64("# a different self the operator tried to push"),
    });

    expect(res.applied.sort()).toEqual(["POLICY.md", "vocab.json"]);
    expect(readFileSync(join(dir, "DELTA.md"), "utf8")).toBe(learned); // untouched
    expect(readFileSync(join(dir, "POLICY.md"), "utf8")).toBe(newPolicy);
    expect(readFileSync(join(dir, "vocab.json"), "utf8")).toBe(newVocab);
    // Structural: DELTA.md is not a member of the fixed set by construction.
    expect(FIXED_OPERATOR_FILES.has("DELTA.md")).toBe(false);
  });

  test("all-or-nothing: a bad payload is refused and NOTHING is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-bundle-"));
    writeFileSync(join(dir, "POLICY.md"), "# good existing policy");
    writeFileSync(join(dir, "vocab.json"), '{"writeNoun":"kept"}');
    expect(() =>
      applyBundle(dir, 100_000, {
        DELTA_POLICY_MD_B64: b64("# a valid new policy"), // valid, but…
        DELTA_VOCAB_JSON_B64: b64("{not json"), // …invalid → the whole apply must abort
      }),
    ).toThrow(/vocab\.json/);
    // Validate-all precedes any swap, so the valid POLICY payload must NOT have landed.
    expect(readFileSync(join(dir, "POLICY.md"), "utf8")).toBe("# good existing policy");
    expect(readFileSync(join(dir, "vocab.json"), "utf8")).toBe('{"writeNoun":"kept"}');
  });

  test("refuses a POLICY over the token budget (would boot-loop) — nothing written", () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-bundle-"));
    const huge = "x".repeat(50_000); // ~12.5k tokens
    expect(() => applyBundle(dir, 4_000, { DELTA_POLICY_MD_B64: b64(huge) })).toThrow(
      /budget|boot-loop/,
    );
    expect(existsSync(join(dir, "POLICY.md"))).toBe(false);
  });
});
