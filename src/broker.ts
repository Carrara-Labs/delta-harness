// SPDX-License-Identifier: Apache-2.0
// Subscription-token consumer (spec §C, architecture "Providers subscription-first").
// The OpenAI-subscription path doesn't use a static key: an external control
// plane's broker owns a rotating refresh token and vends a short-lived access
// token from `GET /api/broker/openai-token` → { accessToken, accountId, planType,
// expiresAt }. Delta mints one, caches it until just before expiry, and presents
// it as the bearer plus the `chatgpt-account-id` header the ChatGPT/Codex backend
// requires. Delta never sees the refresh token — multi-agent-on-one-sub stays
// solved control-plane-side.

/** What the provider needs each call: a bearer + any extra headers. Static keys
 * and broker-minted subscription tokens both satisfy this. */
export interface Credential {
  get(): Promise<{ token: string; headers?: Record<string, string> }>;
  /** Drop any cached token so the NEXT get() re-fetches. Called after the backend
   * rejects the current token (401/403): our cache would otherwise keep serving the
   * dead token until its claimed expiry, never picking up the broker's refreshed one.
   * A static key has nothing to invalidate (optional). */
  invalidate?(): void;
  /** Cool this credential down for `ms` after a 429, so a shared subscription identity
   * isn't re-hit while throttled — get() reports no servable token during the window and
   * the cascade rides the metered fallback. No-op for a static key (optional). */
  penalize?(ms: number): void;
}

type MintResponse = {
  accessToken: string;
  accountId?: string | null;
  planType?: string | null;
  expiresAt?: string; // ISO
};

const REFRESH_SKEW_MS = 5 * 60_000; // re-mint 5 min before expiry

/** The broker has no unexpired subscription token right now (409). Distinct so a
 * caller can fall back to the metered OpenRouter chain instead of hard-failing —
 * exactly what the keep-alive poll does control-plane-side. */
export class NoServableToken extends Error {
  constructor() {
    super("broker has no servable subscription token (409) — fall back to metered provider");
  }
}

/** The broker mint endpoint returned a non-409 error status (e.g. 401 gateway-token rejected,
 * 429 mint throttled, 5xx). Carries the status so the provider can classify it as a
 * credential-wide failure and fail over immediately instead of re-minting once per model. */
export class BrokerMintError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`broker mint ${status}: ${body.slice(0, 300)}`);
  }
}

export class BrokerCredential implements Credential {
  private cached: { token: string; accountId: string | null; expiresAt: number } | null = null;
  private inflight: Promise<void> | null = null;
  private cooldownUntil = 0;

  constructor(
    private mintUrl: string,
    /** Bearer for the mint endpoint itself (the machine's gateway token). */
    private mintAuth?: string,
    private accountHeader = "chatgpt-account-id",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  /** After a 429, skip the subscription for `ms` (capped) so the shared identity gets
   * a rest and the cascade rides the metered fallback. */
  penalize(ms: number): void {
    this.cooldownUntil = Math.max(
      this.cooldownUntil,
      Date.now() + Math.min(Math.max(ms, 0), 5 * 60_000),
    );
  }

  async get(): Promise<{ token: string; headers?: Record<string, string> }> {
    // In a post-429 cooldown, report no servable token so the cascade fails over without
    // re-hitting the throttled subscription identity (H4).
    if (Date.now() < this.cooldownUntil) throw new NoServableToken();
    if (!this.cached || this.cached.expiresAt - Date.now() < REFRESH_SKEW_MS) {
      // Coalesce concurrent misses onto one mint call (many turns, one token).
      this.inflight ??= this.mint().finally(() => {
        this.inflight = null;
      });
      await this.inflight;
    }
    // Re-check the cooldown AFTER awaiting: a concurrent turn's 429 may have penalized us while
    // this call sat on the inflight mint (codex P2). The account header is mandatory for the
    // Codex backend, so a cached token without one is unusable (mint() already rejects those).
    if (Date.now() < this.cooldownUntil) throw new NoServableToken();
    const c = this.cached;
    if (!c) throw new Error("broker mint produced no token");
    return {
      token: c.token,
      ...(c.accountId ? { headers: { [this.accountHeader]: c.accountId } } : {}),
    };
  }

  /** Post-401/403 recovery: drop the cached token so the next get() re-mints (and
   * picks up whatever the broker's refresh ticker has rotated to). */
  invalidate(): void {
    this.cached = null;
  }

  private async mint(): Promise<void> {
    const res = await this.fetchImpl(this.mintUrl, {
      headers: this.mintAuth ? { authorization: `Bearer ${this.mintAuth}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 409) throw new NoServableToken();
    if (!res.ok) {
      // Carry the status so the provider treats a broker auth/rate failure as credential-wide
      // (fail over now) rather than a generic error re-tried once per model (codex P1).
      throw new BrokerMintError(res.status, await res.text().catch(() => ""));
    }
    const data = (await res.json()) as MintResponse;
    // Validate the mint payload's runtime types — a broker bug must fail over cleanly, never
    // cache a malformed token. accessToken AND accountId are both mandatory: the Codex backend
    // rejects a request missing the chatgpt-account-id header, so a token without an account is
    // unusable. Treat any of these as "no servable token".
    if (typeof data.accessToken !== "string" || !data.accessToken) {
      this.cached = null;
      throw new NoServableToken();
    }
    if (typeof data.accountId !== "string" || !data.accountId) {
      this.cached = null;
      throw new NoServableToken();
    }
    // An already-expired, near-expiry, or unparseable-expiry token is UNUSABLE: caching it would
    // serve a token that 401s mid-call (codex H1). The control-plane broker always sends a real ISO
    // expiresAt, so a missing/bad one is a broker fault — same handling: fail over to metered.
    const parsed = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed - Date.now() <= REFRESH_SKEW_MS) {
      this.cached = null;
      throw new NoServableToken();
    }
    this.cached = { token: data.accessToken, accountId: data.accountId, expiresAt: parsed };
  }
}

/** A static-key credential (OpenRouter / any keyed OpenAI-compatible endpoint). */
export class StaticCredential implements Credential {
  constructor(private apiKey: string) {}
  async get(): Promise<{ token: string }> {
    return { token: this.apiKey };
  }
}
