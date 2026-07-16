// The whole loop, end to end — the proof the harness was built for (spec §H).
// Every prior test exercises ONE half: reflect.test / reflect-review.test prove the
// WRITE (a review distills a learning into governed memory), and memory recall is
// unit-tested in isolation. Nothing chained them. This drives the REAL runner (the
// Queue → executeRun path, not a hand-called reflect()) across TWO threads and proves
// the harness.s core learning promise: a correction a human made while reviewing
// meeting #1 is recalled into the agent's context when it processes meeting #2 — and
// is scoped to that use-case, not leaked into an unrelated one.
//
// Thread = session. A plain enqueue (no previous_response_id) opens a fresh session,
// so turns 2 and 3 are each the first run of a NEW thread — where recall fires.

import { describe, expect, test } from "bun:test";
import type { ChatRequest, ModelResult } from "../src/provider";
import { Queue } from "../src/queue";
import { makeDeps, ok, textResult } from "./helpers";

const TASK_TYPE = "meeting-processing";

// A reviewer's disposition digest — the shape buildReviewMessage produces: a note plus
// a proposed→accepted edit-diff. The correction IS the signal.
const REVIEW_DIGEST = `Your submission was reviewed.

Reviewer feedback:
- "Every action item needs a named owner — an unassigned task gets dropped on the floor."

Outcome digest:
- item 1 (task) — APPROVED WITH EDITS
  proposed: "Follow up on the pricing deck."
  final:    "Owner: Dana — follow up on the pricing deck by Friday."
- item 2 (task) — approved`;

// What the review-triggered reflection should distill from that diff.
const LEARNING =
  "For meeting action items, always capture a named owner; an unassigned task gets dropped.";

/** Wait for the background reflection to land its memory row (fire-and-forget). */
async function waitForMemory(db: ReturnType<typeof makeDeps>["db"]) {
  for (let i = 0; i < 50; i++) {
    const n = (db.query("SELECT COUNT(*) AS n FROM memory").get() as { n: number }).n;
    if (n > 0) return;
    await Bun.sleep(20);
  }
}

/** All the messages every non-reflection (task) model call actually received — the
 *  ground truth for "what the model saw". The reflection distiller call is routed off
 *  by its review rubric so it never pollutes this record. */
function makeChat(taskTurns: ChatRequest["messages"][]) {
  return async (req: ChatRequest): Promise<ModelResult> => {
    const system = (req.messages.find((m) => m.role === "system")?.content as string) ?? "";
    // The distiller turn carries REFLECT_REVIEW_SYSTEM — return the learning it should
    // extract from the proposed-vs-accepted diff.
    if (system.includes("what you PROPOSED vs what the reviewer ACCEPTED")) {
      return ok({
        role: "assistant",
        content: JSON.stringify({
          kind: "learning",
          content: LEARNING,
          aliases: ["action item owner", "meeting owner"],
          confidence: 0.9,
        }),
      });
    }
    taskTurns.push(req.messages);
    return textResult("Processed the meeting; proposed the action items for review.");
  };
}

const hasLearning = (msgs: ChatRequest["messages"]) =>
  msgs.some((m) => typeof m.content === "string" && m.content.includes(LEARNING));

describe("the learning loop, end to end (review → learn → recall across threads)", () => {
  test("a correction from meeting #1's review is recalled when processing meeting #2", async () => {
    const taskTurns: ChatRequest["messages"][] = [];
    // agentId + namespace set explicitly: the write half (reflect) and the read half
    // (recall) MUST share both, or recall reads a slice the write never populated —
    // the exact asymmetry that silently broke recall three times before. Same deps =
    // same db across both threads, so thread #2 reads what thread #1 wrote.
    const deps = makeDeps(makeChat(taskTurns), new Map(), {
      agentId: "delta-mp-1",
      memoryNamespace: "kb",
    });
    const queue = new Queue(deps);

    // Thread #1 — a human reviewed meeting #1's proposals; the disposition turn reflects.
    const t1 = queue.enqueue({
      input: REVIEW_DIGEST,
      metadata: {
        reflect: true,
        review_kind: "submission_disposition",
        submission_id: "sub_meeting_1",
        task_type: TASK_TYPE,
      },
    });
    expect((await queue.wait(t1.id)).status).toBe("done");
    await waitForMemory(deps.db);

    // The learning landed on the middle tier: shared across runs of this use-case,
    // bound to no user, provenance = review. (No user in the run → task_type tier.)
    const mem = deps.db.query("SELECT audience, task_type, source, content FROM memory").get() as {
      audience: string;
      task_type: string;
      source: string;
      content: string;
    };
    expect(mem).toEqual({
      audience: "task_type",
      task_type: TASK_TYPE,
      source: "review",
      content: LEARNING,
    });

    // Thread #2 — a DIFFERENT session (fresh enqueue) processes meeting #2. Because it
    // declares the same task_type, recall surfaces the use-case learning at thread start.
    const t2 = queue.enqueue({
      input: "Process this meeting transcript and extract the action items.",
      metadata: { task_type: TASK_TYPE },
    });
    expect((await queue.wait(t2.id)).status).toBe("done");

    // The headline assertion: the model, on a brand-new thread, LITERALLY saw the
    // learning the human's review produced on the previous thread.
    const lastTurn = taskTurns.at(-1)!;
    expect(hasLearning(lastTurn)).toBe(true);

    // And it wasn't there before there was anything to learn — thread #1's own task
    // turn carried no recalled learning (sanity: recall isn't spuriously firing).
    expect(hasLearning(taskTurns[0]!)).toBe(false);

    // Recall is a usefulness signal — the surfaced row's hit count advanced.
    const hits = (deps.db.query("SELECT hits FROM memory").get() as { hits: number }).hits;
    expect(hits).toBeGreaterThan(0);
  });

  test("the learning is scoped to its use-case — an unrelated thread does not inherit it", async () => {
    const taskTurns: ChatRequest["messages"][] = [];
    const deps = makeDeps(makeChat(taskTurns), new Map(), {
      agentId: "delta-mp-1",
      memoryNamespace: "kb",
    });
    const queue = new Queue(deps);

    const t1 = queue.enqueue({
      input: REVIEW_DIGEST,
      metadata: {
        reflect: true,
        review_kind: "submission_disposition",
        submission_id: "sub_meeting_1",
        task_type: TASK_TYPE,
      },
    });
    expect((await queue.wait(t1.id)).status).toBe("done");
    await waitForMemory(deps.db);

    // A thread for a DIFFERENT use-case — the meeting learning must not bleed in.
    const other = queue.enqueue({
      input: "Categorize these expense receipts.",
      metadata: { task_type: "expense-processing" },
    });
    expect((await queue.wait(other.id)).status).toBe("done");

    expect(hasLearning(taskTurns.at(-1)!)).toBe(false);
  });
});
