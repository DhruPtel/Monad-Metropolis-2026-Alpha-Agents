import { APP_CHAINS } from "@alpha-agents/config";
import { describe, expect, it } from "vitest";
import { chainName, deriveState, viemChain } from "./session";

const base = {
  initializing: false,
  pending: false,
  authenticated: true,
  address: "0x00000000000000000000000000000000000e2e01",
  chainId: 143,
  targetChainId: 143,
};

describe("deriveState", () => {
  it.each([
    ["connected on the target chain", {}, "connected"],
    ["on another chain", { chainId: 1 }, "wrong-chain"],
    ["logged out", { authenticated: false, address: undefined, chainId: undefined }, "logged-out"],
    ["still loading Privy", { initializing: true, authenticated: false }, "connecting"],
    ["waiting for the wallet", { pending: true, authenticated: false }, "connecting"],
    ["authenticated before the wallet reports", { address: undefined }, "connecting"],
    ["after a failed login", { error: "Rejected", authenticated: false }, "error"],
  ] as const)("is right when %s", (_, override, state) => {
    expect(deriveState({ ...base, ...override })).toBe(state);
  });
});

describe("chains", () => {
  it.each(["local", "testnet", "beta"] as const)("turns %s into a viem chain", (env) => {
    const chain = viemChain(APP_CHAINS[env]);
    expect(chain.id).toBe(APP_CHAINS[env].id);
    expect(chain.rpcUrls.default.http).toEqual([APP_CHAINS[env].browserRpcUrl]);
  });

  it("treats a wallet on Monad mainnet as the wrong chain for the local fork (L-53)", () => {
    const local = APP_CHAINS.local;
    expect(local.id).toBe(143143);
    expect(deriveState({ ...base, chainId: 143, targetChainId: local.id })).toBe("wrong-chain");
    expect(chainName(143, local)).toBe("Monad");
    expect(chainName(local.id, local)).toBe("Monad (local fork)");
  });

  it("names the wallet's chain", () => {
    const target = APP_CHAINS.testnet;
    expect(chainName(10143, target)).toBe("Monad Testnet");
    expect(chainName(1, target)).toBe("Ethereum");
    expect(chainName(143, target)).toBe("Monad");
    expect(chainName(56, target)).toBe("chain 56");
    expect(chainName(undefined, target)).toBeUndefined();
  });
});
