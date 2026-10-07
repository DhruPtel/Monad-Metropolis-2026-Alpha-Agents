import type { EnvironmentId } from "@alpha-agents/config";
import { refreshLocalFeeds } from "@alpha-agents/devenv";

/**
 * Keeps the local fork's Chainlink feeds fresh (P2-U2 step 0, D-237): every
 * minute it re-dates their answers to the fork's latest block, so the oracle
 * adapter's 300-second staleness rule passes on the playtest fork. It exists
 * only for the local environment: for testnet and beta this returns null, and
 * devenv's refreshLocalFeeds itself refuses anything but the local anvil fork.
 */
export const LOCAL_FEED_REFRESH_MS = 60_000;

export interface LocalFeedRefresher {
  readonly everyMs: number;
  refresh(): Promise<void>;
}

export function localFeedRefresherFor(
  environment: EnvironmentId,
  rpcUrl: string,
  refresh: (url: string) => Promise<unknown> = refreshLocalFeeds,
): LocalFeedRefresher | null {
  if (environment !== "local") return null;
  return {
    everyMs: LOCAL_FEED_REFRESH_MS,
    refresh: async () => {
      await refresh(rpcUrl);
    },
  };
}
