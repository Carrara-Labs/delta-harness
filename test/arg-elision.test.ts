// SPDX-License-Identifier: Apache-2.0
// S1 (0.2.12): structural elision of a succeeded tool call's arguments. The rail that bounds what
// the MODEL writes, mirroring capAndSpill/demoteSpilled which only ever bound tool RESULTS.

import { describe, expect, test } from "bun:test";
import { type ChatMsg, chat } from "../src/provider";
import { ELIDED_KEY, elideArgs, elidedArgsRejection } from "../src/tools";

/** Capture the real serialized request body, so the wire assertion tests the ACTUAL adapter
 * rather than an exported internal (the pattern untrusted-framing.test.ts uses). */
async function withCapture(
  run: (base: string, body: () => Record<string, unknown>) => Promise<void>,
) {
  let captured: Record<string, unknown> = {};
  const sse = (...events: unknown[]) =>
    new Response(
      `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`,
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured = (await req.json()) as Record<string, unknown>;
      return sse(
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      );
    },
  });
  try {
    await run(`http://localhost:${server.port}`, () => captured);
  } finally {
    server.stop(true);
  }
}

const CAP = 4_096;
const big = (n: number) => "x".repeat(n);

describe("elideArgs", () => {
  test("leaves a small argument object byte-identical (returns null)", () => {
    expect(elideArgs({ page: 7, buffer_id: "stg_7741" }, CAP)).toBeNull();
  });

  test("elides only the oversize value, keeping the object and its small fields", () => {
    const out = elideArgs({ buffer_id: "stg_7741", page: 7, rows: big(90_000) }, CAP);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    // the semantics that stop duplicate side effects survive
    expect(parsed.buffer_id).toBe("stg_7741");
    expect(parsed.page).toBe(7);
    // only the payload leaves
    expect(parsed.rows[ELIDED_KEY].bytes).toBe(90_000);
    expect(Buffer.byteLength(out as string, "utf8")).toBeLessThanOrEqual(CAP);
  });

  test("survives the real Anthropic wire with a non-empty input", async () => {
    // provider.ts does JSON.parse(arguments) with `catch { input = {} }`, so a PROSE stub would hand
    // the model a call with NO arguments and no explanation — invisible to anyone testing against an
    // OpenAI-compatible endpoint, which is exactly how Aperture would have shipped it. The
    // regression test for that failure, asserted on the actual serialized body.
    const out = elideArgs({ to: "a@b.com", subject: "Q3", body: big(50_000) }, CAP) as string;
    const history: ChatMsg[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "send_email", arguments: out } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "sent" },
    ];
    await withCapture(async (base, body) => {
      await chat(
        { baseUrl: base, apiKey: "t", models: ["claude-test"], api: "anthropic", maxRetries: 0 },
        { messages: history },
      );
      const sent = body() as { messages: Array<{ content: Array<Record<string, unknown>> }> };
      const use = sent.messages.flatMap((m) => m.content).find((b) => b.type === "tool_use") as {
        input: Record<string, unknown>;
      };
      expect(use).toBeDefined();
      expect(use.input).not.toEqual({}); // the failure mode this exists to prevent
      expect(use.input.to).toBe("a@b.com");
      expect(use.input.subject).toBe("Q3");
      const marker = (use.input.body as Record<string, { bytes: number } | undefined>)[ELIDED_KEY];
      expect(marker?.bytes).toBe(50_000);
    });
  });

  test("bounds the TOTAL, not just each value — many sub-threshold fields still fit the cap", () => {
    // A per-value threshold alone admits an arbitrarily large object of small values (codex P1).
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) args[`f${i}`] = big(1_000); // 60KB total, no value over 4KB
    const out = elideArgs(args, CAP);
    expect(out).not.toBeNull();
    expect(Buffer.byteLength(out as string, "utf8")).toBeLessThanOrEqual(CAP);
  });

  test("collapses to a single root marker when the key count alone blows the cap", () => {
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 3_000; i++) args[`field_number_${i}`] = i;
    const out = elideArgs(args, CAP) as string;
    const parsed = JSON.parse(out);
    expect(parsed[ELIDED_KEY].fields).toBe(3_000);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(CAP);
  });

  test("is idempotent by shape — a second pass over an elided object is a no-op", () => {
    const once = elideArgs({ rows: big(90_000) }, CAP) as string;
    expect(elideArgs(JSON.parse(once), CAP)).toBeNull();
  });

  test("measures UTF-8 bytes, not UTF-16 code units", () => {
    // 2000 CJK chars = 2000 UTF-16 units but 6000 UTF-8 bytes. The 0.2.11 lesson: one metric.
    const out = elideArgs({ note: "漢".repeat(2_000) }, CAP);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string).note[ELIDED_KEY].bytes).toBe(6_000);
  });

  test("a NaN or disabled cap never elides", () => {
    // Number("garbage") is NaN, and every `<=` against NaN is false — without the guard this
    // would elide EVERYTHING (codex P2).
    expect(elideArgs({ rows: big(90_000) }, Number.NaN)).toBeNull();
    expect(elideArgs({ rows: big(90_000) }, 0)).toBeNull();
    expect(elideArgs({ rows: big(90_000) }, -1)).toBeNull();
  });

  test("elides largest-first, so the fewest fields are lost", () => {
    const out = elideArgs({ keep: big(300), mid: big(1_200), huge: big(80_000) }, CAP) as string;
    const parsed = JSON.parse(out);
    expect(parsed.huge[ELIDED_KEY]).toBeDefined(); // the one that had to go
    expect(parsed.keep).toBe(big(300)); // untouched
    expect(parsed.mid).toBe(big(1_200)); // untouched — dropping `huge` was already enough
  });

  test("a pathological key count does not take seconds on the commit path", () => {
    // Re-serializing the whole object per field is O(n²); codex measured 7.2s synchronously on
    // 20,000 fields, inside the transaction that commits a tool result.
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i++) args[`field_number_${i}`] = i;
    const t0 = performance.now();
    const out = elideArgs(args, CAP) as string;
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(JSON.parse(out)[ELIDED_KEY].fields).toBe(20_000);
  });

  test("the root marker still fits caps at the configured floor", () => {
    // The root collapse is the one shape that could exceed its own bound. config clamps any cap
    // below CAP_FLOOR (512) to the default, so the marker always fits what it promises.
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 3_000; i++) args[`field_number_${i}`] = i;
    const out = elideArgs(args, 512) as string;
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(512);
  });

  test("an echoed marker is rejected before the tool runs", () => {
    // THE live finding. On a 10-turn session the agent saw the marker in its own history, copied
    // the shape into a later write_file, and silently filed 4 of 10 pages as the placeholder —
    // the run looked cheaper because it had thrown work away. The engine writes markers and never
    // receives one, so a marker on the way IN is always this mistake.
    const echoed = JSON.parse(elideArgs({ rows: big(90_000) }, CAP) as string);
    const err = elidedArgsRejection({ path: "pages/long-3.json", ...echoed });
    expect(err).toContain("engine placeholder");
    expect(err).toContain("rows");
    // the root-collapse shape is rejected too
    expect(elidedArgsRejection({ [ELIDED_KEY]: { bytes: 10 } })).toContain("whole argument object");
    // A STRING-valued echo is the shape a `content` parameter actually produces, and the live
    // rerun proved an object-only check sails straight past it.
    const asText = JSON.stringify({ [ELIDED_KEY]: { bytes: 10_651 } });
    expect(elidedArgsRejection({ path: "p.json", content: asText })).toContain("content");
    // NESTED and ARRAY echoes: elision only ever PRODUCES a top-level marker, but an echo can
    // arrive anywhere, so the guard walks where the producer does not.
    expect(elidedArgsRejection({ rows: [{ [ELIDED_KEY]: { bytes: 1 } }] })).toContain("rows");
    expect(elidedArgsRejection({ a: { b: { [ELIDED_KEY]: { bytes: 1 } } } })).toContain("a");

    // FALSE POSITIVES — every one of these is legitimate and must pass. The guard matches the
    // engine's EXACT shape, not mere presence of the key, or an agent could never write
    // documentation or save a test fixture about this very feature (codex).
    expect(elidedArgsRejection({ path: "a.json", content: "real" })).toBeNull();
    expect(
      elidedArgsRejection({
        path: "doc.md",
        content: `the ${ELIDED_KEY} marker is engine-authored`,
      }),
    ).toBeNull();
    // a real config carrying the key with a different shape
    expect(
      elidedArgsRejection({ content: JSON.stringify({ [ELIDED_KEY]: { enabled: true } }) }),
    ).toBeNull();
    // our own docs saved as a fixture: the key alongside other content
    expect(
      elidedArgsRejection({
        content: JSON.stringify({ [ELIDED_KEY]: { bytes: 5 }, note: "how the marker works" }),
      }),
    ).toBeNull();
  });

  test("the marker stays tiny, because every marker byte costs a real field", () => {
    // A 135-byte explanatory marker collapsed a 30-field object to a single root marker where a
    // 33-byte one preserved 17 real fields. The cap is both per-value AND total (codex).
    const out = elideArgs({ rows: big(90_000) }, CAP) as string;
    const marker = JSON.stringify(JSON.parse(out).rows);
    expect(Buffer.byteLength(marker, "utf8")).toBeLessThan(45);

    const many: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) many[`f${i}`] = big(200);
    const parsed = JSON.parse(elideArgs(many, CAP) as string);
    // structure survives: this must NOT collapse to a single root marker
    expect(parsed[ELIDED_KEY]).toBeUndefined();
    expect(Object.values(parsed).filter((v) => typeof v === "string").length).toBeGreaterThan(10);
  });

  test("survives an unserializable value without throwing on the commit path", () => {
    const circular: Record<string, unknown> = { rows: big(90_000) };
    circular.self = circular;
    expect(() => elideArgs(circular, CAP)).not.toThrow();
  });
});
