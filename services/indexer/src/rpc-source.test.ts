import { describe, expect, it } from "vitest";
import { RpcError, RpcLogSource, classifyRpcFailure } from "./rpc-source.ts";
import { RangeTooLargeError } from "./source.ts";

const URL_WITH_KEY = "https://rpc.example/secret-api-key-123";

function scripted(...replies: { status?: number; body: unknown }[]) {
  const seen: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)).method as string);
    const reply = replies.shift() ?? { body: { jsonrpc: "2.0", id: 1, result: "0x1" } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

describe("classifyRpcFailure (L-21)", () => {
  it.each([
    [429, undefined, "Too Many Requests", "rate-limit"],
    [200, -32005, "rate limit exceeded", "rate-limit"],
    [200, -32005, "query returned more than 10000 results", "range"],
    [200, -32602, "block range is too large", "range"],
    [200, -32000, "eth_getLogs is limited to a 100 range", "range"],
    [200, -32603, "internal error", "other"],
  ] as const)("HTTP %i, code %s, %s: %s", (status, code, message, want) => {
    expect(classifyRpcFailure(status, code, message)).toBe(want);
  });
});

describe("RpcLogSource", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  it("backs off on a rate limit and retries the same request", async () => {
    sleeps.length = 0;
    const { fetchFn, seen } = scripted(
      { status: 429, body: {} },
      { body: { jsonrpc: "2.0", id: 2, error: { code: -32005, message: "rate limited" } } },
      { body: { jsonrpc: "2.0", id: 3, result: "0x10" } },
    );
    const source = new RpcLogSource({ url: URL_WITH_KEY, fetch: fetchFn, sleep, baseDelayMs: 100 });
    expect(await source.head()).toBe(16);
    expect(seen).toEqual(["eth_blockNumber", "eth_blockNumber", "eth_blockNumber"]);
    expect(sleeps).toEqual([100, 200]);
  });

  it("reports a refused range for the poller to split, without retrying", async () => {
    const { fetchFn, seen } = scripted({
      body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "block range too large" } },
    });
    const source = new RpcLogSource({ url: URL_WITH_KEY, fetch: fetchFn, sleep });
    await expect(
      source.logs({
        address: "0x0000000000000000000000000000000000000001",
        fromBlock: 1,
        toBlock: 5000,
      }),
    ).rejects.toBeInstanceOf(RangeTooLargeError);
    expect(seen).toHaveLength(1);
  });

  it("never puts the RPC URL in an error", async () => {
    const { fetchFn } = scripted({
      body: { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal error" } },
    });
    const source = new RpcLogSource({ url: URL_WITH_KEY, fetch: fetchFn, sleep });
    const err = await source.head().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(String((err as Error).message)).not.toContain("secret-api-key");
    const failing = (async () => {
      throw new TypeError(`fetch failed for ${URL_WITH_KEY}`);
    }) as unknown as typeof fetch;
    const down = new RpcLogSource({ url: URL_WITH_KEY, fetch: failing, sleep });
    const netErr = await down.head().catch((e: unknown) => e);
    expect(String((netErr as Error).message)).not.toContain("secret-api-key");
  });

  it("drops logs the node marks removed", async () => {
    const log = {
      address: "0x01",
      topics: [],
      data: "0x",
      blockNumber: "0x2",
      blockHash: "0xaa",
      transactionHash: "0xbb",
      logIndex: "0x0",
    };
    const { fetchFn } = scripted({
      body: { jsonrpc: "2.0", id: 1, result: [log, { ...log, logIndex: "0x1", removed: true }] },
    });
    const source = new RpcLogSource({ url: URL_WITH_KEY, fetch: fetchFn, sleep });
    const logs = await source.logs({
      address: "0x0000000000000000000000000000000000000001",
      fromBlock: 1,
      toBlock: 2,
    });
    expect(logs.map((l) => l.logIndex)).toEqual([0]);
  });
});

describe("RpcLogSource failover (P2-EC)", () => {
  const PRIMARY = "https://primary.example/key-a";
  const FALLBACK = "https://fallback.example/key-b";

  /** A primary that fails in the given way and a fallback that answers; records which URL got each call. */
  function twoProviders(primary: "refused" | 429 | 503 | "ok") {
    const hits: string[] = [];
    const fetchFn = (async (url: string) => {
      const which = url === PRIMARY ? "primary" : "fallback";
      hits.push(which);
      if (which === "primary" && primary === "refused") throw new TypeError("fetch failed");
      if (which === "primary" && typeof primary === "number")
        return new Response(JSON.stringify({ error: { message: "busy" } }), { status: primary });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: which === "primary" ? "0x1" : "0x2" }),
      );
    }) as unknown as typeof fetch;
    return { fetchFn, hits };
  }

  it.each(["refused", 429, 503] as const)(
    "moves a call to the fallback when the primary is %s",
    async (failure) => {
      const { fetchFn, hits } = twoProviders(failure);
      const source = new RpcLogSource({
        url: PRIMARY,
        fallbackUrl: FALLBACK,
        fetch: fetchFn,
        sleep: async () => undefined,
      });
      expect(await source.head()).toBe(2);
      expect(hits).toEqual(["primary", "fallback"]);
      expect(source.failovers).toBe(1);
    },
  );

  it("stays on the fallback for a minute, then tries the primary again", async () => {
    let now = 0;
    const { fetchFn, hits } = twoProviders(503);
    const source = new RpcLogSource({
      url: PRIMARY,
      fallbackUrl: FALLBACK,
      fetch: fetchFn,
      sleep: async () => undefined,
      now: () => now,
    });
    await source.head();
    now = 30_000;
    await source.head();
    expect(hits).toEqual(["primary", "fallback", "fallback"]);
    now = 61_000;
    await source.head();
    expect(hits.slice(3)).toEqual(["primary", "fallback"]);
  });

  it("never moves a range refusal: that is about the request, not the provider", async () => {
    const hits: string[] = [];
    const fetchFn = (async (url: string) => {
      hits.push(url === PRIMARY ? "primary" : "fallback");
      return new Response(
        JSON.stringify({ error: { code: -32600, message: "up to a 10 block range" } }),
      );
    }) as unknown as typeof fetch;
    const source = new RpcLogSource({ url: PRIMARY, fallbackUrl: FALLBACK, fetch: fetchFn });
    await expect(
      source.logs({ address: PRIMARY as never, fromBlock: 1, toBlock: 100 }),
    ).rejects.toBeInstanceOf(RangeTooLargeError);
    expect(hits).toEqual(["primary"]);
  });

  it("reports each provider's chain, so a wrong-chain fallback is refused at start", async () => {
    const fetchFn = (async (url: string) =>
      new Response(
        JSON.stringify({ result: url === PRIMARY ? "0x279f" : "0x8f" }),
      )) as unknown as typeof fetch;
    const source = new RpcLogSource({ url: PRIMARY, fallbackUrl: FALLBACK, fetch: fetchFn });
    expect(await source.chainIds()).toEqual([10143, 143]);
  });

  it("puts neither URL in an error when both providers fail", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const source = new RpcLogSource({
      url: PRIMARY,
      fallbackUrl: FALLBACK,
      fetch: fetchFn,
      maxRetries: 0,
    });
    const err = await source.head().catch((e: unknown) => e as Error);
    expect(String(err)).not.toMatch(/key-a|key-b|example/);
  });
});
