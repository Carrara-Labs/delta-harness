// Sprint 5 §3.1: review-triggered reflection — the real "proposed vs accepted".
// The control plane stamps the submission-disposition turn with
// {reflect: true, review_kind: "submission_disposition", submission_id}; the run's
// transcript IS the review payload (buildReviewMessage digest: dispositions +
// edit-diffs + reviewer notes). Reflection must swap to the diff-focused rubric,
// stamp review provenance, and floor confidence on the governed local rail.

import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { Events } from "../src/events";
import type { ChatMsg, ChatRequest } from "../src/provider";
import { Queue } from "../src/queue";
import { reflect } from "../src/reflect";
import type { ToolCtx } from "../src/tools";
import { makeDeps, ok, textResult } from "./helpers";

const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

// A realistic buildReviewMessage body — dispositions, a proposed→final diff, a note.
const REVIEW_DIGEST = `Your submission was reviewed.

Reviewer feedback:
- "Stop hedging — state the number or say you don't know."

Outcome digest:
- item 1 (learning) — APPROVED WITH EDITS
  proposed: "Revenue is likely around $2M ARR, though this is uncertain."
  final:    "Revenue: $2M ARR (source: June board deck)."
- item 2 (learning) — approved

Reflect on the outcome and update your own approach/memory. Also weigh any edit-diffs (what you proposed vs. what the human accepted).`;

function seedReviewRun(db: ReturnType<typeof openDb>, metadata: Record<string, unknown>) {
  const now = Date.now();
  db.query("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s', ?, ?)").run(now, now);
  db.query(
    "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r','s',1,'done',?,?)",
  ).run(JSON.stringify({ input: REVIEW_DIGEST, metadata }), now);
  const msgs: ChatMsg[] = [
    { role: "user", content: REVIEW_DIGEST },
    {
      role: "assistant",
      content: "Understood — I over-hedged; the reviewer wants sourced numbers.",
    },
  ];
  for (const m of msgs)
    db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)").run(
      JSON.stringify(m),
      now,
    );
  return db.query("SELECT * FROM runs WHERE id='r'").get() as Parameters<typeof reflect>[1];
}

const REVIEW_META = {
  reflect: true,
  review_kind: "submission_disposition",
  submission_id: "sub_1",
};

describe("review-triggered reflection", () => {
  test("a review run gets the proposed-vs-accepted rubric, not the task rubric", async () => {
    const db = openDb(":memory:");
    let systemSeen = "";
    const chat = async (req: ChatRequest) => {
      systemSeen = (req.messages.find((m) => m.role === "system")?.content as string) ?? "";
      return ok({ role: "assistant", content: '{"kind":"none"}' });
    };
    const run = seedReviewRun(db, REVIEW_META);
    await reflect({ db, events: new Events(db), chat, tools: new Map() }, run, { runId: "r" }, ctx);
    expect(systemSeen).toContain("what you PROPOSED vs what the reviewer ACCEPTED");
    expect(systemSeen).toContain("Ground the artifact in the DIFF");
    expect(systemSeen).not.toContain("You just finished a task");
    // The anti-poisoning block rides BOTH rubrics.
    expect(systemSeen).toContain("Do NOT distill");
  });

  test("no review metadata → the original task rubric (no regression)", async () => {
    const db = openDb(":memory:");
    let systemSeen = "";
    const chat = async (req: ChatRequest) => {
      systemSeen = (req.messages.find((m) => m.role === "system")?.content as string) ?? "";
      return ok({ role: "assistant", content: '{"kind":"none"}' });
    };
    const run = seedReviewRun(db, { reflect: true });
    await reflect({ db, events: new Events(db), chat, tools: new Map() }, run, { runId: "r" }, ctx);
    expect(systemSeen).toContain("You just finished a task");
    expect(systemSeen).toContain("Do NOT distill");
  });

  test("a review-grounded correction is locally staged and enqueued", async () => {
    const db = openDb(":memory:");
    const run = seedReviewRun(db, REVIEW_META);
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"learning","content":"State sourced numbers plainly; never hedge a figure the deck confirms.","confidence":0.9}',
      });
    const out = await reflect(
      { db, events: new Events(db), chat, tools: new Map() },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    const row = db
      .query(
        "SELECT m.source, p.destination_role, p.lifecycle FROM memory m JOIN promotion p ON p.memory_id = m.id",
      )
      .get() as { source: string; destination_role: string; lifecycle: string };
    expect(row).toEqual({ source: "review", destination_role: "curated", lifecycle: "staged" });
  });

  test("review provenance alone does not authorize widening a user's data", async () => {
    const db = openDb(":memory:");
    const run = seedReviewRun(db, { ...REVIEW_META, user_id: "alice" });
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"preference","content":"Alice wants sourced numbers without hedging.","proposed_audience":"org","confidence":0.9}',
      });
    await reflect({ db, events: new Events(db), chat, tools: new Map() }, run, { runId: "r" }, ctx);
    expect((db.query("SELECT audience FROM memory").get() as { audience: string }).audience).toBe(
      "user",
    );
    expect((db.query("SELECT count(*) AS n FROM promotion").get() as { n: number }).n).toBe(0);
  });

  test("store-less: the memory row carries source='review' and the confidence floor", async () => {
    const db = openDb(":memory:");
    const run = seedReviewRun(db, REVIEW_META);
    // The distiller rates 0.5 — below the 0.6 self gate, but review provenance
    // floors it: an accepted diff is ground truth.
    const chat = async () =>
      ok({
        role: "assistant",
        content:
          '{"kind":"pitfall","content":"Hedged numbers get edited out — cite the source instead.","confidence":0.5}',
      });
    const out = await reflect(
      { db, events: new Events(db), chat, tools: new Map(), agentId: "delta-1" },
      run,
      { runId: "r" },
      ctx,
    );
    expect(out?.mode).toBe("staged");
    const row = db.query("SELECT source, confidence FROM memory").get() as {
      source: string;
      confidence: number;
    };
    expect(row.source).toBe("review");
    expect(row.confidence).toBe(0.8);
  });

  test("end-to-end through the queue: a review turn reflects in the background", async () => {
    let call = 0;
    const deps = makeDeps(async () => {
      call++;
      if (call === 1) return textResult("Noted — I'll stop hedging sourced figures.");
      return ok({
        role: "assistant",
        content:
          '{"kind":"learning","content":"This reviewer strips hedging from sourced figures.","confidence":0.85}',
      });
    });
    const queue = new Queue(deps);
    const done = await queue.wait(
      queue.enqueue({ input: REVIEW_DIGEST, metadata: REVIEW_META }).id,
    );
    expect(done.status).toBe("done");
    for (let i = 0; i < 50; i++) {
      const n = (deps.db.query("SELECT COUNT(*) AS n FROM memory").get() as { n: number }).n;
      if (n > 0) break;
      await Bun.sleep(20);
    }
    const mem = deps.db.query("SELECT content AS value, source FROM memory").get() as {
      value: string;
      source: string;
    } | null;
    expect(mem?.value).toContain("hedging");
    expect(mem?.source).toBe("review");
  });
});
