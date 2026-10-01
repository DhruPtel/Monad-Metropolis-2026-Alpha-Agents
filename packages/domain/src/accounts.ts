import { z } from "zod";

/**
 * The accounts an agent has (FINAL_PLAN 4.1.6, 4.1.10). The two capital accounts
 * are never mixed, and the funding address holds credits, never trading capital.
 * The token-bound account holds skills only and is not an account kind here.
 */
export const ACCOUNT_KINDS = ["personal_account", "strategy_vault", "funding_address"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const AccountKindSchema = z.enum(ACCOUNT_KINDS);

/** The capital accounts the Executor can trade from. */
export const CAPITAL_ACCOUNT_KINDS = ["personal_account", "strategy_vault"] as const;
export type CapitalAccountKind = (typeof CAPITAL_ACCOUNT_KINDS)[number];

/**
 * How a tool call selects one of the calling agent's capital accounts. Identity
 * comes from the connection, so a tool never takes an account address.
 */
export const ACCOUNT_REFS = ["personal", "vault"] as const;
export type AccountRef = (typeof ACCOUNT_REFS)[number];
export const AccountRefSchema = z.enum(ACCOUNT_REFS);

export const ACCOUNT_REF_KIND: Readonly<Record<AccountRef, CapitalAccountKind>> = {
  personal: "personal_account",
  vault: "strategy_vault",
};
