import { APP_CHAINS } from "@alpha-agents/config";
import { describe, expect, it } from "vitest";
import { type Rpc, checkWalletNetwork, walletNetworkName } from "./network-check";

const AGENT_NFT = "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E" as const;
const PIN = 109_670_000n;
const PIN_TAG = `0x${PIN.toString(16)}`;
const local = APP_CHAINS.local;

/** The pinned block's hash, which the fork shares with Monad mainnet. */
const MAINNET_PIN_HASH = "0x2ea4dc887103736c3f5e5ae20efca5d17600c98acf24ae226059d7e6e8eccd9a";

/**
 * A node as an RPC sees it: its chain ID, its blocks by number, the block it
 * calls "latest", and AgentNFT's code.
 */
function node(options: {
  chainId: number;
  blocks: Record<string, string>;
  latest: string;
  code: string;
}): Rpc {
  return async (method, params) => {
    if (method === "eth_chainId") return `0x${options.chainId.toString(16)}`;
    if (method === "eth_getBlockByNumber") {
      const tag = params[0] === "latest" ? options.latest : String(params[0]);
      const hash = options.blocks[tag];
      return hash ? { number: tag, hash } : null;
    }
    if (method === "eth_getCode") return options.code;
    throw new Error(`unexpected ${method}`);
  };
}

// The running fork: mainnet's history up to the pin, then its own block with
// the AgentNFT deployment.
const FORK = node({
  chainId: 143143,
  blocks: { [PIN_TAG]: MAINNET_PIN_HASH, "0x6896f71": "0xf1f1" },
  latest: "0x6896f71",
  code: "0x6080abcd",
});

const check = (wallet: Rpc, app: Rpc = FORK) =>
  checkWalletNetwork({ wallet, app, target: local, referenceBlock: PIN, contract: AGENT_NFT });

describe("checkWalletNetwork", () => {
  it("passes a wallet on the fork", async () => {
    expect(await check(FORK)).toEqual({ ok: true });
  });

  it("passes a wallet on the fork that reports a stale latest block (the OKX case, L-57)", async () => {
    // The wallet's cached "latest" is from an earlier fork run: another hash
    // at the same number, and the node behind it is the right one.
    const stale = node({
      chainId: 143143,
      blocks: { [PIN_TAG]: MAINNET_PIN_HASH, "0x6896f71": "0xdead" },
      latest: "0x6896f71",
      code: "0x6080abcd",
    });
    const wallet: Rpc = async (method, params) =>
      method === "eth_getBlockByNumber" && params[0] === "latest"
        ? stale(method, params)
        : FORK(method, params);
    expect(await check(wallet)).toEqual({ ok: true });
  });

  it("fails a wallet on real Monad mainnet (chain ID 143), saying so", async () => {
    const mainnet = node({
      chainId: 143,
      blocks: { [PIN_TAG]: MAINNET_PIN_HASH, "0x69b2a08": "0xaaaa" },
      latest: "0x69b2a08",
      code: "0x",
    });
    const result = await check(mainnet);
    expect(result).toMatchObject({ ok: false, reason: "wrong-chain-id" });
    if (result.ok) return;
    expect(result.message).toBe(
      "Your wallet is on Monad mainnet (chain ID 143), but this app uses Monad (local fork) (chain ID 143143). Nothing was sent. In your wallet, use Monad (local fork): chain ID 143143, RPC URL http://127.0.0.1:8545.",
    );
  });

  it("fails a wallet on chain 143143 pointed at a different node", async () => {
    const otherNode = node({
      chainId: 143143,
      blocks: { [PIN_TAG]: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      latest: PIN_TAG,
      code: "0x6080abcd",
    });
    const result = await check(otherNode);
    expect(result).toMatchObject({ ok: false, reason: "different-block" });
    if (result.ok) return;
    expect(result.message).toContain(
      "Your wallet's network uses chain ID 143143 but is a different node from the one this app reads",
    );
    expect(result.message).toContain("at block 109670000 it has block 0xbbbbbbbb…");
  });

  it("fails a node forked at the same block without AgentNFT", async () => {
    const bareFork = node({
      chainId: 143143,
      blocks: { [PIN_TAG]: MAINNET_PIN_HASH },
      latest: PIN_TAG,
      code: "0x",
    });
    const result = await check(bareFork);
    expect(result).toMatchObject({ ok: false, reason: "no-contract-in-wallet" });
  });

  it("blames the app's side when AgentNFT is not deployed on the fork", async () => {
    const undeployed = node({
      chainId: 143143,
      blocks: { [PIN_TAG]: MAINNET_PIN_HASH },
      latest: PIN_TAG,
      code: "0x",
    });
    const result = await check(undeployed, undeployed);
    expect(result).toMatchObject({ ok: false, reason: "no-contract-in-app" });
    if (!result.ok) expect(result.message).toContain("Deploy it with pnpm deploy:agent-nft");
  });

  it("says the wallet did not answer, instead of naming another network", async () => {
    const result = await check(() => Promise.reject(new Error("method not supported")));
    expect(result).toMatchObject({ ok: false, reason: "wallet-unreachable" });
    if (!result.ok) {
      expect(result.message).toContain("Your wallet did not answer a request for its chain ID");
      expect(result.message).not.toContain("network that reports");
    }
  });

  it("never names the target as the wallet's other network", async () => {
    // Every failure message for a wallet on the target's chain ID must not
    // claim the wallet is somewhere else by chain ID (the contradiction).
    for (const wallet of [
      node({ chainId: 143143, blocks: {}, latest: PIN_TAG, code: "0x6080abcd" }),
      node({
        chainId: 143143,
        blocks: { [PIN_TAG]: MAINNET_PIN_HASH },
        latest: PIN_TAG,
        code: "0x",
      }),
    ]) {
      const result = await check(wallet);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toMatch(/not Monad \(local fork\)/);
    }
  });
});

describe("walletNetworkName", () => {
  it("names Monad mainnet and other chains with their chain ID", () => {
    expect(walletNetworkName(143, local)).toBe("Monad mainnet (chain ID 143)");
    expect(walletNetworkName(10143, local)).toBe("Monad Testnet (chain ID 10143)");
    expect(walletNetworkName(56, local)).toBe("another network (chain ID 56)");
  });
});
