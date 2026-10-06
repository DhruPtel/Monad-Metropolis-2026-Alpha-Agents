import { afterEach, describe, expect, it } from "vitest";
import { type UpstreamProxy, retryable, startUpstreamProxy } from "./upstream-proxy.ts";

const block = (n = "0x6896e70") => ({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_getBlockByNumber",
  params: [n, true],
});
const proxies: UpstreamProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

/** A scripted upstream: answers in order, recording which URL each request went to. */
function scripted(answers: (unknown | number | Error)[]) {
  const seen: string[] = [];
  const fetchFn = (async (url: string) => {
    seen.push(url);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    if (typeof a === "number") return new Response("busy", { status: a });
    return new Response(JSON.stringify(a));
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

async function ask(p: UpstreamProxy, body: unknown) {
  const res = await fetch(p.url, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as unknown };
}

describe("what the proxy retries (L-91)", () => {
  it("retries a fixed block answered as null, and transient errors, but not other answers", () => {
    expect(retryable(block(), { result: null })).toBe(true);
    expect(retryable(block("latest"), { result: null })).toBe(false);
    expect(retryable({ method: "eth_getBalance" }, { result: null })).toBe(false);
    expect(
      retryable({ method: "eth_getTransactionReceipt", params: ["0xab"] }, { result: null }),
    ).toBe(false);
    expect(retryable(block(), { error: { message: "Resource not found" } })).toBe(true);
    expect(retryable(block(), { error: { message: "execution reverted" } })).toBe(false);
    expect(retryable(block(), { result: { hash: "0xab" } })).toBe(false);
  });
});

describe("the retrying proxy", () => {
  it("asks again until a node has the block, alternating with the secondary", async () => {
    const { seen, fetchFn } = scripted([
      { jsonrpc: "2.0", id: 1, result: null },
      { jsonrpc: "2.0", id: 1, error: { message: "Resource not found" } },
      503,
      { jsonrpc: "2.0", id: 1, result: { hash: "0xab" } },
    ]);
    const p = await startUpstreamProxy({
      upstreams: ["http://a", "http://b"],
      baseDelayMs: 1,
      fetchFn,
    });
    proxies.push(p);
    const r = await ask(p, block());
    expect(r.body).toEqual({ jsonrpc: "2.0", id: 1, result: { hash: "0xab" } });
    expect(seen).toEqual(["http://a", "http://b", "http://a", "http://b"]);
    expect(p.retries()).toBe(3);
  });

  it("passes other answers through once, and retries a batch with one missing block", async () => {
    const { seen, fetchFn } = scripted([
      { jsonrpc: "2.0", id: 1, result: "0x0" },
      [
        { id: 1, result: "0x1" },
        { id: 2, result: null },
      ],
      [
        { id: 1, result: "0x1" },
        { id: 2, result: { hash: "0xcd" } },
      ],
    ]);
    const p = await startUpstreamProxy({ upstreams: ["http://a"], baseDelayMs: 1, fetchFn });
    proxies.push(p);
    expect(
      (await ask(p, { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [] })).body,
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: "0x0",
    });
    const batch = await ask(p, [
      { id: 1, method: "eth_chainId" },
      { ...block(), id: 2 },
    ]);
    expect(batch.body).toEqual([
      { id: 1, result: "0x1" },
      { id: 2, result: { hash: "0xcd" } },
    ]);
    expect(seen).toHaveLength(3);
  });

  it("gives up after its attempts with the last answer, and survives a dropped connection", async () => {
    const { fetchFn } = scripted([
      new Error("ECONNRESET"),
      ...Array(7).fill({ id: 1, result: null }),
    ]);
    const p = await startUpstreamProxy({
      upstreams: ["http://a"],
      baseDelayMs: 1,
      attempts: 8,
      fetchFn,
    });
    proxies.push(p);
    const r = await ask(p, block());
    expect(r.body).toEqual({ id: 1, result: null });
    expect(p.retries()).toBe(7);
  });
});
