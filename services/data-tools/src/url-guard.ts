import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The read_url guard (D-214): a URL is fetched only if it is plain http or
 * https on the default port, carries no credentials, names no internal host,
 * and its host and every address it resolves to are public. The check runs
 * before any request is made, so a refused URL costs nothing and reaches
 * nothing.
 */
export type Lookup = (host: string) => Promise<readonly string[]>;

export const systemLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export type UrlRefusal =
  | "NOT_A_URL"
  | "SCHEME_NOT_ALLOWED"
  | "CREDENTIALS_IN_URL"
  | "PORT_NOT_ALLOWED"
  | "INTERNAL_HOST"
  | "PRIVATE_ADDRESS"
  | "HOST_NOT_FOUND";

export type UrlCheck =
  | { readonly ok: true; readonly url: string; readonly host: string }
  | { readonly ok: false; readonly reason: UrlRefusal };

export const MAX_URL_LENGTH = 2048;

/** Names that point inside a network or at a cloud metadata service. */
const INTERNAL_NAMES = new Set(["localhost", "metadata", "instance-data", "kubernetes"]);
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet"];

function v4Parts(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return null;
  return parts;
}

/** Whether an IPv4 address is outside the public internet. */
export function isNonPublicV4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return true;
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 address to eight 16-bit groups, or null if malformed. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const p = v4Parts(dotted[1]);
    if (!p) return null;
    const [a, b, c, d] = p as [number, number, number, number];
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":").map((g) => parseInt(g, 16)));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/** Whether an IPv6 address is outside the public internet, checking embedded IPv4 too. */
export function isNonPublicV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embedded = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(8)) return true; // unspecified
  if (zeroTo(7) && g7 === 1) return true; // loopback
  if (zeroTo(5) && g5 === 0xffff) return isNonPublicV4(embedded); // IPv4-mapped
  if (zeroTo(6)) return true; // IPv4-compatible (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return isNonPublicV4(embedded); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local (AWS metadata fd00:ec2::254)
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true; // link- and site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2002) return true; // 6to4 carries an arbitrary IPv4 address
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  return false;
}

export function isNonPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isNonPublicV4(ip);
  if (family === 6) return isNonPublicV6(ip);
  return true;
}

/** Checks a URL for read_url; resolves the host and refuses if any address is not public. */
export async function checkUrl(raw: string, lookup: Lookup = systemLookup): Promise<UrlCheck> {
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "NOT_A_URL" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "NOT_A_URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, reason: "SCHEME_NOT_ALLOWED" };
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "CREDENTIALS_IN_URL" };
  // URL drops a default port, so any port left is a non-default one.
  if (url.port !== "") return { ok: false, reason: "PORT_NOT_ALLOWED" };
  // WHATWG URL has already normalized numeric IPv4 forms (0x7f.1, 2130706433) to dotted quads.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0)
    return isNonPublicAddress(literal)
      ? { ok: false, reason: "PRIVATE_ADDRESS" }
      : { ok: true, url: url.href, host: literal };
  if (
    !host.includes(".") ||
    INTERNAL_NAMES.has(host) ||
    INTERNAL_SUFFIXES.some((s) => host.endsWith(s))
  )
    return { ok: false, reason: "INTERNAL_HOST" };
  let addresses: readonly string[];
  try {
    addresses = await lookup(host);
  } catch {
    return { ok: false, reason: "HOST_NOT_FOUND" };
  }
  if (addresses.length === 0) return { ok: false, reason: "HOST_NOT_FOUND" };
  if (addresses.some(isNonPublicAddress)) return { ok: false, reason: "PRIVATE_ADDRESS" };
  return { ok: true, url: url.href, host };
}

/** P3-U9: the most redirect hops followed before a URL is refused. */
export const MAX_REDIRECTS = 5;

export type RedirectCheck =
  | { readonly ok: true; readonly url: string; readonly host: string; readonly hops: number }
  | {
      readonly ok: false;
      readonly reason: UrlRefusal | "TOO_MANY_REDIRECTS";
      readonly hop: number;
    };

/**
 * The read broker's redirect check (P3-U9): Tavily follows redirects itself,
 * so before a page is handed to it the platform follows the chain one hop at a
 * time, without following automatically, and runs every hop through the
 * guard above. A hop to a private or internal address is refused before any
 * request is made to it. The final URL is what Tavily reads. A probe that
 * cannot connect is not a refusal: the URL is handed on as it is and the
 * provider reports the failure.
 */
export async function followRedirects(
  first: UrlCheck & { ok: true },
  lookup: Lookup = systemLookup,
  f: typeof fetch = fetch,
): Promise<RedirectCheck> {
  let current = first;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await f(current.url, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": "alpha-agents-read-broker" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { ok: true, url: current.url, host: current.host, hops: hop };
    }
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location)
      return { ok: true, url: current.url, host: current.host, hops: hop };
    if (hop === MAX_REDIRECTS) return { ok: false, reason: "TOO_MANY_REDIRECTS", hop: hop + 1 };
    let next: string;
    try {
      next = new URL(location, current.url).toString();
    } catch {
      return { ok: false, reason: "NOT_A_URL", hop: hop + 1 };
    }
    const check = await checkUrl(next, lookup);
    if (!check.ok) return { ok: false, reason: check.reason, hop: hop + 1 };
    current = check;
  }
  return { ok: false, reason: "TOO_MANY_REDIRECTS", hop: MAX_REDIRECTS + 1 };
}
