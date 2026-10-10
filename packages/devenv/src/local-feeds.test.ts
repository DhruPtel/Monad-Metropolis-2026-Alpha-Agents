import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LOCAL_FORK_CHAIN_ID, MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import { type Address, CLASS_F_FEEDS, addressEntry } from "@alpha-agents/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotLocalForkError } from "./guard.ts";
import { LOCAL_FEED_RUNTIME_CODE } from "./local-feed-code.ts";
import { localFeedAddresses, localFeedsInstalled, refreshLocalFeeds } from "./local-feeds.ts";
import { rpc } from "./rpc.ts";

/**
 * The local feed refresher (D-237) must be impossible to use anywhere but the
 * local anvil fork. These tests prove it refuses a remote RPC, a local node
 * that is not anvil and an anvil on another chain, before sending anything
 * that changes state; then they run it on a throwaway anvil of its own (never
 * the playtest fork on 8545).
 */
const feeds = localFeedAddresses();

describe("the feeds the refresher keeps fresh (F-U3 step 0)", () => {
  it("lists MON/USD and USDC/USD first, then every other class F feed leg once", () => {
    expect(feeds[0]).toBe(addressEntry("local", "chainlink_mon_usd").address);
    expect(feeds[1]).toBe(addressEntry("local", "chainlink_usdc_usd").address);
    const legs = new Set<string>();
    for (const f of CLASS_F_FEEDS) for (const l of f.legs) legs.add(l.proxy.toLowerCase());
    expect(new Set(feeds.map((a) => a.toLowerCase()))).toEqual(legs);
    expect(feeds.length).toBe(legs.size);
    expect(feeds.length).toBeGreaterThanOrEqual(20);
  });
});

/** A local JSON-RPC server that records every method it is sent. */
function fakeNode(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      calls.push(method);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: answers[method] ?? null }));
    });
  });
  return { server, calls };
}

describe("the local feed refresher refuses every network but the local fork", () => {
  const geth = fakeNode({ web3_clientVersion: "Geth/v1.14.0", eth_chainId: "0x8f" });
  const wrongChain = fakeNode({
    web3_clientVersion: "anvil/v1.8.3",
    eth_chainId: `0x${MONAD_MAINNET_CHAIN_ID.toString(16)}`,
  });
  let gethUrl = "";
  let wrongUrl = "";
  beforeAll(async () => {
    for (const n of [geth, wrongChain])
      await new Promise<void>((r) => n.server.listen(0, "127.0.0.1", r));
    gethUrl = `http://127.0.0.1:${(geth.server.address() as AddressInfo).port}`;
    wrongUrl = `http://127.0.0.1:${(wrongChain.server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    geth.server.close();
    wrongChain.server.close();
  });

  it("refuses a remote RPC (testnet, mainnet) before sending any request", async () => {
    for (const url of [
      "https://rpc.monad.xyz",
      "https://testnet-rpc.monad.xyz",
      "http://10.0.0.5:8545",
    ]) {
      await expect(refreshLocalFeeds(url)).rejects.toBeInstanceOf(NotLocalForkError);
    }
  });

  it("refuses a local node that is not anvil, asking it only who it is", async () => {
    await expect(refreshLocalFeeds(gethUrl)).rejects.toBeInstanceOf(NotLocalForkError);
    expect(new Set(geth.calls)).toEqual(new Set(["web3_clientVersion"]));
  });

  it("refuses an anvil serving Monad mainnet's chain ID, sending nothing that changes state", async () => {
    await expect(refreshLocalFeeds(wrongUrl)).rejects.toBeInstanceOf(NotLocalForkError);
    expect(wrongChain.calls.every((m) => m === "web3_clientVersion" || m === "eth_chainId")).toBe(
      true,
    );
  });
});

const PORT = 8573;
const URL = `http://127.0.0.1:${PORT}`;
const haveAnvil = spawnSync("anvil", ["--version"]).status === 0;

describe.skipIf(!haveAnvil)(
  "the local feed refresher on an anvil of its own",
  { timeout: 30_000 },
  () => {
    let anvil: ChildProcess;
    const feed = feeds[0] as Address;

    beforeAll(async () => {
      anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", String(LOCAL_FORK_CHAIN_ID)], {
        stdio: "ignore",
      });
      for (let i = 0; i < 50; i += 1) {
        if (await rpc(URL, "eth_chainId").catch(() => null)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      // A feed already swapped: LocalFeed at the address with round 41, 8 decimals, $0.0343682.
      await rpc(URL, "anvil_setCode", [feed, LOCAL_FEED_RUNTIME_CODE]);
      const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
      await rpc(URL, "anvil_setStorageAt", [feed, "0x0", word(41n | (8n << 80n))]);
      await rpc(URL, "anvil_setStorageAt", [feed, "0x1", word(3_436_820n)]);
      await rpc(URL, "anvil_setStorageAt", [feed, "0x2", word(1n)]);
    });
    afterAll(() => {
      anvil?.kill("SIGTERM");
    });

    const round = async () => {
      const r = (await rpc(URL, "eth_call", [
        { to: feed, data: "0xfeaf968c" },
        "latest",
      ])) as string;
      return {
        roundId: BigInt(`0x${r.slice(2, 66)}`),
        answer: BigInt(`0x${r.slice(66, 130)}`),
        updatedAt: BigInt(`0x${r.slice(194, 258)}`),
      };
    };

    it("re-dates the answer to the latest block, keeps it, and mines nothing", async () => {
      await rpc(URL, "evm_increaseTime", ["0x15180"]);
      await rpc(URL, "evm_mine");
      const head = (await rpc(URL, "eth_getBlockByNumber", ["latest", false])) as {
        number: string;
        timestamp: string;
      };
      const [written] = await refreshLocalFeeds(URL, [feed]);
      const after = (await rpc(URL, "eth_getBlockByNumber", ["latest", false])) as {
        number: string;
      };
      expect(after.number).toBe(head.number);
      expect(await round()).toEqual({
        roundId: 42n,
        answer: 3_436_820n,
        updatedAt: BigInt(head.timestamp),
      });
      expect(written).toMatchObject({ decimals: 8, down: false });
      expect(await localFeedsInstalled(URL, [feed])).toBe(true);
    });

    it("sets a new answer, a negative one included, and takes a feed down and back up", async () => {
      await refreshLocalFeeds(URL, [feed], { [feed.toLowerCase()]: { answer: -7n } });
      const r = await round();
      expect(r.answer).toBe(2n ** 256n - 7n);
      await refreshLocalFeeds(URL, [feed], { [feed.toLowerCase()]: { down: true } });
      await expect(round()).rejects.toThrow();
      await refreshLocalFeeds(URL, [feed], {
        [feed.toLowerCase()]: { down: false, answer: 3_436_820n },
      });
      expect((await round()).answer).toBe(3_436_820n);
    });

    it("skips an address with no code, leaving it empty, and still refreshes the rest", async () => {
      // On this bare anvil the other class F feeds have no code (the fork would have them).
      const empty = feeds[1] as Address;
      const written = await refreshLocalFeeds(URL, [empty, feed]);
      expect(written.map((w) => w.feed)).toEqual([feed]);
      expect(await rpc(URL, "eth_getCode", [empty, "latest"])).toBe("0x");
      expect(await localFeedsInstalled(URL, [feed])).toBe(true);
      expect(await localFeedsInstalled(URL, [empty, feed])).toBe(false);
    });
  },
);
