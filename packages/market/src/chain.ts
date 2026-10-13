import {
  BASE_TOKENS,
  MONAD_BASE_TOKENS,
  UNISWAP_V4_BASE_ETH_USDC_POOL,
  UNISWAP_V4_MON_USDC_POOL,
} from "@alpha-agents/domain";

/**
 * The chain research reads (M-FAST). Every upstream identifier the market
 * package carried for Monad (GeckoTerminal's network and DEX ids, DefiLlama's
 * chain and coin, CoinGecko's and CoinMarketCap's platform, the address book
 * environment whose external entries are this chain's, the hookless v4
 * native/USDC pool the depth and the oracle cross-check read) lives here per
 * chain. The process picks one chain at start: MARKET_CHAIN names it, else
 * APP_ENV=base means Base, else Monad; everything else keeps reading the
 * module constants, which are derived from the pick. M-U4 threads the chain
 * through the constructors instead; this is the fast path for one process
 * per chain (A-98).
 */
export type MarketChainKey = "monad" | "base";
/** What every chain tool result carries as `chain`. */
export type MarketChainLabel = "monad-mainnet" | "base-mainnet";

export interface MarketChain {
  readonly key: MarketChainKey;
  readonly chainId: number;
  readonly label: MarketChainLabel;
  /** The chain's name in prose: "Monad", "Base". */
  readonly name: string;
  /** The address book environment whose external entries are this chain's mainnet addresses. */
  readonly book: "beta" | "base";
  readonly native: {
    readonly symbol: string;
    readonly wrappedSymbol: string;
    /** DefiLlama's coin id for the native asset's price history. */
    readonly llamaCoin: string;
  };
  readonly geckoterminal: {
    readonly network: string;
    readonly dexes: {
      readonly uniswap_v3: string;
      readonly uniswap_v4: string;
      readonly pancakeswap_v3: string;
    };
  };
  readonly defillama: { readonly chain: string };
  /** The chain's USDC and wrapped native token, lowercase, as the token probes and the screen use them. */
  readonly tokens: { readonly USDC: `0x${string}`; readonly WMON: `0x${string}` };
  /** Chainlink's native/USD feed on the chain (the book's chainlink_mon_usd). */
  readonly nativeUsdFeed: `0x${string}`;
  /** CoinMarketCap's id for the native token (MON 30495, ETH 1027) and the plausible USD range of its price. */
  readonly nativeCmcId: number;
  readonly nativePriceRangeUsd: readonly [number, number];
  /** The platform name CoinGecko's coin list and CoinMarketCap's map use for this chain, lowercase. */
  readonly coingeckoPlatform: string;
  readonly cmcPlatform: string;
  readonly v4NativeUsdcPool: {
    readonly id: `0x${string}`;
    readonly fee: number;
    readonly tickSpacing: number;
    readonly hooks: `0x${string}`;
  };
  readonly x: {
    /** The project's official accounts, the only accounts the platform ever names. */
    readonly accounts: readonly string[];
    readonly ticker: string;
  };
}

export const MARKET_CHAINS: Readonly<Record<MarketChainKey, MarketChain>> = {
  monad: {
    key: "monad",
    chainId: 143,
    label: "monad-mainnet",
    name: "Monad",
    book: "beta",
    native: { symbol: "MON", wrappedSymbol: "WMON", llamaCoin: "coingecko:monad" },
    geckoterminal: {
      network: "monad",
      dexes: {
        uniswap_v3: "uniswap-v3-monad",
        uniswap_v4: "uniswap-v4-monad",
        pancakeswap_v3: "pancakeswap-v3-monad",
      },
    },
    defillama: { chain: "Monad" },
    tokens: MONAD_BASE_TOKENS,
    nativeUsdFeed: "0xBcD78f76005B7515837af6b50c7C52BCf73822fb",
    nativeCmcId: 30495,
    nativePriceRangeUsd: [0.0001, 100],
    coingeckoPlatform: "monad",
    cmcPlatform: "monad",
    v4NativeUsdcPool: UNISWAP_V4_MON_USDC_POOL,
    x: { accounts: ["monad", "monad_dev", "monad_eco"], ticker: "$MON" },
  },
  base: {
    key: "base",
    chainId: 8453,
    label: "base-mainnet",
    name: "Base",
    book: "base",
    native: { symbol: "ETH", wrappedSymbol: "WETH", llamaCoin: "coingecko:ethereum" },
    geckoterminal: {
      network: "base",
      dexes: {
        uniswap_v3: "uniswap-v3-base",
        uniswap_v4: "uniswap-v4-base",
        pancakeswap_v3: "pancakeswap-v3-base",
      },
    },
    defillama: { chain: "Base" },
    tokens: { USDC: BASE_TOKENS.USDC, WMON: BASE_TOKENS.WETH },
    nativeUsdFeed: "0xa4250cE1aA15Ff4cb5E5a8655293b65694e436Ed",
    nativeCmcId: 1027,
    nativePriceRangeUsd: [10, 100_000],
    coingeckoPlatform: "base",
    cmcPlatform: "base",
    v4NativeUsdcPool: UNISWAP_V4_BASE_ETH_USDC_POOL,
    x: { accounts: ["base", "BuildOnBase", "jessepollak"], ticker: "$ETH" },
  },
};

export function marketChainFor(key: string | undefined): MarketChain {
  if (key === undefined || key === "") return MARKET_CHAINS.monad;
  if (key === "monad" || key === "base") return MARKET_CHAINS[key];
  throw new Error(`MARKET_CHAIN must be "monad" or "base", not "${key}"`);
}

/** The chain this process researches: MARKET_CHAIN, else APP_ENV=base means Base, else Monad. */
export const MARKET_CHAIN: MarketChain = marketChainFor(
  process.env.MARKET_CHAIN ?? (process.env.APP_ENV === "base" ? "base" : undefined),
);
