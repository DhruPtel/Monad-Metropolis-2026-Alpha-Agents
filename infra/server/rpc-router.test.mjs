import { describe, expect, it } from "vitest";
import { Router, cacheMsFor, providerOf, shouldFailOver } from "./rpc-router.mjs";

const A = "https://a.quiknode.pro/key";
const B = "https://testnet-rpc.monad.xyz";
const ok = (result) => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result } });

/** A fetch that answers from a script per upstream URL and records each call. */
function fakeFetch(script) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = script[url].shift() ?? script[url].at(-1) ?? ok("0x1");
    if (next === "down") throw new Error("connect ECONNREFUSED");
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { f, calls };
}

const req = (method, params = [], id = 7) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("rpc router", () => {
  it("names a provider from its hostname, never its URL", () => {
    expect(providerOf(A)).toBe("QuickNode");
    expect(providerOf("https://monad-testnet.g.alchemy.com/v2/secret")).toBe("Alchemy");
    expect(providerOf(B)).toBe("Monad public");
  });

  it("caches only reads that cannot change within a block", () => {
    expect(cacheMsFor({ method: "eth_call", params: [{}, "latest"] }, 400)).toBe(400);
    expect(cacheMsFor({ method: "eth_getTransactionCount", params: ["0x1", "pending"] }, 400)).toBe(
      0,
    );
    expect(cacheMsFor({ method: "eth_sendRawTransaction", params: ["0x"] }, 400)).toBe(0);
    expect(cacheMsFor({ method: "eth_getLogs", params: [{}] }, 400)).toBe(0);
    expect(cacheMsFor({ method: "eth_getTransactionReceipt", params: ["0x"] }, 400)).toBe(0);
    expect(cacheMsFor({ method: "eth_chainId" }, 400)).toBe(3_600_000);
  });

  it("fails over on a limit or an outage, never on a revert", () => {
    expect(shouldFailOver(429, null)).toBe(true);
    expect(shouldFailOver(503, null)).toBe(true);
    expect(shouldFailOver(0, null)).toBe(true);
    expect(shouldFailOver(200, { error: { code: -32005, message: "limit" } })).toBe(true);
    expect(shouldFailOver(200, { error: { code: -32007, message: "request limit reached" } })).toBe(
      true,
    );
    expect(
      shouldFailOver(200, {
        error: { code: -32614, message: "eth_getLogs is limited to a 100 range" },
      }),
    ).toBe(true);
    expect(shouldFailOver(200, { error: { code: 3, message: "execution reverted" } })).toBe(false);
    expect(shouldFailOver(200, { result: "0x1" })).toBe(false);
  });

  it("answers a repeated read within the block from its cache, with the caller's id", async () => {
    let t = 1_000;
    const { f, calls } = fakeFetch({ [B]: [ok("0x2a")] });
    const r = new Router(
      { routes: { m: { upstreams: [B], blockMs: 400 } } },
      { fetch: f, now: () => t },
    );
    const body = req("eth_call", [{ to: "0x1" }, "latest"], 1);
    expect(JSON.parse((await r.handle("m", "c:1", body))[1]).result).toBe("0x2a");
    const [, again] = await r.handle("m", "c:2", req("eth_call", [{ to: "0x1" }, "latest"], 99));
    expect(JSON.parse(again)).toEqual({ jsonrpc: "2.0", id: 99, result: "0x2a" });
    expect(calls).toHaveLength(1);
    t += 401;
    await r.handle("m", "c:1", body);
    expect(calls).toHaveLength(2);
    expect(r.stats.routes.m).toMatchObject({ calls: 3, upstreamCalls: 2, cacheHits: 1 });
    expect(r.stats.routes.m.byClient["c:1"]).toEqual({ eth_call: 2 });
  });

  it("shares cached reads between routes of one cache group", async () => {
    const { f, calls } = fakeFetch({ [B]: [ok("0x2a")] });
    const route = { upstreams: [B], blockMs: 400, cacheGroup: "monad-testnet" };
    const r = new Router({ routes: { m1: route, m2: { ...route } } }, { fetch: f });
    await r.handle("m1", "c", req("eth_blockNumber"));
    await r.handle("m2", "c", req("eth_blockNumber"));
    expect(calls).toHaveLength(1);
  });

  it("keeps the hash of each transaction a client sends", async () => {
    const { f } = fakeFetch({ [B]: [ok("0xabc")] });
    const r = new Router({ routes: { m: { upstreams: [B] } } }, { fetch: f });
    await r.handle("m", "c:9", req("eth_sendRawTransaction", ["0xff"]));
    expect(r.stats.routes.m.sent).toEqual({ "c:9": ["0xabc"] });
  });

  it("never caches a pending nonce or a send", async () => {
    const { f, calls } = fakeFetch({ [B]: [ok("0x5")] });
    const r = new Router({ routes: { m: { upstreams: [B], blockMs: 400 } } }, { fetch: f });
    await r.handle("m", "c", req("eth_getTransactionCount", ["0xab", "pending"]));
    await r.handle("m", "c", req("eth_getTransactionCount", ["0xab", "pending"]));
    await r.handle("m", "c", req("eth_sendRawTransaction", ["0xff"]));
    await r.handle("m", "c", req("eth_sendRawTransaction", ["0xff"]));
    expect(calls).toHaveLength(4);
  });

  it("moves to the next upstream on a 429 or an outage, rests the limited one, and returns a revert as it is", async () => {
    let t = 0;
    const revert = {
      status: 200,
      body: { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } },
    };
    const { f, calls } = fakeFetch({
      [B]: [{ status: 429, body: {} }, ok("0x1"), revert],
      [A]: [ok("0x9"), ok("0xa")],
    });
    const r = new Router(
      { routes: { m: { upstreams: [B, A], blockMs: 0 } } },
      { fetch: f, now: () => t },
    );
    expect(JSON.parse((await r.handle("m", "c", req("eth_blockNumber")))[1]).result).toBe("0x9");
    // The limited one rests: the next call goes to the fallback first.
    expect(JSON.parse((await r.handle("m", "c", req("eth_blockNumber")))[1]).result).toBe("0xa");
    t += 31_000;
    expect(JSON.parse((await r.handle("m", "c", req("eth_blockNumber")))[1]).result).toBe("0x1");
    const [, reverted] = await r.handle("m", "c", req("eth_call", [{}, "latest"]));
    expect(JSON.parse(reverted).error.message).toBe("execution reverted");
    expect(calls.map((c) => c.url)).toEqual([B, A, A, B, B]);
    expect(r.stats.routes.m.failovers).toBe(1);
    expect(r.stats.routes.m.upstreams).toMatchObject({
      "0:Monad public": { calls: 3, ok: 2, failedOver: 1 },
      "1:QuickNode": { calls: 2, ok: 2 },
    });
    const down = fakeFetch({ [B]: ["down"], [A]: [ok("0x3")] });
    const r2 = new Router({ routes: { m: { upstreams: [B, A], blockMs: 0 } } }, { fetch: down.f });
    expect(JSON.parse((await r2.handle("m", "c", req("eth_blockNumber")))[1]).result).toBe("0x3");
  });

  it("counts each call of a batch and passes the batch through uncached", async () => {
    const { f, calls } = fakeFetch({
      [B]: [
        {
          status: 200,
          body: [
            { id: 1, result: "0x1" },
            { id: 2, result: "0x2" },
          ],
        },
      ],
    });
    const r = new Router({ routes: { m: { upstreams: [B], blockMs: 400 } } }, { fetch: f });
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber" },
      { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{}, "latest"] },
    ]);
    await r.handle("m", "c", batch);
    expect(calls).toHaveLength(1);
    expect(r.stats.routes.m.byMethod).toEqual({ eth_blockNumber: 1, eth_call: 1 });
    expect((await r.handle("x", "c", batch))[0]).toBe(404);
  });
});
