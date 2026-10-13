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

/**
 * M-FAST: Base's hookless Uniswap v4 ETH/USDC 0.05% pool, the research
 * reads' native/USDC reference on Base (ETH is currency0 as the zero
 * address, native USDC currency1); read on Base mainnet at block 52,534,000.
 */
export const UNISWAP_V4_BASE_ETH_USDC_POOL = Object.freeze({
  id: "0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a" as `0x${string}`,
  fee: 500,
  tickSpacing: 10,
  hooks: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  source: "Planv2/FINAL_PLAN.md > 0.8.1; evidence/m-fast/HANDOFF.md",
});
