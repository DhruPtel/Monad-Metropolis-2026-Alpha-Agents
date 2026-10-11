import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { SnapshotRow } from "./snapshots.ts";
import type { IntentView } from "./store.ts";
import {
  MAX_CHART_POINTS,
  closedPositions,
  holdingLines,
  hundredDollars,
  maxDrawdown,
  perUnitSeries,
  returnSinceStart,
  tradeMarks,
  winShare,
} from "./window.ts";

/**
 * The portfolio window's math (F-U11): the value-per-unit series on which
 * deposits and withdrawals never count, the three scores with their
 * not-enough-data states, the $100 figure against holding USDC, the trade
 * markers and the holdings with cost basis and gain.
 */
const E18 = 10n ** 18n;
const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
const WBTC = "0x00000000000000000000000000000000000000c3" as Hex;
const WMON = "0x00000000000000000000000000000000000000c2" as Hex;
const T0 = Date.parse("2026-10-10T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const snap = (
  minutes: number,
  perUnit: number | null,
  value: bigint,
  reason: "interval" | "trade" = "interval",
): SnapshotRow => ({
  agentId: 7,
  account: "0x00000000000000000000000000000000000ac007" as Hex,
  block: 1n,
  blockTime: BigInt(Math.floor(at(minutes).getTime() / 1000)),
  valueUsdc: value,
  usdc: value,
  wmon: 0n,
  custody: "v3",
  holdings: null,
  perUnit: perUnit === null ? null : BigInt(Math.round(perUnit * 1e6)) * 10n ** 12n,
  mode: "NORMAL",
  reason,
  intentId: null,
  createdAt: at(minutes),
});

describe("the value-per-unit series (F-U11)", () => {
  it("reads the snapshots oldest first, skipping those without a value per unit, and a deposit moves the value but not the series", () => {
    // 100 USDC at 1.00 per unit; the agent gains 2%; the owner deposits 100 more (units minted at 1.02).
    const rows = [
      snap(120, 1.02, 204_000_000n),
      snap(0, 1.0, 100_000_000n),
      snap(60, 1.02, 102_000_000n),
      snap(30, null, 101_000_000n),
    ];
    const series = perUnitSeries(rows);
    expect(series.map((p) => [p.at.slice(11, 16), p.perUnitE18, p.valueUsdcE6])).toEqual([
      ["00:00", E18.toString(), "100000000"],
      ["01:00", (102n * 10n ** 16n).toString(), "102000000"],
      ["02:00", (102n * 10n ** 16n).toString(), "204000000"],
    ]);
    const r = returnSinceStart(series);
    expect(r).toMatchObject({ ok: true, bps: 200 });
    const h = hundredDollars(series);
    expect(h).toEqual({ ok: true, now: "102.00", usdc: "100.00", since: at(0).toISOString() });
    // A withdrawal of half at 1.02: the value halves, the series does not, and nothing is a loss.
    const after = perUnitSeries([...rows, snap(180, 1.02, 102_000_000n)]);
    expect(returnSinceStart(after)).toMatchObject({ ok: true, bps: 200 });
    expect(maxDrawdown(after)).toMatchObject({ ok: true, bps: 0 });
  });

  it("thins a long history evenly, keeping the first, the last and every trade's reading", () => {
    const rows = Array.from({ length: 1_000 }, (_, i) =>
      snap(i, 1 + i / 10_000, 100_000_000n, i === 500 ? "trade" : "interval"),
    );
    const series = perUnitSeries(rows);
    expect(series.length).toBeLessThanOrEqual(MAX_CHART_POINTS);
    expect(series[0]?.at).toBe(at(0).toISOString());
    expect(series[series.length - 1]?.at).toBe(at(999).toISOString());
    expect(series.some((p) => p.at === at(500).toISOString() && p.reason === "trade")).toBe(true);
  });

  it("says not enough data with fewer than two readings or under an hour of history", () => {
    expect(returnSinceStart([])).toMatchObject({ ok: false });
    const one = perUnitSeries([snap(0, 1, 100_000_000n)]);
    expect(returnSinceStart(one)).toMatchObject({
      ok: false,
      reason: "Not enough data yet: the account needs at least two readings.",
    });
    const brief = perUnitSeries([snap(0, 1, 100_000_000n), snap(45, 1.1, 110_000_000n)]);
    expect(maxDrawdown(brief)).toMatchObject({
      ok: false,
      reason: "Not enough data yet: the account needs at least an hour of history.",
    });
    expect(hundredDollars(brief)).toMatchObject({ ok: false });
    const hour = perUnitSeries([snap(0, 1, 100_000_000n), snap(60, 1.1, 110_000_000n)]);
    expect(hundredDollars(hour)).toMatchObject({ ok: true, now: "110.00" });
  });

  it("measures the largest fall from a peak, and a loss shows as a negative return and a figure under 100", () => {
    const series = perUnitSeries([
      snap(0, 1.0, 100_000_000n),
      snap(60, 1.2, 120_000_000n),
      snap(120, 0.9, 90_000_000n),
      snap(180, 1.05, 105_000_000n),
      snap(240, 0.95, 95_000_000n),
    ]);
    expect(maxDrawdown(series)).toEqual({
      ok: true,
      bps: 2_500,
      peakAt: at(60).toISOString(),
      troughAt: at(120).toISOString(),
    });
    expect(returnSinceStart(series)).toMatchObject({ ok: true, bps: -500 });
    expect(hundredDollars(series)).toMatchObject({ ok: true, now: "95.00", usdc: "100.00" });
  });
});

const intent = (over: Partial<IntentView>): IntentView =>
  ({
    intentId: "intent-1",
    chainId: 143143,
    agentId: 7,
    account: null,
    custody: "v3",
    sell: "USDC",
    buy: "WBTC",
    sellToken: USDC,
    buyToken: WBTC,
    sellDecimals: 6,
    buyDecimals: 8,
    route: null,
    amountIn: 10_000_000n,
    reason: "",
    status: "reconciled",
    reasonCodes: [],
    blockers: [],
    expectedOut: null,
    ownerEpoch: 0n,
    configEpoch: 0n,
    strategyEpoch: 1n,
    source: "template",
    approvedBy: "auto",
    approvedAt: at(1),
    submittedAt: at(1),
    settledAt: at(2),
    minAmountOut: null,
    deadline: null,
    actionId: null,
    txId: null,
    txHash: "0xabc",
    amountOut: 10_000n,
    failure: null,
    createdAt: at(1),
    expiresAt: at(31),
    updatedAt: at(2),
    ...over,
  }) as IntentView;

describe("trade markers and closed positions (F-U11)", () => {
  it("marks settled trades only, with the side, the token and the USDC each way, oldest first", () => {
    const marks = tradeMarks([
      intent({
        intentId: "intent-2",
        sell: "WBTC",
        buy: "USDC",
        sellToken: WBTC,
        buyToken: USDC,
        sellDecimals: 8,
        buyDecimals: 6,
        amountIn: 5_000n,
        amountOut: 6_000_000n,
        settledAt: at(50),
      }),
      intent({ intentId: "intent-1" }),
      intent({ intentId: "intent-3", status: "rejected", settledAt: null }),
    ]);
    expect(marks).toEqual([
      {
        at: at(2).toISOString(),
        intentId: "intent-1",
        side: "buy",
        symbol: "WBTC",
        amountRaw: "10000",
        decimals: 8,
        usdcE6: "10000000",
        txHash: "0xabc",
      },
      {
        at: at(50).toISOString(),
        intentId: "intent-2",
        side: "sell",
        symbol: "WBTC",
        amountRaw: "5000",
        decimals: 8,
        usdcE6: "6000000",
        txHash: "0xabc",
      },
    ]);
  });

  it("counts a position as closed once it is sold out or no longer held, and says which made money", () => {
    const buyBtc = intent({ intentId: "b1", amountIn: 10_000_000n, amountOut: 10_000n });
    const sellBtcAll = intent({
      intentId: "s1",
      sell: "WBTC",
      buy: "USDC",
      sellToken: WBTC,
      buyToken: USDC,
      sellDecimals: 8,
      buyDecimals: 6,
      amountIn: 10_000n,
      amountOut: 12_000_000n,
      settledAt: at(50),
    });
    const buyMon = intent({
      intentId: "b2",
      buy: "WMON",
      buyToken: WMON,
      buyDecimals: 18,
      amountIn: 20_000_000n,
      amountOut: 800n * E18,
      settledAt: at(3),
    });
    const sellMonHalf = intent({
      intentId: "s2",
      sell: "WMON",
      buy: "USDC",
      sellToken: WMON,
      buyToken: USDC,
      sellDecimals: 18,
      buyDecimals: 6,
      amountIn: 400n * E18,
      amountOut: 9_000_000n,
      settledAt: at(60),
    });
    // WBTC sold out at a profit; WMON half sold at a loss and still held: open, not counted.
    const closed = closedPositions([buyBtc, sellBtcAll, buyMon, sellMonHalf], ["WMON", "USDC"]);
    expect(closed).toEqual([
      { symbol: "WBTC", spentUsdcE6: "10000000", receivedUsdcE6: "12000000", profitable: true },
    ]);
    expect(winShare(closed)).toEqual({ ok: true, bps: 10_000, closed: 1, won: 1 });
    // WMON no longer held (the rest left another way): counted, at a loss.
    const both = closedPositions([buyBtc, sellBtcAll, buyMon, sellMonHalf], ["USDC"]);
    expect(both.map((c) => [c.symbol, c.profitable])).toEqual([
      ["WBTC", true],
      ["WMON", false],
    ]);
    expect(winShare(both)).toEqual({ ok: true, bps: 5_000, closed: 2, won: 1 });
    expect(winShare([])).toMatchObject({
      ok: false,
      reason: "Not enough data yet: no position has been closed.",
    });
    // A buy with no sale is never closed.
    expect(closedPositions([buyBtc], [])).toEqual([]);
  });
});

describe("the holdings with cost basis and gain (F-U11)", () => {
  it("values each token at its price, shares the priced total, and reads the gain against the cost basis", () => {
    const lines = holdingLines(
      [
        {
          token: USDC,
          symbol: "USDC",
          decimals: 6,
          balance: 60_000_000n,
          costBasisUsdcE6: null,
          priceE18: E18,
        },
        {
          token: WBTC,
          symbol: "WBTC",
          decimals: 8,
          balance: 20_000n,
          costBasisUsdcE6: 18_000_000n,
          priceE18: 100_000n * E18,
        },
        {
          token: WMON,
          symbol: "WMON",
          decimals: 18,
          balance: 800n * E18,
          costBasisUsdcE6: 20_000_000n,
          priceE18: null,
        },
        {
          token: "0x00000000000000000000000000000000000000c4",
          symbol: "AUSD",
          decimals: 6,
          balance: 0n,
          costBasisUsdcE6: 0n,
          priceE18: E18,
        },
      ],
      USDC,
    );
    expect(lines.map((l) => l.symbol)).toEqual(["USDC", "WBTC", "WMON"]);
    expect(lines[0]).toMatchObject({
      isCash: true,
      valueUsdcE6: "60000000",
      shareBps: 7_500,
      costBasisUsdcE6: "60000000",
      gainUsdcE6: null,
    });
    expect(lines[1]).toMatchObject({
      valueUsdcE6: "20000000",
      shareBps: 2_500,
      costBasisUsdcE6: "18000000",
      gainUsdcE6: "2000000",
      gainBps: 1_111,
    });
    // Unpriced: held, counted as unknown, no share and no gain.
    expect(lines[2]).toMatchObject({
      valueUsdcE6: null,
      shareBps: null,
      costBasisUsdcE6: "20000000",
      gainUsdcE6: null,
      gainBps: null,
    });
  });
});
