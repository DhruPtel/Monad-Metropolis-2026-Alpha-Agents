/**
 * The trading profile (2026-10-13, testnet testing): which offchain trading
 * limits the runner applies on top of a plan's own parameters. Testnet trades
 * small amounts on shallow pools with no real users, so its profile drops the
 * minimum trade and lets gas, priced at MON's real price, decide how small a
 * trade can go. Every other environment (mainnet, the beta and the forks) runs
 * the launch profile, which changes nothing.
 *
 * The onchain limits (the Executor's policy and the trading account's
 * backstops) are not here: they stay as deployed in every environment.
 */
import { GOAL_LIMITS } from "./limits.ts";

export interface TradingProfile {
  readonly id: "launch" | "testnet";
  /** The least a leg may be worth, replacing the plan's; null keeps the plan's own. */
  readonly minTradeUsdcE6: bigint | null;
  /** The most a leg may cost in bps of its value, replacing the plan's; null keeps the plan's own. */
  readonly costHurdleBps: number | null;
  /** Whether a leg's gas, in USDC, counts toward its cost. */
  readonly countsGas: boolean;
}

export const LAUNCH_TRADING_PROFILE: TradingProfile = Object.freeze({
  id: "launch",
  minTradeUsdcE6: null,
  costHurdleBps: null,
  countsGas: false,
});

/**
 * Testnet only. No minimum trade (one USDC base unit, so a leg is never empty),
 * a cost limit at the onchain slippage limit, and gas counted in the cost.
 */
export const TESTNET_TRADING_PROFILE: TradingProfile = Object.freeze({
  id: "testnet",
  minTradeUsdcE6: 1n,
  costHurdleBps: GOAL_LIMITS.maxSlippageBps,
  countsGas: true,
});

/** The profile for an environment id: the testnet profile on testnet alone. */
export function tradingProfileFor(environmentId: string): TradingProfile {
  return environmentId === "testnet" ? TESTNET_TRADING_PROFILE : LAUNCH_TRADING_PROFILE;
}

/** A plan's parameters with the profile's minimum trade and cost limit in place of its own. */
export function withTradingProfile<
  P extends { readonly minTradeUsdcE6: bigint; readonly costHurdleBps: number },
>(params: P, profile: TradingProfile): P {
  return {
    ...params,
    ...(profile.minTradeUsdcE6 !== null ? { minTradeUsdcE6: profile.minTradeUsdcE6 } : {}),
    ...(profile.costHurdleBps !== null ? { costHurdleBps: profile.costHurdleBps } : {}),
  };
}

/** A transaction's gas in USDC base units: gas in wei at MON's USD price (18 decimals). */
export function gasCostUsdcE6(gasWei: bigint, monUsdE18: bigint): bigint {
  // wei × USD/MON (1e18) / 1e18 (wei per MON) / 1e12 (to 6 decimals), rounded up.
  const d = 10n ** 30n;
  return (gasWei * monUsdE18 + d - 1n) / d;
}

/**
 * Whether a leg's whole cost, its price impact and fees (`costBps`) plus its
 * gas, stays within the limit; the total in bps of the leg's value.
 */
export function legCostWithGas(o: {
  readonly legValueUsdcE6: bigint;
  readonly costBps: number;
  readonly gasUsdcE6: bigint;
  readonly hurdleBps: number;
}): { readonly gasBps: number; readonly totalBps: number; readonly passes: boolean } {
  if (o.legValueUsdcE6 <= 0n) return { gasBps: 10_000, totalBps: 10_000, passes: false };
  const gasBps = Number((o.gasUsdcE6 * 10_000n + o.legValueUsdcE6 - 1n) / o.legValueUsdcE6);
  const totalBps = o.costBps + gasBps;
  return { gasBps, totalBps, passes: totalBps <= o.hurdleBps };
}
