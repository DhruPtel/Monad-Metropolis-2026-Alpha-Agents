import type { Hex } from "viem";

/**
 * Which of its accounts an agent manages when it has a vault (Step 0 of the
 * 2026-10-12 session, A-90). An agent may have a personal account (its
 * owner's own money) and a vault (depositors' money); the owner chooses which
 * one the agent trades when turning automatic trading on, and the choice is
 * kept by the platform. Without a choice the vault is managed once it exists
 * (A-87), as before.
 */
export const MANAGED_ACCOUNTS = ["personal", "vault"] as const;
export type ManagedAccount = (typeof MANAGED_ACCOUNTS)[number];

export const isManagedAccount = (v: unknown): v is ManagedAccount =>
  typeof v === "string" && (MANAGED_ACCOUNTS as readonly string[]).includes(v);

export interface ManagedAccountResolution {
  /** The account the agent trades, or null before either exists. */
  readonly account: Hex | null;
  /** Whether that account is the agent's vault. */
  readonly isVault: boolean;
  /** Which kind is in force, the choice or the default. */
  readonly managed: ManagedAccount;
}

/**
 * The account the agent trades: its vault when it has one and the owner has
 * not chosen the personal account, else the personal account (null before it
 * is opened). A choice of "vault" without a vault falls back to the personal
 * account, since a vault, once created, never goes away.
 */
export function managedAccountOf(a: {
  readonly vault: Hex | null;
  readonly personal: Hex | null;
  readonly choice: ManagedAccount | null;
}): ManagedAccountResolution {
  if (a.vault && a.choice !== "personal")
    return { account: a.vault, isVault: true, managed: "vault" };
  return { account: a.personal, isVault: false, managed: "personal" };
}

/** The owner's words for each choice, as the arming card and the choice dialog show them. */
export const MANAGED_ACCOUNT_WORDS: Readonly<
  Record<ManagedAccount, { readonly title: string; readonly detail: string }>
> = {
  vault: {
    title: "Its vault",
    detail:
      "Depositors' money, yours among it. The trading permission has no fixed expiry: it ends on a sale, a configuration change or when you revoke it.",
  },
  personal: {
    title: "Your personal account",
    detail: "Your own money only. The trading permission lasts at most 30 days, then you renew it.",
  },
};
