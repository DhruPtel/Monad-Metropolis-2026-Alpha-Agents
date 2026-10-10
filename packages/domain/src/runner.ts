/**
 * The template runner's own reasons for holding (P3-U3, D-290), beside the
 * Executor's (REJECTION_CODES) and the trade flow's (TRADE_FLOW_CODES), which
 * the runner also records when they are what stops a leg. Each has an
 * owner-facing message and how it clears; they feed why-not-traded.
 */
export const RUNNER_HOLD_CODES = [
  "IN_BAND",
  "BELOW_MIN_TRADE",
  "VOLATILITY_BRAKE",
  "VOLATILITY_UNAVAILABLE",
  "COST_HURDLE",
  "LEG_PENDING",
  "OWNER_TRADE_LIMIT",
  "NO_PLAN",
  "PLAN_NOT_APPROVED",
  "STRATEGY_EPOCH_STALE",
  // F-U6: the target portfolio's own reasons (D-344).
  "SCREEN_STALE",
  "ATTESTATION_UNAVAILABLE",
  "CAP_REACHED",
  "CASH_FLOOR",
] as const;
export type RunnerHoldCode = (typeof RUNNER_HOLD_CODES)[number];

/** How a hold clears, in the same terms as a blocked trade's (by the market means by waiting). */
export type RunnerHoldClears = "by_waiting" | "by_the_owner" | "by_the_platform";

export const RUNNER_HOLD_FACTS: Readonly<
  Record<
    RunnerHoldCode,
    { readonly message: string; readonly clears: RunnerHoldClears; readonly hint: string }
  >
> = Object.freeze({
  IN_BAND: {
    message:
      "The account's WMON share is inside its band around the target, so no trade is needed.",
    clears: "by_waiting",
    hint: "Nothing to do: the runner trades again when the share drifts outside the band.",
  },
  BELOW_MIN_TRADE: {
    message:
      "The account is outside its band, but the trade back would be smaller than the plan's minimum trade.",
    clears: "by_waiting",
    hint: "Clears as prices move the account further from its target, or with a smaller minimum trade in the plan.",
  },
  VOLATILITY_BRAKE: {
    message:
      "MON's 24-hour volatility is above the plan's brake, so buys wait; sales still go through.",
    clears: "by_waiting",
    hint: "Clears when MON's 24-hour volatility falls back under the brake.",
  },
  VOLATILITY_UNAVAILABLE: {
    message:
      "MON's volatility could not be read, so buys wait until it can; sales still go through.",
    clears: "by_waiting",
    hint: "Clears when the volatility source answers again.",
  },
  COST_HURDLE: {
    message:
      "The trade would cost more against the oracle (fee and price impact) than the plan allows.",
    clears: "by_waiting",
    hint: "Clears when the venue's price comes back near the oracle or liquidity deepens.",
  },
  LEG_PENDING: {
    message:
      "The previous trade of this rebalance is still on its way; the next one waits for it to settle.",
    clears: "by_waiting",
    hint: "Clears when the previous trade settles.",
  },
  OWNER_TRADE_LIMIT: {
    message:
      "The owner's limit on trades per day is reached; trading resumes as the oldest trade leaves the 24-hour window.",
    clears: "by_waiting",
    hint: "Clears as the oldest trade leaves the 24-hour window.",
  },
  NO_PLAN: {
    message: "The agent has no plan yet, so the runner makes no trades.",
    clears: "by_the_owner",
    hint: "The owner, or the console, sets a plan.",
  },
  PLAN_NOT_APPROVED: {
    message: "The plan waits for the owner's approval before the runner trades on it.",
    clears: "by_the_owner",
    hint: "The owner approves the plan.",
  },
  STRATEGY_EPOCH_STALE: {
    message:
      "The owner changed the goal after this plan was set, so the plan no longer trades until a new one is set.",
    clears: "by_the_owner",
    hint: "The owner, or the console, sets a plan under the current goal.",
  },
  SCREEN_STALE: {
    message:
      "The token the plan would buy has no passing safety screen from the last six hours, so the buy waits for a fresh one.",
    clears: "by_the_platform",
    hint: "Clears when the platform's next screen of the token passes.",
  },
  ATTESTATION_UNAVAILABLE: {
    message:
      "The token the plan would buy is priced by a platform attestation, and no attestor is live yet, so the buy waits.",
    clears: "by_the_platform",
    hint: "Clears when the price attestor is live for the token.",
  },
  CAP_REACHED: {
    message:
      "The position the plan would add to is at its cap, or the registry no longer lets this account buy the token, so the buy waits.",
    clears: "by_waiting",
    hint: "Clears as the position's share falls below its cap, or when the plan lowers its target.",
  },
  CASH_FLOOR: {
    message:
      "Buying more would take the account's USDC below its floor, so buys wait until a sale or a deposit frees cash.",
    clears: "by_waiting",
    hint: "Clears when a sale or a deposit brings USDC above the floor.",
  },
});
