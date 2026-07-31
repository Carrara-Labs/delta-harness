import { describe, expect, test } from "bun:test";

import { getProfile, grantSelfWrite, PROFILES } from "../src/profiles";

// The trusted-gateway self-write grant is security-sensitive: it must be off by
// default, must not over-escalate, and an untrusted caller must never be able to
// turn it on via request metadata.

describe("grantSelfWrite", () => {
  const safe = PROFILES.safe as (typeof PROFILES)["safe"];
  const trusted = PROFILES.trusted as (typeof PROFILES)["trusted"];

  test("off by default: the safe profile keeps no self-write", () => {
    expect(grantSelfWrite(safe, false).allowed).not.toContain("remember");
  });

  test("on: grants AND pins remember, and escalates nothing else", () => {
    const p = grantSelfWrite(safe, true);
    expect(Array.isArray(p.allowed) && p.allowed.includes("remember")).toBe(true);
    expect(Array.isArray(p.pinned) && p.pinned.includes("remember")).toBe(true);
    expect(p.budget).toEqual(safe.budget); // same tight safe-floor budget
    expect(p.allowed).not.toContain("code"); // still no code execution / delegation
  });

  test("a '*'-tools profile already has it: unchanged", () => {
    expect(grantSelfWrite(trusted, true).allowed).toBe("*");
  });

  test("idempotent: granting twice does not duplicate the tool", () => {
    const twice = grantSelfWrite(grantSelfWrite(safe, true), true);
    const n = (Array.isArray(twice.allowed) ? twice.allowed : []).filter(
      (t) => t === "remember",
    ).length;
    expect(n).toBe(1);
  });

  test("untrusted callers cannot escalate: request metadata only narrows the ceiling", () => {
    // A safe-ceiling daemon: a request asking for the fuller tier stays at the floor.
    // Old names ('work'/'chat') still resolve via the 0.2.7 back-compat aliases.
    expect(getProfile("work", "chat").name).toBe("safe");
    expect(getProfile("trusted", "safe").name).toBe("safe");
    // And without the daemon flag, no self-write regardless of the requested profile.
    expect(grantSelfWrite(getProfile("work", "chat"), false).allowed).not.toContain("remember");
  });
});
