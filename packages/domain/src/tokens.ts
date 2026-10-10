import type { Address } from "./ids.ts";

/**
 * The token universe and its safety screen (F-U1, FINAL_PLAN 0.2 and 0.3).
 *
 * - Price class (D-337): a token is class F when a reviewed Chainlink feed
 *   prices it (directly, through its underlying asset, or as an exchange rate
 *   times a USD feed), verified onchain; every other token is class A.
 * - The screen (D-339): a token may be bought only while it has a passing
 *   screen no older than six hours. Each check passes, fails or is skipped,
 *   with a reason and its evidence. Any failed check refuses the token.
 *
 * Addresses are lowercase here; the feed map and the reviewed list are the
 * platform's own review, never read from a token's name or symbol.
 */

/** A-61 and A-63. */
export const SCREEN_RULES = {
  /** Any buy, transfer or sell tax above this is refused (A-61). */
  maxTaxBps: 100,
  /** The route pool's liquidity, in USD (A-61). */
  minLiquidityUsd: 50_000,
  /** A reference-size buy then sell may cost at most this (A-61). */
  maxRoundTripBps: 300,
  /** The route pool must be at least this old (A-61). */
  minPoolAgeHours: 72,
  /** A screen is good for six hours (A-61). */
  ttlSeconds: 6 * 3600,
  /** The reference size for the simulated round trip, in USD (A-63). */
  referenceSizeUsd: 250,
  /** An upgrade authority counts as a timelock at this delay or longer (A-63). */
  minTimelockSeconds: 86_400,
  /** A tax is measured against the quote; this much shortfall is rounding, not a tax (A-63). */
  taxToleranceBps: 5,
} as const;

/** Every check a screen runs, in the order the console shows them. */
export const SCREEN_CHECK_CODES = [
  "ROUTE",
  "BUY",
  "TRANSFER",
  "SELL",
  "ROUND_TRIP",
  "OWNER_POWERS",
  "UPGRADEABLE",
  "LIQUIDITY",
  "POOL_AGE",
  "LOOK_ALIKE",
  "GOPLUS",
] as const;
export type ScreenCheckCode = (typeof SCREEN_CHECK_CODES)[number];

export const SCREEN_CHECK_LABELS: Readonly<Record<ScreenCheckCode, string>> = {
  ROUTE: "Route to a base asset",
  BUY: "Simulated buy",
  TRANSFER: "Simulated transfer",
  SELL: "Simulated sell",
  ROUND_TRIP: "Round trip cost",
  OWNER_POWERS: "Owner powers",
  UPGRADEABLE: "Upgradeability",
  LIQUIDITY: "Pool liquidity",
  POOL_AGE: "Pool age",
  LOOK_ALIKE: "Name and symbol",
  GOPLUS: "GoPlus (second opinion)",
};

export type ScreenCheckStatus = "pass" | "fail" | "skipped";
export type EvidenceValue = string | number | boolean | null;

export interface ScreenCheck {
  readonly code: ScreenCheckCode;
  readonly status: ScreenCheckStatus;
  /** One plain sentence: why it passed, failed or was skipped. */
  readonly reason: string;
  readonly evidence: Readonly<Record<string, EvidenceValue>>;
}

export type ScreenVerdict = "passed" | "refused";

/** A screen passes only when no check failed and every required check passed. */
export const REQUIRED_SCREEN_CHECKS: readonly ScreenCheckCode[] = SCREEN_CHECK_CODES.filter(
  (c) => c !== "GOPLUS",
);

export function screenVerdict(checks: readonly ScreenCheck[]): ScreenVerdict {
  if (checks.some((c) => c.status === "fail")) return "refused";
  const passed = new Set(checks.filter((c) => c.status === "pass").map((c) => c.code));
  return REQUIRED_SCREEN_CHECKS.every((c) => passed.has(c)) ? "passed" : "refused";
}

export type PriceClass = "F" | "A";

/** The base assets a route may end in: what an account holds between trades. */
export const NATIVE_MON = "0x0000000000000000000000000000000000000000" as const;
export const MONAD_BASE_TOKENS = {
  USDC: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
  WMON: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
} as const satisfies Record<string, Address>;

export interface FeedLeg {
  readonly proxy: Address;
  /** What `description()` must answer onchain. */
  readonly description: string;
  readonly decimals: number;
  /** The directory's heartbeat; an answer older than this is stale. */
  readonly heartbeatSeconds: number;
  readonly deviationPct: number;
}

/**
 * How a feed prices the token: `direct` is a feed for this token; `underlying`
 * prices the asset it wraps or bridges (a depeg is not seen); `composite` is an
 * exchange rate to a base asset times that asset's USD feed.
 */
export type FeedKind = "direct" | "underlying" | "composite";

export interface ClassFFeed {
  readonly address: Address;
  readonly symbol: string;
  readonly kind: FeedKind;
  /** One leg, or the exchange rate then the USD leg for a composite. */
  readonly legs: readonly FeedLeg[];
  readonly note: string;
}

const CHAINLINK_DIRECTORY = "https://reference-data-directory.vercel.app/feeds-monad-mainnet.json";
export const CLASS_F_FEED_SOURCE = `${CHAINLINK_DIRECTORY}; token addresses from CoinGecko's Monad platform list, checked against each token's symbol() onchain (F-U1)`;

const usd = (proxy: Address, description: string, decimals = 8, deviationPct = 0.05): FeedLeg => ({
  proxy,
  description,
  decimals,
  heartbeatSeconds: 3600,
  deviationPct,
});
const rate = (
  proxy: Address,
  description: string,
  heartbeatSeconds = 86_400,
  deviationPct = 0.05,
): FeedLeg => ({ proxy, description, decimals: 18, heartbeatSeconds, deviationPct });

const MON_USD = usd("0xbcd78f76005b7515837af6b50c7c52bcf73822fb", "MON / USD", 8, 0.02);
const USDC_USD = usd("0xf5f15f188abcb0d165d1edb7f37f7d6fa2fcebec", "USDC / USD");
const BTC_USD = usd("0xc1d4c3331635184fa4c3c22fb92211b2ac9e0546", "BTC / USD", 8, 0.02);

/**
 * The reviewed feed map (F-U1). Every proxy answered its description, its
 * decimals and a round inside its heartbeat on 2026-10-09; the token screen
 * and discovery re-check them on every run. Where the directory lists two
 * feeds for one rate, the one with the tighter deviation threshold is used.
 * mUSD and CAKE have USD feeds but no token address we could confirm, so they
 * stay class A until one is (A-63).
 */
export const CLASS_F_FEEDS: readonly ClassFFeed[] = [
  {
    address: MONAD_BASE_TOKENS.WMON,
    symbol: "WMON",
    kind: "underlying",
    legs: [MON_USD],
    note: "Wrapped MON at MON's price; WMON is a 1:1 deposit contract",
  },
  {
    address: MONAD_BASE_TOKENS.USDC,
    symbol: "USDC",
    kind: "direct",
    legs: [USDC_USD],
    note: "Circle's USDC",
  },
  {
    address: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d",
    symbol: "USDT0",
    kind: "direct",
    legs: [usd("0x731efd09d87128787787947cc21be835620e765e", "USDT0 / USD", 18)],
    note: "Tether's USDT0",
  },
  {
    address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
    symbol: "AUSD",
    kind: "direct",
    legs: [usd("0xe20751c7b5867bcbef815ffc1b284c3f412a9e13", "AUSD / USD")],
    note: "Agora's AUSD",
  },
  {
    address: "0x111111d2bf19e43c34263401e0cad979ed1cdb61",
    symbol: "USD1",
    kind: "direct",
    legs: [usd("0xa63564f2a626f69130c1cca87f984351b26cf2f1", "USD1 / USD")],
    note: "World Liberty Financial's USD1",
  },
  {
    address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
    symbol: "USDe",
    kind: "direct",
    legs: [usd("0x6b5902eabce27c23fc97ea136504395b4d22c1fd", "USDE / USD")],
    note: "Ethena's USDe",
  },
  {
    address: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2",
    symbol: "sUSDe",
    kind: "direct",
    legs: [usd("0xb7e7a36a0fc6543c10f4f9b60e942f1b628f2a13", "SUSDE / USD")],
    note: "Ethena's staked USDe",
  },
  {
    address: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242",
    symbol: "WETH",
    kind: "underlying",
    legs: [usd("0x1b1414782b859871781ba3e4b0979b9ca57a0a04", "ETH / USD")],
    note: "Wormhole-bridged WETH at ETH's price: a bridge failure is not seen by the feed",
  },
  {
    address: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
    symbol: "WBTC",
    kind: "direct",
    legs: [usd("0x2d1df1bd061aac38c22407ad69d69bcc3c62edbd", "WBTC / USD")],
    note: "WBTC's own feed",
  },
  {
    address: "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b",
    symbol: "cbBTC",
    kind: "direct",
    legs: [usd("0x3ddc1bae752aaee31b577bf844c799c349a1d6bd", "CBBTC / USD")],
    note: "Coinbase's cbBTC",
  },
  {
    address: "0x10aeaf63194db8d453d4d85a06e5efe1dd0b5417",
    symbol: "wstETH",
    kind: "direct",
    legs: [usd("0xe6cd21b31948503db54a07875999979722504b9a", "WSTETH / USD")],
    note: "Lido's wrapped stETH",
  },
  {
    address: "0xa3d68b74bf0528fdd07263c60d6488749044914b",
    symbol: "weETH",
    kind: "direct",
    legs: [usd("0x42dd36b9d6938dccff8fe4e9770589aba614fcbb", "WEETH / USD")],
    note: "ether.fi's wrapped eETH",
  },
  {
    address: "0x76f257b1dda5cc71bee4ef637fbdde4c801310a9",
    symbol: "LINK",
    kind: "direct",
    legs: [usd("0x5c266b5c655664d6c99a13ff0d7f1f7eaf4ac9ba", "LINK / USD")],
    note: "Chainlink's LINK",
  },
  {
    address: "0xa3227c5969757783154c60bf0bc1944180ed81b9",
    symbol: "sMON",
    kind: "composite",
    legs: [rate("0x0bd1d6e72b9cd91442360f0e9c40eef0bc480e75", "SMON / MON Exchange Rate"), MON_USD],
    note: "Kintsu's staked MON: its exchange rate times MON/USD",
  },
  {
    address: "0x8498312a6b3cbd158bf0c93abdcf29e6e4f55081",
    symbol: "gMON",
    kind: "composite",
    legs: [rate("0x256376e2ec4a8290e2ebfaee7c71bb7ef6b60221", "GMON / MON Exchange Rate"), MON_USD],
    note: "Magma's staked MON: its exchange rate times MON/USD",
  },
  {
    address: "0x0c65a0bc65a5d819235b71f554d210d3f80e0852",
    symbol: "aprMON",
    kind: "composite",
    legs: [
      rate("0x11b34d7aad41931bb4effc716d7d20be6e6d1542", "APRMON / MON Exchange Rate", 3600),
      MON_USD,
    ],
    note: "aPriori's staked MON: its exchange rate (hourly) times MON/USD",
  },
  {
    address: "0x1b68626dca36c7fe922fd2d55e4f631d962de19c",
    symbol: "shMON",
    kind: "composite",
    legs: [
      rate("0x2dc0b316e3d4e673c7f9a809e80a3e60b26d7774", "SHMON / MON Exchange Rate"),
      MON_USD,
    ],
    note: "FastLane's staked MON: its exchange rate times MON/USD",
  },
  {
    address: "0xab6e5a0c3799d020c790d34f7b2c02639e238af7",
    symbol: "syrupUSDC",
    kind: "composite",
    legs: [
      rate("0xaec21ef8f7aa33687c647bfedaa8cd7f7855973f", "SYRUPUSDC / USDC Exchange Rate"),
      USDC_USD,
    ],
    note: "Maple's syrupUSDC: its exchange rate times USDC/USD",
  },
  {
    address: "0xae4efbc7736f963982aacb17efa37fcbab924cb3",
    symbol: "SolvBTC",
    kind: "composite",
    legs: [
      rate(
        "0x8caede99d5253457e3bd7a52697c99d00549d04a",
        "SOLVBTC / BTC Exchange Rate",
        86_400,
        0.01,
      ),
      BTC_USD,
    ],
    note: "Solv's BTC: its exchange rate times BTC/USD",
  },
];

export function classFFeed(token: string): ClassFFeed | null {
  const t = token.toLowerCase();
  return CLASS_F_FEEDS.find((f) => f.address === t) ?? null;
}

/** A power a reviewed token holds that the screen accepts for it. */
export type ReviewedPower = "owner_powers" | "upgradeable";

export interface ReviewedToken {
  readonly address: Address;
  readonly symbol: string;
  readonly issuer: string;
  readonly accepts: readonly ReviewedPower[];
  readonly reason: string;
}

/**
 * The reviewed list (D-339, A-64): issuer-controlled tokens whose pause,
 * blacklist, freeze or upgrade roles are documented issuer controls. The
 * screen still simulates, taxes, liquidity and age for them; only the owner
 * powers and upgradeability checks accept what is named here.
 */
export const REVIEWED_TOKENS: readonly ReviewedToken[] = [
  {
    address: MONAD_BASE_TOKENS.USDC,
    symbol: "USDC",
    issuer: "Circle",
    accepts: ["owner_powers", "upgradeable"],
    reason: "Circle's FiatToken: documented pause and blacklist roles, upgraded by Circle's admin",
  },
  {
    address: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d",
    symbol: "USDT0",
    issuer: "Tether (USDT0)",
    accepts: ["owner_powers", "upgradeable"],
    reason: "Tether's USDT0: documented freeze and upgrade roles held by the issuer",
  },
  {
    address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
    symbol: "AUSD",
    issuer: "Agora",
    accepts: ["owner_powers", "upgradeable"],
    reason: "Agora's AUSD: documented pause and freeze roles held by the issuer",
  },
  {
    address: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242",
    symbol: "WETH",
    issuer: "Wormhole",
    accepts: ["owner_powers", "upgradeable"],
    reason: "Wormhole's bridged WETH: the bridge's token, upgraded by Wormhole governance",
  },
  {
    address: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
    symbol: "WBTC",
    issuer: "BitGo",
    accepts: ["owner_powers", "upgradeable"],
    reason: "WBTC: mint and burn by its custodian's documented roles",
  },
  {
    address: "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b",
    symbol: "cbBTC",
    issuer: "Coinbase",
    accepts: ["owner_powers", "upgradeable"],
    reason: "Coinbase's cbBTC: documented pause and blacklist roles, upgraded by Coinbase",
  },
];

export function reviewedToken(token: string): ReviewedToken | null {
  const t = token.toLowerCase();
  return REVIEWED_TOKENS.find((r) => r.address === t) ?? null;
}

/**
 * Look-alike names (D-339): the same symbol or name as a listed token at
 * another address. Case, spacing, punctuation and common confusable letters
 * are folded first, so "USDC", "usdc", "U.S.D.C" and "USDС" (Cyrillic С) are one.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "l",
  "|": "l",
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  і: "i",
  ѕ: "s",
  ο: "o",
  α: "a",
  Α: "a",
  Β: "b",
  Ε: "e",
  Ο: "o",
  Ρ: "p",
  Τ: "t",
};

export function foldName(s: string): string {
  return [...s.normalize("NFKC").toLowerCase()]
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]/g, "");
}

export interface ListedToken {
  readonly symbol: string;
  readonly name: string;
  /** The listing's address on Monad, when it has one there. */
  readonly monadAddress: string | null;
  readonly source: "coingecko" | "coinmarketcap" | "reviewed";
}

export interface LookAlike {
  readonly listed: ListedToken;
  readonly field: "symbol" | "name";
}

/**
 * The listed token this one imitates, or null. A token matches a listing by
 * its folded symbol or name; it is an impostor when the listing has another
 * address on Monad, or no Monad address at all while a listed token of that
 * symbol is a top asset (the caller passes only listings worth guarding).
 */
export function lookAlike(
  token: { address: string; symbol: string; name: string },
  listings: readonly ListedToken[],
): LookAlike | null {
  const addr = token.address.toLowerCase();
  const sym = foldName(token.symbol);
  const name = foldName(token.name);
  // A listing at this very address is this token: it imitates nothing.
  if (listings.some((l) => l.monadAddress?.toLowerCase() === addr)) return null;
  for (const listed of listings) {
    const same = (field: "symbol" | "name", a: string, b: string) =>
      a.length >= 2 && a === b ? { listed, field } : null;
    const hit =
      same("symbol", sym, foldName(listed.symbol)) ?? same("name", name, foldName(listed.name));
    if (hit) return hit;
  }
  return null;
}

/**
 * Bridged copies of top coins (D-359, Q-68): a token whose name or symbol
 * matches a listed coin stays refused as a look-alike, unless it is a reviewed
 * bridged form of that coin and the bridge's own record confirms it on every
 * screen. Wormhole's record is its TokenBridge contract on Monad
 * (`isWrappedAsset` and `wrappedAsset(origin chain, origin address)`); an
 * issuer's own token bridge is checked against the issuer's official token
 * list. Every other check still applies.
 */
export type BridgeProof =
  | {
      readonly kind: "wormhole_wrapped";
      readonly tokenBridge: Address;
      /** Wormhole's chain ID of the origin (1 is Solana). */
      readonly originChain: number;
      readonly originAddress: `0x${string}`;
    }
  | { readonly kind: "issuer_token_list"; readonly url: string };

export interface BridgedException {
  /** The listed coin's symbol this bridged form may share. */
  readonly listedSymbol: string;
  readonly bridge: string;
  readonly proof: BridgeProof;
  readonly note: string;
}

export const WORMHOLE_BRIDGE_MONAD = "0x0b2719cda2f10595369e6673cea3ee2edfa13ba7" as const;

export const BRIDGED_EXCEPTIONS: readonly BridgedException[] = [
  {
    listedSymbol: "SOL",
    bridge: "Wormhole",
    proof: {
      kind: "wormhole_wrapped",
      tokenBridge: WORMHOLE_BRIDGE_MONAD,
      originChain: 1,
      // The native SOL mint (So11111111111111111111111111111111111111112), as Wormhole writes it.
      originAddress: "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
    },
    note: "Wormhole's wrapped SOL; TokenBridge from github.com/monad-crypto/protocols mainnet/wormhole_portal.jsonc",
  },
  {
    listedSymbol: "CAKE",
    bridge: "PancakeSwap",
    proof: {
      kind: "issuer_token_list",
      url: "https://tokens.pancakeswap.finance/pancakeswap-monad-default.json",
    },
    note: "PancakeSwap's own CAKE on Monad, listed in PancakeSwap's official Monad token list",
  },
];

export function bridgedException(listedSymbol: string): BridgedException | null {
  const s = listedSymbol.toUpperCase();
  return BRIDGED_EXCEPTIONS.find((b) => b.listedSymbol === s) ?? null;
}
