// @ts-check
// The arithmetic of the canary run (P2-EC part 2), kept apart from the chain
// so it is tested on its own: the swap intent, the launch pool's price from
// its slot0, slippage and deviation against the Chainlink price, the fees a
// transaction may cost, and the spending budget (D-316).
import { keccak256, toBytes } from "viem";

/** The registry ID of the v4 MON/USDC 0.05% adapter. */
export const V4_ADAPTER_ID = keccak256(toBytes("uniswap-v4-mon-usdc-500"));

/** The signer's and the Executor's slippage floor (launch policy, 50 bps). */
export const FLOOR_SLIPPAGE_BPS = 50n;

/** The most an intent's deadline may lie ahead (launch policy, 120 s). */
export const DEADLINE_SECONDS = 120n;

/** The fee caps of A-38: at most 500 gwei per gas and 10 gwei of priority. */
export const MAX_FEE_PER_GAS_CAP = 500_000_000_000n;
export const MAX_PRIORITY_FEE_CAP = 10_000_000_000n;

/**
 * Fees for an owner transaction, as the signer sets them (A-38): twice the
 * base fee plus the tip, within the caps; null when the base fee alone is over.
 * @param {bigint} baseFee @param {bigint} priorityFee
 */
export function fees(baseFee, priorityFee) {
  const tip = priorityFee < MAX_PRIORITY_FEE_CAP ? priorityFee : MAX_PRIORITY_FEE_CAP;
  if (baseFee + tip > MAX_FEE_PER_GAS_CAP) return null;
  const maxFee = baseFee * 2n + tip;
  return {
    maxFeePerGas: maxFee > MAX_FEE_PER_GAS_CAP ? MAX_FEE_PER_GAS_CAP : maxFee,
    maxPriorityFeePerGas: tip,
  };
}

/**
 * A gas limit from an estimate (D-306): Monad charges the limit, so it stays
 * close to the estimate, at 110%.
 * @param {bigint} estimate
 */
export const gasLimitFor = (estimate) => (estimate * 110n + 99n) / 100n;

/**
 * Whether a transaction may be sent within the budget: what is already spent
 * plus the most it can cost (limit times max fee) stays within the budget.
 * @param {{ spentWei: bigint, budgetWei: bigint, gas: bigint, maxFeePerGas: bigint }} b
 */
export function withinBudget(b) {
  return b.spentWei + b.gas * b.maxFeePerGas <= b.budgetWei;
}

/**
 * The launch pool's price in USDC per MON, 18 decimals, from its sqrtPriceX96.
 * currency0 is native MON (18 decimals) and currency1 is USDC (6), so the raw
 * price is USDC units per MON wei, scaled up by 10^12 to whole tokens.
 * @param {bigint} sqrtPriceX96
 */
export function poolPriceE18(sqrtPriceX96) {
  const q192 = 1n << 192n;
  return (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n * 10n ** 12n) / q192;
}

/**
 * Signed difference in basis points of `a` from `b` (positive when `a` is higher).
 * @param {bigint} a @param {bigint} b
 */
export const bpsFrom = (a, b) => Number(((a - b) * 1_000_000n) / b) / 100;

/**
 * What a swap would give at the oracle's price, with no fee or impact:
 * WMON for USDC on a buy, USDC for WMON on a sale.
 * @param {"buy" | "sell"} direction @param {bigint} amountIn @param {bigint} priceE18 USDC per MON, 18 decimals
 */
export function atOraclePrice(direction, amountIn, priceE18) {
  return direction === "buy"
    ? (amountIn * 10n ** 12n * 10n ** 18n) / priceE18
    : (amountIn * priceE18) / 10n ** 18n / 10n ** 12n;
}

/**
 * Slippage of a settled swap against the Chainlink price, in basis points:
 * how much less it gave than the oracle's price would (fee and impact included).
 * @param {"buy" | "sell"} direction @param {bigint} amountIn @param {bigint} amountOut @param {bigint} priceE18
 */
export function slippageBps(direction, amountIn, amountOut, priceE18) {
  const ideal = atOraclePrice(direction, amountIn, priceE18);
  return Number(((ideal - amountOut) * 1_000_000n) / ideal) / 100;
}

/**
 * The canary's swap intent (FINAL_PLAN 4.1.7), from what the chain says now.
 * @param {{
 *   chainId: number, account: `0x${string}`, step: string, runId: string,
 *   configEpoch: bigint, policyHash: `0x${string}`, tokenIn: `0x${string}`,
 *   tokenOut: `0x${string}`, amountIn: bigint, floor: bigint, blockTime: bigint,
 * }} r
 * @returns {import("@alpha-agents/signer").SwapIntentArgs}
 */
export function canaryIntent(r) {
  return {
    schemaVersion: 1,
    chainId: BigInt(r.chainId),
    agentId: 1n,
    account: r.account,
    actionId: keccak256(toBytes(`p2ec-canary:${r.runId}:${r.step}`)),
    ownerEpoch: 0n,
    configEpoch: r.configEpoch,
    policyHash: r.policyHash,
    adapterId: V4_ADAPTER_ID,
    tokenIn: r.tokenIn,
    tokenOut: r.tokenOut,
    amountIn: r.amountIn,
    minAmountOut: r.floor,
    deadline: r.blockTime + DEADLINE_SECONDS,
  };
}
