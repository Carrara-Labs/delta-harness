import { openDb } from "../src/db";
import { Events } from "../src/events";
import type { AssistantMsg, ModelResult, Usage } from "../src/provider";
import type { Deps } from "../src/run";
import type { Tools } from "../src/tools";
import type { Vocab } from "../src/vocab";

// An EXAMPLE product vocab — the engine's default is NEUTRAL, so tests that exercise
// the review-loop mechanism with a real product's bindings use this fixture. It models a
// generic knowledge-base product (a propose-for-review write rail). The engine hard-codes
// none of it — a product supplies its own vocab.json; this is just one shape.
export const exampleVocab: Vocab = {
  coreVerbs: [
    "get_my_user",
    "get_my_dashboard",
    "search_text",
    "get_entity_context",
    "get_person_context",
    "get_project_context",
    "list_inbox",
    "list_my_submissions",
    "list_tasks",
    "propose_submission",
  ],
  writeVerbSuffix: "propose_submission",
  writeNoun: "Knowledge Base",
  runRefKey: "delta_run_ref",
  learningTargetKind: "learning",
  taskNoun: "task",
  itemNoun: "review item",
  subjectKeys: ["entity", "person"],
  // The propose_submission envelope — carried by the bundle, not the engine. Key order
  // matters (a product may pin its exact inline-args shape).
  writeShape: {
    output: "{{summary}}",
    actions_brief: "{{brief}}",
    delta_run_ref: "{{run_id}}",
    items: [
      {
        op: "create",
        target_kind: "{{target_kind}}",
        payload: { content: "{{content}}", source_kind: "agent" },
        confidence: "{{confidence}}",
      },
    ],
  },
};

export function makeDeps(
  chat: Deps["chat"],
  tools: Tools = new Map(),
  overrides: Partial<Deps> = {},
): Deps {
  const db = openDb(":memory:");
  return {
    db,
    events: new Events(db),
    chat,
    tools,
    workspace: "/tmp/delta-test-ws",
    compactAtTokens: 1_000_000, // effectively off unless a test lowers it
    ...overrides,
  };
}

export const usage1: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  total: 15,
  costUsd: 0.001,
};

export function ok(message: AssistantMsg, model = "test/model"): ModelResult {
  return { ok: true, model, message, finishReason: "stop", usage: { ...usage1 }, latencyMs: 1 };
}

export function textResult(text: string): ModelResult {
  return ok({ role: "assistant", content: text });
}

export function toolCallResult(name: string, args: unknown, id = "call_1"): ModelResult {
  return ok({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
}
