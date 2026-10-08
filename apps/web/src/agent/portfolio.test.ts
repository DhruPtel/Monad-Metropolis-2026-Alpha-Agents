import { describe, expect, it } from "vitest";
import type { PortfolioJson } from "@/api/client";
import {
  DEPOSIT_BLOCK_MESSAGES,
  capRoom,
  claimables,
  depositCheck,
  parseAmount,
  positions,
  priceAgeSeconds,
  withdrawCheck,
} from "./portfolio";

const PX = 25_000_000_000_000_000n; // 0.025 USD per WMON
const NOW = 1_790_000_000;

export function portfolio(over: Partial<PortfolioJson> = {}): PortfolioJson {
  return {
    chainId: 143143,
    block: "109670100",
    timestamp: NOW,
    agentId: "1",
    owner: "0x00000000000000000000000000000000000e2e01",
    contracts: {
      agentNft: "0x00000000000000000000000000000000000000a1",
      accountFactory: "0x00000000000000000000000000000000000000a2",
      oracle: "0x00000000000000000000000000000000000000a3",
      usdc: "0x00000000000000000000000000000000000000c1",
      wmon: "0x00000000000000000000000000000000000000c2",
      executor: "0x00000000000000000000000000000000000000a4",
    },
    account: "0x00000000000000000000000000000000000ac001",
    predictedAccount: "0x00000000000000000000000000000000000ac001",
    allowlist: { enabled: true, listed: true },
    caps: {
      personalUsdcE6: "100000000",
      platformUsdcE6: "2000000000",
      platformTotalUsdcE6: "250000000",
      principalUsdcE6: "40000000",
    },
    balances: { usdcE6: "30000000", wmonWei: "400000000000000000000" },
    claimable: { usdcE6: "0", wmonWei: "0" },
    mode: "NORMAL",
    depositsClosed: false,
    breaker: { navUsdcE6: "40000000", perUnitE18: "1", peakE18: "1", drawdownBps: 0 },
    peak7dE18: "1000000000000000000",
    prices: {
      monUsd: { priceE18: PX.toString(), updatedAt: NOW - 20, reason: "OK" },
      usdcUsd: { priceE18: "1000000000000000000", updatedAt: NOW - 600, reason: "OK" },
    },
    wallet: { usdcE6: "70000000", wmonWei: "0", monWei: "1000000000000000000" },
    ...over,
  };
}

describe("portfolio positions (P2-U7)", () => {
  it("values WMON at the oracle price and gives each asset's share", () => {
    expect(positions(portfolio())).toEqual({
      usdc: 30_000_000n,
      wmon: 400n * 10n ** 18n,
      wmonValueUsdc: 10_000_000n,
      totalUsdc: 40_000_000n,
      usdcShareBps: 7_500,
      wmonShareBps: 2_500,
    });
    expect(priceAgeSeconds(portfolio())).toBe(20);
  });

  it("gives no total when WMON is held and its price is unusable, and a total of USDC alone when none is", () => {
    const stale = portfolio({
      prices: {
        ...portfolio().prices,
        monUsd: { priceE18: "0", updatedAt: NOW - 900, reason: "STALE" },
      },
    });
    expect(positions(stale)).toMatchObject({ totalUsdc: null, usdcShareBps: null });
    const usdcOnly = { ...stale, balances: { usdcE6: "5000000", wmonWei: "0" } };
    expect(positions(usdcOnly)).toMatchObject({
      totalUsdc: 5_000_000n,
      usdcShareBps: 10_000,
      wmonShareBps: 0,
    });
    expect(positions({ ...usdcOnly, balances: { usdcE6: "0", wmonWei: "0" } }).usdcShareBps).toBe(
      0,
    );
  });
});

describe("deposit blocks, before any transaction", () => {
  const usdc = (n: bigint) => n * 1_000_000n;

  it("passes a deposit within every cap", () => {
    expect(depositCheck(portfolio(), "USDC", usdc(25n))).toMatchObject({
      ok: true,
      valueUsdc: usdc(25n),
    });
    expect(capRoom(portfolio())).toEqual({
      personal: usdc(60n),
      platform: usdc(1750n),
      room: usdc(60n),
    });
  });

  it("names the allowlist first, even before the account exists", () => {
    const p = portfolio({ account: null, allowlist: { enabled: true, listed: false } });
    expect(depositCheck(p, "USDC", usdc(1n)).block).toBe("NOT_ALLOWLISTED");
    expect(
      depositCheck({ ...p, allowlist: { enabled: false, listed: false } }, "USDC", usdc(1n)).block,
    ).toBe("NO_ACCOUNT");
  });

  it("names each cap with its own message", () => {
    expect(depositCheck(portfolio(), "USDC", usdc(61n)).block).toBe("PERSONAL_CAP");
    const full = portfolio({
      caps: { ...portfolio().caps, platformTotalUsdcE6: "1990000000" },
    });
    expect(depositCheck(full, "USDC", usdc(11n))).toMatchObject({
      block: "PLATFORM_CAP",
      message: DEPOSIT_BLOCK_MESSAGES.PLATFORM_CAP,
    });
  });

  it("names the depeg guard and an unavailable USDC price apart", () => {
    const peg = (reason: string) =>
      portfolio({
        prices: { ...portfolio().prices, usdcUsd: { priceE18: "0", updatedAt: NOW, reason } },
      });
    expect(depositCheck(peg("USDC_DEPEGGED"), "USDC", usdc(1n)).block).toBe("USDC_DEPEGGED");
    expect(depositCheck(peg("STALE"), "USDC", usdc(1n)).block).toBe("USDC_PRICE_UNAVAILABLE");
  });

  it("names a stale feed and when its update was due (L-145)", () => {
    const usdcStale = portfolio({
      prices: {
        ...portfolio().prices,
        usdcUsd: { priceE18: "0", updatedAt: NOW - 7_300, reason: "STALE" },
      },
    });
    const usdcCheck = depositCheck(usdcStale, "USDC", usdc(1n));
    expect(usdcCheck.block).toBe("USDC_PRICE_UNAVAILABLE");
    expect(usdcCheck.message).toBe(
      "Deposits are refused because the USDC/USD price feed (the USDC depeg guard) is stale: it last updated 2 hours 1 minute ago, and answers 2 hours old or older are not used. It normally updates about every 1 hour; its next update was due 1 hour 1 minute ago, so expect one shortly. Withdrawals need no price and still work.",
    );
    const monStale = portfolio({
      prices: {
        ...portfolio().prices,
        monUsd: { priceE18: "0", updatedAt: NOW - 400, reason: "STALE" },
      },
    });
    expect(depositCheck(monStale, "USDC", usdc(1n)).message).toMatch(
      /the MON\/USD price feed \(the price of WMON\) is stale: it last updated 6 minutes ago/,
    );
    // A reason other than staleness keeps the block's own text.
    const reverted = portfolio({
      prices: {
        ...portfolio().prices,
        usdcUsd: { priceE18: "0", updatedAt: NOW, reason: "FEED_REVERTED" },
      },
    });
    expect(depositCheck(reverted, "USDC", usdc(1n)).message).toBe(
      DEPOSIT_BLOCK_MESSAGES.USDC_PRICE_UNAVAILABLE,
    );
  });

  it("refuses while paused or closed, past the wallet's balance, and WMON without a price", () => {
    expect(depositCheck(portfolio({ mode: "PAUSED" }), "USDC", usdc(1n)).block).toBe("PAUSED");
    expect(depositCheck(portfolio({ depositsClosed: true }), "USDC", usdc(1n)).block).toBe(
      "DEPOSITS_CLOSED",
    );
    expect(depositCheck(portfolio(), "USDC", usdc(71n)).block).toBe("OVER_WALLET");
    expect(depositCheck(portfolio(), "USDC", 0n).block).toBe("ZERO_AMOUNT");
    const stale = portfolio({
      prices: { ...portfolio().prices, monUsd: { priceE18: "0", updatedAt: 0, reason: "STALE" } },
    });
    // WMON is held, so even a USDC deposit needs WMON's price to value the account.
    expect(depositCheck(stale, "USDC", usdc(1n)).block).toBe("WMON_PRICE_UNAVAILABLE");
  });

  it("values a WMON deposit at the oracle price against the caps", () => {
    const p = portfolio({
      wallet: { usdcE6: "0", wmonWei: (5000n * 10n ** 18n).toString(), monWei: "0" },
    });
    expect(depositCheck(p, "WMON", 2000n * 10n ** 18n)).toMatchObject({
      ok: true,
      valueUsdc: usdc(50n),
    });
    expect(depositCheck(p, "WMON", 4000n * 10n ** 18n).block).toBe("PERSONAL_CAP");
  });
});

describe("withdrawals and credits", () => {
  it("allow a withdrawal in any mode, limited only by what the account holds", () => {
    for (const mode of ["PAUSED", "REDUCE_ONLY", "WIND_DOWN"] as const) {
      const p = portfolio({
        mode,
        prices: { ...portfolio().prices, monUsd: { priceE18: "0", updatedAt: 0, reason: "STALE" } },
      });
      expect(withdrawCheck(p, "USDC", 30_000_000n)).toBeNull();
    }
    expect(withdrawCheck(portfolio(), "USDC", 30_000_001n)).toMatch(/does not hold/);
    expect(withdrawCheck(portfolio({ account: null }), "USDC", 1n)).toMatch(/no trading account/);
  });

  it("lists claimable credits by token", () => {
    expect(claimables(portfolio())).toEqual([]);
    expect(claimables(portfolio({ claimable: { usdcE6: "1500000", wmonWei: "0" } }))).toEqual([
      { asset: "USDC", token: portfolio().contracts.usdc, amount: 1_500_000n },
    ]);
  });

  it("parses amounts with at most the token's decimals", () => {
    expect(parseAmount("12.5", 6)).toBe(12_500_000n);
    expect(parseAmount(" 3 ", 18)).toBe(3n * 10n ** 18n);
    expect(parseAmount("1.0000001", 6)).toBeNull();
    expect(parseAmount("-1", 6)).toBeNull();
    expect(parseAmount("", 6)).toBeNull();
  });
});
