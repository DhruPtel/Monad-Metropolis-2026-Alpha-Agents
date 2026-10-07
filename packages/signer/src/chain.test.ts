import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { ViemChainClient } from "./chain.ts";

/**
 * The signer's two RPC providers (P2-U4 item 9), against stub JSON-RPC
 * servers: reads fall over to the secondary, receipts ask the secondary
 * first, both must answer the pinned chain, a broadcast goes to the
 * secondary only when the primary never answered, and a timeout is unknown.
 */
type Handler = (method: string, params: unknown[]) => unknown;

interface Stub {
  readonly url: string;
  readonly calls: string[];
  close(): Promise<void>;
}

const servers: Server[] = [];

async function stub(handle: Handler, delayMs = 0): Promise<Stub> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params: unknown[];
      };
      calls.push(method);
      const reply = () => {
        try {
          const result = handle(method, params);
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (err) {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: (err as Error).message },
            }),
          );
        }
      };
      if (delayMs) setTimeout(reply, delayMs);
      else reply();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** A port nothing listens on: a provider that never answers. */
async function deadUrl(): Promise<string> {
  const s = await stub(() => null);
  await s.close();
  return s.url;
}

const HASH = `0x${"ab".repeat(32)}` as Hex;
const RECEIPT = {
  transactionHash: HASH,
  transactionIndex: "0x0",
  blockHash: `0x${"cd".repeat(32)}`,
  blockNumber: "0x10",
  from: "0x0000000000000000000000000000000000000001",
  to: "0x0000000000000000000000000000000000000002",
  cumulativeGasUsed: "0x1",
  gasUsed: "0xf4240",
  effectiveGasPrice: "0x1",
  contractAddress: null,
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  status: "0x1",
  type: "0x2",
};

const chainOf =
  (id: number): Handler =>
  (method) => {
    if (method === "eth_chainId") return `0x${id.toString(16)}`;
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_getTransactionReceipt") return RECEIPT;
    if (method === "eth_sendRawTransaction") return HASH;
    throw new Error(`unexpected ${method}`);
  };

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

describe("the signer's two RPC providers (P2-U4 item 9)", () => {
  it("falls over to the secondary when the primary does not answer", async () => {
    const secondary = await stub(chainOf(143143));
    const c = new ViemChainClient({
      chainId: 143143,
      primaryUrl: await deadUrl(),
      secondaryUrl: secondary.url,
    });
    expect(await c.nonce("0x0000000000000000000000000000000000000001", "latest")).toBe(7);
    expect(secondary.calls).toContain("eth_getTransactionCount");
  });

  it("asks the secondary for receipts first", async () => {
    const primary = await stub(chainOf(143143));
    const secondary = await stub(chainOf(143143));
    const c = new ViemChainClient({
      chainId: 143143,
      primaryUrl: primary.url,
      secondaryUrl: secondary.url,
    });
    const r = await c.receipt(HASH);
    expect(r).toMatchObject({ status: "success", blockNumber: 16n, gasUsed: 1_000_000n });
    expect(secondary.calls).toEqual(["eth_getTransactionReceipt"]);
    expect(primary.calls).toEqual([]);
  });

  it("refuses to start unless both providers answer the pinned chain", async () => {
    const fork = await stub(chainOf(143143));
    const mainnet = await stub(chainOf(143));
    const c = new ViemChainClient({
      chainId: 143143,
      primaryUrl: fork.url,
      secondaryUrl: mainnet.url,
    });
    await expect(c.verifyChain()).rejects.toThrow("answers chain 143, not the pinned 143143");
  });

  it("sends the same signed bytes to the secondary only when the primary never answered", async () => {
    const secondary = await stub(chainOf(143143));
    const c = new ViemChainClient({
      chainId: 143143,
      primaryUrl: await deadUrl(),
      secondaryUrl: secondary.url,
    });
    expect(await c.sendRaw("0x02f8")).toEqual({ kind: "accepted" });
    expect(secondary.calls).toEqual(["eth_sendRawTransaction"]);

    const refusing = await stub((m) => {
      if (m === "eth_sendRawTransaction")
        throw new Error("insufficient funds for gas * price + value");
      return null;
    });
    const second = await stub(chainOf(143143));
    const c2 = new ViemChainClient({
      chainId: 143143,
      primaryUrl: refusing.url,
      secondaryUrl: second.url,
    });
    expect(await c2.sendRaw("0x02f8")).toMatchObject({ kind: "rejected", nonceConsumed: false });
    expect(second.calls).toEqual([]);
  });

  it("calls a broadcast that times out unknown, and a used nonce consumed", async () => {
    const slow = await stub(chainOf(143143), 500);
    const c = new ViemChainClient({ chainId: 143143, primaryUrl: slow.url, timeoutMs: 100 });
    expect((await c.sendRaw("0x02f8")).kind).toBe("unknown");
    const low = await stub((m) => {
      if (m === "eth_sendRawTransaction") throw new Error("nonce too low");
      return null;
    });
    expect(
      await new ViemChainClient({ chainId: 143143, primaryUrl: low.url }).sendRaw("0x02f8"),
    ).toMatchObject({
      kind: "rejected",
      nonceConsumed: true,
    });
  });
});
