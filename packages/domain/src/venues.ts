/**
 * The launch venue (D-166): the hookless Uniswap v4 MON/USDC 0.05% pool.
 * currency0 is native MON (address zero sorts first in v4), currency1 USDC.
 * The oracle adapter reads its spot price through StateView for the 2% rule
 * (P2-U3); the Executor's adapter trades it (P2-U2).
 */
export const UNISWAP_V4_MON_USDC_POOL = Object.freeze({
  id: "0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954" as `0x${string}`,
  fee: 500,
  tickSpacing: 10,
  hooks: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  source: "Planv2/DECISIONS_AND_OPEN_QUESTIONS.md D-166; evidence/p2-u0/SUMMARY.md",
});
