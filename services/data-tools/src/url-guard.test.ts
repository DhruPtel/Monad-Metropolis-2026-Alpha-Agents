import { describe, expect, it } from "vitest";
import { type Lookup, checkUrl, isNonPublicAddress } from "./url-guard.ts";

const DNS: Record<string, string[]> = {
  "example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
  "rebind.example": ["10.0.0.7"],
  "mixed.example": ["93.184.215.14", "127.0.0.1"],
  "meta.example": ["169.254.169.254"],
  "v6local.example": ["fd00:ec2::254"],
};
const lookup: Lookup = async (host) => {
  const found = DNS[host];
  if (!found) throw new Error("ENOTFOUND");
  return found;
};

describe("read_url guard", () => {
  it.each([
    ["http://127.0.0.1/", "PRIVATE_ADDRESS"],
    ["http://127.8.9.10/admin", "PRIVATE_ADDRESS"],
    ["http://2130706433/", "PRIVATE_ADDRESS"], // decimal 127.0.0.1
    ["http://0x7f.1/", "PRIVATE_ADDRESS"], // hex and short form
    ["http://0.0.0.0/", "PRIVATE_ADDRESS"],
    ["http://10.1.2.3/", "PRIVATE_ADDRESS"],
    ["http://172.16.0.1/", "PRIVATE_ADDRESS"],
    ["http://172.31.255.255/", "PRIVATE_ADDRESS"],
    ["http://192.168.1.1/", "PRIVATE_ADDRESS"],
    ["http://100.64.0.1/", "PRIVATE_ADDRESS"],
    ["http://169.254.169.254/latest/meta-data/", "PRIVATE_ADDRESS"],
    ["http://224.0.0.1/", "PRIVATE_ADDRESS"],
    ["http://[::1]/", "PRIVATE_ADDRESS"],
    ["http://[::]/", "PRIVATE_ADDRESS"],
    ["http://[::ffff:127.0.0.1]/", "PRIVATE_ADDRESS"],
    ["http://[::ffff:a9fe:a9fe]/", "PRIVATE_ADDRESS"], // mapped 169.254.169.254
    ["http://[64:ff9b::a9fe:a9fe]/", "PRIVATE_ADDRESS"], // NAT64 169.254.169.254
    ["http://[fd00:ec2::254]/", "PRIVATE_ADDRESS"], // AWS IPv6 metadata
    ["http://[fe80::1]/", "PRIVATE_ADDRESS"],
    ["http://[2002:7f00:1::]/", "PRIVATE_ADDRESS"], // 6to4
    ["http://localhost/", "INTERNAL_HOST"],
    ["http://api.localhost/", "INTERNAL_HOST"],
    ["http://metadata.google.internal/computeMetadata/v1/", "INTERNAL_HOST"],
    ["http://metadata/", "INTERNAL_HOST"],
    ["http://printer.local/", "INTERNAL_HOST"],
    ["http://intranet/", "INTERNAL_HOST"],
    ["http://rebind.example/", "PRIVATE_ADDRESS"],
    ["http://mixed.example/", "PRIVATE_ADDRESS"],
    ["http://meta.example/", "PRIVATE_ADDRESS"],
    ["http://v6local.example/", "PRIVATE_ADDRESS"],
    ["http://unknown.example/", "HOST_NOT_FOUND"],
    ["file:///etc/passwd", "SCHEME_NOT_ALLOWED"],
    ["ftp://example.com/x", "SCHEME_NOT_ALLOWED"],
    ["gopher://example.com/", "SCHEME_NOT_ALLOWED"],
    ["http://user:pass@example.com/", "CREDENTIALS_IN_URL"],
    ["http://example.com:8080/", "PORT_NOT_ALLOWED"],
    ["http://example.com:4200/v1/agents", "PORT_NOT_ALLOWED"],
    ["not a url", "NOT_A_URL"],
    [`https://example.com/${"a".repeat(2100)}`, "NOT_A_URL"],
  ])("refuses %s (%s)", async (url, reason) => {
    expect(await checkUrl(url, lookup)).toEqual({ ok: false, reason });
  });

  it.each([
    ["https://example.com/news?id=1", "example.com"],
    ["http://example.com:80/", "example.com"],
    ["https://8.8.8.8/", "8.8.8.8"],
    ["https://[2606:4700:4700::1111]/", "2606:4700:4700::1111"],
  ])("allows %s", async (url, host) => {
    const r = await checkUrl(url, lookup);
    expect(r).toMatchObject({ ok: true, host });
  });

  it("classifies addresses", () => {
    expect(isNonPublicAddress("1.1.1.1")).toBe(false);
    expect(isNonPublicAddress("172.32.0.1")).toBe(false);
    expect(isNonPublicAddress("100.128.0.1")).toBe(false);
    expect(isNonPublicAddress("2001:4860:4860::8888")).toBe(false);
    expect(isNonPublicAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isNonPublicAddress("not-an-ip")).toBe(true);
  });
});
