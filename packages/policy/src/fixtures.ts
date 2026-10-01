import type {
  AmountRaw,
  ClientRequestId,
  PriceE18,
  RejectionCode,
  SwapIntent,
  UsdcE6,
} from "@alpha-agents/domain";
import { LAUNCH_LIMITS, type PolicyLimits } from "./limits.ts";
import type { AccountState } from "./state.ts";

/**
 * Shared fixtures: one account snapshot builder and one breach case per hard
 * limit. The server pre-checks and, later, the contract tests run the same cases
 * (BUILD_PLAN P0-U5). Values are in base units and never floating point.
 *
 * Base account: NAV 100,000 USDC, 70% USDC and 30% WMON, WMON at 0.025 USDC.
 */
export const FIXTURE_NOW = 1_790_000_000;
export const WMON_PRICE_E18 = 25_000_000_000_000_000n as PriceE18;

/** USDC base units for a whole-USDC amount. */
export const usdc = (whole: bigint): UsdcE6 => (whole * 1_000_000n) as UsdcE6;
/**
 * A USDC holding or sell amount: USDC's raw amount equals its value in base
 * units. The one place a USDC value becomes an AmountRaw; never cast inline.
 */
export const usdcAmount = (whole: bigint): AmountRaw => usdc(whole) as bigint as AmountRaw;
/** The WMON amount worth `value` USDC base units at the fixture price. */
export const wmonWorth = (value: bigint): AmountRaw =>
  ((value * 10n ** 30n) / WMON_PRICE_E18) as AmountRaw;

export function fixtureState(overrides: Partial<AccountState> = {}): AccountState {
  return {
    mode: "NORMAL",
    holdings: { USDC: usdcAmount(70_000n), WMON: wmonWorth(usdc(30_000n)) },
    oracle: {
      WMON: { priceE18: WMON_PRICE_E18, updatedAt: FIXTURE_NOW - 60, poolPriceE18: WMON_PRICE_E18 },
    },
    buyAllowlist: ["USDC", "WMON"],
    recentTrades: [],
    ...overrides,
  };
}

export function fixtureSwap(overrides: Partial<SwapIntent> = {}): SwapIntent {
  return {
    kind: "swap",
    schemaVersion: 1,
    account: "personal",
    sell: "USDC",
    buy: "WMON",
    sellAmountRaw: usdcAmount(1_000n),
    reason: "fixture",
    clientRequestId: "fixture-0001" as ClientRequestId,
    ...overrides,
  };
}

export interface BreachFixture {
  readonly name: string;
  readonly intent: SwapIntent;
  readonly state: AccountState;
  readonly now: number;
  readonly limits: PolicyLimits;
  readonly expected: RejectionCode;
}

const breach = (
  name: string,
  expected: RejectionCode,
  intent: Partial<SwapIntent>,
  state: Partial<AccountState> = {},
  limits: Partial<PolicyLimits> = {},
): BreachFixture => ({
  name,
  expected,
  intent: fixtureSwap(intent),
  state: fixtureState(state),
  now: FIXTURE_NOW,
  limits: { ...LAUNCH_LIMITS, ...limits },
});

const trades = (count: number, each: UsdcE6, at = FIXTURE_NOW - 3_600) =>
  Array.from({ length: count }, () => ({ at, valueUsdcE6: each }));

/** One swap per hard limit, each breaching exactly that limit by one unit. */
export const BREACH_FIXTURES: readonly BreachFixture[] = [
  breach("trade over 10% of NAV", "TRADE_SIZE_EXCEEDED", {
    sell: "WMON",
    buy: "USDC",
    sellAmountRaw: wmonWorth(usdc(10_000n) + 1n),
  }),
  breach(
    "WMON over 40% of NAV after the trade",
    "CONCENTRATION_CAP",
    { sellAmountRaw: (usdcAmount(5_000n) + 1n) as AmountRaw },
    { holdings: { USDC: usdcAmount(65_000n), WMON: wmonWorth(usdc(35_000n)) } },
  ),
  breach(
    "USDC under 10% of NAV after the trade",
    "USDC_FLOOR",
    { sellAmountRaw: (usdcAmount(2_000n) + 1n) as AmountRaw },
    { holdings: { USDC: usdcAmount(12_000n), WMON: wmonWorth(usdc(88_000n)) } },
    { maxAssetBps: 10_000 },
  ),
  breach("slippage over 0.5%", "SLIPPAGE_TOO_HIGH", {
    maxSlippageBps: 51 as SwapIntent["maxSlippageBps"],
  }),
  breach("21st trade in 24 hours", "DAILY_TRADE_LIMIT", {}, { recentTrades: trades(20, usdc(1n)) }),
  breach(
    "turnover over 100% of NAV in 24 hours",
    "TURNOVER_CAP",
    { sellAmountRaw: wmonWorth(usdc(10_000n) + 1n), sell: "WMON", buy: "USDC" },
    { recentTrades: trades(9, usdc(10_000n)) },
    { maxTradeBps: 10_000 },
  ),
  breach(
    "oracle 5 minutes old or older",
    "ORACLE_STALE",
    {},
    {
      oracle: {
        WMON: {
          priceE18: WMON_PRICE_E18,
          updatedAt: FIXTURE_NOW - 300,
          poolPriceE18: WMON_PRICE_E18,
        },
      },
    },
  ),
  breach(
    "pool more than 2% from the oracle",
    "ORACLE_POOL_DEVIATION",
    {},
    {
      oracle: {
        WMON: {
          priceE18: WMON_PRICE_E18,
          updatedAt: FIXTURE_NOW - 60,
          poolPriceE18: ((WMON_PRICE_E18 * 102n) / 100n + 1n) as PriceE18,
        },
      },
    },
  ),
  breach("buy in REDUCE_ONLY", "REDUCE_ONLY_MODE", {}, { mode: "REDUCE_ONLY" }),
  breach("any trade while PAUSED", "PAUSED", {}, { mode: "PAUSED" }),
  breach("agent swap on a vault in handover", "VAULT_IN_HANDOVER", {}, { mode: "HANDOVER" }),
  breach("buy an asset off the allowlist", "ASSET_NOT_ALLOWED", {}, { buyAllowlist: ["USDC"] }),
  breach(
    "sell more than held",
    "INSUFFICIENT_BALANCE",
    { sell: "WMON", buy: "USDC", sellAmountRaw: (wmonWorth(usdc(100n)) + 1n) as AmountRaw },
    { holdings: { USDC: usdcAmount(99_900n), WMON: wmonWorth(usdc(100n)) } },
  ),
];
