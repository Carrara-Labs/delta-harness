// SPDX-License-Identifier: Apache-2.0
// DELTA_MCP_SERVERS parsing is fail-open but never silent: a malformed value or a bad
// entry is dropped with a boot warning (not a tool-less agent that burns a model run),
// and a missing `transport` is inferred from the entry shape instead of crashing the
// stdio branch on Bun.spawn(undefined). Exercised through the public loadConfig surface.

import { describe, expect, test } from "bun:test";
import { loadConfig, unmappedControls } from "../src/config";

describe("DELTA_MCP_SERVERS parsing", () => {
  test("valid http + stdio entries pass through in order", () => {
    const servers = loadConfig({
      DELTA_MCP_SERVERS: JSON.stringify([
        { name: "a", transport: "http", url: "https://x/rpc" },
        { name: "b", transport: "stdio", command: ["node", "s.js"] },
      ]),
    }).mcpServers;
    expect(servers.map((s) => s.name)).toEqual(["a", "b"]);
  });

  test("malformed JSON → no servers, and does not throw", () => {
    expect(loadConfig({ DELTA_MCP_SERVERS: "{not json" }).mcpServers).toEqual([]);
  });

  test("a non-array JSON value → no servers", () => {
    expect(loadConfig({ DELTA_MCP_SERVERS: '{"name":"a"}' }).mcpServers).toEqual([]);
  });

  test("a missing transport is inferred from a url → http, and STAMPED on the object", () => {
    const [s] = loadConfig({
      DELTA_MCP_SERVERS: JSON.stringify([{ name: "a", url: "https://x/rpc" }]),
    }).mcpServers;
    // The stamp matters: without transport on the object, the downstream branch reads
    // undefined and crashes the stdio path on Bun.spawn(undefined).
    expect(s).toMatchObject({ name: "a", transport: "http", url: "https://x/rpc" });
  });

  test("a missing transport is inferred from a command → stdio", () => {
    const [s] = loadConfig({
      DELTA_MCP_SERVERS: JSON.stringify([{ name: "a", command: ["x"] }]),
    }).mcpServers;
    expect(s).toMatchObject({ name: "a", transport: "stdio" });
  });

  test("a stdio entry with a non-string / empty command element is dropped", () => {
    // `[null]` or `[""]` would pass a bare length check and then throw synchronously
    // inside Bun.spawn — reject it at config time instead.
    const servers = loadConfig({
      DELTA_MCP_SERVERS: JSON.stringify([
        { name: "nullelem", transport: "stdio", command: [null] },
        { name: "emptyelem", transport: "stdio", command: [""] },
        { name: "ok", transport: "stdio", command: ["node", "s.js"] },
      ]),
    }).mcpServers;
    expect(servers.map((s) => s.name)).toEqual(["ok"]);
  });

  test("a bad entry is dropped but good siblings survive", () => {
    const servers = loadConfig({
      DELTA_MCP_SERVERS: JSON.stringify([
        { name: "nourl", transport: "http" }, // dropped: http with no url
        { transport: "http", url: "https://x/rpc" }, // dropped: no name
        { name: "ok", transport: "http", url: "https://y/rpc" }, // kept
      ]),
    }).mcpServers;
    expect(servers.map((s) => s.name)).toEqual(["ok"]);
  });
});

describe("DELTA_MAX_CONCURRENCY", () => {
  test("defaults to 8, parses a valid value, clamps to [1, 256], ignores garbage", () => {
    expect(loadConfig({}).maxConcurrency).toBe(8);
    expect(loadConfig({ DELTA_MAX_CONCURRENCY: "24" }).maxConcurrency).toBe(24);
    expect(loadConfig({ DELTA_MAX_CONCURRENCY: "1000" }).maxConcurrency).toBe(256); // hard ceiling
    expect(loadConfig({ DELTA_MAX_CONCURRENCY: "0" }).maxConcurrency).toBe(1); // floored to 1 (never a halted queue)
    expect(loadConfig({ DELTA_MAX_CONCURRENCY: "nope" }).maxConcurrency).toBe(8); // garbage → default
  });
});

describe("code CLI default (D-8)", () => {
  test("connectors are disabled by default — the delegated CLI must not inherit account plugins", () => {
    // A codex session proved its "inert" Gmail skill by listing the operator's real inbox:
    // 6,913 messages, write scope, granted by NOTHING on the host — the connection lives
    // server-side on the CLI's own auth token. Verified against pinned codex-cli 0.146.0:
    // both flags are stable feature names, unknown names error loudly.
    const cli = loadConfig({}).codeCli;
    expect(cli).toContain("--disable");
    expect(cli).toContain("apps");
    expect(cli).toContain("plugins");
  });

  test("an operator-set DELTA_CODE_CLI is used verbatim — no flag injection", () => {
    const cli = loadConfig({ DELTA_CODE_CLI: "codex exec --sandbox workspace-write" }).codeCli;
    expect(cli).not.toContain("--disable");
  });
});

describe("scratch-root overlap guard (D-7 review fix)", () => {
  test("a scratch root that contains the daemon DB is refused back to the workspace", () => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errs.push(a.join(" "));
    try {
      const cfg = loadConfig({
        DELTA_WORKSPACE: "/data/bundle",
        DELTA_DB: "/data/delta.db",
        DELTA_SCRATCH_DIR: "/data",
      });
      expect(cfg.scratchDir).toBe(cfg.workspace); // the model must never gain file-tool reach over the DB
      expect(errs.join("\n")).toContain("DELTA_SCRATCH_DIR");
    } finally {
      console.error = orig;
    }
  });

  test("a dedicated sibling directory passes", () => {
    const cfg = loadConfig({
      DELTA_WORKSPACE: "/data/bundle",
      DELTA_DB: "/data/delta.db",
      DELTA_SCRATCH_DIR: "/data/scratch",
    });
    expect(cfg.scratchDir).toBe("/data/scratch");
  });
});

describe("Responses tuning knobs + unmapped-control reporting (M4, 0.2.16)", () => {
  test("DELTA_TEXT_VERBOSITY and DELTA_REASONING_SUMMARY parse onto the provider", () => {
    const cfg = loadConfig({
      MODEL_API: "responses",
      MODEL_BASE_URL: "https://api.openai.com/v1",
      DELTA_TEXT_VERBOSITY: "low",
      DELTA_REASONING_SUMMARY: "auto",
    });
    expect(cfg.provider.textVerbosity).toBe("low");
    expect(cfg.provider.reasoningSummary).toBe("auto");
  });
  test("unrecognized values are ignored, not sent", () => {
    const cfg = loadConfig({
      MODEL_API: "responses",
      DELTA_TEXT_VERBOSITY: "verbose", // not a level
      DELTA_REASONING_SUMMARY: "always", // only "auto" exists
    });
    expect(cfg.provider.textVerbosity).toBeUndefined();
    expect(cfg.provider.reasoningSummary).toBeUndefined();
  });
  test("a configured control the primary wire cannot render is REPORTED, not silent", () => {
    // The D-2/D-3 principle: the engine knowing something the operator cannot see is the defect.
    expect(
      unmappedControls(
        loadConfig({ MODEL_API: "responses", DELTA_SPEED: "fast", DELTA_CACHE_TTL: "1h" }).provider,
      ).sort(),
    ).toEqual(["DELTA_CACHE_TTL", "DELTA_SPEED"]);
    // …and the same knobs on the wire that DOES render them are not listed.
    expect(
      unmappedControls(
        loadConfig({ MODEL_API: "anthropic", DELTA_SPEED: "fast", DELTA_CACHE_TTL: "1h" }).provider,
      ),
    ).toEqual([]);
    // The chat wire renders cacheTtl (withPromptCache) but has no fast mode.
    expect(
      unmappedControls(loadConfig({ DELTA_SPEED: "fast", DELTA_CACHE_TTL: "1h" }).provider),
    ).toEqual(["DELTA_SPEED"]);
    // Verbosity/summary are Responses-only.
    expect(
      unmappedControls(
        loadConfig({
          MODEL_API: "anthropic",
          DELTA_TEXT_VERBOSITY: "low",
          DELTA_REASONING_SUMMARY: "auto",
        }).provider,
      ).sort(),
    ).toEqual(["DELTA_REASONING_SUMMARY", "DELTA_TEXT_VERBOSITY"]);
    // …and HOST-suppressed knobs are unmapped too (codex #6): a chatgpt.com Responses lane
    // never sends them, so reporting them as live would lie to exactly that lane.
    expect(
      unmappedControls(
        loadConfig({
          MODEL_API: "responses",
          MODEL_BASE_URL: "https://chatgpt.com/backend-api/codex",
          DELTA_TEXT_VERBOSITY: "low",
          DELTA_REASONING_SUMMARY: "auto",
        }).provider,
      ).sort(),
    ).toEqual(["DELTA_REASONING_SUMMARY", "DELTA_TEXT_VERBOSITY"]);
    expect(
      unmappedControls(
        loadConfig({
          MODEL_API: "responses",
          MODEL_BASE_URL: "https://api.openai.com/v1",
          DELTA_TEXT_VERBOSITY: "low",
          DELTA_REASONING_SUMMARY: "auto",
        }).provider,
      ),
    ).toEqual([]);
    // Nothing configured → nothing reported.
    expect(unmappedControls(loadConfig({}).provider)).toEqual([]);
  });
});

describe("GPT-6 Astra (0.2.18)", () => {
  const boot = (env: Record<string, string>) => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errs.push(a.join(" "));
    try {
      return { cfg: loadConfig(env), errs: errs.join("\n") };
    } finally {
      console.error = orig;
    }
  };
  test("reads images on every id form; DELTA_VISION=0 still wins; 5.6 unchanged", () => {
    expect(boot({ DELTA_MODEL_PRIMARY: "gpt-6-astra" }).cfg.vision).toBe(true);
    expect(boot({ DELTA_MODEL_PRIMARY: "openai/gpt-6-astra" }).cfg.vision).toBe(true);
    expect(boot({ DELTA_MODEL_PRIMARY: "gpt-6-astra", DELTA_VISION: "0" }).cfg.vision).toBe(false);
    expect(boot({ DELTA_MODEL_PRIMARY: "gpt-5.6-sol" }).cfg.vision).toBe(true);
  });
  test("an effort GPT-6 rejects is named at boot for ANY cascade member, and still passes through", () => {
    for (const effort of ["none", "minimal"]) {
      const { cfg, errs } = boot({
        DELTA_MODEL_PRIMARY: "gpt-6-astra",
        DELTA_REASONING_EFFORT: effort,
      });
      expect(cfg.reasoningEffort).toBe(effort); // warn, never rewrite: the model is the authority
      expect(errs).toContain("rejected by gpt-6-astra");
    }
    // A fallback on Astra is a terminal 400 mid-cascade (a 400 never fails over): named too,
    // whether it rides the primary provider's list or a separate DELTA_PROVIDERS entry.
    expect(
      boot({
        DELTA_MODEL_PRIMARY: "gpt-5.6-sol",
        DELTA_MODEL_FALLBACKS: "gpt-6-astra",
        DELTA_REASONING_EFFORT: "none",
      }).errs,
    ).toContain("rejected by gpt-6-astra");
    expect(
      boot({
        DELTA_MODEL_PRIMARY: "anthropic/claude-opus-5",
        DELTA_PROVIDERS:
          '[{"label":"oa","baseUrl":"https://api.openai.com/v1","models":["openai/gpt-6-astra"],"apiKeyEnv":"K"}]',
        DELTA_REASONING_EFFORT: "minimal",
      }).errs,
    ).toContain("rejected by openai/gpt-6-astra");
    // Not for an effort Astra takes, and not for a model that still accepts `none`.
    expect(
      boot({ DELTA_MODEL_PRIMARY: "gpt-6-astra", DELTA_REASONING_EFFORT: "low" }).errs,
    ).not.toContain("rejected by");
    expect(
      boot({ DELTA_MODEL_PRIMARY: "gpt-5.6-sol", DELTA_REASONING_EFFORT: "none" }).errs,
    ).not.toContain("rejected by");
  });
});
