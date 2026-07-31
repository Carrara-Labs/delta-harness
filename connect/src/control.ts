import { timingSafeEqual } from "node:crypto";

import type { ScheduleOrigin, ScheduleSpec, Store } from "./store";

const MAX_BODY_BYTES = 32_768;
const MAX_PROMPT_CHARS = 8_000;

type ValidSchedule = { prompt: string; spec: ScheduleSpec };
type Validation = { ok: true; value: ValidSchedule } | { ok: false; error: string };

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Validate the exact 0.3.0 schedule subset. Cron is intentionally deferred. */
export function validateScheduleRequest(value: unknown, now = Date.now()): Validation {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, error: "body must be a JSON object" };
  const body = value as Record<string, unknown>;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT_CHARS)
    return { ok: false, error: `prompt must be 1-${MAX_PROMPT_CHARS} characters` };
  if (typeof body.spec !== "object" || body.spec === null || Array.isArray(body.spec))
    return { ok: false, error: "spec must be an object" };
  const spec = body.spec as Record<string, unknown>;
  if (spec.kind === "cron") {
    return {
      ok: false,
      error: "cron is deferred in Delta Connect 0.3.0; use once/interval",
    };
  }
  if (spec.kind === "once") {
    const runAt = typeof spec.runAt === "string" ? spec.runAt : "";
    const timestamp = Date.parse(runAt);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(runAt) || !Number.isFinite(timestamp))
      return { ok: false, error: "once requires a finite ISO runAt" };
    return { ok: true, value: { prompt, spec: { kind: "once", runAt } } };
  }
  if (spec.kind === "interval") {
    const intervalMs = spec.intervalMs;
    if (
      typeof intervalMs !== "number" ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 60_000 ||
      !Number.isFinite(now + intervalMs) ||
      now + intervalMs > 8.64e15
    ) {
      return { ok: false, error: "interval requires an integer intervalMs >= 60000" };
    }
    return { ok: true, value: { prompt, spec: { kind: "interval", intervalMs } } };
  }
  return { ok: false, error: "spec.kind must be once or interval" };
}

/** Only an explicit loopback HTTP origin with a port is accepted. */
export function controlPort(raw: string): number | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const got = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readCappedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

export class ScheduleControl {
  private server?: ReturnType<typeof Bun.serve>;
  private ticker?: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: Store,
    private readonly url: string,
    private readonly token: string,
    private readonly activeOrigin: () => ScheduleOrigin | null,
    private readonly log: (message: string) => void = () => {},
  ) {}

  start(): void {
    const port = controlPort(this.url);
    if (port === null) throw new Error("DELTA_CONTROL_URL must be http://127.0.0.1:<port>");
    if (!this.token) throw new Error("DELTA_CONTROL_TOKEN is required with DELTA_CONTROL_URL");
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: async (request) => {
        try {
          return await this.handle(request);
        } catch (error) {
          this.log(`control request failed: ${String(error)}`);
          return json({ error: "internal error" }, 500);
        }
      },
    });
    this.admit();
    this.ticker = setInterval(() => this.admit(), 60_000);
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.server?.stop(true);
    this.server = undefined;
  }

  async handle(request: Request): Promise<Response> {
    if (!authorized(request, this.token)) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const collection = url.pathname === "/api/agents/self/schedules";
    const item = url.pathname.match(/^\/api\/agents\/self\/schedules\/([^/]+)$/);
    if (!collection && !item) return json({ error: "not found" }, 404);
    const origin = this.activeOrigin();
    if (!origin) return json({ error: "no active agent turn" }, 409);

    if (collection && request.method === "POST") {
      let body: unknown;
      try {
        const text = await readCappedBody(request);
        if (text === null) return json({ error: "request body too large" }, 413);
        body = JSON.parse(text);
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const valid = validateScheduleRequest(body);
      if (!valid.ok) return json({ error: valid.error }, 400);
      const schedule = this.store.createSchedule(origin, valid.value.prompt, valid.value.spec);
      return json({ schedule: { id: schedule.id, nextRunAt: schedule.nextRunAt } }, 201);
    }
    if (collection && request.method === "GET") {
      return json({ schedules: this.store.listSchedules(origin) });
    }
    if (item && request.method === "DELETE") {
      let id: string;
      try {
        id = decodeURIComponent(item[1] as string);
      } catch {
        return json({ error: "not found" }, 404);
      }
      if (!id || !this.store.cancelSchedule(id, origin)) return json({ error: "not found" }, 404);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  private admit(): void {
    try {
      this.store.admitDue(Date.now());
    } catch (error) {
      this.log(`schedule admission failed: ${String(error)}`);
    }
  }
}
