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
] as const;
export type RunnerHoldCode = (typeof RUNNER_HOLD_CODES)[number];

export type RunnerHoldClears = "by_waiting" | "by_the_market" | "by_the_owner" | "by_the_platform";

export const RUNNER_HOLD_FACTS: Readonly<
  Record<RunnerHoldCode, { readonly message: string; readonly clears: RunnerHoldClears }>
> = Object.freeze({
  IN_BAND: {
    message:
      "The account's WMON share is inside its band around the target, so no trade is needed.",
    clears: "by_the_market",
  },
  BELOW_MIN_TRADE: {
    message:
      "The account is outside its band, but the trade back would be smaller than the plan's minimum trade.",
    clears: "by_the_market",
  },
  VOLATILITY_BRAKE: {
    message:
      "MON's 24-hour volatility is above the plan's brake, so buys wait; sales still go through.",
    clears: "by_the_market",
  },
  VOLATILITY_UNAVAILABLE: {
    message:
      "MON's volatility could not be read, so buys wait until it can; sales still go through.",
    clears: "by_waiting",
  },
  COST_HURDLE: {
    message:
      "The trade would cost more against the oracle (fee and price impact) than the plan allows.",
    clears: "by_the_market",
  },
  LEG_PENDING: {
    message:
      "The previous trade of this rebalance is still on its way; the next one waits for it to settle.",
    clears: "by_waiting",
  },
  OWNER_TRADE_LIMIT: {
    message:
      "The owner's limit on trades per day is reached; trading resumes as the oldest trade leaves the 24-hour window.",
    clears: "by_waiting",
  },
  NO_PLAN: {
    message: "The agent has no plan yet, so the runner makes no trades.",
    clears: "by_the_owner",
  },
  PLAN_NOT_APPROVED: {
    message: "The plan waits for the owner's approval before the runner trades on it.",
    clears: "by_the_owner",
  },
  STRATEGY_EPOCH_STALE: {
    message:
      "The owner changed the goal after this plan was set, so the plan no longer trades until a new one is set.",
    clears: "by_the_owner",
  },
});
