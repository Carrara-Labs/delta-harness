// F4: streaming sync turns. The run loop wires the provider's onDelta to the
// ephemeral event bus (output_text.delta) — not the durable events table. We
// prove the deltas fire (via a real streaming mock model) and that they aren't
// persisted; the HTTP SSE surface is exercised by the live curl smoke.

import { afterAll, describe, expect, test } from "bun:test";
import { Queue } from "../src/queue";
import { makeDeps } from "./helpers";

// A mock OpenAI-compatible endpoint that streams several content deltas.
const mock = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(
      ["Hel", "lo ", "world"]
        .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
        .join("") +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ),
});
afterAll(() => mock.stop());

describe("streaming text deltas", () => {
  test("onDelta emits ephemeral output_text.delta events; not persisted to the durable log", async () => {
    const { chat } = await import("../src/provider");
    const deps = makeDeps((req) =>
      chat({ baseUrl: `http://localhost:${mock.port}/v1`, apiKey: "k", models: ["m"] }, req),
    );
    const deltas: string[] = [];
    deps.events.on((e) => {
      if (e.type === "output_text.delta") deltas.push(String(e.data.delta));
    });
    const queue = new Queue(deps);
    const done = await queue.wait(queue.enqueue({ input: "hi" }).id);
    expect(done.status).toBe("done");
    // The streamed chunks arrived as ephemeral deltas, in order.
    expect(deltas.join("")).toBe("Hello world");
    // And they were NOT written to the durable events table (would bloat it).
    const persisted = deps.db
      .query("SELECT COUNT(*) AS n FROM events WHERE type = 'output_text.delta'")
      .get() as { n: number };
    expect(persisted.n).toBe(0);
    // The final assembled text is the response.
    expect(JSON.parse(done.result ?? "{}").output_text).toBe("Hello world");
  });
});
