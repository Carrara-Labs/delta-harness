// SPDX-License-Identifier: Apache-2.0
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type HostLookup = (host: string) => Promise<string[]>;

function ipv4Bytes(ip: string): [number, number, number, number] | undefined {
  if (isIP(ip) !== 4) return undefined;
  const [a, b, c, d] = ip.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return [a, b, c, d];
}

function ipv6Bytes(raw: string): number[] | undefined {
  const ip = raw.replace(/^\[|\]$/g, "");
  if (isIP(ip) !== 6) return undefined;
  const halves = ip.split("::");
  const groups = (part: string): number[] => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      const v4 = ipv4Bytes(group);
      if (v4) out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      else out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const left = groups(halves[0] ?? "");
  const right = groups(halves[1] ?? "");
  const words =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
      : left;
  if (words.length !== 8) return undefined;
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

/** True for addresses that must never be reachable through the model-facing fetch tool. */
export function isBlockedIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, "");
  const v4 = ipv4Bytes(ip);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  const v6 = ipv6Bytes(ip);
  if (!v6) return false;
  if (v6.every((byte) => byte === 0)) return true; // unspecified ::
  if (v6.slice(0, 15).every((byte) => byte === 0) && v6[15] === 1) return true; // ::1
  const first = v6[0] ?? 0;
  const second = v6[1] ?? 0;
  if ((first & 0xfe) === 0xfc || (first === 0xfe && (second & 0xc0) === 0x80)) return true;
  if (v6.slice(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff)
    return isBlockedIp(v6.slice(12).join("."));
  return false;
}

const defaultLookup: HostLookup = async (host) =>
  (await dnsLookup(host, { all: true })).map(({ address }) => address);

/** Parse a web URL and reject any literal or DNS answer that reaches a non-public address.
 * Accepted residual (TOCTOU): we resolve + check here, then `fetch` re-resolves the hostname
 * independently, so a DNS-rebinding host that flips public→private between the two lookups can
 * still slip through. Closing it fully needs IP-pinned connect (resolve once, dial the checked
 * address with the Host header preserved) — Bun's fetch has no connector hook for that yet.
 * What this DOES stop: every literal private/metadata IP, hostnames that statically resolve
 * private, and redirect-to-internal (the caller re-checks each hop). Big net reduction. */
export async function assertPublicUrl(
  rawUrl: string,
  lookup: HostLookup = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`scheme ${url.protocol || "(missing)"} is not allowed`);

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`private or reserved IP ${host}`);
    return url;
  }
  const addresses = await lookup(host);
  const blocked = addresses.find(isBlockedIp);
  if (blocked) throw new Error(`host ${host} resolves to private or reserved IP ${blocked}`);
  return url;
}
