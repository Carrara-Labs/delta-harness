// SPDX-License-Identifier: Apache-2.0
// The seam with the control plane. Two surfaces over one durable Run:
//   sync  — POST /v1/responses: enqueue → await terminal → driver-compatible body
//   async — POST /v1/tasks: 202 + id, then SSE progress / GET status / DELETE cancel
// Plus GET /v1/queue (why-isn't-my-task-running) and GET /healthz. Failures come
// back as clean turns (error-as-value); the daemon never crashes on a request.

import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { DeltaEvent, Events } from "./events";
import { saveInbox, sniffMime } from "./files";
import { getProfile } from "./profiles";
import { type Queue, SessionOwnershipError, UnknownPreviousResponse } from "./queue";
import type { RunRequest } from "./run";
import { scrubText } from "./scrub";
import { currentSelf, listRevisions, revertSelf, SELF_FILE, writeSelf } from "./self";
import type { Vault } from "./vault";
import { HARNESS_VERSION } from "./version";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** On-disk size of the agent's self-file against its cap (0.2.12). Best-effort: an absent file is
 * 0, which is the truthful answer for an agent that has not written one yet. */
function selfFullness(workspace: string | undefined, cap: number): { bytes: number; cap: number } {
  if (!workspace) return { bytes: 0, cap };
  try {
    return { bytes: statSync(resolve(workspace, SELF_FILE)).size, cap };
  } catch {
    return { bytes: 0, cap };
  }
}

// Hard ceiling on an upload body's ACTUAL bytes. The content-length header is only a
// hint — a chunked body sends none, and a hostile client can declare a small length then
// stream gigabytes. formData() would buffer all of it in RAM first (OOM DoS), so we drain
// the stream ourselves with a running counter and abort the moment it crosses the cap.
const MAX_UPLOAD_BYTES = 110 * 1024 * 1024; // 100MB batch + multipart framing headroom

/** Read a request body into memory, but never more than `max` bytes: returns null (→ 413)
 * the instant the true byte count exceeds the cap, regardless of the declared length. */
export async function readCappedBody(request: Request, max: number): Promise<Uint8Array | null> {
  const body = request.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function createServer(
  queue: Queue,
  events: Events,
  port: number,
  opts?: {
    workspace?: string;
    /** Run-driving gateway token (DELTA_CONTROL_TOKEN) — gates the seam's `/v1/*`. */
    authToken?: string;
    /** Root introspection token (DELTA_INSPECT_TOKEN) — gates the Cockpit's
     *  `/v1/dev/*`. Distinct, higher privilege than driving runs (spec §8). Unset ⇒
     *  `/v1/dev/*` is loopback-only (fail-closed on a public interface). */
    inspectToken?: string;
    /** The daemon's own writable SQLite handle — the Cockpit reads it with fixed,
     *  safe-column `SELECT`s (never a raw table dump). Absent ⇒ `/v1/dev/*` is 404. */
    db?: Database;
    /** Bundle files allowlisted for `/v1/dev/files?path=operator/<name>` — the
     *  self-file + fixed operator files (exact-name match only). */
    operatorFiles?: string[];
    /** DELTA.md self-write byte cap — used by the Cockpit self-file revert endpoint. */
    selfMaxBytes?: number;
    /** Pre-built allowlisted boot config for `/v1/dev/config` (spec §4.6) — assembled
     *  from safe resolved fields in index.ts; secrets are presence booleans, never values. */
    config?: Record<string, unknown>;
    /** The single-file Cockpit UI served (inert, public) at `GET /dev`. */
    cockpitHtml?: string;
    /** Bind host (DELTA_BIND). `delta dev` sets `127.0.0.1` so a local test agent is
     *  loopback-only; unset ⇒ Bun's default (all interfaces), exactly as prod. */
    hostname?: string;
    /** DELTA_INSPECT=off — hard kill-switch: `/dev` and every `/v1/dev/*` return 404,
     *  as if the Cockpit weren't compiled in (spec §7). For hardened deployments. */
    inspectDisabled?: boolean;
    /** DELTA_INSPECT_WRITE=1 — opt-in for `PUT /v1/dev/files` (in-browser operator/
     *  workspace-file editing). Off by default so read-introspection never silently
     *  grants write; `delta dev` turns it on locally. No hot-reload — restart applies. */
    inspectWrite?: boolean;
    /** DELTA_STRICT_TENANT=1 — multiple users behind one control token; every run must be owned
     *  and a task route is served only to its owner. Off by default (single-tenant-per-daemon). */
    strictTenant?: boolean;
    /** DELTA_TRUST_REVIEW_METADATA=1 — honor body-supplied memory-widening authorization. Off by
     *  default: those fields are stripped from every body (S5a). */
    trustReviewMetadata?: boolean;
    /** The Secret Vault (0.2.10). Absent → every /v1/secrets route 503s and status reports
     *  `enabled: false`; the daemon otherwise runs exactly as before. */
    vault?: Vault | null;
    /** Names the running config declares a `{{vault:NAME}}` destination for (plus builtins) —
     *  the operator-sanctioned request set an edge validates a secret request against. */
    vaultDeclared?: string[];
    /** Called after a secret lands, with its NAME (never its value). The daemon uses it to
     *  reconnect any MCP backend whose config references that name — a server whose
     *  credential was missing at boot never connected, so without this the credential would
     *  only take effect on the next restart. Builtins need nothing: they resolve per call. */
    onSecretStored?: (name: string) => void;
  },
) {
  // Gateway auth (codex S8 #1): flycast is network placement, NOT authentication —
  // same-org tenants share the 6PN. When the VM's gateway token is configured
  // (DELTA_CONTROL_TOKEN — the control plane already sends it as a Bearer on every
  // daemon call), every /v1/* request must present it. /healthz stays open: it's
  // the autosuspend wake probe and carries no data. No token configured (bare dev
  // binary) → open, as before.
  const authed = (request: Request): boolean => {
    if (!opts?.authToken) return true;
    const header = request.headers.get("authorization") ?? "";
    const bearer = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    const want = Buffer.from(opts.authToken);
    return bearer.length === want.length && timingSafeEqual(bearer, want);
  };

  // The ONE tenancy principal (S1). The control token authenticates the trusted gateway; the
  // gateway asserts WHICH of its users this request is for via `x-delta-user`. That header is the
  // sole authority — it is never taken from the request body (a client behind the gateway may
  // control the body but not this header). null = no principal asserted (single-tenant/dev).
  const principalOf = (request: Request): string | null =>
    request.headers.get("x-delta-user")?.trim() || null;

  // May `principal` touch a run owned by `owner`? `owner === undefined` means the run doesn't
  // exist. Non-strict (default, single-tenant-per-daemon): an unowned run is open; an owned run is
  // its owner's alone. Strict (DELTA_STRICT_TENANT): the principal must be present AND match — an
  // unowned run is inaccessible. A denied lookup returns 404, never 403, so cross-tenant probing
  // can't even confirm a task id exists (codex P0).
  const mayAccess = (owner: string | null | undefined, principal: string | null): boolean => {
    if (owner === undefined) return false;
    if (opts?.strictTenant) return principal !== null && owner === principal;
    return owner === null || owner === principal;
  };

  // Cockpit introspection gate (spec §7/§8). When DELTA_INSPECT_TOKEN is set, a
  // matching Bearer is required — this is a DIFFERENT credential from the run-driving
  // authToken above (driving a run must not unlock reading everything inside the VM).
  // When it is unset, `/v1/dev/*` is served only to a loopback client (local dev,
  // single-tenant) and fail-closed on any other interface — never expose introspection
  // on a public bind without a token. Checked per-request against the peer address, so
  // it holds regardless of what host the daemon bound.
  const inspectAuthed = (
    request: Request,
    server: { requestIP(request: Request): { address: string } | null },
  ): "ok" | "unauthorized" | "forbidden" => {
    if (opts?.inspectToken) {
      const header = request.headers.get("authorization") ?? "";
      const bearer = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
      const want = Buffer.from(opts.inspectToken);
      return bearer.length === want.length && timingSafeEqual(bearer, want) ? "ok" : "unauthorized";
    }
    return isLoopback(server.requestIP(request)?.address) ? "ok" : "forbidden";
  };

  return Bun.serve({
    port,
    ...(opts?.hostname ? { hostname: opts.hostname } : {}),
    idleTimeout: 0, // turns are budget-bound, not wall-clock-bound
    fetch: async (request, server) => {
      const url = new URL(request.url);
      const { pathname } = url;
      const { method } = request;

      // Liveness + version: the control plane reads the running binary version here to
      // manage the fleet (which agents are on which release). `build` is the exact commit
      // baked at image build (DELTA_BUILD), for provenance. Stays open + data-free.
      if (method === "GET" && pathname === "/healthz")
        return json({
          ok: true,
          version: HARNESS_VERSION,
          ...(process.env.DELTA_BUILD ? { build: process.env.DELTA_BUILD } : {}),
        });
      // Cockpit UI (spec §4.2): public + inert — the page carries no data or secrets;
      // everything it shows comes from the token-gated `/v1/dev/*` fetches below. Served
      // ahead of any auth gate (the existing gate only matches `/v1/`), so a browser can
      // load it and then authenticate its data calls.
      // DELTA_INSPECT=off (spec §7): the whole Cockpit surface disappears — /dev and
      // /v1/dev/* both 404, as if it weren't compiled in. Checked before either route.
      const inspectOff = opts?.inspectDisabled === true;
      // When off, BOTH /dev and every /v1/dev/* uniformly 404 — resolved here, ahead of
      // the generic /v1 auth gate, so a control-token daemon returns a clean 404 (not a
      // 401 that would reveal the gate still exists behind the switch — codex P2).
      if (inspectOff && (pathname === "/dev" || pathname.startsWith("/v1/dev/")))
        return json({ error: { message: "not found" } }, 404);
      if (method === "GET" && pathname === "/dev")
        return new Response(opts?.cockpitHtml ?? PLACEHOLDER_DEV_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });

      // Cockpit data endpoints (spec §4.2) — root introspection, gated by
      // DELTA_INSPECT_TOKEN (distinct from the run-driving authToken). Handled here,
      // BEFORE the generic `/v1/` authToken gate, because they ride a different
      // credential; returning from this block means they never hit that gate.
      if (pathname.startsWith("/v1/dev/")) {
        // Reads are GET; writes are opt-in and enumerated (below).
        const isSecretOp =
          (method === "POST" || method === "DELETE") && pathname.startsWith("/v1/dev/secrets/");
        const isWrite =
          (method === "PUT" && pathname === "/v1/dev/files") ||
          (method === "POST" && pathname === "/v1/dev/self/revert") ||
          isSecretOp;
        if (method !== "GET" && !isWrite)
          return json({ error: { message: "method not allowed" } }, 405);
        const gate = inspectAuthed(request, server);
        if (gate === "unauthorized") return json({ error: { message: "unauthorized" } }, 401);
        if (gate === "forbidden")
          return json(
            {
              error: {
                message:
                  "introspection is disabled on a non-loopback interface without DELTA_INSPECT_TOKEN",
              },
            },
            403,
          );
        const db = opts?.db;
        if (!db) return json({ error: { message: "introspection not available" } }, 404);

        if (pathname === "/v1/dev/stream")
          return streamDev(db, events, {
            since: Number(url.searchParams.get("since") ?? 0) || 0,
            run: url.searchParams.get("run") ?? undefined,
            session: url.searchParams.get("session") ?? undefined,
            live: url.searchParams.get("live") !== "0",
          });

        if (pathname === "/v1/dev/config") return json(opts?.config ?? {});

        if (pathname === "/v1/dev/files") {
          if (isWrite) {
            // Write-through operator/workspace-file editing (fast-follow). Opt-in via
            // DELTA_INSPECT_WRITE so read-introspection never silently grants write.
            // NO hot-reload — bytes land on disk, the response says restart to apply,
            // so dev stays byte-for-byte equal to prod (spec §1 principle 3).
            if (!opts?.inspectWrite)
              return json(
                { error: { message: "editing disabled — set DELTA_INSPECT_WRITE=1" } },
                403,
              );
            const body = await readCappedBody(request, MAX_FILE_BYTES + 1);
            if (!body) return json({ error: { message: "body exceeds the 1MB file cap" } }, 413);
            // A Cockpit edit of DELTA.md routes through writeSelf (codex #20): the operator's
            // own edit is snapshotted + size-checked + atomic, same as the agent's remember.
            const editPath = url.searchParams.get("path") ?? "";
            if (
              db &&
              opts?.workspace &&
              (editPath === "operator/DELTA.md" || editPath === "workspace/DELTA.md")
            ) {
              const r = writeSelf(
                db,
                resolve(opts.workspace),
                new TextDecoder().decode(body),
                opts.selfMaxBytes ?? 3200,
              );
              return r.ok
                ? json({ ok: true, note: "saved DELTA.md — takes effect on the next run" })
                : json({ error: { message: r.error } }, 400);
            }
            return devFilesWrite(opts?.workspace, editPath, opts?.operatorFiles ?? [], body);
          }
          return devFiles(
            opts?.workspace,
            url.searchParams.get("path") ?? "workspace",
            opts?.operatorFiles ?? [],
            url.searchParams.get("raw") === "1",
          );
        }

        // Self-file (DELTA.md) revision history + revert — the no-gate safety net for the
        // agent's autonomous self-writes. List is read-only; revert is a write (inspectWrite).
        if (pathname === "/v1/dev/self/revisions") {
          if (!db || !opts?.workspace) return json({ revisions: [] });
          const revs = listRevisions(db).map((r) => ({
            id: r.id,
            ts: r.ts,
            preview: r.content.slice(0, 200),
            // Full prior content so the Cockpit can diff a revision against current before
            // reverting. Loopback-only surface, bounded (≤20 revisions × the self-file cap),
            // and no more sensitive than `current` which is already returned in full.
            content: r.content,
          }));
          return json({ current: currentSelf(opts.workspace), revisions: revs });
        }
        if (pathname === "/v1/dev/self/revert" && isWrite) {
          if (!opts?.inspectWrite)
            return json(
              { error: { message: "editing disabled — set DELTA_INSPECT_WRITE=1" } },
              403,
            );
          if (!db || !opts?.workspace) return json({ error: { message: "no store" } }, 404);
          const id = Number(url.searchParams.get("id"));
          // Revision ids are positive autoincrement. Number(null)/Number("")/Number("  ")
          // are all 0 (a valid integer), so require a POSITIVE integer explicitly — else an
          // absent or blank id silently reverts to "revision 0" and reports the confusing
          // "no such revision: 0" (codex #3).
          if (!Number.isInteger(id) || id < 1)
            return json({ error: { message: "id required" } }, 400);
          const r = revertSelf(db, opts.workspace, id, opts.selfMaxBytes ?? 3200);
          return r.ok
            ? json({ ok: true, note: "reverted — takes effect on the next run" })
            : json({ error: { message: r.error } }, 400);
        }

        // Raw whitelisted-table peek (fast-follow) — for the rare inspection the
        // purpose-built projections don't cover. Behind an explicit `?ack=root` so it's
        // never hit by accident; fixed table+column allowlist, secret-bearing columns
        // redacted. GET /v1/dev/tables lists the peekable tables + row counts.
        if (pathname === "/v1/dev/tables") return devTablesList(db);
        const tableMatch = pathname.match(/^\/v1\/dev\/tables\/([A-Za-z_]+)$/);
        if (tableMatch) {
          if (url.searchParams.get("ack") !== "root")
            return json(
              {
                error: { message: "raw table access requires ?ack=root (see /v1/dev/runs first)" },
              },
              400,
            );
          return devTablePeek(
            db,
            tableMatch[1] as string,
            Number(url.searchParams.get("limit") ?? 100) || 100,
          );
        }

        // True-to-life per-model-call input/output (the `calls` capture). Redacted on read.
        const runCalls = pathname.match(/^\/v1\/dev\/runs\/([^/]+)\/calls$/);
        if (runCalls) return devRunCalls(db, runCalls[1] as string);
        const runDetail = pathname.match(/^\/v1\/dev\/runs\/([^/]+)$/);
        if (runDetail) return devRunDetail(db, runDetail[1] as string);

        // Vault rotation + deletion (0.2.10). OPERATOR acts, so they ride the inspect
        // credential — a strictly higher privilege than the seam token that drives runs.
        // Creation deliberately lives on /v1/secrets instead: the gateway may ADD a
        // credential (that's the intake flow) but must not be able to swap or destroy one.
        if (isSecretOp) {
          // Loopback peer identity is not sufficient authorization for a credential mutation:
          // any page in a local browser can POST to 127.0.0.1. Require the inspect TOKEN
          // itself, not merely the loopback fallback that read-introspection accepts (V-08).
          if (!opts?.inspectToken)
            return json(
              {
                error: {
                  message: "rotating or deleting a secret requires DELTA_INSPECT_TOKEN",
                },
              },
              403,
            );
          if (!opts?.inspectWrite)
            return json(
              { error: { message: "set DELTA_INSPECT_WRITE=1 to rotate or delete a secret" } },
              403,
            );
          if (!opts?.vault) return json({ error: { message: "the vault is not enabled" } }, 503);
          const name = decodeURIComponent(pathname.slice("/v1/dev/secrets/".length));
          if (method === "DELETE") {
            const gone = opts.vault.delete(name);
            if (gone) events.emit("vault.delete", {}, { name });
            return gone
              ? json({ ok: true, name })
              : json({ error: { message: "no such secret" } }, 404);
          }
          const raw = await readCappedBody(request, 8192);
          if (!raw) return json({ error: { message: "body too large" } }, 413);
          let body: { value?: unknown; purpose?: unknown };
          try {
            body = JSON.parse(new TextDecoder().decode(raw)) as typeof body;
          } catch {
            return json({ error: { message: "body must be JSON" } }, 400);
          }
          if (typeof body.value !== "string")
            return json({ error: { message: "`value` must be a string" } }, 400);
          const r = opts.vault.put(
            name,
            body.value,
            typeof body.purpose === "string" ? body.purpose : "",
            true, // operator rotation may replace
          );
          if (!r.ok) return json({ error: { message: r.error } }, r.status);
          events.emit("vault.set", {}, { name });
          opts.onSecretStored?.(name);
          return json({ ok: true, name });
        }

        if (pathname === "/v1/dev/runs")
          return devRunsList(db, {
            session: url.searchParams.get("session") ?? undefined,
            limit: Number(url.searchParams.get("limit") ?? 50) || 50,
            after: url.searchParams.get("after") ?? undefined,
          });

        return json({ error: { message: "not found" } }, 404);
      }

      if (pathname.startsWith("/v1/") && !authed(request))
        return json({ error: { message: "unauthorized" } }, 401);

      // GET /v1/status (0.2.7) — a data-free read of the running agent's identity, model,
      // effort, profile, budget caps and MCP servers, for edge tooling (Delta Connect's
      // /model, /status). Sourced from the same allowlisted boot-config view as the Cockpit,
      // so it can never leak a key; gated by the seam token like every /v1/* route.
      if (method === "GET" && pathname === "/v1/status") {
        const c = (opts?.config ?? {}) as Record<string, unknown>;
        return json({
          version: c.version,
          ...(c.agent_id ? { agent_id: c.agent_id } : {}),
          // The CANONICAL name, not the configured alias (0.2.12). `DELTA_PROFILE=work` reported
          // "work" here while the 0.2.7 changelog and the guide both promise "trusted" — a
          // docs-vs-wire disagreement an edge tool cannot reconcile.
          profile: getProfile(c.profile).name,
          safe_mode: c.safe_mode ?? false,
          model: c.model,
          ...(c.budget ? { budget: c.budget } : {}),
          mcp_servers: c.mcp_servers ?? [],
          // Vault (0.2.10). Read LIVE, not from the boot config snapshot — a secret provided
          // a minute ago must be visible here, and the edge gates its intake UX on `enabled`.
          // `declared` = names the config actually has a destination wired for, so an edge can
          // refuse a model-solicited credential nobody configured a use for.
          vault: {
            enabled: Boolean(opts?.vault),
            count: opts?.vault?.list().length ?? 0,
            declared: opts?.vaultDeclared ?? [],
          },
          // Self-file fullness (0.2.12). Read LIVE for the same reason `vault` is: self bytes are
          // per-run, so a boot snapshot would report the seed forever. A nearly-full DELTA.md
          // refuses every `remember` — the lane silently stops learning — and across the Aperture
          // fleet fullness turned out to be the single best predictor of degraded self-learning.
          // It was computed on every run and dropped, discoverable only by querying the collector.
          self: selfFullness(opts?.workspace, opts?.selfMaxBytes ?? 3200),
        });
      }

      // ── The Secret Vault surface (0.2.10) ──────────────────────────────────────
      // Write-only by design: values go IN (create-only), metadata comes OUT, and there is
      // NO route that returns a value — not even to the authenticated gateway. A lost secret
      // is re-provided, never recovered. Deleting/rotating is an operator act behind the
      // higher-privilege inspect credential, so a prompt-injected intake flow cannot swap an
      // established credential for an attacker's.
      if (pathname === "/v1/secrets" || pathname.startsWith("/v1/secrets/")) {
        // A bare dev binary leaves /v1/* open (no control token configured). That default is
        // fine for run traffic and NOT fine for a credential store: without a token, serve the
        // vault only to a loopback peer, never on a public or org-network bind (codex V-07).
        if (!opts?.authToken && !isLoopback(server.requestIP(request)?.address))
          return json(
            {
              error: {
                message:
                  "the vault requires DELTA_CONTROL_TOKEN when the daemon is reachable off-loopback",
              },
            },
            403,
          );
        if (!opts?.vault)
          return json(
            {
              error: {
                message:
                  "the vault is not enabled on this daemon (set DELTA_VAULT_KEY; unavailable in safe mode)",
              },
            },
            503,
          );
        const vault = opts.vault;
        const name = pathname.startsWith("/v1/secrets/")
          ? decodeURIComponent(pathname.slice("/v1/secrets/".length))
          : "";

        if (method === "GET" && !name) return json({ secrets: vault.list() });

        if (method === "PUT" && name) {
          const raw = await readCappedBody(request, 8192);
          if (!raw) return json({ error: { message: "body too large" } }, 413);
          let body: { value?: unknown; purpose?: unknown };
          try {
            body = JSON.parse(new TextDecoder().decode(raw)) as typeof body;
          } catch {
            return json({ error: { message: "body must be JSON" } }, 400);
          }
          if (typeof body.value !== "string")
            return json({ error: { message: "`value` must be a string" } }, 400);
          const r = vault.put(
            name,
            body.value,
            typeof body.purpose === "string" ? body.purpose : "",
            false, // create-only: rotation requires the operator route below
          );
          // Never echo the request back — an error body must carry the NAME and nothing else.
          if (!r.ok) return json({ error: { message: r.error } }, r.status);
          events.emit("vault.set", {}, { name });
          opts.onSecretStored?.(name);
          return json({ ok: true, name });
        }

        // Rotation and deletion are OPERATOR acts, not gateway acts: they live on
        // `/v1/dev/secrets/:name` behind the inspect credential (see the dev block above).
        return json({ error: { message: "not found" } }, 404);
      }

      // Inbound attachments (Sprint 8): batch multipart → workspace inbox. The
      // claim-check: bytes land on disk; callers get PATHS to reference in the
      // next turn — file bytes never enter a prompt. Same trust model as
      // /v1/responses (the control plane fronts this on the private network).
      if (method === "POST" && pathname === "/v1/files" && opts?.workspace) {
        // Reject oversized bodies BEFORE materializing the multipart. The declared
        // content-length is a fast-path reject only; readCappedBody enforces the TRUE
        // ceiling on the actual stream, so a chunked or under-declared body can't OOM
        // the daemon by buffering unbounded in formData() (codex S8 #5 + H6).
        const declared = Number(request.headers.get("content-length") ?? 0);
        if (declared > MAX_UPLOAD_BYTES)
          return json({ error: { message: "body exceeds the 100MB batch cap" } }, 413);
        const raw = await readCappedBody(request, MAX_UPLOAD_BYTES);
        if (!raw) return json({ error: { message: "body exceeds the 100MB batch cap" } }, 413);
        let form: Awaited<ReturnType<Request["formData"]>>;
        try {
          // Re-parse the BOUNDED bytes as multipart — same shape formData() expects, but
          // now RAM is capped at MAX_UPLOAD_BYTES no matter what the client streamed.
          form = await new Response(raw, {
            headers: { "content-type": request.headers.get("content-type") ?? "" },
          }).formData();
        } catch {
          return json(
            { error: { message: "multipart/form-data with `file` parts required" } },
            400,
          );
        }
        // typeof-guard, not `instanceof File`: Bun types formData via undici's File,
        // which doesn't unify with the global File constructor.
        const parts = form
          .getAll("file")
          .filter(
            (f): f is Exclude<ReturnType<(typeof form)["getAll"]>[number], string> =>
              typeof f !== "string",
          );
        if (parts.length === 0)
          return json({ error: { message: "no `file` parts in the form" } }, 400);
        // Validate the WHOLE batch before saving any of it — a mid-batch 413 must
        // not leave half the files committed (codex S8 #8).
        if (parts.length > 50)
          return json({ error: { message: "too many parts — cap is 50 files per batch" } }, 413);
        let total = 0;
        for (const f of parts) {
          if (f.size > 25 * 1024 * 1024)
            return json({ error: { message: `'${f.name}' exceeds the 25MB per-file cap` } }, 413);
          total += f.size;
        }
        if (total > 100 * 1024 * 1024)
          return json({ error: { message: "batch exceeds the 100MB cap" } }, 413);
        const files: Array<{ path: string; size: number; mime: string }> = [];
        for (const f of parts) {
          files.push(
            await saveInbox(opts.workspace, f.name, new Uint8Array(await f.arrayBuffer())),
          );
        }
        return json({ files }, 201);
      }

      if (method === "GET" && pathname === "/v1/queue") {
        // Caller identity rides a header set by the trusted control plane; absent it, everyone
        // else's entries stay opaque (spec §J cross-user isolation). In strict multi-tenant mode a
        // principal is required and the snapshot is filtered to the caller's own entries — others'
        // positions/ages aren't even disclosed opaquely (codex P2).
        const principal = principalOf(request);
        if (opts?.strictTenant && principal === null)
          return json({ error: { message: "x-delta-user is required" } }, 401);
        // Strict → mineOnly: only the caller's entries, positions numbered among themselves.
        return json({ queue: queue.snapshot(principal, opts?.strictTenant === true) });
      }

      // Lifecycle signal for a scale-to-zero host (the hosting contract): "is the agent
      // safe to suspend?" → { busy, running, queued }, the durable queued-OR-running
      // truth so a host never suspends with work owed. Behind the /v1/ gate below (the
      // host already holds the control token) — deliberately NOT folded into /healthz,
      // which stays open + data-free (busy is operational state, not liveness).
      // HOST-ONLY BY DESIGN: the counts are GLOBAL because the decision is whole-machine
      // (suspend the VM iff NO tenant has work) — a per-tenant view can't answer that. It is
      // gated by the control token, i.e. only the trusted host/gateway can read it; it is never a
      // tenant-facing endpoint even in strict mode (codex P2 — accepted, not a leak to a tenant).
      if (method === "GET" && pathname === "/v1/busy") return json(queue.activity());

      if (method === "POST" && (pathname === "/v1/responses" || pathname === "/v1/tasks")) {
        const parsed = await readRequest(request);
        if ("error" in parsed) return json({ error: { message: parsed.error } }, 400);
        const principal = principalOf(request);
        // Strict multi-tenant: a run must be owned, so a create without an asserted principal is
        // refused rather than stamped NULL-owner (which would then be readable by anyone, S1).
        if (opts?.strictTenant && principal === null)
          return json({ error: { message: "x-delta-user is required" } }, 401);
        // Canonicalize identity: when a gateway asserted the principal, overwrite the stored body's
        // user_id (and drop the camel alias) with it, so EVERY downstream consumer that reads the
        // body — recall, reflection, event identity — keys on the same authoritative owner and can't
        // be pointed at another tenant's memory via a body field (codex P0).
        canonicalizeIdentity(parsed.body, principal);
        // S5a: strip body-supplied memory-widening authorization from EVERY body by default — a
        // shared control token authenticates the gateway, not that a body field came from a human
        // reviewer, so an untrusted body could otherwise widen a `user`-scoped memory into a
        // cross-user audience. Opt back in only for a single-tenant operator that builds its own
        // bodies; the durable trusted path is S5c.
        if (!opts?.trustReviewMetadata) stripAuthzMetadata(parsed.body);
        try {
          const run = queue.enqueue(parsed.body, principal, opts?.strictTenant ?? false);
          if (pathname === "/v1/tasks") {
            return json({ id: run.id, object: "task", status: "queued" }, 202);
          }
          // Streaming sync turn (§A P1 → P0 for chat): stream text deltas as they
          // arrive, then a terminal frame with the full response.
          const wantsStream =
            parsed.body.stream === true ||
            (request.headers.get("accept") ?? "").includes("text/event-stream");
          if (wantsStream) return streamResponse(queue, events, run.id);
          const done = await queue.wait(run.id);
          return json(JSON.parse(done.result ?? "{}"));
        } catch (e) {
          // An unknown previous id and a cross-tenant one return the SAME 404 — a distinct 400 vs
          // 403 would be an existence oracle for another tenant's session (codex P1).
          if (e instanceof UnknownPreviousResponse || e instanceof SessionOwnershipError)
            return json({ error: { message: "no such previous_response_id" } }, 404);
          throw e;
        }
      }

      // /v1/tasks/:id  — GET status · DELETE cancel · GET …/events — SSE progress
      const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)(\/events)?$/);
      if (taskMatch) {
        const id = taskMatch[1] as string;
        // Tenancy check FIRST (S1) — status, events, and cancel all require the caller to own the
        // run. A miss (no such run) and a cross-tenant hit both return the SAME 404, so a probe
        // can't distinguish "not yours" from "doesn't exist".
        if (!mayAccess(queue.owner(id), principalOf(request)))
          return json({ error: { message: "no such task" } }, 404);
        const run = queue.get(id);
        if (!run) return json({ error: { message: "no such task" } }, 404);

        if (method === "GET" && taskMatch[2] === "/events") {
          // Two shapes on one path (A1): `?since=<id>` → a bounded, cursor-paged JSON poll for a
          // host that can't hold an SSE connection; otherwise the live SSE tail. `?coarse=1` drops
          // the per-token deltas so the feed is a structural heartbeat under the narrative layer.
          // (The JSON poll reads the persisted `events` table, which never holds ephemeral deltas,
          // so it is coarse inherently.)
          if (url.searchParams.has("since")) {
            const db = opts?.db;
            if (!db) return json({ error: { message: "event polling requires a database" } }, 501);
            const since = Number(url.searchParams.get("since")) || 0;
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
            return json(pollEvents(db, id, since, limit));
          }
          return streamEvents(queue, events, id, url.searchParams.get("coarse") === "1");
        }
        if (method === "GET") {
          return json({
            id: run.id,
            object: "task",
            status: run.status,
            // A3: the cold-start timeline, so the UI can split "waking the agent" (accepted →
            // started) from "reading your question" (started → done). started_at is set the instant
            // the daemon dequeues the run — i.e. its first turn begins — the boundary a user waits on.
            created_at: run.created_at,
            ...(run.started_at ? { started_at: run.started_at } : {}),
            ...(run.finished_at ? { finished_at: run.finished_at } : {}),
            // A6: surface the last provider/tool error (already one-lined by normalizeError) so a
            // plain HTTP poller learns WHY a run failed before its first token — no shell-in needed.
            ...(run.error ? { error: run.error } : {}),
            ...(run.status === "done" || run.status === "failed" || run.status === "cancelled"
              ? { result: JSON.parse(run.result ?? "{}") }
              : {}),
          });
        }
        if (method === "DELETE") {
          const ok = queue.cancel(id);
          return json({ id, cancelled: ok, status: queue.get(id)?.status });
        }
      }

      return json({ error: { message: "not found" } }, 404);
    },
  });
}

async function readRequest(request: Request): Promise<{ body: RunRequest } | { error: string }> {
  let body: RunRequest;
  try {
    body = (await request.json()) as RunRequest;
  } catch {
    return { error: "invalid JSON body" };
  }
  if (typeof body.input !== "string" || body.input.length === 0) {
    return { error: "`input` must be a non-empty string" };
  }
  return { body };
}

/** Make a gateway-asserted principal the ONE identity in the stored body (S1): overwrite
 * `metadata.user_id` and drop the camelCase alias, so every downstream reader (memory recall,
 * reflection write, event identity) keys on the authoritative owner rather than a caller-supplied
 * body field. No principal (single-tenant/dev) → leave the body's own identity untouched. */
function canonicalizeIdentity(body: RunRequest, principal: string | null): void {
  if (principal === null) return;
  const meta = (body.metadata && typeof body.metadata === "object" ? body.metadata : {}) as Record<
    string,
    unknown
  >;
  meta.user_id = principal;
  delete meta.userId;
  body.metadata = meta as RunRequest["metadata"];
}

/** Remove memory-widening authorization from a caller-supplied request body (S5a). Reflection only
 * widens a `user`-scoped memory when `review_kind = submission_disposition` AND `widen_authorized`
 * (reflect.ts) — both read from run metadata. In strict multi-tenant mode those come from an
 * untrusted body, so a user could self-authorize a cross-user leak; strip them here so only a
 * trusted control-plane path (S5c) can ever set them. */
function stripAuthzMetadata(body: RunRequest): void {
  const m = body.metadata;
  if (!m || typeof m !== "object") return;
  const meta = m as Record<string, unknown>;
  delete meta.review_kind;
  delete meta.widen_authorized;
  if (meta.review && typeof meta.review === "object")
    delete (meta.review as Record<string, unknown>).widen_authorized;
}

/** SSE progress = a filtered tail of the §K event stream for this run. Replays
 *  nothing; emits live events until the run reaches a terminal state, then ends
 *  with a `done` frame carrying the final response payload. */
/** A coarse-mode SSE feed drops the per-token narrative deltas (`output_text.delta`,
 * `reasoning.delta`) — everything ending in `.delta` — leaving the structural heartbeat
 * (run/turn/tool lifecycle + model.call + checkpoint + error). */
const isDelta = (type: string): boolean => type.endsWith(".delta");

/** Bounded, cursor-paged JSON poll of a run's persisted events (A1). Returns rows with id>since in
 * id order (capped at `limit`) plus a `cursor` to pass as the next `since`, and `done` once the run
 * is terminal so a poller knows to stop. Ephemeral token deltas are never persisted, so this feed is
 * inherently coarse. The `events_run` index (run_id, id) keys the scan. */
function pollEvents(
  db: Database,
  runId: string,
  since: number,
  limit: number,
): { events: Array<Record<string, unknown>>; cursor: number; done: boolean } {
  const rows = db
    .query(
      `SELECT id, ts, type, turn, data FROM events
       WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(runId, since, limit) as Array<{
    id: number;
    ts: number;
    type: string;
    turn: number | null;
    data: string;
  }>;
  const list = rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    type: r.type,
    ...(r.turn !== null ? { turn: r.turn } : {}),
    ...(JSON.parse(r.data) as Record<string, unknown>),
  }));
  const cursor = rows.length ? (rows[rows.length - 1] as { id: number }).id : since;
  // `done` only once we've drained to the tail (a full page may have more waiting).
  const done =
    rows.length < limit &&
    ["done", "failed", "cancelled"].includes(
      (db.query("SELECT status FROM runs WHERE id = ?").get(runId) as { status?: string } | null)
        ?.status ?? "",
    );
  return { events: list, cursor, done };
}

function streamEvents(queue: Queue, events: Events, runId: string, coarse = false): Response {
  const encoder = new TextEncoder();
  // Hoisted so cancel() (client disconnect) hits the same teardown as terminal
  // completion — otherwise the heartbeat + event listener leak per dropped conn.
  let teardown = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const frame = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": ping\n\n"));
      }, 15_000);
      heartbeat.unref?.();

      const cleanup = (close: boolean) => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        off();
        if (close) {
          try {
            controller.close();
          } catch {}
        }
      };
      teardown = () => cleanup(false); // cancel() already tears the stream down

      const finishTerminal = () => {
        if (closed) return;
        const run = queue.get(runId);
        if (!run || run.status === "queued" || run.status === "running") return;
        frame("done", { status: run.status, response: JSON.parse(run.result ?? "{}") });
        cleanup(true);
      };

      const off = events.on((e: DeltaEvent) => {
        if (e.runId !== runId) return;
        if (coarse && isDelta(e.type)) return; // heartbeat mode: no per-token deltas
        frame(e.type, { ts: e.ts, turn: e.turn, ...e.data });
        if (e.type === "run.finished") finishTerminal();
      });

      // If the run already finished before this stream opened, close immediately.
      finishTerminal();
    },
    cancel() {
      teardown(); // client disconnected — release the interval + listener
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** Streaming sync turn (§A): forward `response.output_text.delta` frames as the
 *  model produces text, then a terminal `response.completed` frame carrying the
 *  full driver-compatible payload. Same lifecycle discipline as streamEvents
 *  (heartbeat, cancel teardown, close-once). */
function streamResponse(queue: Queue, events: Events, runId: string): Response {
  const encoder = new TextEncoder();
  let teardown = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const frame = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": ping\n\n"));
      }, 15_000);
      heartbeat.unref?.();

      const cleanup = (close: boolean) => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        off();
        if (close) {
          try {
            controller.close();
          } catch {}
        }
      };
      teardown = () => cleanup(false);

      const finishTerminal = () => {
        if (closed) return;
        const run = queue.get(runId);
        if (!run || run.status === "queued" || run.status === "running") return;
        frame("response.completed", JSON.parse(run.result ?? "{}"));
        cleanup(true);
      };

      const off = events.on((e: DeltaEvent) => {
        if (e.runId !== runId) return;
        if (e.type === "output_text.delta")
          frame("response.output_text.delta", { delta: e.data.delta });
        else if (e.type === "run.finished") finishTerminal();
      });

      finishTerminal(); // already done before the stream opened
    },
    cancel() {
      teardown();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ── Cockpit (spec §4) ────────────────────────────────────────────────────────
// All read-only, all fed by the seam that already exists. The invariant: never
// return a secret-bearing column or an out-of-sandbox path, even to a holder of
// the inspect token (leaking a knowledge-base act-as token revokes the whole family).

const PLACEHOLDER_DEV_HTML =
  '<!doctype html><meta charset=utf-8><title>Delta Cockpit</title><body style="font:14px ui-monospace,monospace;background:#0b0e14;color:#cdd6f4;padding:2rem"><h1>▲ Delta Cockpit</h1><p>UI asset not embedded in this build. Data endpoints are live at <code>/v1/dev/*</code>.</p>';

/** Peer-address loopback test — the fail-open condition for un-tokened `/v1/dev/*`.
 *  Covers IPv4, IPv6, and IPv4-mapped-IPv6 loopback. */
function isLoopback(addr?: string | null): boolean {
  if (!addr) return false;
  return (
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.") ||
    addr.startsWith("::ffff:127.")
  );
}

// Keys whose values are credential-shaped: redacted wherever they appear in a
// journal args/result payload (defense in depth — the run request is never
// returned raw, but a tool could have been called WITH a secret in its args).
const SECRET_KEY =
  /^(authorization|auth[_-]?token|api[_-]?key|apikey|x[_-]?api[_-]?key|token|secret|password|passwd|bearer|credential|refresh[_-]?token|access[_-]?token|client[_-]?secret|cookie|set-cookie)$/i;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value); // scrub secret-shaped substrings
  if (value === null || typeof value !== "object") return value;
  // Fail CLOSED at the depth limit: an object we won't descend into is replaced
  // wholesale, so a deeply-nested secret key can never slip through unredacted
  // (returning the raw value here was a fail-open — codex P1).
  if (depth >= 8) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactSecrets(v, depth + 1);
  }
  return out;
}

type RunRow = {
  id: string;
  session_id: string;
  seq: number;
  status: string;
  usage: string | null;
  tools: string | null;
  request: string | null;
  result?: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

function safeParse<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Project a `runs` row to safe columns only. NEVER echoes `request`/`result` raw
 *  (they carry `metadata.authToken` / full payloads); `last_input_preview` is a
 *  200-char slice and `model` is the single safe field lifted from the result. */
function projectRun(r: RunRow) {
  const usage = safeParse<Record<string, number>>(r.usage) ?? {};
  const tools = safeParse<string[]>(r.tools);
  const req = safeParse<{ input?: unknown }>(r.request);
  const preview = typeof req?.input === "string" ? req.input.slice(0, 200) : "";
  const model = safeParse<{ model?: string }>(r.result ?? null)?.model ?? null;
  return {
    id: r.id,
    session_id: r.session_id,
    seq: r.seq,
    status: r.status,
    model,
    tokens: { in: usage.input ?? 0, out: usage.output ?? 0 },
    cost_usd: usage.costUsd ?? 0,
    tools: Array.isArray(tools) ? tools : [],
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    last_input_preview: preview,
  };
}

// `result` is the response payload ({model, output_text, usage, …}) — NOT secret-
// bearing like `request` (which carries metadata.authToken), so it's safe to select
// and lift the `model` field from. projectRun never echoes it raw.
const RUN_LIST_COLS =
  "id, session_id, seq, status, usage, tools, request, result, created_at, started_at, finished_at";

/** `GET /v1/dev/runs` — recent runs, safe projections, keyset cursor `(created_at,id)`. */
function devRunsList(
  db: Database,
  q: { session?: string; limit: number; after?: string },
): Response {
  const limit = Math.min(Math.max(1, q.limit), 200);
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (q.session) {
    clauses.push("session_id = ?");
    args.push(q.session);
  }
  if (q.after) {
    const [ca, id] = q.after.split(",");
    clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    args.push(Number(ca), Number(ca), id ?? "");
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .query(`SELECT ${RUN_LIST_COLS} FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args, limit) as RunRow[];
  const last = rows[rows.length - 1];
  return json({
    runs: rows.map(projectRun),
    ...(rows.length === limit && last ? { next: `${last.created_at},${last.id}` } : {}),
  });
}

/** `GET /v1/dev/runs/:id` — the projection plus the redacted journal + transcript
 *  (this is what backs a tool card's expand; live event payloads stay lean). */
function devRunDetail(db: Database, id: string): Response {
  const r = db.query(`SELECT ${RUN_LIST_COLS} FROM runs WHERE id = ?`).get(id) as RunRow | null;
  if (!r) return json({ error: { message: "no such run" } }, 404);
  const journal = (
    db
      .query(
        "SELECT tool, call_id, args, status, result, created_at, finished_at FROM journal WHERE run_id = ? ORDER BY created_at, call_id",
      )
      .all(id) as {
      tool: string;
      call_id: string;
      args: string;
      status: string;
      result: string | null;
      created_at: number;
      finished_at: number | null;
    }[]
  ).map((j) => ({
    tool: j.tool,
    call_id: j.call_id,
    status: j.status,
    args: redactSecrets(safeParse(j.args) ?? j.args),
    result: j.result ? redactSecrets(safeParse(j.result) ?? j.result) : null,
    is_error: typeof j.result === "string" && j.result.startsWith("[tool error]"),
    ms: j.finished_at ? j.finished_at - j.created_at : null,
  }));
  const transcript = (
    db.query("SELECT msg FROM messages WHERE run_id = ? ORDER BY id").all(id) as { msg: string }[]
  ).map(({ msg }) => {
    const m = safeParse<{
      role: string;
      content?: unknown;
      tool_calls?: { id: string; function?: { name?: string } }[];
      tool_call_id?: string;
    }>(msg);
    if (!m) return { role: "unknown" };
    const out: Record<string, unknown> = { role: m.role };
    // A `tool`-role message's content is a raw tool RESULT — the same payload the
    // journal redacts. Redact it here too, or a secret the tool returned would leak
    // through the transcript that the journal already scrubbed.
    if (m.role === "tool" && typeof m.content === "string")
      out.content = redactSecrets(safeParse(m.content) ?? m.content);
    else if (typeof m.content === "string") out.content = m.content;
    // Strip image bytes from multi-part user content — keep text, placeholder the rest.
    else if (Array.isArray(m.content))
      out.content = m.content.map((p) =>
        p && typeof p === "object" && (p as { type?: string }).type === "text"
          ? p
          : { type: (p as { type?: string })?.type ?? "part" },
      );
    if (m.tool_calls)
      out.tool_calls = m.tool_calls.map((tc) => ({ id: tc.id, name: tc.function?.name }));
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
  // The user's input, in full. It lives in `runs.request` from the instant of enqueue —
  // whereas the `messages` transcript above is only written once the run DEQUEUES and
  // executes. A queued run therefore has an empty transcript but a known input, so the
  // Cockpit sources the user bubble from here as a fallback (a queued message must still
  // display). Same field `projectRun` already slices into `last_input_preview`, so no new
  // surface is exposed — string inputs only (multimodal parts stay in the transcript path).
  const reqInput = safeParse<{ input?: unknown }>(r.request)?.input;
  const input = typeof reqInput === "string" ? reqInput : null;
  return json({ ...projectRun(r), input, journal, transcript });
}

/** `GET /v1/dev/runs/:id/calls` — the true-to-life per-model-call snapshots (the `calls`
 *  capture, dev-only). Each is the EXACT assembled request the model saw — system spine
 *  + full message list + tool schemas — paired with the response. Redacted on the read
 *  path (raw on disk stays true), like the journal/transcript. Empty if capture was off. */
function devRunCalls(db: Database, id: string): Response {
  let rows: { turn: number; request: string; response: string; created_at: number }[] = [];
  try {
    rows = db
      .query(
        "SELECT turn, request, response, created_at FROM calls WHERE run_id = ? ORDER BY turn, id",
      )
      .all(id) as typeof rows;
  } catch {
    // `calls` table absent (older DB / capture never migrated) → just no calls.
    return json({ calls: [] });
  }
  const calls = rows.map((r) => ({
    turn: r.turn,
    created_at: r.created_at,
    request: redactSecrets(safeParse(r.request) ?? {}),
    response: redactSecrets(safeParse(r.response) ?? {}),
  }));
  return json({ calls });
}

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB body cap (spec §4.5)
// Raw-serve cap (`?raw=1`, the byte path behind inline previews + downloads). Higher
// than the text cap — a screenshot or a scanned résumé the agent handled is easily a
// few MB — but still bounded so a huge file can't balloon the daemon's memory.
const MAX_RAW_BYTES = 10 * 1024 * 1024;
// The ONLY mimes a `?raw=1` response will hand back with their real content-type, so the
// browser renders them in place. Everything else is forced to octet-stream + attachment,
// which means agent-authored HTML/SVG can never execute script in the Cockpit's origin.
// (Images can't script; the PDF viewer can't reach the parent frame.)
const INLINE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);
// Credential-bearing files that sit inside the workspace root but must never be
// served: `delta dev`'s workspace IS the project dir, which holds `delta.env`
// (API keys). Matches .env / delta.env / foo.env / .env.local etc. (codex P1).
const SENSITIVE_FILE = /\.env(\.[^/\\]*)?$/i;

/** `GET /v1/dev/files` — two namespaces (`workspace/<rel>`, `operator/<name>`),
 *  both realpath-sandboxed under the workspace root. Symlink/`..`/absolute escape
 *  → 403; missing → 404 (spec §4.5). */
function devFiles(
  workspace: string | undefined,
  pathParam: string,
  operatorFiles: string[],
  raw = false,
): Response {
  if (!workspace) return json({ error: { message: "no workspace" } }, 404);
  let root: string;
  try {
    root = realpathSync(workspace);
  } catch {
    return json({ error: { message: "no workspace" } }, 404);
  }

  // Resolve the namespace to a concrete target under the workspace root.
  let target: string;
  if (pathParam === "workspace" || pathParam === "workspace/") {
    target = root;
  } else if (pathParam.startsWith("workspace/")) {
    const rel = pathParam.slice("workspace/".length);
    if (isAbsolute(rel) || rel.split(/[\\/]/).includes(".."))
      return json({ error: { message: "path escapes the sandbox" } }, 403);
    target = resolve(root, rel);
  } else if (pathParam.startsWith("operator/")) {
    const name = pathParam.slice("operator/".length);
    // Exact-name allowlist — no arbitrary steering path, no directory traversal.
    if (name.includes("/") || name.includes("\\") || !operatorFiles.includes(name))
      return json({ error: { message: "not an operator file" } }, 403);
    target = resolve(root, name);
  } else {
    return json({ error: { message: "path must start with workspace/ or operator/" } }, 400);
  }

  // realpath the target: this follows symlinks along the WHOLE path, so an escape
  // via a symlinked segment lands outside `root` and is rejected by containment.
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return json({ error: { message: "not found" } }, 404);
  }
  if (real !== root && !real.startsWith(root + sep))
    return json({ error: { message: "path escapes the sandbox" } }, 403);
  // Belt-and-braces: reject a leaf that is itself a symlink (spec: reject symlink segments).
  try {
    if (lstatSync(target).isSymbolicLink())
      return json({ error: { message: "symlinks are not served" } }, 403);
  } catch {}

  const st = statSync(real);
  if (st.isDirectory()) {
    if (raw) return json({ error: { message: "not a file" } }, 400);
    const entries = readdirSync(real, { withFileTypes: true }).flatMap((e) => {
      const full = join(real, e.name);
      let ls: ReturnType<typeof lstatSync>;
      try {
        ls = lstatSync(full);
      } catch {
        return [];
      }
      if (ls.isSymbolicLink()) return []; // skip symlink entries (spec §4.5)
      if (SENSITIVE_FILE.test(e.name)) return []; // never list credential env files
      // `.delta/` is the daemon's own state dir (db/wal/shm under `delta dev`), not the
      // agent's files — hide it so the Files view is purely the workspace. Inspect the db
      // via the Data tab instead. (In prod, state lives outside the workspace entirely.)
      if (real === root && e.name === ".delta") return [];
      return [
        { name: e.name, type: e.isDirectory() ? "dir" : "file", size: ls.size, mtime: ls.mtimeMs },
      ];
    });
    return json({ type: "dir", path: pathParam, entries });
  }
  if (SENSITIVE_FILE.test(basename(real))) return json({ error: { message: "not served" } }, 403);
  // TOCTOU-safe read: open the resolved path WITHOUT following a symlink (so a
  // concurrent writer can't swap the leaf for a link between realpath and open),
  // then size + read through the fd — never a re-open by name (codex P1).
  // Residual race (accepted): O_NOFOLLOW only guards the leaf, so an ancestor dir swapped
  // to a symlink between realpath and open could still escape. Closing it needs per-
  // component openat/openat2, which Bun doesn't expose. In Delta's model the daemon runs
  // as the SAME uid as the agent's own tools, so a raced read reaches nothing the agent's
  // bash can't already read directly — no privilege boundary is crossed. Revisit if a
  // deployment ever sandboxes agent tools below the daemon.
  let fd: number;
  try {
    fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return json({ error: { message: "not found" } }, 404);
  }
  try {
    const fst = fstatSync(fd);
    // Reject a hard-linked file: an innocent-named workspace file hard-linked to
    // delta.env would slip past the basename check and leak its bytes (codex P1, read side).
    if (fst.nlink > 1)
      return json({ error: { message: "refusing to read a hard-linked file" } }, 403);
    const cap = raw ? MAX_RAW_BYTES : MAX_FILE_BYTES;
    const meta = { path: pathParam, size: fst.size, mtime: fst.mtimeMs };
    if (fst.size > cap) {
      if (raw) return json({ error: { message: "file too large to serve" } }, 413);
      // Still classify a too-big-to-inline file from its head, so the UI can show
      // "image · 3.2 MB — download" instead of an anonymous "too large".
      return json({ type: "file", ...meta, mime: sniffHead(fd, basename(real)), truncated: true });
    }
    const buf = Buffer.alloc(fst.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    const body = buf.subarray(0, off);
    const mime = sniffMime(body, basename(real));
    if (raw) {
      const inline = INLINE_MIME.has(mime);
      // A quote/newline in the name would break out of the header — neutralize it.
      const dispName = basename(real).replace(/[\r\n"\\]/g, "_");
      const headers: Record<string, string> = {
        "content-type": inline ? mime : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${dispName}"`,
        // Trust our sniff, never the browser's — no content-type upgrade. Combined with
        // the octet-stream+attachment fallback above, this is what keeps agent-authored
        // HTML/SVG inert: it can never come back with a script-executing content-type.
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      };
      // Lock images down to zero subresources (belt-and-braces; an image can't script
      // anyway). NOT on the PDF — the browser's built-in viewer needs to load its own
      // machinery, which `default-src 'none'` would block, leaving a blank frame. A PDF
      // can carry active content, so the UI embeds it in a `sandbox`ed iframe (no script
      // context, no same-origin) rather than relying on the response headers alone.
      if (mime.startsWith("image/")) headers["content-security-policy"] = "default-src 'none'";
      return new Response(body, { headers });
    }
    if (mime === "text/plain")
      return json({ type: "file", ...meta, mime, content: body.toString("utf8") });
    // Binary (image, pdf, archive, …): hand back the metadata + mime; the UI fetches
    // the bytes over `?raw=1` only for the formats it can render.
    return json({ type: "file", ...meta, mime, binary: true });
  } finally {
    closeSync(fd);
  }
}

/** Read just the head of an already-open fd to classify a file too large to inline. */
function sniffHead(fd: number, name: string): string {
  const head = Buffer.alloc(4096);
  let off = 0;
  while (off < head.length) {
    const n = readSync(fd, head, off, head.length - off, off);
    if (n <= 0) break;
    off += n;
  }
  return sniffMime(head.subarray(0, off), name);
}

/** `PUT /v1/dev/files` — write-through operator/workspace-file editing (opt-in). Same
 *  sandbox as the read path: operator-name allowlist or `workspace/<rel>`, no env files,
 *  no symlink follow, parent must be contained. Writes bytes; NO reload (restart applies). */
function devFilesWrite(
  workspace: string | undefined,
  pathParam: string,
  operatorFiles: string[],
  body: Uint8Array,
): Response {
  if (!workspace) return json({ error: { message: "no workspace" } }, 404);
  let root: string;
  try {
    root = realpathSync(workspace);
  } catch {
    return json({ error: { message: "no workspace" } }, 404);
  }
  let target: string;
  if (pathParam.startsWith("operator/")) {
    const name = pathParam.slice("operator/".length);
    if (name.includes("/") || name.includes("\\") || !operatorFiles.includes(name))
      return json({ error: { message: "not an operator file" } }, 403);
    target = resolve(root, name);
  } else if (pathParam.startsWith("workspace/")) {
    const rel = pathParam.slice("workspace/".length);
    if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes(".."))
      return json({ error: { message: "path escapes the sandbox" } }, 403);
    target = resolve(root, rel);
  } else {
    return json({ error: { message: "path must start with operator/ or workspace/" } }, 400);
  }
  if (SENSITIVE_FILE.test(basename(target)))
    return json({ error: { message: "not writable" } }, 403);
  // The file may not exist yet — realpath the PARENT and require IT contained.
  let realParent: string;
  try {
    realParent = realpathSync(dirname(target));
  } catch {
    return json({ error: { message: "parent directory does not exist" } }, 404);
  }
  if (realParent !== root && !realParent.startsWith(root + sep))
    return json({ error: { message: "path escapes the sandbox" } }, 403);
  const dest = join(realParent, basename(target));
  let fd: number;
  try {
    // O_NOFOLLOW: refuse to write THROUGH a symlink. NOT O_TRUNC yet — we must fstat the
    // opened inode FIRST and reject a hard-linked file (nlink > 1), because a workspace
    // file hard-linked to delta.env would otherwise be truncated + overwritten through the
    // link (O_NOFOLLOW only stops symlinks, not hard links — codex P1).
    fd = openSync(dest, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  } catch {
    return json({ error: { message: "could not open the file for writing" } }, 400);
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) return json({ error: { message: "not a regular file" } }, 403);
    if (fst.nlink > 1)
      return json({ error: { message: "refusing to write a hard-linked file" } }, 403);
    ftruncateSync(fd, 0); // safe now that the inode is confirmed a single-linked regular file
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return json({
    ok: true,
    path: pathParam,
    bytes: body.length,
    note: "saved to disk — restart the daemon to apply (no hot-reload, so dev stays equal to prod)",
  });
}

// Raw-peek allowlist (fast-follow). Fixed table names + column lists — NEVER interpolate
// a user-supplied identifier. String cells run through the free-text scrubber so a secret
// that landed in memory.content / meta.value / a payload can't surface. Tables that hold
// the raw run request or wire messages are deliberately absent (use /v1/dev/runs).
const PEEK_TABLES: Record<string, { cols: string[]; order: string }> = {
  sessions: { cols: ["id", "user_id", "created_at", "updated_at"], order: "created_at DESC, id" },
  memory: {
    cols: [
      "id",
      "namespace",
      "agent_id",
      "user_id",
      "audience",
      "task_type",
      "artifact_kind",
      "content",
      "trust",
      "source",
      "confidence",
      "hits",
      "last_used",
      "created_at",
    ],
    order: "id DESC",
  },
  memory_occurrence: { cols: ["memory_id", "run_id", "created_at"], order: "created_at DESC" },
  promotion: {
    cols: [
      "id",
      "memory_id",
      "namespace",
      "destination_role",
      "artifact_kind",
      "name",
      "content",
      "lifecycle",
      "attempts",
      "last_error",
      "created_at",
    ],
    order: "id DESC",
  },
  events: { cols: ["id", "ts", "type", "session_id", "run_id", "turn"], order: "id DESC" },
  meta: { cols: ["key", "value"], order: "key" },
  lease: {
    cols: ["name", "holder_id", "acquired_at", "expires_at", "heartbeat_at"],
    order: "name",
  },
};

/** `GET /v1/dev/tables` — the peekable tables + row counts. */
function devTablesList(db: Database): Response {
  const tables = Object.keys(PEEK_TABLES).map((name) => {
    let rows = 0;
    try {
      rows = (db.query(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n;
    } catch {}
    return { name, rows };
  });
  return json({ tables });
}

// `meta` is a generic key/value store — a future writer could stash a raw credential
// under some key, which no shape-scrubber would catch. So its `value` is shown ONLY for
// these known-safe keys; everything else is hidden (allowlist, per the config §4.6 rule).
const META_SAFE_KEYS = new Set(["daemon_id", "harness_version", "schema_version"]);

/** `GET /v1/dev/tables/:name?ack=root` — newest-first rows, fixed projection, string
 *  cells scrubbed. Capped LIMIT only (no cursor — a peek is a peek; use /runs for depth). */
function devTablePeek(db: Database, name: string, limit: number): Response {
  // Own-property only — `PEEK_TABLES["constructor"]` would otherwise resolve an inherited
  // function and slip past the allowlist before throwing on spec.cols (codex P2).
  if (!Object.hasOwn(PEEK_TABLES, name))
    return json({ error: { message: "table is not peekable" } }, 404);
  const spec = PEEK_TABLES[name] as { cols: string[]; order: string };
  const lim = Math.min(Math.max(1, limit), 500);
  const rows = db
    .query(`SELECT ${spec.cols.join(", ")} FROM ${name} ORDER BY ${spec.order} LIMIT ?`)
    .all(lim) as Record<string, unknown>[];
  const rowsOut = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      // meta.value: only known-safe keys pass; the rest are hidden, not shape-guessed.
      if (name === "meta" && k === "value" && !META_SAFE_KEYS.has(String(r.key)))
        out[k] = "[hidden]";
      else out[k] = typeof v === "string" ? scrubText(v) : v;
    }
    return out;
  });
  return json({ table: name, cols: spec.cols, rows: rowsOut });
}

type EventRow = {
  id: number;
  ts: number;
  type: string;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  run_id: string | null;
  task_id: string | null;
  entity_id: string | null;
  turn: number | null;
  data: string;
};

function rowToEvent(r: EventRow): DeltaEvent {
  return {
    id: r.id,
    ts: r.ts,
    type: r.type,
    ...(r.user_id ? { userId: r.user_id } : {}),
    ...(r.agent_id ? { agentId: r.agent_id } : {}),
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    ...(r.run_id ? { runId: r.run_id } : {}),
    ...(r.task_id ? { taskId: r.task_id } : {}),
    ...(r.entity_id ? { entityId: r.entity_id } : {}),
    ...(r.turn != null ? { turn: r.turn } : {}),
    data: safeParse<Record<string, unknown>>(r.data) ?? {},
  };
}

/** `GET /v1/dev/stream` — replay + live in one code path (spec §4.3). Reuses the
 *  daemon-wide Events bus (no module-global state); carries the full envelope so a
 *  client can demux interleaved runs and resume by `id`. Backfill→live race is
 *  closed by subscribe-into-buffer → backfill ≤ highWater → flush > highWater;
 *  backpressure drops only ephemeral frames (recoverable is not required). */
function streamDev(
  db: Database,
  events: Events,
  q: { since: number; run?: string; session?: string; live: boolean },
): Response {
  const encoder = new TextEncoder();
  // Terminate a connection that falls this many frames behind even on persisted
  // frames (on top of the 512 highWaterMark) — bounds memory; the client resumes
  // by cursor (codex P2).
  const HARD_CAP = 2048;
  const { since, run, session, live } = q;
  const match = (e: DeltaEvent) =>
    (!run || e.runId === run) && (!session || e.sessionId === session);
  const envelope = (e: DeltaEvent) => ({
    id: e.id < 0 ? null : e.id,
    type: e.type,
    ts: e.ts,
    run_id: e.runId ?? null,
    session_id: e.sessionId ?? null,
    turn: e.turn ?? null,
    data: e.data,
  });
  let teardown = () => {};
  const stream = new ReadableStream(
    {
      start(controller) {
        let closed = false;
        let buffering = true;
        let dedupe = true;
        const buffered: DeltaEvent[] = [];
        const seen = new Set<number>();

        const write = (e: DeltaEvent) => {
          if (closed) return;
          // Backpressure: a slow/abandoned reader must never grow memory unbounded
          // or stall the run loop. Under mild pressure, drop ephemerals (a live
          // nicety). Persisted frames are never *dropped* (a gap would be silent) —
          // but if the consumer falls a hard cap behind even on persisted frames,
          // TERMINATE the connection so memory stays bounded; the client reconnects
          // with `since=<last id>` and resumes without loss (codex P2).
          const ds = controller.desiredSize ?? 1;
          if (ds <= -HARD_CAP) return cleanup(true);
          if (e.id < 0 && ds <= 0) return; // ephemeral drop under mild pressure
          controller.enqueue(
            encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(envelope(e))}\n\n`),
          );
        };
        const emit = (e: DeltaEvent) => {
          if (!match(e)) return;
          if (dedupe && e.id >= 0) {
            if (seen.has(e.id)) return;
            seen.add(e.id);
          }
          write(e);
        };

        const heartbeat = setInterval(() => {
          // The heartbeat also respects pressure — a stalled reader shouldn't keep
          // accumulating pings either (codex P2).
          if (!closed && (controller.desiredSize ?? 1) > 0)
            controller.enqueue(encoder.encode(": ping\n\n"));
        }, 15_000);
        heartbeat.unref?.();
        const cleanup = (close: boolean) => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          off();
          if (close) {
            try {
              controller.close();
            } catch {}
          }
        };
        teardown = () => cleanup(false);

        // (1) Subscribe FIRST, into a buffer — nothing emitted between the SELECT and
        // the switch can be lost. (JS is single-threaded, so start() runs to completion
        // before any emit fires; the buffer is belt-and-braces for correctness.)
        const off = events.on((e: DeltaEvent) => {
          if (closed) return;
          if (buffering) {
            buffered.push(e);
            return;
          }
          emit(e);
          if (run && e.type === "run.finished" && e.runId === run) cleanup(true);
        });

        // (2) Backfill persisted rows since<id≤highWater, filtered, in id order.
        const highWater =
          (db.query("SELECT max(id) AS h FROM events").get() as { h: number | null }).h ?? 0;
        const clauses = ["id > ?", "id <= ?"];
        const args: (string | number)[] = [since, highWater];
        if (run) {
          clauses.push("run_id = ?");
          args.push(run);
        }
        if (session) {
          clauses.push("session_id = ?");
          args.push(session);
        }
        const rows = db
          .query(
            `SELECT id, ts, type, user_id, agent_id, session_id, run_id, task_id, entity_id, turn, data
             FROM events WHERE ${clauses.join(" AND ")} ORDER BY id`,
          )
          .all(...args) as EventRow[];
        for (const row of rows) {
          const e = rowToEvent(row);
          seen.add(e.id);
          write(e); // SQL already applied the filter
        }

        // (3) Flush the buffer, keeping only id>highWater (or ephemerals), deduped.
        buffering = false;
        for (const e of buffered) {
          if (e.id >= 0 && e.id <= highWater) continue; // already backfilled
          emit(e);
        }
        buffered.length = 0;
        // Steady state: new live events have strictly increasing ids beyond highWater
        // and were never backfilled — dedup is no longer needed, so drop it to keep
        // `seen` from growing without bound on a long-lived global follow.
        dedupe = false;
        seen.clear();

        // (4) Replay-only, or a run that already finished → close; else stay live.
        if (!live) return cleanup(true);
        if (run) {
          const rr = db.query("SELECT status FROM runs WHERE id = ?").get(run) as {
            status: string;
          } | null;
          if (rr && rr.status !== "queued" && rr.status !== "running") return cleanup(true);
        }
      },
      cancel() {
        teardown();
      },
    },
    { highWaterMark: 512 },
  );
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
