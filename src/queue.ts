// SPDX-License-Identifier: Apache-2.0
// The durable run queue (spec §B): every inbound becomes a queued Run row —
// durable before anything is acked. Serial within a session (preserves the
// memory chain), concurrent across sessions. On boot, `recover()` resumes runs
// that were mid-flight when the process died, then drains the queue.

import { readdirSync, rmSync } from "node:fs";
import { reflect } from "./reflect";
import {
  type Deps,
  executeRun,
  getRun,
  type RunRequest,
  type RunRow,
  responsePayload,
  rid,
  zeroUsage,
} from "./run";
import type { ToolCtx } from "./tools";

/** Thrown by enqueue when previous_response_id doesn't resolve — surfacing it
 * beats silently forking a fresh session and losing the intended history. */
export class UnknownPreviousResponse extends Error {
  constructor(id: string) {
    super(`unknown previous_response_id: ${id}`);
  }
}

/** Thrown by enqueue when a caller tries to continue a session it doesn't own
 * (previous_response_id points at a session owned by a different user). Without
 * this check any caller could inherit another user's session by id — and
 * session-scoped recall would then read back that session's compacted transcript
 * (cross-user disclosure). */
export class SessionOwnershipError extends Error {
  constructor(id: string) {
    super(`previous_response_id belongs to a session owned by another user: ${id}`);
  }
}

export class Queue {
  private waiters = new Map<string, ((run: RunRow) => void)[]>();
  private aborts = new Map<string, AbortController>();
  private busy = new Set<string>(); // session ids with a run in flight
  private active = 0;

  constructor(
    private deps: Deps,
    // Max concurrent RUNS (one per active session). Runs are IO-bound async work on ONE event
    // loop — this is really "how many provider calls in flight", not threads. The daemon sets it
    // from DELTA_MAX_CONCURRENCY (default 8); the mechanism itself is proven correct to 128+. The
    // practical ceiling is the provider's concurrent-request tolerance (a subscription key wants a
    // LOW value; a high-limit API key can go to 25+), then per-run context memory (~4-15MB/run).
    private concurrency = 8,
  ) {}

  /** Durable-before-ack: the row is committed before this returns. */
  enqueue(req: RunRequest, principal: string | null = null, strict = false): RunRow {
    const { db, events } = this.deps;
    const now = Date.now();
    // Ownership principal (S1). When the HTTP boundary resolved a principal from the
    // gateway-asserted `x-delta-user` header, it is AUTHORITATIVE — a client behind the trusted
    // gateway may control the request body but not that header, so the header overrides any
    // body-supplied identity (codex P0: never let caller-body metadata be the auth). Body metadata
    // stays the fallback for callers that don't front a header-setting gateway (single-tenant/dev).
    // Both aliases are read (the chat vs task entry paths populate one or the other; spineOf uses
    // the same snake/camel tolerance). NOTE: the server ALSO canonicalizes the stored body's
    // `user_id` to this same principal at ingress, so every downstream consumer that reads the
    // body (recall, reflection, event identity) keys on the SAME owner — the read/write scope can't
    // diverge (codex P0).
    const bodyOwner =
      (typeof req.metadata?.user_id === "string" && req.metadata.user_id) ||
      (typeof req.metadata?.userId === "string" && req.metadata.userId) ||
      null;
    const userId = principal ?? bodyOwner;
    // Resolve + authorize a continuation FIRST, so the idempotency dedupe below can scope to the
    // run's ACTUAL owner (the existing session's, which a continuation inherits — not the asserted
    // principal). Doing dedupe first under the principal would miss a null-owned continuation and
    // start a duplicate on retry (codex P2).
    let sessionId: string | undefined;
    let dedupeOwner = userId; // a fresh run is owned by the resolved principal…
    if (req.previous_response_id) {
      const prev = db
        .query(
          `SELECT r.session_id AS session_id, s.user_id AS user_id
           FROM runs r JOIN sessions s ON s.id = r.session_id
           WHERE r.id = ?`,
        )
        .get(req.previous_response_id) as { session_id: string; user_id: string | null } | null;
      if (!prev) throw new UnknownPreviousResponse(req.previous_response_id);
      // Session ownership. Non-strict (single-tenant/dev): a user-OWNED session may only be
      // continued by that same user; a null-owner session stays open (no identity was asserted at
      // creation — matches pre-S0 behavior). Strict multi-tenant: the previous owner must EQUAL the
      // principal, null included — a legacy/unowned session must not be continuable by an arbitrary
      // tenant just because they know its id (codex P1). `userId` is the same value
      // `sessions.user_id` was stamped with at creation.
      const mismatch = strict
        ? prev.user_id !== userId
        : prev.user_id !== null && prev.user_id !== userId;
      if (mismatch) throw new SessionOwnershipError(req.previous_response_id);
      sessionId = prev.session_id;
      dedupeOwner = prev.user_id; // …but a continuation inherits the existing session's owner
    }
    // Dispatch idempotency (fire-and-forget callers): if a run WITH THE SAME OWNER already carries
    // this key, return it instead of starting a second one. By default a NON-terminal match dedupes
    // and a terminal run FREES the key (a stable key reused later runs fresh — the neutral-engine
    // contract, unchanged). A caller whose key is unique per intent opts into `idempotency_terminal`
    // (Connect's async turns do): a terminal run then ALSO dedupes, so a retry after losing the 202
    // for a run the daemon durably accepted re-attaches instead of starting a SECOND run — which
    // would duplicate billing and side effects and strand the first result (codex P1). Scoping the
    // dedupe to the run's owner is load-bearing for tenancy — an unscoped match would hand one tenant
    // another tenant's run (and, on the sync route, its streamed result) via a guessed/shared key
    // (codex P0). `s.user_id IS ?` is SQLite's null-safe compare, so a null owner matches only null.
    // Newest-first (global created_at, since seq is only session-local — codex P1) so a caller
    // re-attaches to its latest run. Single-writer (bun) + synchronous check-before-insert = race-safe.
    if (req.idempotency_key) {
      const existing = db
        .query(
          `SELECT r.id, r.status FROM runs r JOIN sessions s ON s.id = r.session_id
           WHERE json_extract(r.request, '$.idempotency_key') = ?
             AND s.user_id IS ?
           ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
        )
        .get(req.idempotency_key, dedupeOwner) as { id: string; status: string } | null;
      const terminal = existing && ["done", "failed", "cancelled"].includes(existing.status);
      if (existing && (!terminal || req.idempotency_terminal))
        return getRun(db, existing.id) as RunRow;
    }
    const id = `resp_${rid()}`;
    db.transaction(() => {
      if (!sessionId) {
        sessionId = `sess_${rid()}`;
        db.query(
          "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ).run(sessionId, userId, now, now);
      }
      const { seq } = db
        .query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM runs WHERE session_id = ?")
        .get(sessionId) as { seq: number };
      db.query(
        "INSERT INTO runs (id, session_id, seq, status, request, created_at) VALUES (?, ?, ?, 'queued', ?, ?)",
      ).run(id, sessionId, seq, JSON.stringify(req), now);
    })();
    const position = (
      this.deps.db.query("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'").get() as {
        n: number;
      }
    ).n;
    events.emit(
      "run.enqueued",
      { sessionId: sessionId as string, runId: id, ...(userId ? { userId } : {}) },
      { position },
    );
    queueMicrotask(() => this.pump());
    return getRun(this.deps.db, id) as RunRow;
  }

  /** Read-only run lookup for HTTP routes (status, cancel, SSE terminal check). */
  get(runId: string): RunRow | null {
    return getRun(this.deps.db, runId);
  }

  /** The session owner (user_id) for a run — the tenancy principal an HTTP route checks against
   * (S1). `undefined` = no such run; `null` = an unowned single-tenant/dev run; a string = the
   * owning principal. Reading the session (not the run) keeps this the same source `enqueue`
   * stamped and `snapshot` filters on, so the read/write scope can't diverge. */
  owner(runId: string): string | null | undefined {
    const row = this.deps.db
      .query(
        "SELECT s.user_id AS user_id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?",
      )
      .get(runId) as { user_id: string | null } | null;
    return row ? row.user_id : undefined;
  }

  /** Resolves when the run reaches a terminal state. */
  wait(runId: string): Promise<RunRow> {
    const run = getRun(this.deps.db, runId);
    if (!run) return Promise.reject(new Error(`no such run: ${runId}`));
    if (run.status !== "queued" && run.status !== "running") return Promise.resolve(run);
    return new Promise((resolve) => {
      const list = this.waiters.get(runId) ?? [];
      list.push(resolve);
      this.waiters.set(runId, list);
    });
  }

  cancel(runId: string): boolean {
    const { db, events } = this.deps;
    const run = getRun(db, runId);
    if (!run) return false;
    if (run.status === "queued") {
      // Never-started runs still owe waiters a Responses-compatible payload.
      const payload = responsePayload(
        run,
        "cancelled",
        "cancelled before start",
        "delta",
        zeroUsage(),
      );
      const changed = db
        .query(
          "UPDATE runs SET status = 'cancelled', error = 'cancelled', result = ?, finished_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(JSON.stringify(payload), Date.now(), runId);
      if (changed.changes === 0) return this.cancel(runId); // raced with pump — it's running now
      events.emit("run.cancelled", { sessionId: run.session_id, runId }, {});
      this.settle(runId);
      return true;
    }
    const abort = this.aborts.get(runId);
    if (abort) {
      abort.abort();
      events.emit("run.cancelled", { sessionId: run.session_id, runId }, {});
      return true;
    }
    return false;
  }

  /** Queue snapshot for GET /v1/queue (spec §A/§J). The caller sees their own
   * entries in full; everyone else's are opaque — only status/position/age, so
   * you learn "why is my task waiting" without enumerating others' ids, sessions,
   * or user ids. `caller === null` (no identity) sees everything opaque.
   * `mineOnly` (strict multi-tenant): return ONLY the caller's entries and number
   * their positions among themselves — so a caller can't even infer other tenants'
   * queued work from a global position number (codex P2). */
  snapshot(
    caller: string | null = null,
    mineOnly = false,
  ): Array<{
    id: string | null;
    session_id: string | null;
    status: string;
    user_id: string | null;
    position: number | null;
    age_ms: number;
    mine: boolean;
  }> {
    const now = Date.now();
    const all = this.deps.db
      .query(
        `SELECT r.id, r.session_id, r.status, s.user_id, r.created_at
         FROM runs r JOIN sessions s ON s.id = r.session_id
         WHERE r.status IN ('queued','running')
         ORDER BY r.created_at, r.seq`,
      )
      .all() as Array<{
      id: string;
      session_id: string;
      status: string;
      user_id: string | null;
      created_at: number;
    }>;
    // In mineOnly mode, drop other tenants BEFORE numbering, so positions are tenant-local.
    const rows = mineOnly ? all.filter((r) => caller !== null && r.user_id === caller) : all;
    let pos = 0;
    return rows.map((r) => {
      const mine = caller !== null && r.user_id === caller;
      const position = r.status === "queued" ? ++pos : null;
      return mine
        ? {
            id: r.id,
            session_id: r.session_id,
            status: r.status,
            user_id: r.user_id,
            position,
            age_ms: now - r.created_at,
            mine: true,
          }
        : {
            id: null,
            session_id: null,
            status: r.status,
            user_id: null,
            position,
            age_ms: now - r.created_at,
            mine: false,
          };
    });
  }

  /** Lifecycle signal for a host managing scale-to-zero (the hosting contract): is the
   * agent safe to suspend? Reports the DURABLE truth from the runs table — queued OR
   * running — not the in-memory busy set (which tracks only in-flight sessions). A
   * queued-but-not-yet-dispatched run must also hold the machine awake, or the host
   * would suspend with work owed and strand it until the next wake. `busy` is the
   * one boolean a host needs; the counts are for observability.
   *
   * Covers task work only. Post-run background reflection (opt-in self-learning) is NOT
   * counted — it is best-effort and expendable across a suspend (the run's result is
   * already durably delivered before reflection starts). The `WHERE` keeps this cheap:
   * it rides the runs(status, …) index and touches only active rows, so a host can poll
   * it freely without scanning the whole run history. */
  activity(): {
    busy: boolean;
    running: number;
    queued: number;
    /** snake_case because this is the JSON field name consumers read (`/v1/status` is snake_case
     * throughout, and the spec promised `last_event_ms_ago`). `Response.json()` does no case
     * conversion, so a camelCase property here ships a differently-named field than the docs
     * describe and reads as the feature being absent (codex P1). */
    last_event_ms_ago?: number;
  } {
    const row = this.deps.db
      .query(
        `SELECT COALESCE(SUM(status = 'running'), 0) AS running,
                COALESCE(SUM(status = 'queued'), 0) AS queued
         FROM runs WHERE status IN ('queued', 'running')`,
      )
      .get() as { running: number; queued: number };
    // S7: how long the daemon has been SILENT, not how old the turn is. A turn emitting tool calls
    // every 20s is healthy at four minutes old, so turn age would card it; silence would not.
    // Every consumer currently guesses this constant on its own — Aperture's reconciler treated two
    // minutes as a stall and offered a Resume on a healthy 12-hour run, which would have duplicated
    // it. Only meaningful while running: a queued-but-not-started daemon has nothing to be silent
    // about, and an idle one is not being watched.
    // DAEMON-WIDE, not per-run: this is the newest event across every running run, so on a daemon
    // serving several runs a noisy one keeps the clock low while a sibling is genuinely stuck. That
    // is the right scope for `/v1/busy` (whose other fields are daemon-wide too) and the wrong input
    // for a per-run Resume decision — a host wanting that reads `/v1/tasks/:id/events` (codex).
    // Ordered by `id` rather than `MAX(ts)` so the `events_run(run_id, id)` index answers it
    // directly; ids are assigned in insertion order, so the newest id IS the newest event.
    let last_event_ms_ago: number | undefined;
    if (row.running > 0) {
      const ev = this.deps.db
        .query(
          `SELECT e.ts AS ts FROM events e
             JOIN runs r ON r.id = e.run_id
            WHERE r.status = 'running'
            ORDER BY e.id DESC LIMIT 1`,
        )
        .get() as { ts: number | null } | undefined;
      if (ev?.ts) last_event_ms_ago = Math.max(0, Date.now() - ev.ts);
    }
    return {
      busy: row.running + row.queued > 0,
      running: row.running,
      queued: row.queued,
      ...(last_event_ms_ago !== undefined ? { last_event_ms_ago } : {}),
    };
  }

  /** Boot: resume crashed mid-flight runs, then drain queued ones. */
  recover(): void {
    const rows = this.deps.db
      .query("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at")
      .all() as RunRow[];
    for (const row of rows) this.start(row, true);
    this.pump();
  }

  private pump(): void {
    const { db } = this.deps;
    while (this.active < this.concurrency) {
      const candidates = db
        .query("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at, seq")
        .all() as RunRow[];
      const next = candidates.find((r) => !this.busy.has(r.session_id));
      if (!next) return;
      const claimed = db
        .query(
          "UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(Date.now(), next.id);
      if (claimed.changes === 0) continue; // lost a race with cancel — pick again
      this.start({ ...next, status: "running" }, false);
    }
  }

  private start(run: RunRow, resuming: boolean): void {
    this.busy.add(run.session_id);
    this.active++;
    const abort = new AbortController();
    this.aborts.set(run.id, abort);
    this.deps.events.emit(
      resuming ? "run.resumed" : "run.started",
      { sessionId: run.session_id, runId: run.id },
      {},
    );
    executeRun(this.deps, run.id, { resuming, signal: abort.signal })
      .catch((e) => {
        // executeRun is error-as-value; this is the last-resort backstop so the
        // daemon never crashes and the run never wedges in 'running'.
        this.deps.db
          .query("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
          .run(String(e).slice(0, 2000), Date.now(), run.id);
        this.deps.events.emit(
          "error",
          { sessionId: run.session_id, runId: run.id },
          { "error.type": "run", message: String(e).slice(0, 2000) },
        );
      })
      .finally(() => {
        this.busy.delete(run.session_id);
        this.aborts.delete(run.id);
        this.active--;
        this.settle(run.id); // waiters get their (in-memory) RunRow first
        // Run-scoped scratch is wiped for EVERY run — the dir (`scratch/<runId>/`, advertised to the
        // agent as {{run.scratch}}) is run-scoped by contract, so its lifetime is the run. This bounds
        // disk growth and gives every agent a deterministic clean slate. Safe here: the run is terminal
        // (executeRun resolved), so no tool still holds a scratch path.
        this.wipeRunScratch(run.id);
        // store:false → retain nothing. Purge AFTER settle (the resolved RunRow is already
        // in-memory, so deleting the row can't affect it) and INSTEAD of reflecting (reflection
        // would read the transcript we're erasing; an ephemeral turn does its learning via the
        // review loop, not per-turn self-reflection). EXCEPTION: idempotency_terminal promises
        // exactly-once for the key, which requires the terminal run to persist so a retry re-attaches
        // instead of starting a second — so an ephemeral+idempotent-terminal turn is NOT purged.
        const req = JSON.parse(run.request) as RunRequest;
        if (req.store === false && !req.idempotency_terminal) {
          this.purgeEphemeral(run.session_id);
          // Spill + research artifacts are transcript-derived and, unlike scratch, are engine-owned
          // (not model-writable). For an ephemeral turn they must ALSO go for the zero-trace guarantee.
          // EPHEMERAL-ONLY: durable sessions depend on `.delta/spill/<runId>.*` surviving across runs
          // — `recall` reconstructs the spill path from a prior turn's transcript and compaction
          // accumulates spill pointers. Wiping durable spill would silently break cross-run recall.
          this.wipeRunSpill(run.id);
          this.wipeRunResearch(run.id);
        } else {
          this.maybeReflect(run.id); // background self-learning (never blocks waiters)
        }
        this.pump();
      });
  }

  /** Remove the run's scratch dir (`scratch/<runId>/`). Called for every terminal run: the dir is
   *  run-scoped by contract so wiping it can never touch another run's state (runIds are unique).
   *  force:true → a no-op when the run never wrote scratch (the common case). */
  private wipeRunScratch(runId: string): void {
    rmSync(`${this.deps.workspace}/scratch/${runId}`, { recursive: true, force: true });
  }

  /** Remove the run's spilled tool results (`.delta/spill/<runId>.*`). EPHEMERAL-ONLY — see the call
   *  site: durable recall/compaction reconstruct these paths in later runs. safe(runId)===runId for a
   *  `resp_…` id, so the prefix match is exact. */
  private wipeRunSpill(runId: string): void {
    this.wipeByPrefix(`${this.deps.workspace}/.delta/spill`, `${runId}.`);
  }

  /** Remove the run's research artifacts (`research/<runId>.<seq>/`). EPHEMERAL-ONLY (transcript-
   *  derived, and durable sessions may re-read them via recall). */
  private wipeRunResearch(runId: string): void {
    this.wipeByPrefix(`${this.deps.workspace}/research`, `${runId}.`);
  }

  /** rm every direct child of `dir` whose name starts with `prefix`. Best-effort: a missing dir or
   *  entry is swallowed (force:true) — most runs spill/research nothing. */
  private wipeByPrefix(dir: string, prefix: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // dir never created
    }
    for (const name of entries) {
      if (name.startsWith(prefix)) rmSync(`${dir}/${name}`, { recursive: true, force: true });
    }
  }

  /** Fire the learning loop for a completed run, opt-in (metadata.reflect or the
   * daemon default). Fully background: waiters already got their response, and a
   * reflection failure is logged, never fatal (spec §H). */
  private maybeReflect(runId: string): void {
    if (this.deps.safeMode) return;
    const run = getRun(this.deps.db, runId);
    if (run?.status !== "done") return;
    // Opt-in from EITHER side: the daemon default OR the per-run request. (Using
    // `??` here would let a `false` default swallow a per-run metadata.reflect.)
    const meta = (JSON.parse(run.request) as { metadata?: Record<string, unknown> }).metadata ?? {};
    const perRun = meta.reflect === true;
    if (this.deps.reflect !== true && !perRun) return;
    const spine = { sessionId: run.session_id, runId: run.id };
    // Carry the run's act-as-user token into the reflection's tool calls — a knowledge base
    // proposal / the skill registry write must land as the run's principal, not the daemon's
    // (codex 6+7 #8). Best-effort: an expired token degrades like any tool error.
    const ctx: ToolCtx = {
      workspace: this.deps.workspace,
      activate: () => {},
      ...(typeof meta.authToken === "string" && meta.authToken
        ? { authToken: meta.authToken }
        : {}),
    };
    // this.deps satisfies ReflectDeps (db/events/chat/tools/agentId/charter).
    reflect(this.deps, run, spine, ctx).catch((e) =>
      this.deps.events.emit("error", spine, {
        "error.type": "reflection",
        message: String(e).slice(0, 500),
      }),
    );
  }

  /** store:false — retain nothing on disk after the turn is terminal (an EPHEMERAL turn, the
   *  OpenAI Responses `store` flag). An ephemeral turn never carries previous_response_id, so its
   *  session is a fresh single-run session and deleting by session_id removes exactly this turn's
   *  transcript: the runs row (request/result), messages, raw model calls, and tool journal. The
   *  cross-run stores — memory / promotion / self_revisions / thread_state — are intentionally left
   *  intact: they hold abstracted learnings and self-file identity, not this turn's content. Product-
   *  agnostic: any caller can ask for an ephemeral turn; nothing here knows about meetings. */
  private purgeEphemeral(sessionId: string): void {
    const { db } = this.deps;
    db.transaction(() => {
      db.query("DELETE FROM calls WHERE session_id = ?").run(sessionId);
      // journal is keyed by run_id (no session_id) — delete via the session's runs before they go.
      db.query(
        "DELETE FROM journal WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)",
      ).run(sessionId);
      db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      db.query("DELETE FROM runs WHERE session_id = ?").run(sessionId);
      db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
    })();
  }

  private settle(runId: string): void {
    const list = this.waiters.get(runId);
    if (!list) return;
    this.waiters.delete(runId);
    const run = getRun(this.deps.db, runId) as RunRow;
    for (const resolve of list) resolve(run);
  }
}
