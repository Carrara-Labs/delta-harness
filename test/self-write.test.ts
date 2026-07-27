import { describe, expect, test } from "bun:test";

import { getProfile, grantSelfWrite, PROFILES } from "../src/profiles";

// The trusted-gateway self-write grant is security-sensitive: it must be off by
// default, must not over-escalate, and an untrusted caller must never be able to
// turn it on via request metadata.

describe("grantSelfWrite", () => {
  const chat = PROFILES.chat as (typeof PROFILES)["chat"];
  const work = PROFILES.work as (typeof PROFILES)["work"];

  test("off by default: the chat profile keeps no self-write", () => {
    expect(grantSelfWrite(chat, false).allowed).not.toContain("remember");
  });

  test("on: grants AND pins remember, and escalates nothing else", () => {
    const p = grantSelfWrite(chat, true);
    expect(Array.isArray(p.allowed) && p.allowed.includes("remember")).toBe(true);
    expect(Array.isArray(p.pinned) && p.pinned.includes("remember")).toBe(true);
    expect(p.budget).toEqual(chat.budget); // same tight chat budget
    expect(p.allowed).not.toContain("code"); // still no code execution / delegation
  });

  test("a '*'-tools profile already has it: unchanged", () => {
    expect(grantSelfWrite(work, true).allowed).toBe("*");
  });

  test("idempotent: granting twice does not duplicate the tool", () => {
    const twice = grantSelfWrite(grantSelfWrite(chat, true), true);
    const n = (Array.isArray(twice.allowed) ? twice.allowed : []).filter(
      (t) => t === "remember",
    ).length;
    expect(n).toBe(1);
  });

  test("untrusted callers cannot escalate: request metadata only narrows the ceiling", () => {
    // A chat-ceiling daemon: a request asking for the 'work' profile stays chat.
    expect(getProfile("work", "chat").name).toBe("chat");
    // And without the daemon flag, no self-write regardless of the requested profile.
    expect(grantSelfWrite(getProfile("work", "chat"), false).allowed).not.toContain("remember");
  });
});
