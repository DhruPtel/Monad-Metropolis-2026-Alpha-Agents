import { formatAmount } from "@alpha-agents/domain";
import type { SetupStepView } from "@alpha-agents/ui";
import type { ReactNode } from "react";

/**
 * The portfolio's guided setup (UI-U1): opening the account, depositing,
 * setting a goal and turning on automatic trading as one flow with clear
 * steps. Pure: the page passes what it knows and the action for each step,
 * and the first step not yet done carries its action.
 */
export interface SetupFacts {
  readonly allowlisted: boolean;
  readonly hasAccount: boolean;
  /** The account's value; null while unknown or without an account. */
  readonly valueUsdcE6: bigint | null;
  /** Null from an API without goals, which counts as nothing to do. */
  readonly goalConfigured: boolean | null;
  readonly armingState: "unarmed" | "awaiting_first_trade" | "armed";
  readonly custody: "v2" | "v3";
}

export type SetupStepKey = "open" | "deposit" | "goal" | "turnOn";

/** The least trading balance the activation sweep accepts (the TRADING_BALANCE check). */
export const MIN_TRADING_USDC_E6 = 5_000_000n;

const usdc = (e6: bigint) => formatAmount(e6, 6, { maxFractionDigits: 2, minFractionDigits: 2 });

export function setupSteps(
  f: SetupFacts,
  actions: Readonly<Partial<Record<SetupStepKey, ReactNode>>>,
): SetupStepView[] {
  const value = f.valueUsdcE6 ?? 0n;
  const done: Record<SetupStepKey, boolean> = {
    open: f.hasAccount,
    deposit: f.hasAccount && value >= MIN_TRADING_USDC_E6,
    goal: f.goalConfigured !== false,
    turnOn: f.armingState !== "unarmed",
  };
  const order: readonly SetupStepKey[] = ["open", "deposit", "goal", "turnOn"];
  const nextKey = order.find((k) => !done[k]) ?? null;
  const stateOf = (k: SetupStepKey): SetupStepView["state"] =>
    done[k]
      ? "done"
      : k !== nextKey
        ? "later"
        : k === "open" && !f.allowlisted
          ? "blocked"
          : "next";
  // The next step carries its action; a blocked first step carries it too, disabled by the page,
  // so the owner sees what comes after the platform adds the wallet.
  const actionOf = (k: SetupStepKey): ReactNode =>
    stateOf(k) === "next" || stateOf(k) === "blocked" ? (actions[k] ?? undefined) : undefined;
  return [
    {
      key: "open",
      title: "Open a trading account",
      state: stateOf("open"),
      detail: done.open
        ? "Open. Only you can withdraw from it; the agent trades it within its hard limits."
        : !f.allowlisted
          ? "This wallet is not yet allowed to deposit during the beta. Ask the platform to add it, then open the account here."
          : f.custody === "v3"
            ? "Your wallet creates an account on the fund agent's set. Only you can withdraw from it, at any time."
            : "Your wallet creates the account. Only you can withdraw from it, at any time.",
      action: actionOf("open"),
    },
    {
      key: "deposit",
      title: "Deposit",
      state: stateOf("deposit"),
      detail: done.deposit
        ? `${usdc(value)} USDC in the account.`
        : f.hasAccount && value > 0n
          ? `${usdc(value)} USDC in the account; at least ${usdc(MIN_TRADING_USDC_E6)} USDC gives the agent something to trade.`
          : `At least ${usdc(MIN_TRADING_USDC_E6)} USDC in the account gives the agent something to trade. Your wallet approves exactly the amount, then deposits it.`,
      action: actionOf("deposit"),
    },
    {
      key: "goal",
      title: "Set a goal",
      state: stateOf("goal"),
      detail: done.goal
        ? "Set. It fixes how boldly the agent trades and its hard limits."
        : "The goal fixes how boldly the agent trades, its research budget and its hard limits.",
      action: actionOf("goal"),
    },
    {
      key: "turnOn",
      title: "Turn on automatic trading",
      state: stateOf("turnOn"),
      detail:
        f.armingState === "armed"
          ? "On. The agent trades on its own within its limits."
          : f.armingState === "awaiting_first_trade"
            ? "Your permission is on chain; approving the agent's first plan turns it on."
            : "Your wallet registers the trading permission, the agent runs one activation sweep and builds a plan; approving that plan turns trading on.",
      action: actionOf("turnOn"),
    },
  ];
}
