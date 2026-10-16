import type { Address } from "./ids.ts";

/**
 * 2026-10-16: the Uniswap v2 family venues the fund agent may trade through, as configuration:
 * a v2 fork is its factory, its router (when it has one), the fee its pairs charge and the base
 * tokens its pairs quote against. Adding a fork is a new entry here and its factory listed in the
 * ProtocolRegistryV3 (by its constructor or the timelock); no new contract code.
 */
export interface V2VenueConfig {
  readonly id: string;
  readonly name: string;
  readonly chainId: number;
  readonly factory: Address;
  /** The fork's own router; the fund agent swaps through the pair directly, so it may be null. */
  readonly router: Address | null;
  /** The fee a pair charges when the venue cannot say per pair, in millionths (3,000 = 0.3%). */
  readonly defaultFeePpm: number;
  /**
   * A per-pair quote the venue offers, `(tokenIn, amountIn) -> amountOut`, by selector, from which
   * a pair's own fee is read; null when every pair charges `defaultFeePpm`.
   */
  readonly pairQuoteSelector: `0x${string}` | null;
  /** The stack's base tokens on this venue: its cash (USDC) and its wrapped native token. */
  readonly bases: { readonly usdc: Address; readonly wmon: Address };
  /** Where an owner gets the cash token on a testnet: an open `mint(address,uint256)`. */
  readonly usdcMintable: boolean;
}

/**
 * nad.fun's DEX on Monad testnet (2026-10-16 discovery): a v2 fork whose pairs are minimal
 * proxies ("NadFun LP"); launch pairs charge 1.6% and stable pairs 0.25%, each readable from the
 * pair's own quote (selector 0xca706bcf). Its USDC ("USD Coin (mock)") is mintable by anyone and
 * pairs with its WMON, which every launch token pairs against.
 */
export const NADFUN_TESTNET: V2VenueConfig = Object.freeze({
  id: "nadfun",
  name: "nad.fun",
  chainId: 10143,
  factory: "0x59c51c66b79c68f63d5446940cd13b6968788e36",
  router: null,
  defaultFeePpm: 16_000,
  pairQuoteSelector: "0xca706bcf",
  bases: Object.freeze({
    usdc: "0xe7046ecd03426cc22cd298e4abccb5086977e01b",
    wmon: "0x5a4e0bfdef88c9032cb4d24338c5eb3d3870bfdd",
  }),
  usdcMintable: true,
}) as V2VenueConfig;

export const V2_VENUES: readonly V2VenueConfig[] = Object.freeze([NADFUN_TESTNET]);

/** The v2 formula: what `amountIn` buys at these reserves after a fee in millionths. */
export function v2AmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feePpm: number,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inAfterFee = amountIn * BigInt(1_000_000 - feePpm);
  return (inAfterFee * reserveOut) / (reserveIn * 1_000_000n + inAfterFee);
}
