import { formatAmount } from "@alpha-agents/domain";

/** A USDC amount (6 decimals) with exactly two decimals, as the owner pages show it. */
export const usdcCents = (e6: bigint | string) =>
  formatAmount(BigInt(e6), 6, { minFractionDigits: 2, maxFractionDigits: 2 });

/** Basis points as a percent with two decimals, with a + on gains when `signed`. */
export const percentFromBps = (bps: number, signed = false) =>
  `${signed && bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
