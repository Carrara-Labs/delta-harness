// SPDX-License-Identifier: Apache-2.0
// Refreshing MCP-server credential (spec §E / G6b). Production MCP-server auth is an
// entity-scoped OAuth agent principal with a ONE-SHOT rotating refresh token:
// each use mints a new access token AND a new refresh token, invalidating the old
// one — reusing a spent refresh token trips reuse-detection and revokes the whole
// agent family. So the two rules are absolute:
//   1. persist the rotated refresh token the INSTANT it arrives, before using the
//      access token — a crash after that resumes on the new token, never the spent
//      one (idempotent across restarts);
//   2. coalesce concurrent refreshes onto ONE call — many turns, one rotation —
//      so a refresh token is never double-spent.
// Storage-agnostic: the caller supplies load/save (a file on the VM, seeded from
// the Fly secret). Built + tested ONLY against a mock OAuth endpoint.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface RefreshingCredential {
  /** The current access token — mints/rotates transparently when stale. */
  get(): Promise<string>;
  /** Force a rotation (the MCP client calls this on a 401). */
  refresh(): Promise<void>;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string; // the rotated token — one-shot, must be persisted
  expires_in?: number; // seconds
};

const REFRESH_SKEW_MS = 60_000; // rotate a minute before expiry

export class RefreshingMcpCredential implements RefreshingCredential {
  private access: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private opts: {
      /** OAuth token endpoint (mint access from refresh; rotation-on-use). */
      tokenUrl: string;
      /** OAuth client_id — REQUIRED by the MCP-server endpoint (a missing one → 400
       * invalid_request). The Delta agent principal authenticates as `delta-agent`. */
      clientId: string;
      /** Read the persisted refresh token (null → not provisioned). */
      loadRefresh: () => string | null;
      /** Persist the rotated refresh token. MUST be durable before we proceed. */
      saveRefresh: (token: string) => void;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async get(): Promise<string> {
    if (!this.access || this.access.expiresAt - Date.now() < REFRESH_SKEW_MS) await this.rotate();
    if (!this.access) throw new Error("MCP-server auth: no access token after rotate");
    return this.access.token;
  }

  async refresh(): Promise<void> {
    this.access = null; // force a real rotation on the next get/this call
    await this.rotate();
  }

  /** One rotation at a time: concurrent callers await the same inflight promise, so
   * a one-shot refresh token is spent exactly once (never double-spent). */
  private rotate(): Promise<void> {
    this.inflight ??= this.doRotate().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRotate(): Promise<void> {
    const refresh = this.opts.loadRefresh();
    if (!refresh) throw new Error("MCP-server auth: no refresh token provisioned");
    // The MCP-server endpoint is OAuth-standard: an application/x-www-form-urlencoded body
    // (NOT JSON) with a REQUIRED client_id — a JSON body or missing client_id → 400.
    // No `resource`/`audience` param (an explicit one that mismatches the principal's
    // audience → invalid_target; omitting it lets the endpoint use the token's own).
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: this.opts.clientId,
    });
    const res = await (this.opts.fetchImpl ?? fetch)(this.opts.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`MCP-server token refresh ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as TokenResponse;
    // RULE 1 — persist the rotated token FIRST. Once the server responded, the old
    // token is already spent; the new one must survive even if we crash right here.
    if (data.refresh_token && data.refresh_token !== refresh) {
      this.opts.saveRefresh(data.refresh_token);
    }
    if (!data.access_token) throw new Error("MCP-server token refresh returned no access_token");
    const ttl = typeof data.expires_in === "number" ? data.expires_in * 1000 : 10 * 60_000;
    this.access = { token: data.access_token, expiresAt: Date.now() + ttl };
  }
}

/** File-backed persistence for the rotating refresh token (spec §E / G6a wiring):
 * seed the file from the Fly secret on FIRST boot only, then rotations land in the
 * file (Fly secrets are immutable at runtime, so the rotating token can't live
 * there). One-shot safety (codex P1): once the file exists it is authoritative and
 * the seed is NEVER reused — reusing a spent seed after a rotation would revoke the
 * whole agent family. Writes are atomic (temp + rename) so a crash can't leave a
 * torn token file that strands the family.
 *
 * NOTE (codex P1, cross-process): this coalesces a single writer only. Multiple
 * daemons/machines sharing one refresh token would still race — production MUST
 * provision a per-machine principal (G6a), one writer per token. */
export function fileRefreshStore(
  path: string,
  seed?: string,
): {
  loadRefresh: () => string | null;
  saveRefresh: (token: string) => void;
} {
  return {
    loadRefresh: () => {
      // If the file exists, its content is authoritative — an empty/corrupt file
      // returns null so refresh fails LOUDLY rather than falling back to a spent seed.
      if (existsSync(path)) {
        try {
          return readFileSync(path, "utf8").trim() || null;
        } catch {
          return null;
        }
      }
      return seed || null; // no file yet → first boot uses the Fly-secret seed
    },
    saveRefresh: (token: string) => {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, token, { mode: 0o600 });
      renameSync(tmp, path); // atomic swap — never a partially-written token file
    },
  };
}
