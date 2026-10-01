import {
  ACCOUNT_MODES,
  ASSET_DECIMALS,
  type AccountMode,
  type AmountRaw,
  type AssetId,
  type Bps,
  type ClientRequestId,
  type PriceE18,
  type RejectionCode,
  type SwapIntent,
  type UsdcE6,
  parseAmount,
} from "@alpha-agents/domain";
import {
  type AccountState,
  type PolicyResult,
  type SwapCheck,
  checkSwap,
} from "@alpha-agents/policy";

/**
 * The policy sandbox: a form describing one swap and one account, turned into
 * a SwapIntent and an AccountState and run through packages/policy's
 * checkSwap with the launch limits. Pure, so tests can check every preset.
 * All amounts are typed decimals parsed to bigints; nothing uses floating point.
 */
export interface SandboxForm {
  readonly sell: AssetId;
  readonly buy: AssetId;
  readonly sellAmount: string;
  readonly maxSlippageBps: string;
  readonly mode: AccountMode;
  readonly usdcHolding: string;
  readonly wmonHolding: string;
  /** USDC per WMON, as typed, for example "0.025". */
  readonly wmonPrice: string;
  readonly oracleAgeSeconds: string;
  /** Pool price distance from the oracle, in basis points; may be negative. */
  readonly poolDeviationBps: string;
  readonly tradesLast24h: string;
  readonly turnoverUsedUsdc: string;
  readonly wmonBuyable: boolean;
}

/** A fixed clock so results never depend on when the page is opened. */
export const SANDBOX_NOW = 1_790_000_000;

export const DEFAULT_FORM: SandboxForm = {
  sell: "USDC",
  buy: "WMON",
  sellAmount: "1,000",
  maxSlippageBps: "30",
  mode: "NORMAL",
  usdcHolding: "70,000",
  wmonHolding: "1,200,000",
  wmonPrice: "0.025",
  oracleAgeSeconds: "60",
  poolDeviationBps: "0",
  tradesLast24h: "2",
  turnoverUsedUsdc: "5,000",
  wmonBuyable: true,
};

export interface SandboxPreset {
  readonly id: string;
  readonly label: string;
  readonly form: SandboxForm;
  /** The reason codes this preset produces, checked by a test. */
  readonly expected: readonly RejectionCode[];
}

const preset = (
  id: string,
  label: string,
  patch: Partial<SandboxForm>,
  expected: RejectionCode[],
): SandboxPreset => ({
  id,
  label,
  form: { ...DEFAULT_FORM, ...patch },
  expected,
});

/** One preset per limit, each breaking it by a small margin. */
export const PRESETS: readonly SandboxPreset[] = [
  preset("ok", "Within limits", {}, []),
  // 400,040 WMON is 10,001 USDC, just over 10% of the 100,000 USDC account.
  preset("size", "Trade too large", { sell: "WMON", buy: "USDC", sellAmount: "400,040" }, [
    "TRADE_SIZE_EXCEEDED",
  ]),
  preset("slippage", "Too much slippage", { maxSlippageBps: "75" }, ["SLIPPAGE_TOO_HIGH"]),
  preset(
    "concentration",
    "Over 40% in WMON",
    { usdcHolding: "65,000", wmonHolding: "1,400,000", sellAmount: "5,001" },
    ["CONCENTRATION_CAP"],
  ),
  // With two assets, the USDC floor only binds together with the 40% cap (FINAL_PLAN 6.3).
  preset(
    "floor",
    "Under 10% in USDC",
    { usdcHolding: "12,000", wmonHolding: "3,520,000", sellAmount: "2,001" },
    ["CONCENTRATION_CAP", "USDC_FLOOR"],
  ),
  preset("trades", "21st trade in 24 hours", { tradesLast24h: "20" }, ["DAILY_TRADE_LIMIT"]),
  preset(
    "turnover",
    "Turnover over 100%",
    { tradesLast24h: "9", turnoverUsedUsdc: "91,000", sellAmount: "9,500" },
    ["TURNOVER_CAP"],
  ),
  preset("stale", "Oracle 5 minutes old", { oracleAgeSeconds: "300" }, ["ORACLE_STALE"]),
  preset("deviation", "Pool 2.5% off the oracle", { poolDeviationBps: "250" }, [
    "ORACLE_POOL_DEVIATION",
  ]),
  preset("reduce-only", "Buy in reduce-only", { mode: "REDUCE_ONLY" }, ["REDUCE_ONLY_MODE"]),
  preset("paused", "Account paused", { mode: "PAUSED" }, ["PAUSED"]),
  preset("handover", "Vault in handover", { mode: "HANDOVER" }, ["VAULT_IN_HANDOVER"]),
  preset("allowlist", "WMON not on the buy list", { wmonBuyable: false }, ["ASSET_NOT_ALLOWED"]),
  preset(
    "balance",
    "Sell more than held",
    { usdcHolding: "99,900", wmonHolding: "4,000", sell: "WMON", buy: "USDC", sellAmount: "4,001" },
    ["INSUFFICIENT_BALANCE"],
  ),
];

export type SandboxOutcome =
  | { readonly kind: "input"; readonly errors: readonly string[] }
  | { readonly kind: "policy"; readonly result: PolicyResult<SwapCheck> };

function integer(text: string, label: string, errors: string[], min: number, max: number): number {
  const n = Number(text.trim().replace(/,/g, ""));
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    errors.push(`${label} must be a whole number from ${min} to ${max}.`);
    return 0;
  }
  return n;
}

function decimal(text: string, decimals: number, label: string, errors: string[]): bigint {
  const value = parseAmount(text, decimals);
  if (value === undefined) {
    errors.push(`${label} must be a number with at most ${decimals} decimals.`);
    return 0n;
  }
  return value;
}

/** Turns the form into an intent and an account state and runs checkSwap. */
export function runSandbox(form: SandboxForm): SandboxOutcome {
  const errors: string[] = [];
  if (!ACCOUNT_MODES.includes(form.mode)) errors.push("Mode is not a canonical account mode.");
  if (form.sell === form.buy) errors.push("Sell and buy must be different assets.");
  const sellAmount = decimal(form.sellAmount, ASSET_DECIMALS[form.sell], "Sell amount", errors);
  if (sellAmount === 0n) errors.push("Sell amount must be greater than zero.");
  const slippage = integer(form.maxSlippageBps, "Max slippage", errors, 0, 10_000);
  const usdc = decimal(form.usdcHolding, ASSET_DECIMALS.USDC, "USDC held", errors);
  const wmon = decimal(form.wmonHolding, ASSET_DECIMALS.WMON, "WMON held", errors);
  const price = decimal(form.wmonPrice, 18, "WMON price", errors);
  const age = integer(form.oracleAgeSeconds, "Oracle age", errors, -86_400, 86_400 * 365);
  const deviation = integer(form.poolDeviationBps, "Pool deviation", errors, -9_999, 10_000);
  const trades = integer(form.tradesLast24h, "Trades in 24 hours", errors, 0, 1_000);
  const turnover = decimal(form.turnoverUsedUsdc, ASSET_DECIMALS.USDC, "Turnover used", errors);
  if (turnover > 0n && trades === 0)
    errors.push("Turnover used needs at least one trade in 24 hours.");
  if (errors.length > 0) return { kind: "input", errors };

  // Spread the turnover over the trades, all an hour ago, inside the window.
  const each = trades > 0 ? turnover / BigInt(trades) : 0n;
  const recentTrades = Array.from({ length: trades }, (_, i) => ({
    at: SANDBOX_NOW - 3_600,
    valueUsdcE6: (i === 0 ? each + (turnover - each * BigInt(trades)) : each) as UsdcE6,
  }));

  const state: AccountState = {
    mode: form.mode,
    holdings: { USDC: usdc as AmountRaw, WMON: wmon as AmountRaw },
    oracle: {
      WMON: {
        priceE18: price as PriceE18,
        updatedAt: SANDBOX_NOW - age,
        poolPriceE18: ((price * BigInt(10_000 + deviation)) / 10_000n) as PriceE18,
      },
    },
    buyAllowlist: form.wmonBuyable ? ["USDC", "WMON"] : ["USDC"],
    recentTrades,
  };
  const intent: SwapIntent = {
    kind: "swap",
    schemaVersion: 1,
    account: "personal",
    sell: form.sell,
    buy: form.buy,
    sellAmountRaw: sellAmount as AmountRaw,
    maxSlippageBps: slippage as Bps,
    reason: "Policy sandbox",
    clientRequestId: "console-sandbox" as ClientRequestId,
  };
  return { kind: "policy", result: checkSwap(intent, state, SANDBOX_NOW) };
}
