import { APP_CHAINS } from "@alpha-agents/config";
import { describe, expect, it } from "vitest";
import { type Rpc, checkWalletNetwork, walletNetworkName } from "./network-check";

const AGENT_NFT = "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E" as const;
const local = APP_CHAINS.local;

/** A chain as an RPC sees it: its blocks by number and its contracts' code. */
function chain(blocks: Record<string, string>, head: string, code: string): Rpc {
  return async (method, params) => {
    if (method === "eth_getBlockByNumber") {
      const tag = params[0] === "latest" ? head : String(params[0]);
      const hash = blocks[tag];
      return hash ? { number: tag, hash } : null;
    }
    if (method === "eth_getCode") return code;
    throw new Error(`unexpected ${method}`);
  };
}

const FORK = chain({ "0x68979f2": "0xf0f0", "0x68979f3": "0xf1f1" }, "0x68979f3", "0x6080abcd");
// Mainnet is far ahead of the fork's head, and AgentNFT has no code there.
const MAINNET = chain({ "0x69b2a08": "0xaaaa" }, "0x69b2a08", "0x");
const noSleep = async () => undefined;

describe("checkWalletNetwork", () => {
  it("passes when the wallet and the app see the same latest block and code", async () => {
    const result = await checkWalletNetwork({
      wallet: FORK,
      app: FORK,
      target: local,
      walletChainId: local.id,
      contract: AGENT_NFT,
      sleep: noSleep,
    });
    expect(result).toEqual({ ok: true });
  });

  it("refuses a wallet on Monad mainnet and names it (the L-53 mint)", async () => {
    const result = await checkWalletNetwork({
      wallet: MAINNET,
      app: FORK,
      target: local,
      walletChainId: 143,
      contract: AGENT_NFT,
      sleep: noSleep,
    });
    expect(result).toMatchObject({ ok: false, reason: "different-blocks" });
    if (result.ok) return;
    expect(result.message).toContain("Your wallet is on Monad mainnet, not Monad (local fork)");
    expect(result.message).toContain("Nothing was sent");
    expect(result.message).toContain("chain ID 143143, RPC URL http://127.0.0.1:8545");
  });

  it("refuses a network that reports the fork's chain ID but has other blocks", async () => {
    const lookalike = chain({ "0x68979f3": "0xbeef" }, "0x68979f3", "0x6080abcd");
    const result = await checkWalletNetwork({
      wallet: lookalike,
      app: FORK,
      target: local,
      walletChainId: local.id,
      contract: AGENT_NFT,
      sleep: noSleep,
    });
    expect(result).toMatchObject({ ok: false, reason: "different-blocks" });
    if (!result.ok) expect(result.message).toContain("a network that reports chain 143143");
  });

  it("refuses when the same block shows different contract code", async () => {
    const sameBlocksNoContract = chain({ "0x68979f3": "0xf1f1" }, "0x68979f3", "0x");
    const result = await checkWalletNetwork({
      wallet: sameBlocksNoContract,
      app: FORK,
      target: local,
      walletChainId: local.id,
      contract: AGENT_NFT,
      sleep: noSleep,
    });
    expect(result).toMatchObject({ ok: false, reason: "different-code" });
  });

  it("waits for an app RPC that is a block behind the wallet's", async () => {
    let calls = 0;
    const lagging: Rpc = async (method, params) => {
      if (method === "eth_getBlockByNumber" && params[0] === "0x68979f3" && calls++ === 0) {
        return null;
      }
      return FORK(method, params);
    };
    const slept: number[] = [];
    const result = await checkWalletNetwork({
      wallet: FORK,
      app: lagging,
      target: local,
      walletChainId: local.id,
      contract: AGENT_NFT,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(result).toEqual({ ok: true });
    expect(slept).toEqual([1_000]);
  });

  it("says so when the wallet does not answer", async () => {
    const result = await checkWalletNetwork({
      wallet: () => Promise.reject(new Error("locked")),
      app: FORK,
      target: local,
      walletChainId: local.id,
      contract: AGENT_NFT,
      sleep: noSleep,
    });
    expect(result).toMatchObject({ ok: false, reason: "wallet-unreachable" });
  });
});

describe("walletNetworkName", () => {
  it("names Monad mainnet, the target's lookalike, and other chains", () => {
    expect(walletNetworkName(143, local)).toBe("Monad mainnet");
    expect(walletNetworkName(143143, local)).toBe("a network that reports chain 143143");
    expect(walletNetworkName(10143, local)).toBe("Monad Testnet");
    expect(walletNetworkName(undefined, local)).toBe("an unknown network");
  });
});
