import {
  type TestFork,
  moveLocalFeed,
  refreshLocalFeeds,
  startTestFork,
  testForkUpstream,
} from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localFeedRefresherFor } from "./local-feeds.ts";
import { type Observation, baselineFrom, detectTriggers } from "./research-loop.ts";

/**
 * The market mover and the watcher's price trigger on a fork of their own
 * (P3-U10, port 8561): the mover changes MON/USD on the LocalFeed by a
 * share and re-dates the round; read back through the same feed, the move
 * fires PRICE_MOVE for the levels whose trigger it passes and not for the
 * others, once, as the watcher would see it. Skips without MONAD_RPC_URL.
 */
const PORT = 8561;
const upstream = testForkUpstream();
const feed = () => {
  const e = addressEntry("local", "chainlink_mon_usd").address;
  if (!e) throw new Error("no MON/USD feed in the local address book");
  return e;
};

const readAnswer = async (url: string) => {
  const [round] = await refreshLocalFeeds(url, [feed()]);
  if (!round) throw new Error("the feed was not read");
  return round;
};

describe.skipIf(upstream === null)("the market mover and the price trigger on a fork", () => {
  let fork: TestFork;
  beforeAll(async () => {
    fork = await startTestFork({ port: PORT });
  }, 120_000);
  afterAll(async () => {
    await fork?.stop();
  });

  it("moves MON/USD by a share on the fork, re-dated, and the watcher fires the trigger for the levels it passes", async () => {
    const before = await readAnswer(fork.url);
    expect(before.answer > 0n).toBe(true);
    const moved = await moveLocalFeed(fork.url, feed(), -800);
    expect(moved.before).toBe(before.answer);
    expect(moved.round.answer).toBe((before.answer * 9_200n) / 10_000n);
    const after = await readAnswer(fork.url);
    expect(after.answer).toBe(moved.round.answer);
    expect(after.updatedAt >= moved.round.updatedAt).toBe(true);

    // As the watcher sees it: the baseline at the old price, the observation at the new one.
    const scale = 10n ** BigInt(18 - before.decimals);
    const seen = (answer: bigint): Observation => ({
      at: new Date(),
      monUsdE18: answer * scale,
      volatility24hPct: null,
      mode: "NORMAL",
      navUsdcE6: null,
      goalEpoch: "1",
      blockedIn24h: {},
      settledSinceBaseline: 0,
      held: [],
      rechecks: [],
    });
    const b = baselineFrom(seen(before.answer), null);
    const o = seen(after.answer);
    const codes = (level: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE") =>
      detectTriggers({ o, b, aggressiveness: level, brakeBps: null }).map((t) => t.code);
    expect(codes("CONSERVATIVE")).toEqual(["PRICE_MOVE"]);
    expect(codes("BALANCED")).toEqual(["PRICE_MOVE"]);
    expect(codes("AGGRESSIVE")).toEqual([]);

    // The orchestrator's refresher offers the same move.
    const refresher = localFeedRefresherFor("local", fork.url);
    expect(refresher).not.toBeNull();
    const r = await refresher?.moveMon(500);
    expect(r).toMatchObject({ before: after.answer.toString(), decimals: before.decimals });
    expect(BigInt(r?.after ?? "0")).toBe((after.answer * 10_500n) / 10_000n);
  }, 120_000);
});
