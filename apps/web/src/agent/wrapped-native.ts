import { TESTNET_CHAIN } from "@alpha-agents/config";

/**
 * CO-U1 (owner, 2026-10-15): the plan's wrapped-native target is stored as WMON on every chain
 * (targetWmonBps, the "WMON" asset); the page names it as this build's chain names it: WETH on
 * Base and Arbitrum, WMON on Monad. Labels only; the plan data is unchanged.
 */
export const WRAPPED_NATIVE: "WETH" | "WMON" = TESTNET_CHAIN.native === "ETH" ? "WETH" : "WMON";

/** A symbol as this chain shows it: WMON becomes the chain's wrapped native, anything else is kept. */
export const wrappedLabel = (symbol: string): string =>
  symbol === "WMON" ? WRAPPED_NATIVE : symbol;
