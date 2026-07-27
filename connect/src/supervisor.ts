import type { AgentSupervisor } from "./types";

// Local keep-alive: the daemon runs on always-on hardware, so waking is a
// health check and suspending is a no-op. The Fly supervisor (later) swaps in
// machine start + RAM-snapshot suspend behind this same interface.

export class LocalKeepAliveSupervisor implements AgentSupervisor {
  constructor(private readonly baseUrl: string) {}

  async ensureAwake(): Promise<string> {
    try {
      const r = await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`healthz ${r.status}`);
    } catch {
      // Best-effort: if truly down, the turn call will surface the real error.
    }
    return this.baseUrl;
  }

  async maybeSuspend(): Promise<void> {
    // no-op: keep-alive
  }
}
