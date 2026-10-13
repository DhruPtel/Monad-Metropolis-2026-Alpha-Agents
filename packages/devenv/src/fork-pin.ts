import { readFileSync } from "node:fs";
import { MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import { localPaths } from "./paths.ts";

/**
 * Monad mainnet passed this height before P0-U2 (October 2026). A pin below it
 * is a placeholder or a typo. Same floor as ForkConfigTest in chains/monad.
 */
export const MIN_PLAUSIBLE_BLOCK = 100_000_000;

export interface ForkPin {
  /**
   * The chain the fork copies: Monad mainnet, 143. Not the fork's own chain ID,
   * which is LOCAL_FORK_CHAIN_ID (143143, D-195).
   */
  readonly chainId: number;
  readonly blockNumber: number;
}

/** Parses and validates the committed fork pin, chains/monad/fork.json. */
export function parseForkConfig(
  text: string,
  expectedChainId = MONAD_MAINNET_CHAIN_ID,
  minPlausibleBlock = MIN_PLAUSIBLE_BLOCK,
): ForkPin {
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null) throw new Error("fork.json must be a JSON object");
  const { chainId, blockNumber } = data as Record<string, unknown>;
  if (chainId !== expectedChainId) throw new Error(`fork.json chainId must be ${expectedChainId}`);
  if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber)) {
    throw new Error("fork.json blockNumber must be an integer");
  }
  if (blockNumber < minPlausibleBlock) {
    throw new Error(
      `fork.json blockNumber is below ${minPlausibleBlock}; it looks like a placeholder`,
    );
  }
  return { chainId, blockNumber };
}

export function readForkConfig(path: string = localPaths().forkConfig): ForkPin {
  return parseForkConfig(readFileSync(path, "utf8"));
}
