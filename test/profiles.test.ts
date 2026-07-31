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

  test("DELTA_ALLOWED_TOOLS sets the tool surface on the operator's own daemon", () => {
    process.env.DELTA_ALLOWED_TOOLS = "read_file, web_search, remember";
    expect(getProfile(undefined, "safe").allowed).toEqual([
      "read_file",
      "web_search",
      "remember",
    ]);
  });

  test("DELTA_PINNED_TOOLS overrides the pinned set", () => {
    process.env.DELTA_PINNED_TOOLS = "read_file";
    expect(getProfile(undefined, "trusted").pinned).toEqual(["read_file"]);
  });

  test("fail-safe: an env var set but empty falls back to the safe floor, never allow-all", () => {
    process.env.DELTA_ALLOWED_TOOLS = "  , ,  ";
    const p = getProfile(undefined, "trusted"); // full ceiling
    expect(p.allowed).toEqual(PROFILES.safe?.allowed);
    expect(p.allowed).not.toBe("*");
  });

  test("unset envelope leaves the tier untouched", () => {
    delete process.env.DELTA_ALLOWED_TOOLS;
    delete process.env.DELTA_PINNED_TOOLS;
    expect(getProfile(undefined, "trusted").allowed).toBe("*");
  });
});
