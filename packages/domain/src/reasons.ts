/**
 * Rejection reason codes: the enum the chain tools server, the Executor's
 * `IntentRejected` event and the policy pre-checks share (FINAL_PLAN 4.4.2).
 * They feed "why the agent did not trade", so each has an owner-facing message.
 *
 * Two additions to the plan's list: `DEADLINE_TOO_FAR`, because the Executor
 * requires `deadline <= block.timestamp + 120` and the plan names only the
 * expired side; and `VAULT_IN_HANDOVER` (D-152), for agent swaps on a vault
 * whose new owner has not yet accepted management.
 *
 * The last four are the Executor's own refusals (P2-U2, D-238): a session key
 * the agent's owner did not register, an expired grant, a replayed actionId,
 * and an intent for another chain, schema, account or policy. The order is
 * the Solidity enum `Reason` in chains/monad/src/interfaces/IExecutor.sol,
 * which a test holds to this list: an enum crosses the ABI as its index.
 */
export const REJECTION_CODES = [
  "ASSET_NOT_ALLOWED",
  "VENUE_NOT_ALLOWED",
  "TRADE_SIZE_EXCEEDED",
  "CONCENTRATION_CAP",
  "USDC_FLOOR",
  "SLIPPAGE_TOO_HIGH",
  "DAILY_TRADE_LIMIT",
  "TURNOVER_CAP",
  "ORACLE_STALE",
  "ORACLE_POOL_DEVIATION",
  "INSUFFICIENT_BALANCE",
  "REDUCE_ONLY_MODE",
  "PAUSED",
  "EPOCH_MISMATCH",
  "VAULT_IN_HANDOVER",
  "SIMULATION_FAILED",
  "DEADLINE_EXPIRED",
  "DEADLINE_TOO_FAR",
  "EXECUTOR_REVERTED",
  "SESSION_UNKNOWN",
  "SESSION_EXPIRED",
  "ACTION_REPLAYED",
  "INTENT_INVALID",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** Owner-facing text for each code, phrased as the reason the agent did not trade. */
export const REJECTION_MESSAGES: Readonly<Record<RejectionCode, string>> = {
  ASSET_NOT_ALLOWED: "The trade involves an asset that is not on the allowed list.",
  VENUE_NOT_ALLOWED: "The trading venue is not registered or is paused.",
  TRADE_SIZE_EXCEEDED: "The trade is larger than 10% of the account's value.",
  CONCENTRATION_CAP:
    "After the trade, more than 40% of the account would be in one non-USDC asset.",
  USDC_FLOOR: "After the trade, less than 10% of the account would be in USDC.",
  SLIPPAGE_TOO_HIGH:
    "The allowed slippage is above 0.5%, or the quote is worse than the oracle price allows.",
  DAILY_TRADE_LIMIT: "The account already made 20 trades in the last 24 hours.",
  TURNOVER_CAP: "The trade would take 24-hour turnover above 100% of the account's value.",
  ORACLE_STALE: "The price feed is 5 minutes old or older, so prices cannot be trusted.",
  ORACLE_POOL_DEVIATION: "The pool price is more than 2% away from the oracle price.",
  INSUFFICIENT_BALANCE: "The account does not hold enough of the asset being sold.",
  REDUCE_ONLY_MODE: "The account is in reduce-only mode, so only sales into USDC are allowed.",
  PAUSED: "The account is paused, so no new trades are allowed.",
  EPOCH_MISMATCH: "The agent changed owner or configuration since this trade was proposed.",
  VAULT_IN_HANDOVER:
    "The vault is changing hands, so the agent cannot trade it until the new owner accepts management.",
  SIMULATION_FAILED: "A dry run of the trade failed before it was sent.",
  DEADLINE_EXPIRED: "The trade's deadline passed before it could be executed.",
  DEADLINE_TOO_FAR: "The trade's deadline is more than 2 minutes away.",
  EXECUTOR_REVERTED: "The onchain Executor rejected the trade.",
  SESSION_UNKNOWN: "The trade was not sent by the session key the owner registered for this agent.",
  SESSION_EXPIRED: "The owner's permission for this agent to trade has expired.",
  ACTION_REPLAYED: "This exact trade was already sent once, so it was not sent again.",
  INTENT_INVALID: "The trade was prepared for another chain, account or set of limits.",
};
