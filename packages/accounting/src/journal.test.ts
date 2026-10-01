import type { UsdcE6 } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import {
  JournalEntrySchema,
  ValuationSchema,
  availableCredits,
  creditsExhausted,
} from "./index.ts";

const trade = {
  environment: "fork",
  entryId: "4f0b8a0e-6c1d-4f1e-9a54-3d2f0c9b7e21",
  actionId: `0x${"ab".repeat(32)}`,
  occurredAt: 1_790_000_000,
  kind: "trade",
  lines: [
    { account: "personal_account", asset: "USDC", amountRaw: "-1000000000" },
    { account: "venue", asset: "USDC", amountRaw: "1000000000" },
    { account: "personal_account", asset: "WMON", amountRaw: "39800000000000000000000" },
    { account: "venue", asset: "WMON", amountRaw: "-39800000000000000000000" },
  ],
};

const fresh = {
  environment: "mainnet-beta",
  account: "strategy_vault",
  asOf: { block: 109_670_000, timestamp: 1_790_000_000 },
  status: "fresh",
  navUsdcE6: "100000000000",
  holdings: [
    {
      asset: "USDC",
      amountRaw: "70000000000",
      priceE18: "1000000000000000000",
      valueUsdcE6: "70000000000",
    },
    {
      asset: "WMON",
      amountRaw: "1200000000000000000000000",
      priceE18: "25000000000000000",
      valueUsdcE6: "30000000000",
    },
  ],
};

describe("journal entries", () => {
  it("accept a balanced trade and keep amounts exact", () => {
    const entry = JournalEntrySchema.parse(trade);
    expect(entry.lines[2]?.amountRaw).toBe(39_800n * 10n ** 18n);
  });

  it.each([
    ["an unbalanced asset", [trade.lines[0], trade.lines[1], trade.lines[2]], /WMON lines sum to/],
    [
      "a zero line",
      [...trade.lines, { account: "venue", asset: "USDC", amountRaw: "0" }],
      /moves nothing/,
    ],
    [
      "a fractional amount",
      [{ ...trade.lines[0], amountRaw: "-1.5" }, trade.lines[1]],
      /signed decimal/,
    ],
    ["a single line", [trade.lines[0]], /lines/],
  ])("reject %s", (_, lines, message) => {
    const r = JournalEntrySchema.safeParse({ ...trade, lines });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join("\n")).toMatch(message);
  });

  it("require the environment label", () => {
    expect(JournalEntrySchema.safeParse({ ...trade, environment: undefined }).success).toBe(false);
  });
});

describe("valuations", () => {
  it("accept a fresh valuation whose NAV is the sum of holdings", () => {
    expect(ValuationSchema.parse(fresh).navUsdcE6).toBe(100_000_000_000n);
  });

  it("reject a NAV that does not match the holdings", () => {
    expect(ValuationSchema.safeParse({ ...fresh, navUsdcE6: "100000000001" }).success).toBe(false);
  });

  it("never carry a number when unavailable", () => {
    const unavailable = {
      ...fresh,
      status: "unavailable",
      navUsdcE6: null,
      reason: "oracle_stale",
    };
    expect(ValuationSchema.safeParse(unavailable).success).toBe(true);
    expect(ValuationSchema.safeParse({ ...unavailable, navUsdcE6: "100000000000" }).success).toBe(
      false,
    );
  });
});

describe("credits", () => {
  const credits = (balance: bigint, unsettled: bigint, reserved: bigint) => ({
    balanceUsdcE6: balance as UsdcE6,
    unsettledUsdcE6: unsettled as UsdcE6,
    reservedUsdcE6: reserved as UsdcE6,
  });

  it("subtract unsettled usage and reservations from the balance", () => {
    expect(availableCredits(credits(10_000_000n, 2_500_000n, 500_000n))).toBe(7_000_000n);
  });

  it("floor at zero and report exhaustion", () => {
    expect(availableCredits(credits(1_000_000n, 900_000n, 200_000n))).toBe(0n);
    expect(creditsExhausted(credits(1_000_000n, 1_000_000n, 0n))).toBe(true);
    expect(creditsExhausted(credits(1_000_000n, 999_999n, 0n))).toBe(false);
  });
});
