import { describe, expect, test } from "bun:test";

import { Connector, extractDocumentMarker, operatorAuthorized } from "../src/core";
import { Store } from "../src/store";
import type {
  AgentClient,
  AgentSupervisor,
  ChannelCodec,
  Inbound,
  OperationResult,
} from "../src/types";

class RecordingCodec implements ChannelCodec {
  readonly name = "test";
  sent: string[] = [];
  documents: string[] = [];

  async send(_chatId: string, text: string) {
    this.sent.push(text);
    return { ok: true, retryable: false };
  }

  async sendDocument(_chatId: string, path: string) {
    this.documents.push(path);
    return { ok: true, retryable: false };
  }
}

class RecordingSupervisor implements AgentSupervisor {
  awake = 0;
  restarts: boolean[] = [];

  async ensureAwake() {
    this.awake++;
    return "http://agent";
  }
  async maybeSuspend() {}
  async restart(safeMode: boolean): Promise<OperationResult> {
    this.restarts.push(safeMode);
    return { ok: true };
  }
  async shutdown(): Promise<OperationResult> {
    return { ok: true };
  }
}

const event = (eventId: string, text: string, actorId = "tg:7"): Inbound => ({
  eventId,
  conversationId: "tg:100",
  actorId,
  chatId: "100",
  text,
});

async function drain(connector: Connector) {
  while (await connector.runOnce()) {}
}

describe("operator authorization", () => {
  test("requires a human Telegram event and a non-empty raw actor allowlist", () => {
    expect(operatorAuthorized("tg:1", "tg:7", new Set())).toBe(false);
    expect(operatorAuthorized("tg:1", "tg:7", new Set(["7", "8"]))).toBe(true);
    expect(operatorAuthorized("tg:1", "tg:9", new Set(["7", "8"]))).toBe(false);
    expect(operatorAuthorized("schedule:x:1", "tg:7", new Set(["7"]))).toBe(false);
    expect(operatorAuthorized("tg:1", "7", new Set(["7"]))).toBe(false);
  });

  test("denied operator commands are local and never reach agent or supervisor", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const supervisor = new RecordingSupervisor();
    let runs = 0;
    const agent: AgentClient = {
      async run() {
        runs++;
        return { responseId: "r", outputText: "should not run" };
      },
    };
    const connector = new Connector(store, codec, agent, supervisor);
    store.insertInbox(event("tg:1", "/restart"));
    store.insertInbox(event("schedule:s:1", "/safemode"));
    await drain(connector);
    expect(runs).toBe(0);
    expect(supervisor.restarts).toEqual([]);
    expect(codec.sent).toEqual([
      "That operator command is not authorized.",
      "That operator command is not authorized.",
    ]);
  });

  test("allowlisted commands restart, safe-mode, and validate revert ids", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const supervisor = new RecordingSupervisor();
    const reverted: number[] = [];
    const agent: AgentClient = {
      async run() {
        return { responseId: "r", outputText: "unused" };
      },
      async revertSelf(id) {
        reverted.push(id);
        return { ok: true, note: "reverted — takes effect on the next run" };
      },
    };
    const connector = new Connector(store, codec, agent, supervisor, undefined, new Set(["7"]));
    store.insertInbox(event("tg:1", "/restart"));
    store.insertInbox(event("tg:2", "/safemode"));
    store.insertInbox(event("tg:3", "/revert nope"));
    store.insertInbox(event("tg:4", "/revert 12"));
    await drain(connector);
    expect(supervisor.restarts).toEqual([false, true]);
    expect(reverted).toEqual([12]);
    expect(codec.sent[2]).toContain("Usage: /revert");
    expect(codec.sent[3]).toContain("takes effect on the next run");
  });
});

describe("local status and document replies", () => {
  test("status projects safe fields without advancing the existing session", async () => {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const supervisor = new RecordingSupervisor();
    let runs = 0;
    const agent: AgentClient = {
      async run() {
        runs++;
        return { responseId: "resp_1", outputText: "answer" };
      },
      async status() {
        return {
          version: "0.2.7",
          profile: "chat",
          model: { model: "primary", models: ["primary", "fallback"], reasoning_effort: "high" },
          budget: { maxSteps: 20, maxTokens: 400000, maxCostUsd: 1 },
          mcp_servers: [{ name: "files", transport: "stdio" }],
        };
      },
    };
    const connector = new Connector(store, codec, agent, supervisor);
    store.insertInbox(event("tg:1", "hello"));
    await drain(connector);
    store.insertInbox(event("tg:2", "/status"));
    await drain(connector);
    expect(runs).toBe(1);
    expect(store.getSession("tg:100")?.prev_response_id).toBe("resp_1");
    expect(codec.sent.at(-1)).toContain("Version: 0.2.7");
    expect(codec.sent.at(-1)).toContain("MCP servers: files (stdio)");
    expect(codec.sent.at(-1)).not.toContain("undefined");
  });

  test("trailing send marker strips text and preserves text-before-document ordering", async () => {
    expect(extractDocumentMarker("done\n[[send: reports/a.pdf]]")).toEqual({
      text: "done",
      path: "reports/a.pdf",
    });
    expect(extractDocumentMarker("[[send: reports/a.pdf]] trailing")).toEqual({
      text: "[[send: reports/a.pdf]] trailing",
    });

    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const connector = new Connector(
      store,
      codec,
      {
        async run() {
          return {
            responseId: "r",
            outputText: "Your report is ready.\n[[send: reports/a.pdf]]",
          };
        },
      },
      new RecordingSupervisor(),
    );
    store.insertInbox(event("tg:1", "make report"));
    await drain(connector);
    expect(codec.sent).toEqual(["Your report is ready."]);
    expect(codec.documents).toEqual(["reports/a.pdf"]);
  });
});

describe("0.3.1 command surface (against 0.2.8 status)", () => {
  const status08 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: "0.2.8",
    profile: "trusted",
    safe_mode: false,
    model: {
      model: "claude-opus-5",
      provider: "anthropic-native",
      provider_chain: ["anthropic-native", "openrouter"],
      reasoning_effort: "low",
    },
    budget: { maxSteps: 100, maxTokens: 3_000_000, maxCostUsd: 15 },
    mcp_servers: [],
    ...over,
  });

  function rig(agent: Partial<AgentClient>) {
    const store = new Store(":memory:");
    const codec = new RecordingCodec();
    const base: AgentClient = {
      async run() {
        return { responseId: "r", outputText: "answer" };
      },
    };
    const connector = new Connector(
      store,
      codec,
      { ...base, ...agent },
      new RecordingSupervisor(),
      () => {},
      new Set(["7"]), // actor tg:7 is the operator
    );
    return { store, codec, connector };
  }

  test("/status is plain English: provider above model, humanized budget, safe mode line hidden when off", async () => {
    const { store, codec, connector } = rig({
      async status() {
        return status08();
      },
    });
    store.insertInbox(event("tg:1", "/status"));
    await drain(connector);
    const reply = codec.sent.at(-1) ?? "";
    // Provider line comes before the model line, both human-readable.
    expect(reply.indexOf("Provider: anthropic-native")).toBeGreaterThanOrEqual(0);
    expect(reply.indexOf("Provider:")).toBeLessThan(reply.indexOf("Model:"));
    expect(reply).toContain("failover: anthropic-native → openrouter");
    expect(reply).toContain("Budget per task: 100 steps · 3M tokens · $15 max");
    expect(reply).not.toContain("Safe mode"); // off → no noise
  });

  test("/status shows Safe mode ON when the daemon reports it", async () => {
    const { store, codec, connector } = rig({
      async status() {
        return status08({ safe_mode: true, profile: "safe" });
      },
    });
    store.insertInbox(event("tg:1", "/status"));
    await drain(connector);
    expect(codec.sent.at(-1)).toContain("Safe mode: ON");
  });

  test("/model always resolves effort — 'default' when the daemon leaves it unset", async () => {
    const { store, codec, connector } = rig({
      async status() {
        const s = status08();
        (s.model as Record<string, unknown>).reasoning_effort = undefined;
        return s;
      },
    });
    store.insertInbox(event("tg:1", "/model"));
    await drain(connector);
    const reply = codec.sent.at(-1) ?? "";
    expect(reply).toContain("Provider: anthropic-native");
    expect(reply).toContain("Effort: default");
  });

  test("/provider names the provider and failover chain", async () => {
    const { store, codec, connector } = rig({
      async status() {
        return status08();
      },
    });
    store.insertInbox(event("tg:1", "/provider"));
    await drain(connector);
    const reply = codec.sent.at(-1) ?? "";
    expect(reply).toContain("Provider: anthropic-native");
    expect(reply).toContain("Failover: anthropic-native → openrouter");
  });

  test("bare /revert lists revisions as tappable rows with a set-diff of each change", async () => {
    const now = Date.now();
    const { store, codec, connector } = rig({
      async revisions() {
        return {
          current: "# You\nline A\nline B\nline C\n",
          revisions: [
            { id: 12, ts: now - 2 * 3600_000, content: "# You\nline A\nline B\n" }, // C added since
            { id: 11, ts: now - 5 * 3600_000, content: "# You\nline A\n" }, // B added since
          ],
        };
      },
    });
    store.insertInbox(event("tg:1", "/revert"));
    await drain(connector);
    const reply = codec.sent.at(-1) ?? "";
    expect(reply).toContain("/revert_12"); // tappable, underscore
    expect(reply).toContain("/revert_11");
    expect(reply).toContain("2h ago");
    expect(reply).toContain('"line C"'); // first added line = the topic for revision 12
    expect(reply).toContain("+1/-0");
  });

  test("/revert_12 (tappable) restores revision 12 via the inspect endpoint", async () => {
    const reverted: number[] = [];
    const { store, codec, connector } = rig({
      async revertSelf(id: number) {
        reverted.push(id);
        return { ok: true, note: "reverted" };
      },
    });
    store.insertInbox(event("tg:1", "/revert_12"));
    await drain(connector);
    expect(reverted).toEqual([12]);
    expect(codec.sent.at(-1)).toContain("reverted");
  });

  test("/revert_12 with trailing junk does NOT restore — it shows usage (codex P1)", async () => {
    const reverted: number[] = [];
    const { store, codec, connector } = rig({
      async revertSelf(id: number) {
        reverted.push(id);
        return { ok: true, note: "reverted" };
      },
    });
    store.insertInbox(event("tg:1", "/revert_12 garbage"));
    await drain(connector);
    expect(reverted).toEqual([]); // never fired
    expect(codec.sent.at(-1)).toContain("Usage: /revert");
  });

  test("revision picker counts a duplicated line as a real change (multiset diff, codex P1)", async () => {
    const now = Date.now();
    const { store, codec, connector } = rig({
      async revisions() {
        return {
          current: "note\nnote\n", // a second "note" was appended since the snapshot
          revisions: [{ id: 5, ts: now - 60_000, content: "note\n" }],
        };
      },
    });
    store.insertInbox(event("tg:1", "/revert"));
    await drain(connector);
    const reply = codec.sent.at(-1) ?? "";
    expect(reply).toContain("+1/-0"); // NOT "+0/-0 (no textual change)"
    expect(reply).not.toContain("no textual change");
  });

  test("operator commands stay gated: a non-operator cannot list revisions", async () => {
    let listed = 0;
    const { store, codec, connector } = rig({
      async revisions() {
        listed++;
        return { current: "", revisions: [] };
      },
    });
    store.insertInbox(event("tg:1", "/revert", "tg:999")); // not the operator
    await drain(connector);
    expect(listed).toBe(0);
    expect(codec.sent.at(-1)).toContain("not authorized");
  });
});
