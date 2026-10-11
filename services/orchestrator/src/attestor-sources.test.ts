import type { ChainReaderV3, MarketStateV3 } from "@alpha-agents/chain-tools";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { fixedSource, geckoTerminalSource, poolSpotSource } from "./attestor-sources.ts";

/**
 * The attestor's sources (F-T2 Step 0): the pool spot source prices a token
 * at its usable pools' spot as the oracle reads it, the median when several
 * pools price it, USDC at exactly 1, and nothing for a token without a usable
 * pool; GeckoTerminal's reading is aged against the attestor's clock.
 */
const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
const GHO = "0x00000000000000000000000000000000000000a2" as Hex;
const THIN = "0x00000000000000000000000000000000000000a3" as Hex;
const E18 = 10n ** 18n;

const pool = (pricedToken: Hex, poolPriceE18: bigint | null, over: Record<string, unknown> = {}) =>
  ({
    poolId: `0x${pricedToken.slice(-2).repeat(32)}`,
    pricedToken,
    poolPriceE18,
    codeIntact: true,
    status: "ACTIVE",
    ...over,
  }) as unknown as MarketStateV3["pools"][number];

const reader = (pools: MarketStateV3["pools"]) =>
  ({ market: async () => ({ usdc: USDC, pools }) as unknown as MarketStateV3 }) as ChainReaderV3;

describe("the pool spot source", () => {
  it("prices a token at its usable pools' spot, the median of several, USDC at 1, nothing without a pool", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const src = poolSpotSource(
      reader([
        pool(GHO, (E18 * 9994n) / 10_000n),
        pool(GHO, E18, { status: "PAUSED" }),
        pool(GHO, (E18 * 101n) / 100n, { poolId: "0x02" }),
        pool(GHO, (E18 * 99n) / 100n, { poolId: "0x03", codeIntact: false }),
        pool(THIN, null),
      ]),
    );
    const gho = await src.priceOf(GHO, now);
    // The usable pools: 0.9994 and 1.01; the lower middle of two.
    expect(gho).toEqual({ priceE18: (E18 * 9994n) / 10_000n, observedAt: now });
    expect(await src.priceOf(USDC, now)).toEqual({ priceE18: E18, observedAt: now });
    expect(await src.priceOf(THIN, now)).toBeNull();
    expect(await src.priceOf("0x00000000000000000000000000000000000000a9", now)).toBeNull();
  });

  it("the GeckoTerminal source ages its reading against the attestor's clock, and the fixed source answers its tokens only", async () => {
    const fetchedAt = Date.now() - 30_000;
    const market = {
      tokenPriceUsd: async (_n: string, token: string) =>
        token.toLowerCase() === GHO
          ? { priceUsd: 1.0005, fetchedAtMs: fetchedAt, pool: "p" }
          : null,
    };
    const chainNow = new Date(Date.now() + 9 * 86_400_000);
    const gecko = geckoTerminalSource(market as never);
    const r = await gecko.priceOf(GHO, chainNow);
    // 1.0005 USD, within a floating-point rounding of the conversion.
    expect(r?.priceE18).toBeGreaterThan(1_000_499_000_000_000_000n);
    expect(r?.priceE18).toBeLessThan(1_000_501_000_000_000_000n);
    expect(chainNow.getTime() - (r?.observedAt.getTime() ?? 0)).toBeGreaterThanOrEqual(30_000);
    expect(chainNow.getTime() - (r?.observedAt.getTime() ?? 0)).toBeLessThan(31_000);
    expect(await gecko.priceOf(THIN, chainNow)).toBeNull();
    const fixed = fixedSource("fixed", { [GHO]: E18 });
    expect((await fixed.priceOf(GHO, chainNow))?.priceE18).toBe(E18);
    expect(await fixed.priceOf(THIN, chainNow)).toBeNull();
  });
});
