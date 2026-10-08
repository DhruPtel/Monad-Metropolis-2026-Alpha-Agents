import { describe, expect, it } from "vitest";
import { PRICE_FEEDS, readableDuration, staleFeedMessage } from "./feeds.ts";

const NOW = 1_800_000_000;

describe("readableDuration", () => {
  it.each([
    [0, "0 seconds"],
    [1, "1 second"],
    [59, "59 seconds"],
    [60, "1 minute"],
    [3_599, "59 minutes"],
    [3_600, "1 hour"],
    [7_500, "2 hours 5 minutes"],
  ])("%is reads as %s", (s, text) => expect(readableDuration(s)).toBe(text));
});

describe("staleFeedMessage (L-145)", () => {
  it("names USDC/USD, its age, its bound and when its update was due, for a deposit", () => {
    const m = staleFeedMessage({
      feed: "USDC_USD",
      updatedAt: NOW - 7_500,
      now: NOW,
      refused: "deposit",
    });
    expect(m).toBe(
      "Deposits are refused because the USDC/USD price feed (the USDC depeg guard) is stale: it last updated 2 hours 5 minutes ago, and answers 2 hours old or older are not used. It normally updates about every 1 hour; its next update was due 1 hour 5 minutes ago, so expect one shortly. Withdrawals need no price and still work.",
    );
  });

  it("names MON/USD for a trade", () => {
    const m = staleFeedMessage({
      feed: "MON_USD",
      updatedAt: NOW - 330,
      now: NOW,
      refused: "trade",
    });
    expect(m).toContain("Trades are refused because the MON/USD price feed (the price of WMON)");
    expect(m).toContain("last updated 5 minutes ago");
    expect(m).toContain("about every 30 seconds; its next update was due 5 minutes ago");
    expect(m).toContain("Nothing was sent.");
  });

  it("says when the update is expected if it is not yet due", () => {
    // A bound shorter than the heartbeat cannot happen at launch; the wording still holds.
    const m = staleFeedMessage({
      feed: "USDC_USD",
      updatedAt: NOW - 600,
      now: NOW,
      refused: "deposit",
    });
    expect(m).toContain("its next update is expected in about 50 minutes");
  });

  it("says a feed that never answered has no answer yet", () => {
    const m = staleFeedMessage({ feed: "MON_USD", updatedAt: 0, now: NOW, refused: "trade" });
    expect(m).toContain("MON/USD price feed (the price of WMON) has no answer yet");
  });

  it("keeps every bound longer than the feed's heartbeat, so a stale feed is always overdue", () => {
    for (const f of Object.values(PRICE_FEEDS))
      expect(f.maxAgeSeconds).toBeGreaterThan(f.heartbeatSeconds);
  });
});
