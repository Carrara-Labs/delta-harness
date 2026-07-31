import type { AgentSupervisor, OperationResult } from "./types";

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

  async restart(_safeMode: boolean): Promise<OperationResult> {
    return { ok: false, error: "daemon is externally managed" };
  }

  async shutdown(): Promise<OperationResult> {
    return { ok: true };
  }
}

type ManagedOptions = {
  bootFailures?: number;
  healthTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollMs?: number;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
};

/** Opt-in process owner for the bundled one-machine deployment. */
export class ManagedProcessSupervisor implements AgentSupervisor {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private inFlight: Promise<OperationResult> | null = null;
  private failures = 0;
  private readonly maxFailures: number;
  private readonly healthTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pollMs: number;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly log: (message: string) => void;

  constructor(
    private readonly baseUrl: string,
    private readonly entry: string,
    opts: ManagedOptions = {},
  ) {
    this.maxFailures = Math.max(1, opts.bootFailures ?? 3);
    this.healthTimeoutMs = Math.max(100, opts.healthTimeoutMs ?? 30_000);
    this.stopTimeoutMs = Math.max(100, opts.stopTimeoutMs ?? 5_000);
    this.pollMs = Math.max(10, opts.pollMs ?? 250);
    this.baseEnv = { ...(opts.env ?? process.env) };
    this.log = opts.log ?? (() => {});
  }

  async start(): Promise<OperationResult> {
    return this.serialized(() => this.bootWithFallback());
  }

  async ensureAwake(): Promise<string> {
    if (!(await this.healthy())) {
      const result = await this.start();
      if (!result.ok) this.log(`managed daemon unavailable: ${result.error ?? "boot failed"}`);
    }
    return this.baseUrl;
  }

  async maybeSuspend(): Promise<void> {
    // no-op: this local child stays awake
  }

  async restart(safeMode: boolean): Promise<OperationResult> {
    return this.serialized(async () => {
      await this.stopChild();
      return safeMode ? this.bootOnce(true) : this.bootWithFallback();
    });
  }

  async shutdown(): Promise<OperationResult> {
    if (this.inFlight) await this.inFlight;
    return this.serialized(async () => {
      await this.stopChild();
      return { ok: true };
    });
  }

  private serialized(run: () => Promise<OperationResult>): Promise<OperationResult> {
    if (this.inFlight) return this.inFlight;
    const pending = run()
      .catch((error) => ({ ok: false, error: String(error) }))
      .finally(() => {
        if (this.inFlight === pending) this.inFlight = null;
      });
    this.inFlight = pending;
    return pending;
  }

  private async bootWithFallback(): Promise<OperationResult> {
    while (this.failures < this.maxFailures) {
      const result = await this.bootOnce(false);
      if (result.ok) return result;
    }
    this.log(`${this.failures} normal boots failed; attempting safe mode`);
    const safe = await this.bootOnce(true);
    return safe.ok
      ? safe
      : { ok: false, error: `safe-mode boot failed: ${safe.error ?? "unknown"}` };
  }

  private async bootOnce(safeMode: boolean): Promise<OperationResult> {
    await this.stopChild();
    try {
      const env = { ...this.baseEnv };
      if (safeMode) env.DELTA_SAFE_MODE = "1";
      this.child = Bun.spawn([process.execPath, this.entry], {
        env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (error) {
      if (!safeMode) this.failures++;
      return { ok: false, error: String(error) };
    }

    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.child || this.child.exitCode !== null) break;
      if (await this.healthy()) {
        this.failures = 0;
        return { ok: true, note: safeMode ? "daemon started in safe mode" : "daemon restarted" };
      }
      await Bun.sleep(this.pollMs);
    }
    const exit = this.child?.exitCode;
    await this.stopChild();
    if (!safeMode) this.failures++;
    return {
      ok: false,
      error: exit === null ? "health check timed out" : `daemon exited with code ${exit}`,
    };
  }

  private async healthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(Math.min(3000, this.healthTimeoutMs)),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(this.stopTimeoutMs).then(() => false),
      ]);
      if (!exited && child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    } catch {
      // The process is already gone or could not be signalled; shutdown remains a value.
    }
  }
}
