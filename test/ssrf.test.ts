import { describe, expect, test } from "bun:test";
import { assertPublicUrl, isBlockedIp } from "../src/ssrf";

describe("isBlockedIp", () => {
  test.each([
    "127.0.0.1",
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  test.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (ip) =>
    expect(isBlockedIp(ip)).toBe(false));
});

describe("assertPublicUrl", () => {
  const publicLookup = async () => ["8.8.8.8"];

  test.each(["file:///etc/passwd", "ftp://example.com/file"])("rejects %s", async (url) => {
    await expect(assertPublicUrl(url, publicLookup)).rejects.toThrow("scheme");
  });

  test("rejects a metadata IP literal", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/latest", publicLookup)).rejects.toThrow(
      "private or reserved IP",
    );
  });

  test("rejects a hostname if any DNS answer is private", async () => {
    await expect(
      assertPublicUrl("https://rebind.example/", async () => ["8.8.8.8", "10.0.0.1"]),
    ).rejects.toThrow("resolves to private or reserved IP");
  });

  test("accepts a hostname whose DNS answers are public", async () => {
    expect((await assertPublicUrl("https://example.com/path", publicLookup)).href).toBe(
      "https://example.com/path",
    );
  });
});
