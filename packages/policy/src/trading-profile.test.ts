import { describe, expect, it } from "vitest";
import { LAUNCH_LIMITS } from "./limits.ts";
import {
  LAUNCH_TRADING_PROFILE,
  TESTNET_TRADING_PROFILE,
  gasCostUsdcE6,
  legCostWithGas,
  tradingProfileFor,
  withTradingProfile,
} from "./trading-profile.ts";

const E18 = 10n ** 18n;
const params = { minTradeUsdcE6: 500_000n, costHurdleBps: 40, targetWmonBps: 2_000 };

describe("trading profile", () => {
  it("applies the testnet profile on testnet alone; mainnet, the beta and the forks keep the plan", () => {
    expect(tradingProfileFor("testnet")).toBe(TESTNET_TRADING_PROFILE);
    for (const id of ["mainnet", "beta", "local", "base-fork", "canary"])
      expect(tradingProfileFor(id)).toBe(LAUNCH_TRADING_PROFILE);
    expect(withTradingProfile(params, LAUNCH_TRADING_PROFILE)).toEqual(params);
    expect(LAUNCH_TRADING_PROFILE.countsGas).toBe(false);
  });

  it("drops the minimum trade on testnet and sets the cost limit at the onchain slippage limit", () => {
    expect(withTradingProfile(params, TESTNET_TRADING_PROFILE)).toEqual({
      minTradeUsdcE6: 1n,
      costHurdleBps: LAUNCH_LIMITS.maxSlippageBps,
      targetWmonBps: 2_000,
    });
    expect(TESTNET_TRADING_PROFILE.costHurdleBps).toBe(50);
    expect(TESTNET_TRADING_PROFILE.countsGas).toBe(true);
  });

  it("prices gas in USDC, rounded up", () => {
    // 0.1989 MON at 0.02425 USD is 0.004823 USDC.
    expect(gasCostUsdcE6(198_900_000_000_000_000n, 24_250_000_000_000_000n)).toBe(4_824n);
    expect(gasCostUsdcE6(0n, E18)).toBe(0n);
  });

  it("counts gas with price impact and fees against the limit", () => {
    // A 0.80 USDC leg: 20 bps of impact and fees, 4,824 base units of gas is 61 bps.
    expect(
      legCostWithGas({ legValueUsdcE6: 800_000n, costBps: 20, gasUsdcE6: 4_824n, hurdleBps: 50 }),
    ).toEqual({ gasBps: 61, totalBps: 81, passes: false });
    // A 2.00 USDC leg passes: 25 bps of gas.
    expect(
      legCostWithGas({ legValueUsdcE6: 2_000_000n, costBps: 20, gasUsdcE6: 4_824n, hurdleBps: 50 }),
    ).toEqual({ gasBps: 25, totalBps: 45, passes: true });
    expect(
      legCostWithGas({ legValueUsdcE6: 0n, costBps: 0, gasUsdcE6: 0n, hurdleBps: 50 }).passes,
    ).toBe(false);
  });
});
