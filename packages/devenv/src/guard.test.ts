import { spawnSync } from "node:child_process";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NotLocalForkError,
  SELECTORS,
  advanceTime,
  assertLocalFork,
  mineBlocks,
  mintTestUsdc,
  resetToBlock,
  revertToSnapshot,
  setMonBalance,
  takeSnapshot,
} from "./index.ts";

/** A local JSON-RPC server that answers like a node that is not the local anvil fork. */
function fakeNode(client: string, chainIdHex: string) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const { method } = JSON.parse(body) as { method: string };
      calls.push(method);
      const result =
        method === "web3_clientVersion" ? client : method === "eth_chainId" ? chainIdHex : null;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  return { server, calls };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("local-fork guard", () => {
  const geth = fakeNode("Geth/v1.14.0-stable/linux-amd64", "0x8f");
  const wrongChain = fakeNode("anvil/v1.8.3", "0x279f");
  let gethUrl = "";
  let wrongChainUrl = "";

  beforeAll(async () => {
    gethUrl = await listen(geth.server);
    wrongChainUrl = await listen(wrongChain.server);
  });
  afterAll(() => {
    geth.server.close();
    wrongChain.server.close();
  });

  it.each([
    ["a remote mainnet RPC", "https://rpc.provider.test/v1/LEAKCHECK-key"],
    ["a LAN address", "http://192.168.1.20:8545"],
    ["localhost by name", "http://localhost:8545"],
    ["an IPv6 loopback", "http://[::1]:8545"],
    ["not a URL", "anvil"],
  ])("refuses %s before sending anything", async (_, url) => {
    await expect(assertLocalFork(url)).rejects.toBeInstanceOf(NotLocalForkError);
  });

  it("does not put the refused URL in the error", async () => {
    await expect(assertLocalFork("https://rpc.provider.test/v1/LEAKCHECK-key")).rejects.not.toThrow(
      /LEAKCHECK/,
    );
  });

  it("refuses a node on 127.0.0.1 that is not anvil", async () => {
    await expect(assertLocalFork(gethUrl)).rejects.toThrow(/not anvil/);
  });

  it("refuses an anvil node on another chain", async () => {
    await expect(assertLocalFork(wrongChainUrl)).rejects.toThrow(/chain ID is 10143/);
  });

  it("refuses every state-changing action against a non-local RPC, without calling it", async () => {
    const remote = "https://rpc.provider.test/v1/key";
    const address = "0x1111111111111111111111111111111111111111";
    for (const action of [
      () => takeSnapshot(remote),
      () => revertToSnapshot("0x1", remote),
      () => mineBlocks(1, remote),
      () => advanceTime(60, remote),
      () => resetToBlock(109_670_000, remote),
      () => setMonBalance(address, 1n, remote),
      () => mintTestUsdc(address, 1n, remote),
    ]) {
      await expect(action()).rejects.toBeInstanceOf(NotLocalForkError);
    }
  });

  it("refuses every state-changing action against a local node that is not anvil, sending no state change", async () => {
    const address = "0x1111111111111111111111111111111111111111";
    for (const action of [
      () => takeSnapshot(gethUrl),
      () => mineBlocks(1, gethUrl),
      () => advanceTime(60, gethUrl),
      () => resetToBlock(109_670_000, gethUrl),
      () => setMonBalance(address, 1n, gethUrl),
      () => mintTestUsdc(address, 1n, gethUrl),
    ]) {
      await expect(action()).rejects.toBeInstanceOf(NotLocalForkError);
    }
    expect(new Set(geth.calls)).toEqual(new Set(["web3_clientVersion"]));
  });

  it("validates inputs before touching the node", async () => {
    await expect(mineBlocks(0)).rejects.toThrow(/from 1/);
    await expect(advanceTime(-5)).rejects.toThrow(/from 1/);
    await expect(setMonBalance("0x123", 1n)).rejects.toThrow(/address/);
    await expect(revertToSnapshot("latest")).rejects.toThrow(/hex/);
  });
});

const castAvailable = spawnSync("cast", ["--version"]).status === 0;

describe.skipIf(!castAvailable)("function selectors", () => {
  it.each([
    ["masterMinter", "masterMinter()"],
    ["configureMinter", "configureMinter(address,uint256)"],
    ["mint", "mint(address,uint256)"],
    ["balanceOf", "balanceOf(address)"],
  ] as const)("%s matches cast sig", (key, signature) => {
    const out = spawnSync("cast", ["sig", signature], { encoding: "utf8" }).stdout.trim();
    expect(SELECTORS[key]).toBe(out);
  });
});
