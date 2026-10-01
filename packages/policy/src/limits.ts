/**
 * The launch hard limits (FINAL_PLAN 6.3, 4.1.7, 4.7.8; conversation decisions
 * and planning answers). Ratios are integer basis points; times are seconds.
 *
 * These are OFFCHAIN PRE-CHECKS. The Executor contract is the final authority
 * and re-checks every limit onchain; these functions exist only to fail fast
 * with a typed reason before anything is signed. At runtime the limits come
 * from the Executor's `limits(account)` view for the agent's config epoch
 * (FINAL_PLAN 4.4.1, "limits are read, never hard-coded"); LAUNCH_LIMITS is the
 * default and the fixture the server pre-checks and the contract tests share.
 *
 * Boundaries: a maximum passes at exactly its value and fails one unit above;
 * a minimum passes at exactly its value and fails one unit below.
 */
export interface PolicyLimits {
  /** Max value of one trade, as a share of account NAV. */
  readonly maxTradeBps: number;
  /** Max share of NAV in any one non-USDC asset after a trade. */
  readonly maxAssetBps: number;
  /** Min share of NAV in USDC after a trade. */
  readonly minUsdcBps: number;
  /** Max slippage against the oracle-implied output. */
  readonly maxSlippageBps: number;
  /** Max trades in any rolling window. */
  readonly maxTradesPerWindow: number;
  /** Max sum of traded value in any rolling window, as a share of NAV. */
  readonly maxTurnoverBps: number;
  /** Length of the rolling window for trades and turnover. */
  readonly windowSeconds: number;
  /** Max distance from now to an intent's deadline. */
  readonly deadlineSeconds: number;
  /** Max age of an oracle price. */
  readonly oracleMaxAgeSeconds: number;
  /** Max distance between the pool price and the oracle price. */
  readonly oracleMaxDeviationBps: number;
  /** Drawdown from the 7-day peak at which the account becomes REDUCE_ONLY. */
  readonly breakerReduceOnlyBps: number;
  /** Drawdown from the 7-day peak at which the account becomes PAUSED. */
  readonly breakerPauseBps: number;
  /** Window over which the breaker's peak is taken. */
  readonly breakerPeakWindowSeconds: number;
}

const DAY = 86_400;

export const LAUNCH_LIMITS: PolicyLimits = Object.freeze({
  maxTradeBps: 1_000, // 10% of account value per trade
  maxAssetBps: 4_000, // 40% in any non-USDC asset
  minUsdcBps: 1_000, // at least 10% in USDC
  maxSlippageBps: 50, // 0.5%
  maxTradesPerWindow: 20, // 20 trades per rolling 24 hours
  maxTurnoverBps: 10_000, // 100% of NAV per rolling 24 hours
  windowSeconds: DAY,
  deadlineSeconds: 120, // 2-minute deadlines
  oracleMaxAgeSeconds: 300, // oracle price under 5 minutes old
  oracleMaxDeviationBps: 200, // within 2% of the pool price
  breakerReduceOnlyBps: 1_000, // 10% drop from the 7-day peak
  breakerPauseBps: 2_000, // 20% drop from the 7-day peak
  breakerPeakWindowSeconds: 7 * DAY,
});

/**
 * The custody core's own backstops, slightly looser than the Executor's limits
 * (FINAL_PLAN 4.7.8). Not used by the pre-checks; listed so every consumer reads
 * one definition.
 */
export const CUSTODY_BACKSTOPS = Object.freeze({
  maxTradeBps: 1_200,
  maxAssetBps: 4_500,
  maxSlippageBps: 100,
});
