// SPDX-License-Identifier: Apache-2.0
// MCP client (spec §D): connect to N configured servers over Streamable HTTP or
// stdio, discover their tools, and expose each as a Delta ToolDef so it flows
// into the tool directory (index in the prompt, schema on demand, activated via
// search_tools). Per-call timeouts, result truncation, config hot-reload. Zero
// deps — the JSON-RPC + Streamable-HTTP/stdio framing is a few dozen lines.

import { registerImage } from "./files";
import type { RefreshingCredential } from "./mcp-refresh";
import type { ToolDef, Tools } from "./tools";

export type McpServerConfig =
  | {
      name: string;
      transport: "http";
      url: string;
      headers?: Record<string, string>;
      /** Refreshing agent credential (§E / G6b) — a rotating-token OAuth principal.
       * On a 401 the transport rotates once and retries. Attached in code (not the
       * JSON config), so the knowledge base's one-shot token stays out of plain env. */
      credential?: RefreshingCredential;
    }
  | { name: string; transport: "stdio"; command: string[]; env?: Record<string, string> };

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

const PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 60_000;

/** One live connection. HTTP is stateless (a request per call); stdio holds a
 * long-lived child and correlates responses by JSON-RPC id. Both expose a
 * `notify` for fire-and-forget notifications (e.g. notifications/initialized). */
interface Transport {
  /** extraHeaders override the connection's headers for THIS call — used for
   * per-run act-as-user auth passthrough (spec §E P1). */
  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): void;
}

class HttpTransport implements Transport {
  private id = 0;
  private sessionId: string | null = null;

  constructor(
    private url: string,
    private headers: Record<string, string>,
    private credential?: RefreshingCredential,
  ) {}

  private async buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    // Lowercase all keys so a per-call override (e.g. per-run `authorization`)
    // reliably REPLACES a statically-configured `Authorization`, rather than
    // both surviving as distinct object keys (which fetch may send together).
    const out: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) out["mcp-session-id"] = this.sessionId;
    // Base auth from the refreshing agent credential (rotating token), overridable
    // by a per-call header (act-as-user passthrough) applied after.
    if (this.credential) out.authorization = `Bearer ${await this.credential.get()}`;
    for (const src of [this.headers, extra]) {
      if (src) for (const [k, v] of Object.entries(src)) out[k.toLowerCase()] = v;
    }
    return out;
  }

  async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const id = ++this.id;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const send = async () =>
      fetch(this.url, {
        method: "POST",
        headers: await this.buildHeaders(extraHeaders),
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    let res = await send();
    // The agent credential's access token expired (401): rotate ONCE and retry.
    // Skip when this call carries a per-run act-as-user override — that token is
    // the caller's, not ours to refresh.
    const overriding = Boolean(extraHeaders?.authorization || extraHeaders?.Authorization);
    if (res.status === 401 && this.credential && !overriding) {
      await this.credential.refresh();
      res = await send();
    }
    const captured = res.headers.get("mcp-session-id");
    if (captured) this.sessionId = captured;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    // Match the response frame to THIS request's id — SSE bodies may carry
    // notifications/progress before the result (spec), and a buggy server may
    // reorder. Never accept a mismatched or notification frame as our answer.
    const msg = parseRpc(await res.text(), id);
    if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await fetch(this.url, {
      method: "POST",
      headers: await this.buildHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }), // no id = notification
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {}); // best-effort; a server that ignores notifications is fine
  }

  close(): void {}
}

/** Parse a Streamable HTTP body (plain JSON or SSE frames) and return the frame
 * matching the given JSON-RPC id, skipping notifications/other-id messages. */
function parseRpc(text: string, id: number): JsonRpcResponse {
  const trimmed = text.trim();
  const frames: string[] = trimmed.startsWith("{")
    ? [trimmed]
    : trimmed
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
  for (const frame of frames) {
    try {
      const msg = JSON.parse(frame) as JsonRpcResponse;
      if (msg.id === id) return msg;
    } catch {}
  }
  throw new Error(`no MCP response frame for id ${id}: ${text.slice(0, 200)}`);
}

class StdioTransport implements Transport {
  private id = 0;
  private proc: ReturnType<typeof Bun.spawn>;
  private buf = "";
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(command: string[], env: Record<string, string>) {
    this.proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...env } as Record<string, string>,
    });
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      this.buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard line-splitting idiom
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        const waiter = this.pending.get(msg.id);
        if (!waiter) continue;
        this.pending.delete(msg.id);
        if (msg.error)
          waiter.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        else waiter.resolve(msg.result);
      }
    }
    for (const [, w] of this.pending) w.reject(new Error("MCP stdio closed"));
    this.pending.clear();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = ++this.id;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write(line);
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); // no id
  }

  private write(line: string): void {
    const stdin = this.proc.stdin as { write(s: string): void; flush(): void };
    stdin.write(line);
    stdin.flush();
  }

  close(): void {
    this.proc.kill();
  }
}

/** A connected MCP server: does the initialize handshake, lists tools, and turns
 * each into a Delta ToolDef. MCP calls have side effects the server owns, so
 * tools are treated non-idempotent (the journal gives them interrupted-not-refire
 * semantics on resume) unless the name reads clearly read-only. */
export class McpConnection {
  private transport: Transport;
  private toolDefs: ToolDef[] = [];

  constructor(private config: McpServerConfig) {
    this.transport =
      config.transport === "http"
        ? new HttpTransport(config.url, config.headers ?? {}, config.credential)
        : new StdioTransport(config.command, config.env ?? {});
  }

  get name(): string {
    return this.config.name;
  }

  async connect(): Promise<ToolDef[]> {
    await this.transport.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "delta", version: "0.1" },
      },
      15_000,
    );
    // Required by the MCP lifecycle before normal requests; servers that enforce
    // it reject tools/list otherwise.
    await this.transport.notify("notifications/initialized", {});
    const listed = (await this.transport.request("tools/list", {}, 15_000)) as { tools: McpTool[] };
    this.toolDefs = listed.tools
      .map((t) => this.toToolDef(t))
      .filter((t): t is ToolDef => t !== null);
    return this.toolDefs;
  }

  private toToolDef(tool: McpTool): ToolDef | null {
    // Namespaced so two servers' identically-named tools never collide. Use `__`
    // (not `.`) — names must match ^[a-zA-Z0-9_-]{1,128}$ for the model API. A
    // malicious/sloppy server's out-of-charset or over-long name is dropped, not
    // passed through to poison the whole (all-pinned) work profile.
    const name = `${this.config.name}__${tool.name}`;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) return null;
    const readOnly = /(^|[._])(get|list|search|read|versions?|file)([._]|$)/i.test(tool.name);
    return {
      name,
      description: tool.description ?? `${tool.name} (via ${this.config.name})`,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      idempotent: readOnly,
      execute: async (args, ctx) => {
        try {
          if (ctx.signal?.aborted) return "[tool error] cancelled";
          // Per-run act-as-user passthrough: if the run carries an authToken,
          // this call is made as that principal (ACL enforced server-side).
          const override = ctx.authToken ? { authorization: `Bearer ${ctx.authToken}` } : undefined;
          const result = (await this.transport.request(
            "tools/call",
            { name: tool.name, arguments: args },
            CALL_TIMEOUT_MS,
            override,
          )) as {
            content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
            isError?: boolean;
          };
          const pieces: string[] = [];
          for (const c of result.content ?? []) {
            if (c.text) pieces.push(c.text);
            // An MCP image part used to be silently dropped (Sprint 8): save the
            // bytes to the workspace and emit the claim-check marker — the same
            // rail read_file images ride (expanded to a wire block while recent).
            if (c.type === "image" && c.data && c.mimeType) {
              try {
                const ext = c.mimeType.split("/")[1]?.split("+")[0] ?? "bin";
                // uuid slice: two same-tool images in one millisecond must not merge.
                const rel = `.delta/media/${Date.now()}-${crypto.randomUUID().slice(0, 6)}-${tool.name.slice(0, 40)}.${ext}`;
                await Bun.write(`${ctx.workspace}/${rel}`, Buffer.from(c.data, "base64"), {
                  createPath: true,
                });
                registerImage(ctx.workspace, rel); // provenance: this marker may expand
                // Non-vision daemon: same honest phrasing as read_file — a bare
                // marker implies attachment and invites confabulation (codex S8 #9).
                pieces.push(
                  ctx.vision === false
                    ? `[delta:image ${rel}]\n(saved image — your current model CANNOT view it; never guess its contents, delegate visual analysis or say you can't see it)`
                    : `[delta:image ${rel}]`,
                );
              } catch {
                pieces.push("[image part could not be saved]");
              }
            }
          }
          const text = pieces.filter(Boolean).join("\n");
          // Raw — run.ts caps+spills every tool result centrally; a pre-elide here would
          // bypass the spill and make the full output unrecoverable (codex #7).
          return result.isError ? `[tool error] ${text}` : text || "(no content)";
        } catch (e) {
          return `[tool error] ${String(e).slice(0, 2000)}`;
        }
      },
    };
  }

  close(): void {
    this.transport.close();
  }
}

/** The MCP registry: connects configured servers, merges their tools into the
 * shared registry, and supports hot add/remove on a running daemon (spec §D). */
export class McpRegistry {
  private connections = new Map<string, McpConnection>();

  constructor(private registry: Tools) {}

  /** Connect a server and fold its tools in. Errors are returned, not thrown —
   * one bad server must never stop the daemon from starting. */
  async add(config: McpServerConfig): Promise<{ ok: boolean; tools: number; error?: string }> {
    this.remove(config.name); // idempotent re-add / hot-reload
    // Construct INSIDE the try: a stdio server spawns its child in the McpConnection
    // constructor, and Bun.spawn throws SYNCHRONOUSLY on a bad argv (a non-existent
    // binary, an empty string). That throw has to be caught here — otherwise it escapes
    // the un-guarded startup loop and crashes boot, breaking the "one bad server never
    // stops the daemon" contract stated at the call site (codex P1).
    let conn: McpConnection | undefined;
    try {
      conn = new McpConnection(config);
      const defs = await conn.connect();
      this.connections.set(config.name, conn);
      for (const def of defs) this.registry.set(def.name, def);
      return { ok: true, tools: defs.length };
    } catch (e) {
      conn?.close(); // reap the child/socket if it was constructed — never tracked for removal
      return { ok: false, tools: 0, error: String(e).slice(0, 500) };
    }
  }

  remove(name: string): void {
    const conn = this.connections.get(name);
    if (!conn) return;
    for (const key of [...this.registry.keys()]) {
      if (key.startsWith(`${name}__`)) this.registry.delete(key);
    }
    conn.close();
    this.connections.delete(name);
  }

  list(): string[] {
    return [...this.connections.keys()];
  }

  closeAll(): void {
    for (const name of this.list()) this.remove(name);
  }
}
