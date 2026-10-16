import { TESTNET_CHAIN, TESTNET_CHAINS, type TestnetChainKey } from "@alpha-agents/config";

/**
 * CO-U1: one web build per testnet, siloed (no bridging); the network switcher moves between
 * their sites. Each site's API is its own chain's stack on the server.
 */
export const NETWORK_SITES: Readonly<Record<TestnetChainKey, string>> = {
  monad: "https://vivarium-testnet.vercel.app",
  "base-sepolia": "https://vivarium-base.vercel.app",
  "arbitrum-sepolia": "https://vivarium-arbitrum.vercel.app",
  // 2026-10-16: the dev stack's site (nad.fun's tokens), offered only on its own build.
  "monad-dev": "https://vivarium-dev.vercel.app",
};

export const NETWORK_OPTIONS = (Object.keys(NETWORK_SITES) as TestnetChainKey[])
  .filter((key) => key !== "monad-dev" || TESTNET_CHAIN.key === "monad-dev")
  .map((key) => ({
    key,
    name: TESTNET_CHAINS[key].name,
    site: NETWORK_SITES[key],
  }));

/** This build's testnet (TESTNET_CHAIN, inlined by next.config.ts). */
export const CURRENT_NETWORK: TestnetChainKey = TESTNET_CHAIN.key;
