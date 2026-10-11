import type { ChainReaderV3 } from "@alpha-agents/chain-tools";
import type { MarketData } from "@alpha-agents/market";
import { isAddressEqual } from "viem";
import type { PriceReading, PriceSource } from "./attestor.ts";

/**
 * The attestor's price sources (F-U12, F-T2 Step 0): the token's own pool
 * spot price on the chain the account trades on, as the oracle reads it, and
 * GeckoTerminal's price for the token from its own pools. A source that
 * cannot read a price answers null, and the attestor refuses with fewer than
 * two or with the two more than its spread apart: a pool whose spot and the
 * aggregator's price disagree is refused for that stated reason, never priced
 * off one side.
 */

/**
 * The chain's own pools: the spot price of the token's registered, usable
 * pools, as the oracle's `poolPrice` reads it (USD per whole token, a WMON
 * pool converted through the MON feed), the median when several pools price
 * it. The spot is what the Executor checks an attestation against, so this
 * never stands alone: a pool can be moved inside a block, and the attestor
 * needs the aggregator to agree with it (L-219: a two-way route quote
 * misprices a pool with liquidity on one side only, which the spot does not).
 */
export function poolSpotSource(reader: ChainReaderV3): PriceSource {
  return {
    name: "pool",
    async priceOf(token, now): Promise<PriceReading | null> {
      const m = await reader.market();
      if (isAddressEqual(token, m.usdc)) return { priceE18: 10n ** 18n, observedAt: now };
      const prices = m.pools
        .filter(
          (p) =>
            isAddressEqual(p.pricedToken, token) &&
            p.codeIntact &&
            p.status === "ACTIVE" &&
            p.poolPriceE18 !== undefined &&
            p.poolPriceE18 !== null &&
            p.poolPriceE18 > 0n,
        )
        .map((p) => p.poolPriceE18 as bigint)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (prices.length === 0) return null;
      const mid = prices[(prices.length - 1) >> 1] as bigint;
      return { priceE18: mid, observedAt: now };
    },
  };
}

/**
 * GeckoTerminal's USD price of the token from its own pools page (the
 * deepest pool's base or quote price), through the market cache.
 */
export function geckoTerminalSource(market: MarketData, network = "monad"): PriceSource {
  return {
    name: "geckoterminal",
    async priceOf(token, now): Promise<PriceReading | null> {
      const r = await market.tokenPriceUsd(network, token);
      if (!r || r.priceUsd <= 0 || !Number.isFinite(r.priceUsd)) return null;
      // The reading's age, measured against the attestor's clock (the chain's, not the wall's).
      const ageMs = Math.max(0, Date.now() - r.fetchedAtMs);
      return { priceE18: usdToE18(r.priceUsd), observedAt: new Date(now.getTime() - ageMs) };
    },
  };
}

/** A fixed reading, for the fork's tests and a stack without external sources. */
export function fixedSource(name: string, prices: Readonly<Record<string, bigint>>): PriceSource {
  return {
    name,
    async priceOf(token, now) {
      const p = prices[token.toLowerCase()];
      return p === undefined ? null : { priceE18: p, observedAt: now };
    },
  };
}

/** A USD figure as a 1e18 price, exact to 18 places of a decimal string. */
export function usdToE18(usd: number): bigint {
  const s = usd.toFixed(18);
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
}
