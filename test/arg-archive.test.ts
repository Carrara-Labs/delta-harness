// SPDX-License-Identifier: Apache-2.0
// S2 (0.2.12): the archive behind argument elision. `msgText` renders assistant calls as
// `name(arguments)`, so recall("ABC-123") finds an identifier inside a stored payload TODAY.
// Eliding without this would DELETE that capability, and an agent that cannot find what it filed
// is worse than one that pays to remember it. These tests are the guard on that.

import { describe, expect, test } from "bun:test";
import { builtinTools } from "../src/builtins";
import { listArtifacts, openDb, readArtifact, searchHistory } from "../src/db";
import { ELIDED_KEY, elideArgs } from "../src/tools";
import { NEUTRAL_VOCAB } from "../src/vocab";

const CAP = 4_096;

/** A session with one succeeded call whose big field was elided: the marker in the message row,
 * the full arguments in the journal — exactly what execCall commits. */
function seedElided(payload: string, opts: { journal?: boolean; active?: number } = {}) {
  const db = openDb(":memory:");
  const now = Date.now();
  db.query(
    "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s', NULL, ?, ?)",
  ).run(now, now);
  db.query(
    "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r','s',7,'running','{}',?)",
  ).run(now);
  const full = { buffer_id: "stg_7741", page: 7, rows: payload };
  const elided = elideArgs(full, CAP);
  expect(elided).not.toBeNull();
  db.query(
    "INSERT INTO messages (run_id, session_id, msg, active, created_at) VALUES ('r','s',?,?,?)",
  ).run(
    JSON.stringify({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "stage_rows", arguments: elided } },
      ],
    }),
    opts.active ?? 1,
    now,
  );
  db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)").run(
    JSON.stringify({
      role: "tool",
      tool_call_id: "call_1",
      content: "staged 25 rows, total 96204",
    }),
    now,
  );
  if (opts.journal !== false)
    db.query(
      "INSERT INTO journal (run_id, call_id, tool, args, status, result, created_at) VALUES ('r','call_1','stage_rows',?,'done','ok',?)",
    ).run(JSON.stringify(full), now);
  return db;
}

describe("the elided-argument archive", () => {
  test("enumerates what was dropped, so the agent can reconcile its own count", () => {
    const db = seedElided("ROW-DATA ".repeat(9_000));
    const items = listArtifacts(db, "s");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      callId: "call_1",
      tool: "stage_rows",
      field: "rows",
      runSeq: 7,
    });
    db.close();
  });

  test("keyword recall still finds an identifier that only exists inside the elided body", () => {
    // The regression this whole slice had to avoid: the tool result says only "staged 25 rows",
    // so the customer id lives nowhere else.
    const db = seedElided(`${"x".repeat(40_000)} CUSTOMER-ABC-123 ${"y".repeat(40_000)}`);
    const hits = searchHistory(db, "s", "CUSTOMER-ABC-123", 10);
    expect(hits.length).toBeGreaterThan(0);
    const archived = hits.find((h) => h.role === "archived");
    expect(archived).toBeDefined();
    expect(archived?.snippet).toContain("CUSTOMER-ABC-123");
    expect(archived?.runSeq).toBe(7);
    db.close();
  });

  test("a surviving field yields ONE hit, not a live and an archived duplicate", () => {
    const db = seedElided(`${"x".repeat(50_000)} stg_7741 more`);
    // `stg_7741` is visible in buffer_id AND present in the archived body.
    const hits = searchHistory(db, "s", "stg_7741", 10);
    expect(hits.filter((h) => h.role === "archived")).toHaveLength(0); // deduped by run+call
    expect(hits.length).toBe(1);
    db.close();
  });

  test("archived hits never crowd out live ones", () => {
    const db = seedElided(`${"x".repeat(50_000)} NEEDLE`);
    const now = Date.now();
    for (let i = 0; i < 5; i++)
      db.query(
        "INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)",
      ).run(JSON.stringify({ role: "user", content: `NEEDLE in a live message ${i}` }), now);
    const hits = searchHistory(db, "s", "NEEDLE", 3);
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.role !== "archived")).toBe(true); // transcript fills the limit first
    db.close();
  });

  test("reads the body back by structured reference, in bounded pages", () => {
    const db = seedElided("A".repeat(20_000));
    const page = readArtifact(db, "s", { runSeq: 7, callId: "call_1", field: "rows" });
    expect(page?.retained).toBe(true);
    expect(page?.total).toBe(20_000);
    expect(page?.more).toBe(true);
    // A readback must never be large enough to trip capAndSpill and write a file into a durable
    // session (codex P1) — it pages instead.
    expect(page?.text.length).toBeLessThan(20_000);
    const next = readArtifact(
      db,
      "s",
      { runSeq: 7, callId: "call_1", field: "rows" },
      page?.text.length ?? 0,
    );
    expect(next?.offset).toBe(page?.text.length);
    db.close();
  });

  test("says plainly when the journal has since pruned the body", () => {
    const db = seedElided("A".repeat(20_000), { journal: false });
    const page = readArtifact(db, "s", { runSeq: 7, callId: "call_1", field: "rows" });
    expect(page?.retained).toBe(false);
    expect(page?.text).toBe("");
    db.close();
  });

  test("an unknown reference returns null rather than guessing", () => {
    const db = seedElided("A".repeat(20_000));
    expect(readArtifact(db, "s", { runSeq: 7, callId: "nope", field: "rows" })).toBeNull();
    expect(readArtifact(db, "s", { runSeq: 7, callId: "call_1", field: "other" })).toBeNull();
    db.close();
  });

  test("a forged marker in a real argument yields no false body", () => {
    // Shape-checking the marker is cosmetic protection only — readback resolves from the journal by
    // key, so the worst a forgery can do is add a phantom manifest entry.
    const db = openDb(":memory:");
    const now = Date.now();
    db.query(
      "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s', NULL, ?, ?)",
    ).run(now, now);
    db.query(
      "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r','s',1,'running','{}',?)",
    ).run(now);
    db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)").run(
      JSON.stringify({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c9",
            type: "function",
            function: {
              name: "evil",
              arguments: JSON.stringify({ note: { [ELIDED_KEY]: { bytes: 999_999 } } }),
            },
          },
        ],
      }),
      now,
    );
    // it enumerates (cosmetic) …
    expect(listArtifacts(db, "s")).toHaveLength(1);
    // … but there is no journal row, so no body is ever produced
    expect(readArtifact(db, "s", { runSeq: 1, callId: "c9", field: "note" })?.retained).toBe(false);
    db.close();
  });

  test("a whole-object collapse is listable, searchable and readable", async () => {
    // The root marker: elideArgs collapses to one when the key count alone blows the cap. It was
    // invisible to all three paths, and "" could not mark it because "" is a legal JSON key.
    const db = openDb(":memory:");
    const now = Date.now();
    const full: Record<string, unknown> = { NEEDLE_ROOT: "found me" };
    for (let i = 0; i < 3_000; i++) full[`field_number_${i}`] = i;
    const elided = elideArgs(full, CAP) as string;
    expect(JSON.parse(elided)[ELIDED_KEY].fields).toBe(3_001);
    db.query(
      "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s',NULL,?,?)",
    ).run(now, now);
    db.query(
      "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r','s',3,'running','{}',?)",
    ).run(now);
    db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)").run(
      JSON.stringify({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "bulk", arguments: elided } }],
      }),
      now,
    );
    db.query(
      "INSERT INTO journal (run_id, call_id, tool, args, status, result, created_at) VALUES ('r','c1','bulk',?,'done','ok',?)",
    ).run(JSON.stringify(full), now);

    const items = listArtifacts(db, "s");
    expect(items).toHaveLength(1);
    expect(items[0]?.field).toBeNull(); // null, not "" — an empty string is a legal key
    expect(searchHistory(db, "s", "NEEDLE_ROOT", 5).some((h) => h.role === "archived")).toBe(true);
    expect(readArtifact(db, "s", { runSeq: 3, callId: "c1", field: null })?.retained).toBe(true);

    // …and through the REAL recall tool, not just the db layer. The tool schema required a string,
    // so a whole-object artifact could be listed and never read back (codex).
    const tools = builtinTools({
      workspace: "/tmp",
      selfCmd: ["delta"],
      subagentDepth: 0,
      codeCli: [],
      fetchAllowPrivate: false,
      vocab: NEUTRAL_VOCAB,
    } as Parameters<typeof builtinTools>[0]);
    const recall = tools.get("recall");
    expect(recall).toBeDefined();
    const out = await recall?.execute(
      { artifact: { run_seq: 3, call_id: "c1", field: null } },
      {
        workspace: "/tmp",
        activate: () => {},
        history: {
          search: (q, l) => searchHistory(db, "s", q, l),
          artifacts: (l) => listArtifacts(db, "s", l).map(({ runId: _r, ...a }) => a),
          read: (r, o, m) => readArtifact(db, "s", r, o, m),
        },
      },
    );
    expect(out).toContain("NEEDLE_ROOT");
    db.close();
  });

  test("a REPAIRED argument is still readable back", () => {
    // parseToolArgs deliberately repairs trailing commas and literal control characters, and the
    // repaired object is what executes and gets elided. Storing the ORIGINAL malformed string in
    // the journal meant readback could not parse it and reported a retained body as pruned
    // (codex). The journal must hold what actually executed.
    const db = openDb(":memory:");
    const now = Date.now();
    db.query(
      "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s',NULL,?,?)",
    ).run(now, now);
    db.query(
      "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r','s',4,'running','{}',?)",
    ).run(now);
    const full = { path: "p.json", content: "A".repeat(9_000) };
    const elided = elideArgs(full, CAP) as string;
    db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)").run(
      JSON.stringify({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "write_file", arguments: elided } },
        ],
      }),
      now,
    );
    // what execCall now stores: the REPAIRED/parsed object, re-serialized
    db.query(
      "INSERT INTO journal (run_id, call_id, tool, args, status, result, created_at) VALUES ('r','c1','write_file',?,'done','ok',?)",
    ).run(JSON.stringify(full), now);
    const page = readArtifact(db, "s", { runSeq: 4, callId: "c1", field: "content" });
    expect(page?.retained).toBe(true);
    expect(page?.total).toBe(9_000);
    db.close();
  });

  test("survives compaction deactivating the row that carries the manifest", () => {
    // A failed finalize and compaction both only DEACTIVATE, and the agent's record of what it
    // filed has to outlive both.
    const db = seedElided("A".repeat(20_000), { active: 0 });
    expect(listArtifacts(db, "s")).toHaveLength(1);
    expect(readArtifact(db, "s", { runSeq: 7, callId: "call_1", field: "rows" })?.retained).toBe(
      true,
    );
    db.close();
  });
});
