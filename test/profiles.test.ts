import { afterEach, describe, expect, test } from "bun:test";

import { getProfile, PROFILES } from "../src/profiles";

// 0.2.7: the two tiers were renamed chat→safe, work→trusted (naming the capability
// axis, not an activity), with back-compat aliases; and the tool set became an operator
// env knob (DELTA_ALLOWED_TOOLS / DELTA_PINNED_TOOLS) with a fail-safe fallback.

describe("profiles: tiers, aliases, envelope knob (0.2.7)", () => {
  const ORIG_ALLOWED = process.env.DELTA_ALLOWED_TOOLS;
  const ORIG_PINNED = process.env.DELTA_PINNED_TOOLS;
  afterEach(() => {
    if (ORIG_ALLOWED === undefined) delete process.env.DELTA_ALLOWED_TOOLS;
    else process.env.DELTA_ALLOWED_TOOLS = ORIG_ALLOWED;
    if (ORIG_PINNED === undefined) delete process.env.DELTA_PINNED_TOOLS;
    else process.env.DELTA_PINNED_TOOLS = ORIG_PINNED;
  });

  test("canonical tiers exist; old names are back-compat aliases", () => {
    expect(PROFILES.safe?.name).toBe("safe");
    expect(PROFILES.trusted?.name).toBe("trusted");
    expect(getProfile("chat").name).toBe("safe");
    expect(getProfile("work").name).toBe("trusted");
    // an unset daemon default ("work" in config) still resolves to the full tier
    expect(getProfile(undefined, "work").name).toBe("trusted");
  });

  test("DELTA_ALLOWED_TOOLS narrows within the tier, and cannot escalate `safe`", () => {
    // `remember` is not in the safe floor → clamped out; the tier stays truthful.
    process.env.DELTA_ALLOWED_TOOLS = "read_file, web_search, remember";
    expect(getProfile(undefined, "safe").allowed).toEqual(["read_file", "web_search"]);
  });

  test("a custom envelope is built from the trusted ceiling + a list (passes through)", () => {
    process.env.DELTA_ALLOWED_TOOLS = "read_file, web_search, remember, grep";
    expect(getProfile(undefined, "trusted").allowed).toEqual([
      "read_file",
      "web_search",
      "remember",
      "grep",
    ]);
  });

  test("DELTA_PINNED_TOOLS overrides the pinned set (clamped to allowed)", () => {
    process.env.DELTA_PINNED_TOOLS = "read_file";
    expect(getProfile(undefined, "trusted").pinned).toEqual(["read_file"]);
  });

  test("fail-safe: set-but-empty falls back to the safe floor, never allow-all", () => {
    process.env.DELTA_ALLOWED_TOOLS = "  , ,  ";
    const p = getProfile(undefined, "trusted"); // full ceiling
    expect(p.allowed).toEqual([
      "web_search",
      "web_fetch",
      "read_file",
      "list_dir",
      "recall",
      "todo",
    ]);
    expect(p.allowed).not.toBe("*");
  });

  test("fail-safe: a malformed member voids the whole var → safe floor", () => {
    process.env.DELTA_ALLOWED_TOOLS = "read_file, we b_search"; // space = invalid identifier
    expect(getProfile(undefined, "trusted").allowed).toEqual([
      "web_search",
      "web_fetch",
      "read_file",
      "list_dir",
      "recall",
      "todo",
    ]);
  });

  test("unset envelope leaves the tier untouched", () => {
    delete process.env.DELTA_ALLOWED_TOOLS;
    delete process.env.DELTA_PINNED_TOOLS;
    expect(getProfile(undefined, "trusted").allowed).toBe("*");
  });
});

describe("DELTA_MAX_STEPS (D-11)", () => {
  const restore = { ...process.env };
  afterEach(() => {
    process.env.DELTA_MAX_STEPS = restore.DELTA_MAX_STEPS; // undefined deletes on assignment? no —
    if (restore.DELTA_MAX_STEPS === undefined) delete process.env.DELTA_MAX_STEPS;
  });

  test("raises and lowers maxSteps in either direction, like the other two axes", () => {
    process.env.DELTA_MAX_STEPS = "7";
    expect(getProfile("safe").budget.maxSteps).toBe(7);
    process.env.DELTA_MAX_STEPS = "500";
    expect(getProfile("safe").budget.maxSteps).toBe(500);
  });

  test("0 is refused — a zero-step budget fails every run before step 1, undiagnosable", () => {
    const base = getProfile("safe").budget.maxSteps;
    process.env.DELTA_MAX_STEPS = "0";
    expect(getProfile("safe").budget.maxSteps).toBe(base);
    process.env.DELTA_MAX_STEPS = "-3";
    expect(getProfile("safe").budget.maxSteps).toBe(base);
    process.env.DELTA_MAX_STEPS = "not-a-number";
    expect(getProfile("safe").budget.maxSteps).toBe(base);
  });

  test("fractions floor", () => {
    process.env.DELTA_MAX_STEPS = "7.9";
    expect(getProfile("safe").budget.maxSteps).toBe(7);
  });
});
