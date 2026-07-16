// {{model}} in the per-turn context reflects the ACTUAL served model. It's seeded with the
// configured primary on turn 1 (the honest pre-call value), then tracks result.model — so
// after a provider fallback, the context shows the model that really answered.

import { describe, expect, test } from "bun:test";
import type { AssistantMsg, ChatMsg, ModelResult } from "../src/provider";
import { Queue } from "../src/queue";
import type { ToolDef, Tools } from "../src/tools";
import { makeDeps, ok } from "./helpers";

const ping: ToolDef = {
  name: "ping",
  description: "ping",
  parameters: { type: "object", properties: {} },
  idempotent: true,
  execute: async () => "pong",
};

function contextOf(messages: ChatMsg[]): string | undefined {
  const m = messages.find(
    (x) => typeof x.content === "string" && (x.content as string).startsWith("# Context"),
  );
  return typeof m?.content === "string" ? m.content : undefined;
}

describe("{{model}} = the actual served model", () => {
  test("turn 1 seeds the primary; turn 2 shows the model that actually served (fallback)", async () => {
    const seen: ChatMsg[][] = [];
    let call = 0;
    const toolMsg: AssistantMsg = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "ping", arguments: "{}" } }],
    };
    // Both turns are SERVED by the fallback model, not the configured primary.
    const chat = async (req: { messages: ChatMsg[] }): Promise<ModelResult> => {
      seen.push(req.messages);
      call++;
      return call === 1
        ? ok(toolMsg, "fallback/model-B")
        : ok({ role: "assistant", content: "done" }, "fallback/model-B");
    };
    const tools: Tools = new Map([["ping", ping]]);
    const deps = makeDeps(chat, tools, {
      contextTurn: "model={{model}}",
      primaryModel: "primary/model-A",
    });
    const q = new Queue(deps);
    await q.wait(q.enqueue({ input: "go" }).id);

    expect(call).toBe(2);
    // Turn 1: before any call resolved, the honest value is the configured primary.
    expect(contextOf(seen[0] as ChatMsg[])).toContain("model=primary/model-A");
    // Turn 2: the model that ACTUALLY served turn 1 (the fallback) is now reflected.
    expect(contextOf(seen[1] as ChatMsg[])).toContain("model=fallback/model-B");
    deps.db.close();
  });
});
