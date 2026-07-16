// The config bundle — a product is a directory of plain files. `vocab.json` supplies
// the product's nouns; `delta init` scaffolds a starter bundle. The engine reads the
// bundle; it hard-codes no product.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliInit } from "../src/cli";
import { loadConfig } from "../src/config";

describe("vocab.json in the bundle", () => {
  test("loadConfig reads vocab.json; namespace auto-derives from writeNoun", () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-bundle-"));
    writeFileSync(
      join(ws, "vocab.json"),
      JSON.stringify({ writeNoun: "ATS", taskNoun: "candidate", coreVerbs: ["ashby__x"] }),
    );
    const cfg = loadConfig({ DELTA_WORKSPACE: ws });
    expect(cfg.vocab.writeNoun).toBe("ATS");
    expect(cfg.vocab.taskNoun).toBe("candidate");
    expect(cfg.vocab.coreVerbs).toEqual(["ashby__x"]);
    expect(cfg.memoryNamespace).toBe("ats"); // derived per product
  });

  test("DELTA_VOCAB env overrides vocab.json (precedence: env > file > neutral)", () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-bundle-"));
    writeFileSync(join(ws, "vocab.json"), JSON.stringify({ writeNoun: "FromFile" }));
    const cfg = loadConfig({ DELTA_WORKSPACE: ws, DELTA_VOCAB: '{"writeNoun":"FromEnv"}' });
    expect(cfg.vocab.writeNoun).toBe("FromEnv");
  });

  test("no vocab.json → the neutral default (the engine names no product)", () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-bundle-"));
    const cfg = loadConfig({ DELTA_WORKSPACE: ws });
    expect(cfg.vocab.writeNoun).toBe("the record");
    expect(cfg.vocab.coreVerbs).toEqual([]);
  });

  test("a garbled vocab.json falls open to neutral, never crashes boot", () => {
    const ws = mkdtempSync(join(tmpdir(), "delta-bundle-"));
    writeFileSync(join(ws, "vocab.json"), "{ not json");
    const cfg = loadConfig({ DELTA_WORKSPACE: ws });
    expect(cfg.vocab.writeNoun).toBe("the record");
  });
});

describe("delta init", () => {
  test("scaffolds a bundle (delta.env + vocab.json + DELTA.md), never clobbers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-init-"));
    expect(await cliInit([dir])).toBe(0);
    for (const f of ["delta.env", "vocab.json", "DELTA.md"])
      expect(existsSync(join(dir, f))).toBe(true);
    // the scaffolded vocab.json is valid neutral JSON the daemon can load
    const cfg = loadConfig({ DELTA_WORKSPACE: dir });
    expect(cfg.vocab.writeNoun).toBe("the record");
    // idempotent: a second init must not overwrite an edited file
    writeFileSync(join(dir, "DELTA.md"), "# My edited persona");
    expect(await cliInit([dir])).toBe(0);
    expect(readFileSync(join(dir, "DELTA.md"), "utf8")).toBe("# My edited persona");
  });

  test("missing dir arg → usage error (exit 2)", async () => {
    expect(await cliInit([])).toBe(2);
  });
});
