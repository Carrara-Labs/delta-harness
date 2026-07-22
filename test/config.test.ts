// SPDX-License-Identifier: Apache-2.0
// DELTA_MCP_SERVERS parsing is fail-open but never silent: a malformed value or a bad
// entry is dropped with a boot warning (not a tool-less agent that burns a model run),
// and a missing `transport` is inferred from the entry shape instead of crashing the
// stdio branch on Bun.spawn(undefined). Exercised through the public loadConfig surface.

import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

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
