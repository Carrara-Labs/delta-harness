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
