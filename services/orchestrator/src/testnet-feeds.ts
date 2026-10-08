import { rpcTransport } from "@alpha-agents/chain-tools";
import type { EnvironmentId } from "@alpha-agents/config";
import type { ChainReader } from "@alpha-agents/chain-tools";
import { type Hex, createPublicClient, createWalletClient, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Testnet's TestnetFeeds, re-dated on demand (D-253, D-307): right before an
 * action that needs a fresh price (a proposal's or a submission's checks, a
 * deposit), never on a timer, because Monad charges every transaction its gas
 * limit. A feed is re-dated only when, on the chain's own clock, it is too old
 * to stay fresh through the action: MON/USD after 120 of its 300 seconds,
 * USDC/USD after 3,300 of its 3,900. Writes go one at a time and are confirmed
 * by receipt; a failure is logged and left for the oracle to name
 * (ORACLE_STALE), never hidden. Testnet only: the fork keeps LocalFeed's
 * refresher (D-237) and mainnet reads Chainlink.
 */
export interface FeedTarget {
  readonly label: string;
  readonly address: Hex;
  /** Re-date once the answer is older than this many seconds (chain time). */
  readonly redateAfterS: number;
}

export const TESTNET_FEED_REDATE_AFTER_S = { monUsd: 120, usdcUsd: 3_300 } as const;

const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function redate()",
]);

export interface FeedChain {
  /** The latest block's timestamp and each feed's updatedAt. */
  ages(feeds: readonly FeedTarget[]): Promise<{ now: bigint; updatedAt: bigint[] }>;
  /** Re-dates one feed and waits for its receipt; returns the transaction hash. */
  redate(feed: Hex): Promise<Hex>;
}

export interface FreshResult {
  readonly redated: { label: string; hash: Hex; ageS: number }[];
  readonly error: string | null;
}

export class TestnetFeeds {
  private readonly chain: FeedChain;
  private readonly feeds: readonly FeedTarget[];
  private readonly log: (line: string) => void;
  private inFlight: Promise<FreshResult> | null = null;

  constructor(o: { chain: FeedChain; feeds: readonly FeedTarget[]; log: (line: string) => void }) {
    this.chain = o.chain;
    this.feeds = o.feeds;
    this.log = o.log;
  }

  /** Re-dates the feeds that need it before `reason`; concurrent callers share one pass. */
  ensureFresh(reason: string): Promise<FreshResult> {
    this.inFlight ??= this.pass(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pass(reason: string): Promise<FreshResult> {
    const redated: FreshResult["redated"] = [];
    try {
      const { now, updatedAt } = await this.chain.ages(this.feeds);
      for (const [i, feed] of this.feeds.entries()) {
        const ageS = Number(now - (updatedAt[i] ?? 0n));
        if (ageS <= feed.redateAfterS) continue;
        const hash = await this.chain.redate(feed.address);
        redated.push({ label: feed.label, hash, ageS });
        this.log(`testnet feeds: ${feed.label} re-dated (${ageS} s old) before ${reason}: ${hash}`);
      }
      return { redated, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      this.log(`testnet feeds: re-dating before ${reason} failed: ${message}`);
      return { redated, error: message ?? "failed" };
    }
  }
}

/** The viem chain for the feeds, signing with the feed key (TESTNET_FEED_PRIVATE_KEY). */
export function viemFeedChain(
  rpcUrl: string,
  chainId: number,
  privateKey: Hex,
  fallbackRpcUrl?: string | null,
): FeedChain {
  const transport = rpcTransport(rpcUrl, fallbackRpcUrl);
  const client = createPublicClient({ transport });
  const account = privateKeyToAccount(privateKey);
  const chain = {
    id: chainId,
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  } as const;
  const wallet = createWalletClient({ account, chain, transport });
  return {
    async ages(feeds) {
      const [block, ...rounds] = await Promise.all([
        client.getBlock(),
        ...feeds.map((f) =>
          client.readContract({
            address: f.address,
            abi: FEED_ABI,
            functionName: "latestRoundData",
          }),
        ),
      ]);
      return { now: block.timestamp, updatedAt: rounds.map((r) => r[3]) };
    },
    async redate(feed) {
      // Monad charges the gas limit: the estimate plus a fifth, not a fixed large limit.
      const estimate = await client.estimateContractGas({
        address: feed,
        abi: FEED_ABI,
        functionName: "redate",
        account,
      });
      const hash = await wallet.writeContract({
        address: feed,
        abi: FEED_ABI,
        functionName: "redate",
        gas: (estimate * 6n) / 5n,
      });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`redate ${hash} reverted`);
      return hash;
    },
  };
}

/** The refresher for this environment: testnet with the feed key, otherwise null. */
export function testnetFeedsFor(
  environment: EnvironmentId,
  o: {
    chain: FeedChain | null;
    monUsd: Hex | null;
    usdcUsd: Hex | null;
    log: (line: string) => void;
  },
): TestnetFeeds | null {
  if (environment !== "testnet" || !o.chain || !o.monUsd || !o.usdcUsd) return null;
  return new TestnetFeeds({
    chain: o.chain,
    feeds: [
      { label: "MON/USD", address: o.monUsd, redateAfterS: TESTNET_FEED_REDATE_AFTER_S.monUsd },
      { label: "USDC/USD", address: o.usdcUsd, redateAfterS: TESTNET_FEED_REDATE_AFTER_S.usdcUsd },
    ],
    log: o.log,
  });
}

/**
 * The chain reader the chain tools and the trade flow use on testnet: every
 * market read (a proposal's checks, tradable_now, the checks at submission)
 * first makes sure the feeds are fresh. Snapshots keep the plain reader.
 */
export function withFreshFeeds(reader: ChainReader, feeds: TestnetFeeds): ChainReader {
  return {
    chainId: reader.chainId,
    tokenOf: (asset) => reader.tokenOf(asset),
    agent: (agentId) => reader.agent(agentId),
    quote: (sell, amountIn) => reader.quote(sell, amountIn),
    market: async () => {
      await feeds.ensureFresh("a market read");
      return reader.market();
    },
  };
}
