import type { EnvironmentId } from "@alpha-agents/config";
import { addressEntry } from "@alpha-agents/domain";
import { moveLocalFeed, refreshLocalFeeds } from "@alpha-agents/devenv";

/**
 * Keeps the local fork's Chainlink feeds fresh (P2-U2 step 0, D-237): every
 * minute it re-dates their answers to the fork's latest block, so the oracle
 * adapters' staleness rules pass on the playtest fork. Since F-U3 step 0 that
 * is every class F feed leg (devenv's localFeedAddresses), so OracleAdapterV3
 * prices every core token there, not only WMON. It exists only for the local
 * environment: for testnet and beta this returns null, and devenv's
 * refreshLocalFeeds itself refuses anything but the local anvil fork.
 */
export const LOCAL_FEED_REFRESH_MS = 60_000;

export interface LocalFeedRefresher {
  readonly everyMs: number;
  refresh(): Promise<void>;
  /**
   * P3-U10's market mover (the local fork only): moves MON/USD by a share in
   * basis points and re-dates the round, so the watcher sees the move on its
   * next look. Returns the answer before and after, in the feed's decimals.
   */
  moveMon(bps: number): Promise<{ before: string; after: string; decimals: number }>;
}

export function localFeedRefresherFor(
  environment: EnvironmentId,
  rpcUrl: string,
  refresh: (url: string) => Promise<unknown> = refreshLocalFeeds,
  move: typeof moveLocalFeed = moveLocalFeed,
): LocalFeedRefresher | null {
  if (environment !== "local") return null;
  return {
    everyMs: LOCAL_FEED_REFRESH_MS,
    refresh: async () => {
      await refresh(rpcUrl);
    },
    moveMon: async (bps) => {
      const feed = addressEntry("local", "chainlink_mon_usd").address;
      if (!feed) throw new Error("the address book has no MON/USD feed for the local fork");
      const r = await move(rpcUrl, feed, bps);
      return {
        before: r.before.toString(),
        after: r.round.answer.toString(),
        decimals: r.round.decimals,
      };
    },
  };
}
