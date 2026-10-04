import { describe, expect, it } from "vitest";
import {
  feedStats,
  percentile,
  priceFromSqrtX96,
  sampleDeviation,
  shortfallBps,
  summarizeDeviation,
} from "./stats.ts";

describe("percentile", () => {
  it("uses nearest rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0)).toBe(1);
    expect(percentile([5, 1, 3, 2, 4], 100)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe("feedStats", () => {
  // Window 0..10_000 s, heartbeat 3600: updates at 0, 100 (+1%), 3700 (heartbeat, flat), 9000.
  const updates = [
    { t: 0, price: 100 },
    { t: 100, price: 101 },
    { t: 3700, price: 101 },
    { t: 9000, price: 101 },
  ];
  const s = feedStats(updates, 0, 10_000, 3600, [300, 3600]);

  it("measures gaps and changes", () => {
    expect(s.updates).toBe(4);
    expect(s.gapSeconds.min).toBe(100);
    expect(s.gapSeconds.max).toBe(5300);
    expect(s.heartbeatUpdates).toBe(2);
    expect(s.minDeviationTriggeredChangeBps).toBeCloseTo(100, 6);
    expect(s.gapsLongerThanHeartbeat).toBe(1);
  });

  it("counts the time an answer is at least T old, including the tail to the window end", () => {
    // Intervals: 0, 100, 3600, 5300, 1000. Over 300 s: 3300 + 5000 + 700 = 9000 of 10_000.
    expect(s.stale[0]).toEqual({ thresholdSeconds: 300, shareOfTime: 0.9, episodes: 3 });
    // Over 3600 s: only the 5300 s gap, by 1700 s.
    expect(s.stale[1]).toEqual({ thresholdSeconds: 3600, shareOfTime: 0.17, episodes: 1 });
  });
});

describe("sampleDeviation", () => {
  it("holds the last value of each series and skips times before either starts", () => {
    const oracle = [
      { t: 0, price: 100 },
      { t: 50, price: 110 },
    ];
    const pool = [
      { t: 20, price: 102 },
      { t: 60, price: 99 },
    ];
    const samples = sampleDeviation(oracle, pool, 0, 70, 10);
    expect(samples.map((s) => s.t)).toEqual([20, 30, 40, 50, 60, 70]);
    expect(samples[0]?.bps).toBeCloseTo(200, 6);
    expect(samples[3]?.bps).toBeCloseTo(((102 - 110) / 110) * 10_000, 6);
    expect(samples[4]?.bps).toBeCloseTo(-1000, 6);
    expect(samples[5]?.poolAge).toBe(10);
  });

  it("summarizes shares above thresholds and the longest run above 2%", () => {
    const samples = [10, 250, 300, -260, 40, 600].map((bps, i) => ({ t: i * 60, bps, poolAge: 0 }));
    const sum = summarizeDeviation(samples, 60);
    expect(sum.shareAbove["200bps"]).toBeCloseTo(4 / 6, 6);
    expect(sum.shareAbove["500bps"]).toBeCloseTo(1 / 6, 6);
    expect(sum.longestRunAbove200Seconds).toBe(180);
    expect(sum.signedBps.min).toBe(-260);
  });
});

describe("prices", () => {
  it("converts sqrtPriceX96 with decimals", () => {
    // token0 18 decimals, token1 6 decimals, 1 token0 = 0.04 token1.
    const raw = 0.04 * 10 ** (6 - 18);
    const sqrt = BigInt(Math.round(Math.sqrt(raw) * 2 ** 96));
    expect(priceFromSqrtX96(sqrt, 18, 6)).toBeCloseTo(0.04, 9);
  });

  it("reports shortfall as positive when the output is below expectation", () => {
    expect(shortfallBps(99.5, 100)).toBeCloseTo(50, 9);
    expect(shortfallBps(100.2, 100)).toBeCloseTo(-20, 9);
  });
});
