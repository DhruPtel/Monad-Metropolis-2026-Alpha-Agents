import type { ChainReaderV3 } from "@alpha-agents/chain-tools";
import type { MarketData } from "@alpha-agents/market";
import { isAddressEqual } from "viem";
import type { PriceReading, PriceSource } from "./attestor.ts";

/**
 * The attestor's price sources (F-U12): the token's deepest registered pool
 * quoted both ways on the chain the account trades on, and GeckoTerminal's
 * price for the token from its own pools. A source that cannot read a price
 * answers null, and the attestor refuses with fewer than two.
 */

/** 50 USDC: the reference size the pool is quoted at, small against any screened pool's floor. */
const REFERENCE_USDC_E6 = 50_000_000n;

/**
 * The chain's own pools: USDC bought into the token and the result sold
 * back, through the best registered route; the price is the mid of both.
 * A pool can be moved inside a block, so this never stands alone: the
 * attestor needs a second, independent source to agree with it.
 */
export function poolQuoteSource(
  reader: ChainReaderV3,
  referenceUsdcE6 = REFERENCE_USDC_E6,
): PriceSource {
  return {
    name: "pool",
    async priceOf(token, now): Promise<PriceReading | null> {
      const m = await reader.market();
      if (isAddressEqual(token, m.usdc)) return { priceE18: 10n ** 18n, observedAt: now };
      const info = m.tokens.find((t) => isAddressEqual(t.token, token));
      if (!info) return null;
      const o = { optedIn: true, intoUsdc: false, sellsScreened: false };
      const buy = await reader.bestRoute(m.usdc, token, referenceUsdcE6, o);
      if (!buy || buy.amountOut === 0n) return null;
      const sell = await reader.bestRoute(token, m.usdc, buy.amountOut, {
        ...o,
        intoUsdc: true,
        sellsScreened: info.lane === "SCREENED",
      });
      if (!sell || sell.amountOut === 0n) return null;
      const scale = 10n ** BigInt(info.decimals);
      // USD per whole token, 1e18: the USDC in or out (6 decimals) over the tokens out or in.
      const pxBuy = (referenceUsdcE6 * 10n ** 12n * scale) / buy.amountOut;
      const pxSell = (sell.amountOut * 10n ** 12n * scale) / buy.amountOut;
      return { priceE18: (pxBuy + pxSell) / 2n, observedAt: now };
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
    async priceOf(token): Promise<PriceReading | null> {
      const r = await market.tokenPriceUsd(network, token);
      if (!r || r.priceUsd <= 0 || !Number.isFinite(r.priceUsd)) return null;
      return { priceE18: usdToE18(r.priceUsd), observedAt: new Date(r.fetchedAtMs) };
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
