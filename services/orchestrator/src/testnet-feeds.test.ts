import type { ChainReader } from "@alpha-agents/chain-tools";
import { describe, expect, it } from "vitest";
import {
  type FeedChain,
  type FeedTarget,
  TestnetFeeds,
  testnetFeedsFor,
  withFreshFeeds,
} from "./testnet-feeds.ts";

const MON = "0x00000000000000000000000000000000000000a1" as const;
const USDC = "0x00000000000000000000000000000000000000b2" as const;

/** A fake chain whose clock and feed times the test sets; redates move a feed to now. */
function fakeChain(now: bigint, updatedAt: Record<string, bigint>, fail = false) {
  const sent: string[] = [];
  const chain: FeedChain = {
    ages: async (feeds: readonly FeedTarget[]) => ({
      now,
      updatedAt: feeds.map((f) => updatedAt[f.address] ?? 0n),
    }),
    redate: async (feed) => {
      await new Promise((r) => setTimeout(r, 5));
      if (fail) throw new Error("nonce too low\nmore detail");
      sent.push(feed);
      updatedAt[feed] = now;
      return `0x${"ab".repeat(32)}`;
    },
  };
  return { chain, sent };
}

const feedsWith = (chain: FeedChain, lines: string[] = []) =>
  testnetFeedsFor("testnet", { chain, monUsd: MON, usdcUsd: USDC, log: (l) => lines.push(l) });

describe("testnet feeds, re-dated on demand (D-307)", () => {
  it("re-dates only a feed too old to last through the action, on the chain's clock", async () => {
    // MON/USD 121 s old (past 120), USDC/USD 3,000 s old (under 3,300).
    const { chain, sent } = fakeChain(10_000n, { [MON]: 9_879n, [USDC]: 7_000n });
    const lines: string[] = [];
    const result = await feedsWith(chain, lines)?.ensureFresh("a submission");
    expect(sent).toEqual([MON]);
    expect(result?.redated).toEqual([
      { label: "MON/USD", hash: `0x${"ab".repeat(32)}`, ageS: 121 },
    ]);
    expect(lines[0]).toContain("MON/USD re-dated (121 s old) before a submission");
  });

  it("sends nothing when both feeds are fresh enough", async () => {
    const { chain, sent } = fakeChain(10_000n, { [MON]: 9_900n, [USDC]: 7_000n });
    expect((await feedsWith(chain)?.ensureFresh("a deposit"))?.redated).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("shares one pass between concurrent callers, so a feed is re-dated once", async () => {
    const { chain, sent } = fakeChain(10_000n, { [MON]: 1n, [USDC]: 1n });
    const feeds = feedsWith(chain) as TestnetFeeds;
    await Promise.all([feeds.ensureFresh("a"), feeds.ensureFresh("b"), feeds.ensureFresh("c")]);
    expect(sent).toEqual([MON, USDC]);
  });

  it("logs a failed re-date and returns it, leaving the oracle to name the stale price", async () => {
    const { chain } = fakeChain(10_000n, { [MON]: 1n, [USDC]: 1n }, true);
    const lines: string[] = [];
    const result = await feedsWith(chain, lines)?.ensureFresh("a deposit");
    expect(result).toEqual({ redated: [], error: "nonce too low" });
    expect(lines).toEqual(["testnet feeds: re-dating before a deposit failed: nonce too low"]);
  });

  it("exists only on testnet, with the feed key and both feeds", () => {
    const { chain } = fakeChain(0n, {});
    expect(
      testnetFeedsFor("local", { chain, monUsd: MON, usdcUsd: USDC, log: () => undefined }),
    ).toBeNull();
    expect(
      testnetFeedsFor("beta", { chain, monUsd: MON, usdcUsd: USDC, log: () => undefined }),
    ).toBeNull();
    expect(
      testnetFeedsFor("testnet", { chain: null, monUsd: MON, usdcUsd: USDC, log: () => undefined }),
    ).toBeNull();
    expect(
      testnetFeedsFor("testnet", { chain, monUsd: null, usdcUsd: USDC, log: () => undefined }),
    ).toBeNull();
  });

  it("re-dates before a market read only, never before an agent read or a quote", async () => {
    const calls: string[] = [];
    const reader = {
      chainId: 10143,
      tokenOf: () => USDC,
      market: async () => (calls.push("market"), {}),
      agent: async () => (calls.push("agent"), null),
      quote: async () => (calls.push("quote"), { block: 1n, amountOut: 1n }),
    } as unknown as ChainReader;
    const feeds = {
      ensureFresh: async (reason: string) => (
        calls.push(`fresh: ${reason}`),
        { redated: [], error: null }
      ),
    } as unknown as TestnetFeeds;
    const wrapped = withFreshFeeds(reader, feeds);
    await wrapped.agent(1);
    await wrapped.quote("USDC", 1n);
    await wrapped.market();
    expect(calls).toEqual(["agent", "quote", "fresh: a market read", "market"]);
  });
});
