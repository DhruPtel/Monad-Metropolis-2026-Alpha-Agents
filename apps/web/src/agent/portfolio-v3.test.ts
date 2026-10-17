import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import type { PortfolioV3Json } from "@/api/client";
import {
  assetRows,
  capRoomV3,
  claimablesV3,
  depositCheckV3,
  depositTokens,
  legacyLines,
  overviewV3,
  withdrawCheckV3,
  withdrawable,
} from "./portfolio-v3";

/**
 * The portfolio page's rules on the fund agent's set (A-80): every held
 * token's value and share, the account at a glance, every reason a deposit of
 * any registered token would be refused, withdrawals of any held token, and
 * the older v2 account's lines.
 */
const E18 = 10n ** 18n;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address;
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address;
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as Address;
const CHOG = "0x00000000000000000000000000000000000c0de5" as Address;
const NOW = 1_790_000_000;
const PX = (25n * 10n ** 15n).toString();

function fixture(over: Partial<PortfolioV3Json> = {}): PortfolioV3Json {
  return {
    custody: "v3",
    chainId: 143143,
    block: "109670100",
    timestamp: NOW,
    agentId: "7",
    owner: "0x683eE842A16f85e69883F433745263BFe8D55f76",
    contracts: {
      agentNft: "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E",
      accountFactory: "0x5ebF58520f9bAa847959DcF69716030a1583BCDb",
      accountFactoryV2: "0xC898A55c814a629653f6CD7aC007edd6b63ac0De",
      oracle: "0xeeB91f3371Db0d409bbE0Ffa9ea901E09A783a43",
      usdc: USDC,
      wmon: WMON,
      executor: "0x3443dbBd29E19CF17853732C260C6abDb6dC0658",
    },
    account: "0x00000000000000000000000000000000000ac0f3",
    predictedAccount: "0x00000000000000000000000000000000000ac0f3",
    allowlist: { enabled: true, listed: true },
    caps: {
      personalUsdcE6: "100000000",
      platformUsdcE6: "2000000000",
      platformTotalUsdcE6: "250000000",
      principalUsdcE6: "40000000",
    },
    mode: "NORMAL",
    depositsClosed: false,
    navUsdcE6: "41600000",
    breaker: {
      navUsdcE6: "41600000",
      perUnitE18: E18.toString(),
      peakE18: E18.toString(),
      drawdownBps: 120,
    },
    peak7dE18: E18.toString(),
    holdings: [
      {
        token: USDC,
        symbol: "USDC",
        decimals: 6,
        amountRaw: "30000000",
        freeRaw: "30000000",
        costBasisUsdcE6: "0",
        priceE18: E18.toString(),
        priceReason: "OK",
        valueUsdcE6: "30000000",
        claimableRaw: "0",
      },
      {
        token: WMON,
        symbol: "WMON",
        decimals: 18,
        amountRaw: (400n * E18).toString(),
        freeRaw: (390n * E18).toString(),
        costBasisUsdcE6: "10000000",
        priceE18: "29000000000000000",
        priceReason: "OK",
        valueUsdcE6: "11600000",
        claimableRaw: (2n * E18).toString(),
      },
    ],
    tokens: [
      {
        symbol: "USDC",
        address: USDC,
        decimals: 6,
        priceClass: "F",
        walletRaw: "70000000",
        price: { priceE18: E18.toString(), updatedAt: NOW - 600, reason: "OK" },
      },
      {
        symbol: "WMON",
        address: WMON,
        decimals: 18,
        priceClass: "F",
        walletRaw: (5n * E18).toString(),
        price: { priceE18: PX, updatedAt: NOW - 20, reason: "OK" },
      },
      {
        symbol: "WBTC",
        address: WBTC,
        decimals: 8,
        priceClass: "F",
        walletRaw: "0",
        price: { priceE18: (100_000n * E18).toString(), updatedAt: NOW - 30, reason: "OK" },
      },
    ],
    usdcPeg: { priceE18: E18.toString(), updatedAt: NOW - 600, reason: "OK" },
    wallet: { monWei: E18.toString() },
    legacy: {
      account: "0xF8322887Dd39EF54737b8Eb222d8F5b4D039B0e7",
      usdcE6: "100000000",
      wmonWei: "0",
      claimable: { usdcE6: "0", wmonWei: "0" },
      mode: "NORMAL",
    },
    ...over,
  };
}

describe("the fund account's positions (A-80)", () => {
  it("values every held token, shares the priced total, and reads each gain against its cost basis", () => {
    const rows = assetRows(fixture());
    expect(rows.map((r) => [r.symbol, r.valueUsdcE6, r.shareBps, r.gainUsdcE6, r.isCash])).toEqual([
      ["USDC", "30000000", 7_211, null, true],
      ["WMON", "11600000", 2_788, "1600000", false],
    ]);
    // 2026-10-17: each row carries its token, so a plan's row finds it by address.
    expect(rows.map((r) => r.token)).toEqual([USDC, WMON]);
    const o = overviewV3(fixture());
    expect(o).toMatchObject({
      totalValueUsdcE6: "41600000",
      mode: "NORMAL",
      drawdownBps: 120,
      prices: { priced: 2, held: 2, oldestAgeSeconds: 20 },
    });
  });

  it("keeps an unpriced token without a share, and the total unknown", () => {
    const p = fixture({
      navUsdcE6: null,
      holdings: [
        ...fixture().holdings,
        {
          token: CHOG,
          symbol: "CHOG",
          decimals: 18,
          amountRaw: (2_000n * E18).toString(),
          freeRaw: (2_000n * E18).toString(),
          costBasisUsdcE6: "1500000",
          priceE18: null,
          priceReason: "STALE",
          valueUsdcE6: null,
          claimableRaw: "0",
        },
      ],
    });
    const rows = assetRows(p);
    expect(rows[rows.length - 1]).toMatchObject({
      symbol: "CHOG",
      valueUsdcE6: null,
      shareBps: null,
      gainUsdcE6: null,
    });
    expect(overviewV3(p)).toMatchObject({ totalValueUsdcE6: null, prices: { priced: 2, held: 3 } });
  });
});

describe("deposits of any registered token, before any transaction", () => {
  it("passes a USDC and a WMON deposit within every cap, valuing WMON at the oracle price", () => {
    expect(depositCheckV3(fixture(), USDC, 10_000_000n)).toEqual({
      ok: true,
      block: null,
      message: null,
      valueUsdc: 10_000_000n,
    });
    expect(depositCheckV3(fixture(), WMON, 4n * E18)).toEqual({
      ok: true,
      block: null,
      message: null,
      valueUsdc: 100_000n,
    });
    expect(capRoomV3(fixture())).toEqual({
      personal: 60_000_000n,
      platform: 1_750_000_000n,
      room: 60_000_000n,
    });
  });

  it("names the allowlist first, then the account, the token, the amount, the wallet, the mode and the closed deposits", () => {
    expect(
      depositCheckV3(fixture({ allowlist: { enabled: true, listed: false } }), USDC, 1n).block,
    ).toBe("NOT_ALLOWLISTED");
    expect(depositCheckV3(fixture({ account: null }), USDC, 1n).block).toBe("NO_ACCOUNT");
    expect(depositCheckV3(fixture(), CHOG, 1n).block).toBe("TOKEN_NOT_DEPOSITABLE");
    expect(depositCheckV3(fixture(), USDC, 0n).block).toBe("ZERO_AMOUNT");
    expect(depositCheckV3(fixture(), USDC, 70_000_001n).block).toBe("OVER_WALLET");
    expect(depositCheckV3(fixture({ mode: "PAUSED" }), USDC, 1n).block).toBe("PAUSED");
    expect(depositCheckV3(fixture({ depositsClosed: true }), USDC, 1n).block).toBe(
      "DEPOSITS_CLOSED",
    );
  });

  it("names the depeg guard, an unavailable USDC price, a stale feed with its due time, the token's price and a held token's price", () => {
    expect(
      depositCheckV3(
        fixture({
          usdcPeg: { priceE18: (985n * 10n ** 15n).toString(), updatedAt: NOW, reason: "OK" },
        }),
        USDC,
        1n,
      ).block,
    ).toBe("USDC_DEPEGGED");
    expect(
      depositCheckV3(
        fixture({ usdcPeg: { priceE18: "0", updatedAt: 0, reason: "FEED_REVERTED" } }),
        USDC,
        1n,
      ).block,
    ).toBe("USDC_PRICE_UNAVAILABLE");
    const stale = depositCheckV3(
      fixture({ usdcPeg: { priceE18: E18.toString(), updatedAt: NOW - 5_000, reason: "STALE" } }),
      USDC,
      1n,
    );
    expect(stale.block).toBe("USDC_PRICE_UNAVAILABLE");
    expect(stale.message).toMatch(/USDC/);
    const tokens = fixture().tokens.map((t) =>
      t.symbol === "WMON" ? { ...t, price: { ...t.price, reason: "STALE" } } : t,
    );
    expect(depositCheckV3(fixture({ tokens }), WMON, E18).block).toBe("WMON_PRICE_UNAVAILABLE");
    // USDC itself needs no token price, but every held token must be priced for the account to value a deposit.
    expect(depositCheckV3(fixture({ tokens }), USDC, 1n).ok).toBe(true);
    const held = fixture().holdings.map((h) =>
      h.symbol === "WMON" ? { ...h, valueUsdcE6: null, priceE18: null, priceReason: "STALE" } : h,
    );
    expect(depositCheckV3(fixture({ holdings: held, navUsdcE6: null }), USDC, 1n).block).toBe(
      "HELD_PRICE_UNAVAILABLE",
    );
  });

  it("names each cap with the deposit's value", () => {
    const personal = depositCheckV3(fixture(), USDC, 60_000_001n);
    expect(personal).toMatchObject({ block: "PERSONAL_CAP", valueUsdc: 60_000_001n });
    const rich = fixture();
    const platform = depositCheckV3(
      fixture({
        caps: { ...rich.caps, personalUsdcE6: "5000000000", principalUsdcE6: "0" },
        tokens: rich.tokens.map((t) =>
          t.symbol === "USDC" ? { ...t, walletRaw: "3000000000" } : t,
        ),
      }),
      USDC,
      1_750_000_001n,
    );
    expect(platform.block).toBe("PLATFORM_CAP");
  });
});

describe("withdrawals, claims and the older account", () => {
  it("withdraws any held token up to its free balance, and names a balance a trade in flight holds", () => {
    expect(withdrawCheckV3(fixture(), WMON, 390n * E18)).toBeNull();
    expect(withdrawCheckV3(fixture(), WMON, 395n * E18)).toMatch(/trade in flight/);
    expect(withdrawCheckV3(fixture(), USDC, 30_000_001n)).toBe(
      "The account does not hold that much.",
    );
    expect(withdrawCheckV3(fixture(), WBTC, 1n)).toBe("The account does not hold that much.");
    expect(withdrawCheckV3(fixture({ account: null }), USDC, 1n)).toMatch(/no trading account/);
    expect(withdrawable(fixture()).map((h) => h.symbol)).toEqual(["USDC", "WMON"]);
    expect(depositTokens(fixture()).map((t) => t.symbol)).toEqual(["USDC", "WMON", "WBTC"]);
  });

  it("lists what is held for a claim, and the older account's lines", () => {
    expect(claimablesV3(fixture())).toEqual([
      { symbol: "WMON", token: WMON, decimals: 18, amount: 2n * E18 },
    ]);
    expect(legacyLines(fixture())).toEqual([
      { symbol: "USDC", decimals: 6, raw: 100_000_000n, claimableRaw: 0n },
      { symbol: "WMON", decimals: 18, raw: 0n, claimableRaw: 0n },
    ]);
    expect(legacyLines(fixture({ legacy: null }))).toBeNull();
  });
});
