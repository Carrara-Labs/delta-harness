import { describe, expect, test } from "bun:test";
import { childEnv } from "../src/builtins";

const source = {
  PATH: "/bin",
  HOME: "/home/delta",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  MODEL_API_KEY: "provider-secret",
  OPENROUTER_API_KEY: "unused-provider-secret",
  DELTA_MODEL: "example/model",
  DELTA_MCP_REFRESH_TOKEN: "knowledge base-secret",
  DELTA_BROKER_AUTH: "broker-secret",
  DELTA_CONTROL_TOKEN: "control-secret",
  TELEMETRY_TOKEN: "telemetry-secret",
  // The crown jewels: the knowledge base MCP's bearer rides INSIDE this JSON, and inline
  // fallback-provider keys ride inside DELTA_PROVIDERS  -  neither may cross to a child.
  DELTA_MCP_SERVERS:
    '[{"name":"knowledge base","headers":{"authorization":"Bearer knowledge base-mcp-secret"}}]',
  DELTA_PROVIDERS: '[{"baseUrl":"https://x","apiKey":"inline-provider-secret"}]',
};

describe("childEnv", () => {
  test("code CLI receives only non-secret process plumbing", () => {
    expect(childEnv("code", source)).toEqual({
      PATH: "/bin",
      HOME: "/home/delta",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
    });
  });

  test("subagent receives its model route but no daemon service tokens", () => {
    const env = childEnv("subagent", source);
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/delta");
    expect(env.MODEL_API_KEY).toBe("provider-secret");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.DELTA_MODEL).toBe("example/model");
    for (const key of [
      "DELTA_MCP_REFRESH_TOKEN",
      "DELTA_BROKER_AUTH",
      "DELTA_CONTROL_TOKEN",
      "TELEMETRY_TOKEN",
      "DELTA_MCP_SERVERS", // the knowledge base bearer lives in here
      "DELTA_PROVIDERS", // inline provider keys live in here
    ])
      expect(env[key]).toBeUndefined();
  });

  test("no serialized secret VALUE leaks into any child env, code or subagent", () => {
    // Belt-and-suspenders: assert on the concatenated values, not just key names  -
    // catches a future allowlist entry that would smuggle a secret through.
    const secrets = [
      "knowledge base-secret",
      "broker-secret",
      "control-secret",
      "telemetry-secret",
      "knowledge base-mcp-secret",
      "inline-provider-secret",
    ];
    for (const kind of ["code", "subagent"] as const) {
      const blob = Object.values(childEnv(kind, source)).join(" - ");
      for (const s of secrets) expect(blob).not.toContain(s);
    }
  });

  test("subagent falls back to the OpenRouter key", () => {
    const env = childEnv("subagent", { HOME: "/home/delta", OPENROUTER_API_KEY: "key" });
    expect(env.OPENROUTER_API_KEY).toBe("key");
  });
});
