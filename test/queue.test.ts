import { describe, expect, test } from "bun:test";
import { remember } from "../src/memory";
import type { ChatMsg, ChatRequest } from "../src/provider";
import { Queue, SessionOwnershipError } from "../src/queue";
import { executeRun } from "../src/run";
import { testTools } from "../src/tools";
import { makeDeps, textResult, toolCallResult } from "./helpers";

describe("queue + run", () => {
  test("simple turn: enqueue → done with driver-compatible payload", async () => {
    const deps = makeDeps(async () => textResult("hello from delta"));
    const queue = new Queue(deps);
    const run = queue.enqueue({ input: "hi" });
    const done = await queue.wait(run.id);
    expect(done.status).toBe("done");
    const payload = JSON.parse(done.result ?? "{}");
    expect(payload.output_text).toBe("hello from delta");
    expect(payload.id).toMatch(/^resp_[0-9a-f]{32}$/);
    expect(payload.usage.total_tokens).toBe(15);
    expect(payload.output[0].content[0].text).toBe("hello from delta");
  });

  test("store:false purges the whole session transcript after the turn (ephemeral)", async () => {
    const deps = makeDeps(async () => textResult("ephemeral reply"));
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "process meeting X", store: false }).id);
    // The waiter still gets its terminal payload (purge runs AFTER settle, on the in-memory row).
    expect(done.status).toBe("done");
    expect(JSON.parse(done.result ?? "{}").output_text).toBe("ephemeral reply");
    // ...but nothing meeting-derived is retained on disk.
    const { db } = deps;
    const count = (t: string, col: string) =>
      (
        db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).get(done.session_id) as {
          n: number;
        }
      ).n;
    expect(count("sessions", "id")).toBe(0);
    expect(count("runs", "session_id")).toBe(0);
    expect(count("messages", "session_id")).toBe(0);
    expect(count("calls", "session_id")).toBe(0);
  });

  test("store:true (default) retains the session — the purge is opt-in", async () => {
    const deps = makeDeps(async () => textResult("kept"));
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "hi", store: true }).id);
    const n = (
      deps.db.query("SELECT COUNT(*) AS n FROM runs WHERE session_id = ?").get(done.session_id) as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);
  });

  test("previous_response_id threads history into the next model call", async () => {
    const seen: ChatMsg[][] = [];
    const deps = makeDeps(async (req: ChatRequest) => {
      seen.push(req.messages);
      return textResult(`reply ${seen.length}`);
    });
    const queue = new Queue(deps);
    const first = await queue.wait(queue.enqueue({ input: "my name is Nic" }).id);
    const second = await queue.wait(
      queue.enqueue({ input: "what is my name?", previous_response_id: first.id }).id,
    );
    expect(second.session_id).toBe(first.session_id);
    const secondMessages = seen[1] ?? [];
    const texts = secondMessages.map((m) => JSON.stringify(m));
    expect(texts.some((t) => t.includes("my name is Nic"))).toBe(true);
    expect(texts.some((t) => t.includes("reply 1"))).toBe(true);
    expect(texts.some((t) => t.includes("what is my name?"))).toBe(true);
  });

  test("recall reads the namespace reflection writes (production wiring, not the default)", async () => {
    // Regression: reflection writes under memoryNamespace (a product namespace); if run.ts
    // recall read DEFAULT_NAMESPACE instead, it would never surface the agent's own writes.
    const seen: ChatMsg[][] = [];
    const deps = {
      ...makeDeps(async (req: ChatRequest) => {
        seen.push(req.messages);
        return textResult("done");
      }),
      agentId: "delta-ns",
      memoryNamespace: "kb",
    };
    // A prior learning written under the product namespace, exactly as reflection would.
    remember(deps.db, {
      namespace: "kb",
      agentId: "delta-ns",
      audience: "agent",
      artifactKind: "fact",
      content: "the canary lesson lives under the kb namespace",
      confidence: 0.9,
      trust: "trusted",
      source: "self",
    });
    const queue = new Queue(deps);
    await queue.wait(queue.enqueue({ input: "do a fresh task" }).id);
    const prompt = (seen[0] ?? []).map((m) => JSON.stringify(m)).join("\n");
    expect(prompt).toContain("canary lesson");
  });

  test("recall resolves the user from the session, not just request metadata (codex audit P1)", async () => {
    // A user memory written under 'alice'; a later request in her session omits user_id
    // from metadata (only the session carries it). Recall must still surface her rows.
    const seen: ChatMsg[][] = [];
    const deps = {
      ...makeDeps(async (req: ChatRequest) => {
        seen.push(req.messages);
        return textResult("done");
      }),
      agentId: "delta-u",
    };
    remember(deps.db, {
      namespace: "default",
      agentId: "delta-u",
      audience: "user",
      userId: "alice",
      artifactKind: "preference",
      content: "alice wants ranges, not point numbers",
      confidence: 0.9,
      trust: "trusted",
      source: "self",
    });
    const queue = new Queue(deps);
    // First request binds the session to alice; recall runs on this fresh session.
    await queue.wait(queue.enqueue({ input: "kick off", metadata: { user_id: "alice" } }).id);
    const prompt = (seen[0] ?? []).map((m) => JSON.stringify(m)).join("\n");
    expect(prompt).toContain("ranges, not point numbers");
  });

  test("serial within a session, concurrent across sessions", async () => {
    const order: string[] = [];
    let release: (() => void)[] = [];
    const deps = makeDeps(async (req: ChatRequest) => {
      const input = JSON.stringify(req.messages.at(-1));
      order.push(`start:${input}`);
      await new Promise<void>((r) => release.push(r));
      order.push(`end:${input}`);
      return textResult("ok");
    });
    const queue = new Queue(deps);
    const a1 = queue.enqueue({ input: "a1" });
    const a2 = queue.enqueue({ input: "a2", previous_response_id: a1.id }); // same session
    const b1 = queue.enqueue({ input: "b1" }); // other session
    await Bun.sleep(20);
    // a1 and b1 run concurrently; a2 waits for a1.
    expect(order.filter((o) => o.startsWith("start")).length).toBe(2);
    expect(order.some((o) => o.startsWith("start") && o.includes("a2"))).toBe(false);
    for (const r of release) r();
    release = [];
    await queue.wait(a1.id);
    await Bun.sleep(20);
    expect(order.some((o) => o.startsWith("start") && o.includes("a2"))).toBe(true);
    for (const r of release) r();
    await Promise.all([queue.wait(a2.id), queue.wait(b1.id)]);
    expect((await queue.wait(a2.id)).status).toBe("done");
  });

  test("tool loop: model calls a tool, journal records intent→done, result feeds back", async () => {
    let call = 0;
    const deps = makeDeps(async (req: ChatRequest) => {
      call++;
      if (call === 1) return toolCallResult("add", { a: 2, b: 3 });
      const toolMsg = req.messages.find((m) => m.role === "tool");
      return textResult(`the sum is ${(toolMsg as { content: string }).content}`);
    }, testTools());
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "add 2 and 3" }).id);
    expect(done.status).toBe("done");
    expect(JSON.parse(done.result ?? "{}").output_text).toBe("the sum is 5");
    const journal = deps.db.query("SELECT * FROM journal WHERE run_id = ?").all(done.id) as {
      status: string;
      result: string;
      tool: string;
    }[];
    expect(journal.length).toBe(1);
    expect(journal[0]?.status).toBe("done");
    expect(journal[0]?.result).toBe("5");
  });

  test("provider failure is a clean failed turn, not a crash; chain stays valid", async () => {
    let call = 0;
    const deps = makeDeps(async () => {
      call++;
      if (call === 1) return { ok: false as const, model: "test/a", error: "provider melted" };
      return textResult("recovered next turn");
    });
    const queue = new Queue(deps);
    const failed = await queue.wait(queue.enqueue({ input: "hi" }).id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("provider melted");
    expect(JSON.parse(failed.result ?? "{}").output_text).toContain("provider melted");
    // The next turn in the same session still works over a valid message chain.
    const next = await queue.wait(
      queue.enqueue({ input: "again", previous_response_id: failed.id }).id,
    );
    expect(next.status).toBe("done");
  });

  test("unknown tool returns a tool-error result and the run completes", async () => {
    let call = 0;
    const deps = makeDeps(async (req: ChatRequest) => {
      call++;
      if (call === 1) return toolCallResult("summon_demons", {});
      const toolMsg = req.messages.find((m) => m.role === "tool") as { content: string };
      return textResult(toolMsg.content);
    });
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "go" }).id);
    expect(done.status).toBe("done");
    expect(JSON.parse(done.result ?? "{}").output_text).toContain("unknown tool 'summon_demons'");
  });

  test("cancel a queued run", async () => {
    let release: () => void = () => {};
    const deps = makeDeps(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return textResult("ok");
    });
    const queue = new Queue(deps);
    const a1 = queue.enqueue({ input: "a1" });
    const a2 = queue.enqueue({ input: "a2", previous_response_id: a1.id });
    await Bun.sleep(10);
    expect(queue.cancel(a2.id)).toBe(true);
    release();
    await queue.wait(a1.id);
    const cancelled = await queue.wait(a2.id);
    expect(cancelled.status).toBe("cancelled");
    // Even never-started runs owe a Responses-compatible payload (codex P2).
    const payload = JSON.parse(cancelled.result ?? "{}");
    expect(payload.id).toBe(a2.id);
    expect(payload.output_text).toContain("cancelled");
  });

  test("unknown previous_response_id is rejected, not silently forked (codex P2)", () => {
    const deps = makeDeps(async () => textResult("ok"));
    const queue = new Queue(deps);
    expect(() => queue.enqueue({ input: "hi", previous_response_id: "resp_nope" })).toThrow(
      "unknown previous_response_id",
    );
  });

  test("S0: an owned session cannot be continued by another user, nor anonymously", async () => {
    // Without this, any caller could pass Alice's resp_… id and inherit her session —
    // and thread-scoped recall would read back her compacted transcript (cross-user leak).
    const deps = makeDeps(async () => textResult("ok"));
    const queue = new Queue(deps);
    const alice = await queue.wait(
      queue.enqueue({ input: "hi", metadata: { user_id: "alice" } }).id,
    );
    // Bob tries to continue Alice's session by id.
    expect(() =>
      queue.enqueue({
        input: "steal",
        previous_response_id: alice.id,
        metadata: { user_id: "bob" },
      }),
    ).toThrow(SessionOwnershipError);
    // An anonymous caller (no asserted user_id) also cannot continue an owned session.
    expect(() => queue.enqueue({ input: "steal", previous_response_id: alice.id })).toThrow(
      SessionOwnershipError,
    );
    // The rightful owner still can.
    const cont = queue.enqueue({
      input: "again",
      previous_response_id: alice.id,
      metadata: { user_id: "alice" },
    });
    expect(cont.session_id).toBe(alice.session_id);
  });

  test("S0: ownership recognizes the camelCase userId alias, not only user_id", async () => {
    // The chat vs task entry paths populate different aliases; reading only user_id would
    // stamp a { userId } run's session NULL-owned, reopening the hole for that path.
    const deps = makeDeps(async () => textResult("ok"));
    const queue = new Queue(deps);
    const alice = await queue.wait(
      queue.enqueue({ input: "hi", metadata: { userId: "alice" } }).id,
    );
    expect(() =>
      queue.enqueue({
        input: "steal",
        previous_response_id: alice.id,
        metadata: { userId: "bob" },
      }),
    ).toThrow(SessionOwnershipError);
    // The owner continues fine via either alias.
    const cont = queue.enqueue({
      input: "again",
      previous_response_id: alice.id,
      metadata: { user_id: "alice" },
    });
    expect(cont.session_id).toBe(alice.session_id);
  });

  test("S0: a null-owner session (no identity asserted) stays continuable — single-tenant path", async () => {
    const deps = makeDeps(async () => textResult("ok"));
    const queue = new Queue(deps);
    const first = await queue.wait(queue.enqueue({ input: "hi" }).id); // no user_id → null owner
    const cont = queue.enqueue({
      input: "again",
      previous_response_id: first.id,
      metadata: { user_id: "whoever" },
    });
    expect(cont.session_id).toBe(first.session_id);
  });
});

describe("resume semantics (unit)", () => {
  function armCrashedRun(idempotentTool: boolean) {
    const tools = testTools();
    let modelCalls = 0;
    const deps = makeDeps(async (req: ChatRequest) => {
      modelCalls++;
      const toolMsg = req.messages.findLast((m) => m.role === "tool") as
        | { content: string }
        | undefined;
      return textResult(`final: ${toolMsg?.content ?? "none"}`);
    }, tools);
    const { db } = deps;
    const now = Date.now();
    const toolName = idempotentTool ? "add" : "slow_append";
    const args = idempotentTool
      ? JSON.stringify({ a: 4, b: 6 })
      : JSON.stringify({ path: "/tmp/nope", line: "x", ms: 0 });
    // Craft the exact on-disk state of a daemon killed mid-tool-call: run
    // 'running', assistant tool_call persisted, journal intent without result.
    db.query(
      "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('sess_x', NULL, ?, ?)",
    ).run(now, now);
    db.query(
      "INSERT INTO runs (id, session_id, seq, status, request, created_at, started_at) VALUES ('resp_x', 'sess_x', 1, 'running', ?, ?, ?)",
    ).run(JSON.stringify({ input: "do it" }), now, now);
    const insert = db.query(
      "INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('resp_x', 'sess_x', ?, ?)",
    );
    insert.run(JSON.stringify({ role: "user", content: "do it" }), now);
    insert.run(
      JSON.stringify({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_z", type: "function", function: { name: toolName, arguments: args } },
        ],
      }),
      now,
    );
    db.query(
      "INSERT INTO journal (run_id, call_id, tool, args, status, created_at) VALUES ('resp_x', 'call_z', ?, ?, 'intent', ?)",
    ).run(toolName, args, now);
    return { deps, getModelCalls: () => modelCalls };
  }

  test("idempotent tool re-fires on resume", async () => {
    const { deps } = armCrashedRun(true);
    const run = await executeRun(deps, "resp_x", { resuming: true });
    expect(run.status).toBe("done");
    expect(JSON.parse(run.result ?? "{}").output_text).toBe("final: 10");
  });

  test("non-idempotent tool never silently re-fires: synthetic interrupted result", async () => {
    const { deps } = armCrashedRun(false);
    const run = await executeRun(deps, "resp_x", { resuming: true });
    expect(run.status).toBe("done");
    expect(JSON.parse(run.result ?? "{}").output_text).toContain("[interrupted]");
    const journal = deps.db
      .query("SELECT result FROM journal WHERE run_id = 'resp_x' AND call_id = 'call_z'")
      .get() as { result: string };
    expect(journal.result).toContain("[interrupted]");
  });

  test("journal 'done' without a message row replays the recorded result", async () => {
    const { deps } = armCrashedRun(true);
    deps.db
      .query(
        "UPDATE journal SET status = 'done', result = '42', finished_at = ? WHERE run_id = 'resp_x'",
      )
      .run(Date.now());
    const run = await executeRun(deps, "resp_x", { resuming: true });
    expect(run.status).toBe("done");
    expect(JSON.parse(run.result ?? "{}").output_text).toBe("final: 42");
  });
});
