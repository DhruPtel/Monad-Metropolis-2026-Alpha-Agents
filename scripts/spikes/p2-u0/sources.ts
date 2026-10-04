/**
 * Every address the P2-U0 spike reads, with where it came from. Planv2 entries come from the
 * address book (packages/domain); the rest come from the venue's or the feed's official
 * documentation, fetched on 2026-10-03. The driver checks each one has code on the fork before
 * using it.
 */
import type { Address } from "viem";

export interface SourcedAddress {
  readonly id: string;
  readonly label: string;
  readonly address: Address;
  readonly source: string;
}

const FINAL_BOOK = "Planv2/FINAL_PLAN.md > 4. Components > Address book (packages/domain)";
const MORPHO = "Planv2/notes/morpho-vault.md > 2.5 (packages/domain)";
const UNI_V3 =
  "https://developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments (Uniswap v3 Monad Contracts)";
const UNI_V4 = "https://developers.uniswap.org/docs/protocols/v4/deployments (Monad, chain ID 143)";
const KURU = "https://docs.kuru.io/contracts/Contract-addresses (Monad Mainnet Contract Addresses)";
const CHAINLINK =
  "https://reference-data-directory.vercel.app/feeds-monad-mainnet.json (Chainlink reference data, aggregator of the proxy)";

export const ADDR = {
  usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  wmon: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
  monUsd: "0xBcD78f76005B7515837af6b50c7C52BCf73822fb",
  usdcUsd: "0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec",
  ethUsd: "0x1B1414782B859871781bA3E4B0979b9ca57A0A04",
  v3Factory: "0x204faca1764b154221e35c0d20abb3c525710498",
  v3QuoterV2: "0x661e93cca42afacb172121ef892830ca3b70f08d",
  v3SwapRouter02: "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900",
  v4PoolManager: "0x188d586ddcf52439676ca21a244753fa19f9ea8e",
  v4StateView: "0x77395f3b2e73ae90843717371294fa97cc419d64",
  v4Quoter: "0xa222dd357a9076d1091ed6aa2e16c9742dd26891",
  kuruRouter: "0xd651346d7c789536ebf06dc72aE3C8502cd695CC",
  kuruMarginAccount: "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5",
  kuruMonUsdc: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394",
} as const satisfies Record<string, Address>;

export const SOURCES: readonly SourcedAddress[] = [
  { id: "usdc", label: "USDC", address: ADDR.usdc, source: FINAL_BOOK },
  { id: "wmon", label: "WMON", address: ADDR.wmon, source: FINAL_BOOK },
  {
    id: "chainlink_mon_usd",
    label: "Chainlink MON/USD proxy",
    address: ADDR.monUsd,
    source: FINAL_BOOK,
  },
  {
    id: "chainlink_usdc_usd",
    label: "Chainlink USDC/USD proxy",
    address: ADDR.usdcUsd,
    source: FINAL_BOOK,
  },
  {
    id: "chainlink_eth_usd",
    label: "Chainlink ETH/USD proxy",
    address: ADDR.ethUsd,
    source: MORPHO,
  },
  {
    id: "uniswap_v3_factory",
    label: "Uniswap v3 factory",
    address: ADDR.v3Factory,
    source: `${FINAL_BOOK}; ${UNI_V3}`,
  },
  {
    id: "uniswap_v3_quoter_v2",
    label: "Uniswap v3 QuoterV2",
    address: ADDR.v3QuoterV2,
    source: UNI_V3,
  },
  {
    id: "uniswap_v3_swap_router02",
    label: "Uniswap v3 SwapRouter02",
    address: ADDR.v3SwapRouter02,
    source: `${FINAL_BOOK}; ${UNI_V3}`,
  },
  {
    id: "uniswap_v4_pool_manager",
    label: "Uniswap v4 PoolManager",
    address: ADDR.v4PoolManager,
    source: `${FINAL_BOOK}; ${UNI_V4}`,
  },
  {
    id: "uniswap_v4_state_view",
    label: "Uniswap v4 StateView",
    address: ADDR.v4StateView,
    source: `${FINAL_BOOK}; ${UNI_V4}`,
  },
  { id: "uniswap_v4_quoter", label: "Uniswap v4 Quoter", address: ADDR.v4Quoter, source: UNI_V4 },
  {
    id: "kuru_router",
    label: "Kuru Router (market factory)",
    address: ADDR.kuruRouter,
    source: KURU,
  },
  {
    id: "kuru_margin_account",
    label: "Kuru MarginAccount",
    address: ADDR.kuruMarginAccount,
    source: KURU,
  },
  {
    id: "kuru_market_mon_usdc",
    label: "Kuru MON-USDC market",
    address: ADDR.kuruMonUsdc,
    source: KURU,
  },
];

export const FEED_SOURCE = CHAINLINK;
/** Monad Foundation's public RPC: serves eth_getLogs over 100,000-block ranges (the keyed RPC allows 10). */
export const LOGS_RPC = "https://rpc1.monad.xyz";
