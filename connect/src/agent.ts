import type { AgentClient, DownloadedFile, OperationResult } from "./types";

// One turn against the Delta engine seam. Sync request/reply: input +
// previous_response_id + metadata.user_id -> output_text. The engine threads
// the session and enforces ownership by user_id; the edge only supplies them.

export class DeltaAgent implements AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly controlToken?: string,
    private readonly inspectToken?: string,
  ) {}

  async run(
    input: string,
    opts: { previousResponseId?: string; userId: string },
  ): Promise<{ responseId: string; outputText: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.controlToken) headers.authorization = `Bearer ${this.controlToken}`;

    const res = await fetch(`${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input,
        previous_response_id: opts.previousResponseId,
        metadata: { user_id: opts.userId },
      }),
      signal: AbortSignal.timeout(180000),
    });

    const data = (await res.json()) as {
      id?: string;
      status?: string;
      output_text?: string;
    };
    if (data.status !== "completed") {
      throw new Error(
        `agent turn ${data.status ?? res.status}: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return { responseId: data.id ?? "", outputText: data.output_text ?? "" };
  }

  /** Hand files to the daemon workspace (POST /v1/files, multipart). The bytes
   *  land in the workspace inbox and never enter a prompt; the agent reads them
   *  by path with read_file. Returns the saved paths. */
  async uploadFiles(files: DownloadedFile[]): Promise<Array<{ path: string; mime: string }>> {
    const form = new FormData();
    for (const f of files) {
      form.append("file", new Blob([f.bytes], { type: f.mime }), f.name);
    }
    // No content-type header: fetch sets the multipart boundary for FormData.
    const headers: Record<string, string> = {};
    if (this.controlToken) headers.authorization = `Bearer ${this.controlToken}`;

    const res = await fetch(`${this.baseUrl}/v1/files`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      files?: Array<{ path?: string; mime?: string }>;
    };
    if (res.status !== 201 || !Array.isArray(data.files)) {
      throw new Error(`file upload ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data.files.map((f) => ({ path: f.path ?? "", mime: f.mime ?? "" }));
  }

  /** Secret-free status for the /model and /status commands (GET /v1/status, 0.2.7).
   *  Null on any failure — a status read never fails a turn. */
  async status(): Promise<Record<string, unknown> | null> {
    try {
      const headers: Record<string, string> = {};
      if (this.controlToken) headers.authorization = `Bearer ${this.controlToken}`;
      const res = await fetch(`${this.baseUrl}/v1/status`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as unknown;
      return typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /** Write a credential to the harness vault (PUT /v1/secrets/:name, 0.2.10).
   *
   *  Hardened because this is the ONE call in Connect that carries a secret value:
   *   - the base URL must be an explicit loopback HTTP origin, so a misconfigured
   *     DELTA_BASE_URL can never ship a credential to a remote host;
   *   - redirects are refused outright rather than followed with the body re-sent;
   *   - nothing about the value is logged, echoed, or returned.
   *  The harness side is create-only, so a 409 means "already stored" and is terminal. */
  async storeSecret(
    name: string,
    value: string,
    purpose: string,
  ): Promise<{ ok: boolean; status: number; error?: string }> {
    let target: URL;
    try {
      target = new URL(`/v1/secrets/${encodeURIComponent(name)}`, this.baseUrl);
    } catch {
      return { ok: false, status: 0, error: "bad base url" };
    }
    if (
      target.protocol !== "http:" ||
      !(
        target.hostname === "127.0.0.1" ||
        target.hostname === "localhost" ||
        target.hostname === "[::1]"
      )
    ) {
      return { ok: false, status: 0, error: "vault writes are loopback-only" };
    }
    if (!this.controlToken) return { ok: false, status: 0, error: "no control token" };
    try {
      const res = await fetch(target, {
        method: "PUT",
        redirect: "error", // never re-send a credential to a redirect target
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.controlToken}`,
        },
        body: JSON.stringify({ value, purpose }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { ok: true, status: res.status };
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, status: res.status, error: body.error?.message };
    } catch (e) {
      // Deliberately does not include the error string: a fetch failure can echo the request.
      return { ok: false, status: 0, error: e instanceof Error ? e.name : "request failed" };
    }
  }

  /** Credential metadata from the vault: names and purposes, never values. Null on failure. */
  async listSecrets(): Promise<Array<{ name: string; purpose: string }> | null> {
    if (!this.controlToken) return null;
    try {
      const res = await fetch(new URL("/v1/secrets", this.baseUrl), {
        headers: { authorization: `Bearer ${this.controlToken}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { secrets?: Array<{ name: string; purpose: string }> };
      return Array.isArray(body.secrets) ? body.secrets : null;
    } catch {
      return null;
    }
  }

  /** Vault names + whether the vault is usable at all, from /v1/status. */
  async vaultState(): Promise<{ enabled: boolean; declared: string[]; safeMode: boolean }> {
    const s = await this.status();
    const vault = (s?.vault ?? {}) as { enabled?: unknown; declared?: unknown };
    return {
      enabled: vault.enabled === true,
      declared: Array.isArray(vault.declared) ? (vault.declared as string[]) : [],
      safeMode: s?.safe_mode === true,
    };
  }

  /** Inspect-authenticated self-file revert. Never reuse the control/seam token. */
  async revertSelf(id: number): Promise<OperationResult> {
    if (!this.inspectToken)
      return { ok: false, error: "revert unavailable: inspect token missing" };
    try {
      const url = new URL("/v1/dev/self/revert", this.baseUrl);
      url.searchParams.set("id", String(id));
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.inspectToken}` },
        signal: AbortSignal.timeout(10000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        note?: unknown;
        error?: { message?: unknown };
      };
      const message = String(
        res.ok ? (data.note ?? "reverted") : (data.error?.message ?? res.status),
      )
        .slice(0, 300)
        .trim();
      return res.ok ? { ok: true, note: message } : { ok: false, error: message };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 300) };
    }
  }

  /** Start an async turn on the daemon's durable /v1/tasks surface (0.3.2). Returns the run id
   *  immediately (the turn runs in the background); the tracker polls it to completion, so a long
   *  turn no longer holds an HTTP call open under a wall-clock timeout. idempotency_key = the inbox
   *  event id, so a crash-then-redispatch re-attaches to the SAME daemon task instead of double-running. */
  async startTask(
    input: string,
    opts: { previousResponseId?: string; userId: string; idempotencyKey: string },
  ): Promise<{ id: string } | { error: string }> {
    try {
      // x-delta-user asserts the run's owner, so the ownership-gated status/cancel polls below
      // (which the sync /v1/responses path never needed) match — same pattern Aperture QS uses.
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-delta-user": opts.userId,
      };
      if (this.controlToken) headers.authorization = `Bearer ${this.controlToken}`;
      const res = await fetch(`${this.baseUrl}/v1/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          input,
          previous_response_id: opts.previousResponseId,
          idempotency_key: opts.idempotencyKey,
          // Exactly-once per key: if the 202 is lost we re-POST the same key, and the daemon must
          // re-attach to the accepted run even once terminal rather than start a second (0.2.8.1).
          idempotency_terminal: true,
          metadata: { user_id: opts.userId },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { error: `task start ${res.status}` };
      const data = (await res.json().catch(() => ({}))) as { id?: unknown };
      return typeof data.id === "string" && data.id
        ? { id: data.id }
        : { error: "task start: no id" };
    } catch (e) {
      return { error: String(e).slice(0, 200) };
    }
  }

  /** Poll a task's authoritative status (GET /v1/tasks/:id). Null on a transient failure so the
   *  tracker keeps the task active and retries next tick. On a terminal status, result carries the
   *  response id (for the thread head) and the full output_text. */
  async pollTask(
    id: string,
    userId: string,
  ): Promise<{ status: string; responseId?: string; outputText?: string; error?: string } | null> {
    try {
      const headers: Record<string, string> = { "x-delta-user": userId };
      if (this.controlToken) headers.authorization = `Bearer ${this.controlToken}`;
      const res = await fetch(`${this.baseUrl}/v1/tasks/${encodeURIComponent(id)}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as {
        status?: unknown;
        error?: unknown;
        result?: { id?: unknown; output_text?: unknown };
      };
      return {
        status: typeof data.status === "string" ? data.status : "unknown",
        ...(typeof data.result?.id === "string" ? { responseId: data.result.id } : {}),
        ...(typeof data.result?.output_text === "string"
          ? { outputText: data.result.output_text }
          : {}),
        ...(data.error ? { error: String(data.error).slice(0, 300) } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Read a task's structural progress since a cursor (GET /v1/tasks/:id/events?since=N) — the
   *  bounded JSON form of the events feed, not the SSE one.
   *
   *  This is what a live progress preview needs and nothing more: turn and tool lifecycle. Per-token
   *  deltas are deliberately absent (the daemon never persists them), which is the reason this can
   *  be an ordinary poll folded into the existing task tick instead of a long-lived stream with its
   *  own lifecycle. Null on any failure — progress display is never worth a retry. */
  async taskEvents(
    id: string,
    userId: string,
    since: number,
  ): Promise<{ events: Array<Record<string, unknown>>; cursor: number } | null> {
    try {
      const headers: Record<string, string> = { "x-delta-user": userId };
      if (this.controlToken) headers.authorization = `Bearer ${this.controlToken}`;
      const res = await fetch(
        `${this.baseUrl}/v1/tasks/${encodeURIComponent(id)}/events?since=${since}&limit=200`,
        { headers, signal: AbortSignal.timeout(10000) },
      );
      if (!res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as {
        events?: unknown;
        cursor?: unknown;
      };
      if (!Array.isArray(data.events) || typeof data.cursor !== "number") return null;
      return { events: data.events as Array<Record<string, unknown>>, cursor: data.cursor };
    } catch {
      return null;
    }
  }

  /** Cancel a running task (DELETE /v1/tasks/:id). Best-effort; ends the orphaned-billing an
   *  abandoned turn would otherwise incur. */
  async cancelTask(id: string, userId: string): Promise<void> {
    try {
      const headers: Record<string, string> = { "x-delta-user": userId };
      if (this.controlToken) headers.authorization = `Bearer ${this.controlToken}`;
      await fetch(`${this.baseUrl}/v1/tasks/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // best-effort
    }
  }

  /** Inspect-authenticated self-file revision history for the /revert picker (0.3.1).
   *  Reuses the existing GET /v1/dev/self/revisions endpoint; null on any failure. */
  async revisions(): Promise<{
    current: string;
    revisions: { id: number; ts: number; content: string }[];
  } | null> {
    if (!this.inspectToken) return null;
    try {
      const res = await fetch(new URL("/v1/dev/self/revisions", this.baseUrl), {
        headers: { authorization: `Bearer ${this.inspectToken}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { current?: unknown; revisions?: unknown };
      const current = typeof data.current === "string" ? data.current : "";
      const revisions = Array.isArray(data.revisions)
        ? data.revisions.flatMap((r) => {
            if (typeof r !== "object" || r === null) return [];
            const o = r as Record<string, unknown>;
            return typeof o.id === "number" &&
              typeof o.ts === "number" &&
              typeof o.content === "string"
              ? [{ id: o.id, ts: o.ts, content: o.content }]
              : [];
          })
        : [];
      return { current, revisions };
    } catch {
      return null;
    }
  }
}
