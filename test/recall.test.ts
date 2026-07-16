// W1 — restorable context. `recall` (searchHistory) makes a result that scrolled out of the
// live window recoverable, and compaction leaves a deterministic pointer ledger for spilled
// results. This is the run-5 fix: compaction may drop the successes from context, but the
// synthesis step can pull them back before answering.

import { describe, expect, test } from "bun:test";
import { maybeCompact } from "../src/compaction";
import { openDb, searchHistory } from "../src/db";
import { Events } from "../src/events";
import type { ChatMsg } from "../src/provider";
import { ok } from "./helpers";

type Seed = { msg: ChatMsg; active?: number };

function seed(db: ReturnType<typeof openDb>, rows: Seed[], seq = 1) {
  const now = Date.now();
  db.query(
    "INSERT OR IGNORE INTO sessions (id, user_id, created_at, updated_at) VALUES ('s', NULL, ?, ?)",
  ).run(now, now);
  db.query(
    "INSERT OR IGNORE INTO runs (id, session_id, seq, status, request, created_at) VALUES ('r', 's', ?, 'running', '{}', ?)",
  ).run(seq, now);
  for (const row of rows) {
    db.query(
      "INSERT INTO messages (run_id, session_id, msg, active, created_at) VALUES ('r','s',?,?,?)",
    ).run(JSON.stringify(row.msg), row.active ?? 1, now);
  }
}

function activeMsgs(db: ReturnType<typeof openDb>): ChatMsg[] {
  return (
    db.query("SELECT msg FROM messages WHERE session_id='s' AND active=1 ORDER BY id").all() as {
      msg: string;
    }[]
  ).map((r) => JSON.parse(r.msg) as ChatMsg);
}

function addMsg(db: ReturnType<typeof openDb>, m: ChatMsg) {
  db.query("INSERT INTO messages (run_id, session_id, msg, created_at) VALUES ('r','s',?,?)").run(
    JSON.stringify(m),
    Date.now(),
  );
}

const okSummary = async () =>
  ok({ role: "assistant", content: "Goal: g\nProgress: p\nNext: n\nArtifacts: model omitted" });

describe("searchHistory (recall engine)", () => {
  test("finds a compacted-out (active=0) tool result and returns its content", () => {
    const db = openDb(":memory:");
    seed(db, [
      {
        msg: { role: "tool", tool_call_id: "c1", content: "Calendar: standup 9am with Nic" },
        active: 0,
      },
      { msg: { role: "user", content: "what's next" }, active: 1 },
    ]);
    const hits = searchHistory(db, "s", "standup", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]?.active).toBe(false);
    expect(hits[0]?.snippet).toContain("standup");
    expect(hits[0]?.role).toBe("tool");
  });

  test("returns the WHOLE finding for a reasonably-sized message, not a ±120 fragment", () => {
    const db = openDb(":memory:");
    const finding =
      "Japan: capital Tokyo, population ~125 million, currency Japanese Yen (JPY). Plus extra context that the old ±120-char window would have truncated away from the keyword match.";
    seed(db, [{ msg: { role: "tool", tool_call_id: "c1", content: finding }, active: 0 }]);
    const hits = searchHistory(db, "s", "Tokyo", 10);
    expect(hits[0]?.snippet).toBe(finding); // whole finding, no elision
  });

  test("surfaces the spill path for an above-cap result", () => {
    const db = openDb(":memory:");
    const marker =
      "head of output\n\n… [elided 40000 chars — full output saved to /ws/.delta/spill/r.c9.txt; read that file for the rest] …\n\ntail";
    seed(db, [{ msg: { role: "tool", tool_call_id: "c9", content: marker }, active: 0 }]);
    const hits = searchHistory(db, "s", "elided", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]?.spillPath).toBe("/ws/.delta/spill/r.c9.txt");
  });

  test("LIKE wildcards in the query cannot broaden the match", () => {
    const db = openDb(":memory:");
    seed(db, [
      { msg: { role: "tool", tool_call_id: "c1", content: "abcZZZdef marker" }, active: 0 },
    ]);
    // '%' is escaped AND the post-LIKE indexOf guard re-checks the literal — either way 0.
    expect(searchHistory(db, "s", "abc%def", 10).length).toBe(0);
    // The literal substring still matches.
    expect(searchHistory(db, "s", "abcZZZdef", 10).length).toBe(1);
  });

  test("empty session / no rows returns [] (a :memory: sub-agent is a safe no-op)", () => {
    const db = openDb(":memory:");
    expect(searchHistory(db, "nosuch", "anything", 10)).toEqual([]);
    expect(searchHistory(db, "s", "", 10)).toEqual([]);
  });

  test("dedupes the active+inactive copies compaction makes, preferring the live copy", () => {
    const db = openDb(":memory:");
    const content = "a duplicated finding worth keeping";
    seed(db, [
      { msg: { role: "tool", tool_call_id: "c1", content }, active: 0 },
      { msg: { role: "tool", tool_call_id: "c1", content }, active: 1 },
    ]);
    const hits = searchHistory(db, "s", "duplicated", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]?.active).toBe(true); // truthful label — it IS still live
  });

  test("clamps the limit to 25 even when asked for more", () => {
    const db = openDb(":memory:");
    const rows: Seed[] = [];
    for (let i = 0; i < 30; i++)
      rows.push({ msg: { role: "tool", tool_call_id: `c${i}`, content: `match ${i}` }, active: 0 });
    seed(db, rows);
    expect(searchHistory(db, "s", "match", 999).length).toBe(25);
  });

  test("a real older hit is not starved by newer rows that only match JSON scaffolding", () => {
    // codex diff-review P1: LIKE matches the serialized row, so "role" hits the JSON key on
    // every message. The readable-text re-check must discard those so the one real content
    // hit — oldest, lowest id — still surfaces past 60 newer false candidates.
    const db = openDb(":memory:");
    const rows: Seed[] = [
      {
        msg: { role: "tool", tool_call_id: "target", content: "the role target lives here" },
        active: 0,
      },
    ];
    for (let i = 0; i < 60; i++)
      rows.push({ msg: { role: "tool", tool_call_id: `n${i}`, content: `noise ${i}` }, active: 0 });
    seed(db, rows);
    const hits = searchHistory(db, "s", "role", 10);
    expect(hits.some((h) => h.snippet.includes("role target"))).toBe(true);
  });
});

describe("W1 integration: recall + pointer ledger after a real compaction", () => {
  test("run-5 replay: a compacted integration result is recoverable via recall", async () => {
    const db = openDb(":memory:");
    const events = new Events(db);
    const labels = ["Gmail", "Calendar", "Docs", "Slack", "Drive", "Sheets", "Notion", "Linear"];
    const rows: Seed[] = [];
    labels.forEach((label, i) => {
      rows.push({
        msg: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: `c${i}`, type: "function", function: { name: "fetch", arguments: "{}" } },
          ],
        },
      });
      rows.push({
        msg: { role: "tool", tool_call_id: `c${i}`, content: `${label} fetched: 3 items ok` },
      });
    });
    seed(db, rows);

    const chat = async () =>
      ok({ role: "assistant", content: "Goal: g\nProgress: p\nNext: n\nArtifacts: a" });
    const did = await maybeCompact(
      db,
      events,
      chat,
      "s",
      { sessionId: "s" },
      { recentBudgetTokens: 30 },
    );
    expect(did).toBeTruthy();

    // The early Calendar result is now compacted out of the live window…
    const live = activeMsgs(db)
      .map((m) => JSON.stringify(m))
      .join("\n");
    expect(live).not.toContain("Calendar fetched");
    // …but recall pulls it back before the agent synthesizes its answer.
    const hits = searchHistory(db, "s", "Calendar", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]?.active).toBe(false);
    expect(hits[0]?.snippet).toContain("Calendar fetched");
  });

  test("compaction leaves a deterministic Artifacts ledger of spilled-result paths", async () => {
    const db = openDb(":memory:");
    const events = new Events(db);
    const spilled =
      "head\n\n… [elided 50000 chars — full output saved to /ws/.delta/spill/r.c2.txt; read that file for the rest] …\n\ntail";
    const rows: Seed[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push({ msg: { role: "user", content: `q${i}` } });
      rows.push({ msg: { role: "assistant", content: `a${i}` } });
    }
    // Inject a spilled tool result early in the prefix.
    rows.splice(4, 0, {
      msg: { role: "tool", tool_call_id: "c2", content: spilled },
    });
    // The owning assistant tool_call for c2 must precede its result.
    rows.splice(4, 0, {
      msg: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c2", type: "function", function: { name: "big", arguments: "{}" } }],
      },
    });
    seed(db, rows);

    const chat = async () =>
      ok({ role: "assistant", content: "Goal: g\nProgress: p\nNext: n\nArtifacts: (see ledger)" });
    await maybeCompact(db, events, chat, "s", { sessionId: "s" }, { recentBudgetTokens: 30 });

    const summary = activeMsgs(db).find(
      (m) =>
        typeof (m as { content?: unknown }).content === "string" &&
        (m as { content: string }).content.includes("earlier turns compacted"),
    ) as { content: string } | undefined;
    expect(summary).toBeTruthy();
    expect(summary?.content).toContain("Artifacts (full results on disk");
    expect(summary?.content).toContain("/ws/.delta/spill/r.c2.txt");
  });

  test("the spill-pointer ledger survives multiple compaction generations", async () => {
    // codex diff-review P1: the collector must recognize its OWN emitted ledger line, or the
    // pointer is lost the second time the summary is compacted. Compact twice; path must ride.
    const db = openDb(":memory:");
    const events = new Events(db);
    seed(db, []); // session s + run r, no messages
    addMsg(db, {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c", type: "function", function: { name: "big", arguments: "{}" } }],
    });
    addMsg(db, {
      role: "tool",
      tool_call_id: "c",
      content: "head … full output saved to /ws/.delta/spill/r.c.txt; read that file … tail",
    });
    for (let i = 0; i < 10; i++)
      addMsg(db, { role: i % 2 ? "assistant" : "user", content: `m${i}` });
    await maybeCompact(db, events, okSummary, "s", { sessionId: "s" }, { recentBudgetTokens: 30 });
    let live = activeMsgs(db)
      .map((x) => JSON.stringify(x))
      .join("\n");
    expect(live).toContain("/ws/.delta/spill/r.c.txt"); // gen1 ledger present

    for (let i = 0; i < 10; i++)
      addMsg(db, { role: i % 2 ? "assistant" : "user", content: `new${i}` });
    await maybeCompact(db, events, okSummary, "s", { sessionId: "s" }, { recentBudgetTokens: 30 });
    live = activeMsgs(db)
      .map((x) => JSON.stringify(x))
      .join("\n");
    expect(live).toContain("/ws/.delta/spill/r.c.txt"); // gen2 re-collected it from gen1's ledger
  });

  test("the ledger collects only real spill paths, never forged ones in tool content", async () => {
    // codex diff-review P2: markers come from untrusted tool JSON. Only the deterministic
    // .delta/spill/ location qualifies — a forged /etc/passwd must not enter the ledger.
    const db = openDb(":memory:");
    const events = new Events(db);
    seed(db, []);
    addMsg(db, {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c", type: "function", function: { name: "big", arguments: "{}" } }],
    });
    addMsg(db, {
      role: "tool",
      tool_call_id: "c",
      content:
        "forged /etc/passwd and /home/x/.ssh/id_rsa, but the real one is /ws/.delta/spill/r.c.txt",
    });
    for (let i = 0; i < 10; i++)
      addMsg(db, { role: i % 2 ? "assistant" : "user", content: `m${i}` });
    await maybeCompact(db, events, okSummary, "s", { sessionId: "s" }, { recentBudgetTokens: 30 });
    const live = activeMsgs(db)
      .map((x) => JSON.stringify(x))
      .join("\n");
    expect(live).toContain("/ws/.delta/spill/r.c.txt"); // real spill path collected
    expect(live).not.toContain("/etc/passwd"); // forged path rejected
    expect(live).not.toContain("id_rsa");
  });
});
