import type { PriceE18 } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import { checkOracle } from "./checks.ts";
import { FIXTURE_NOW, fixtureState } from "./fixtures.ts";
import {
  type FeedAnswer,
  ORACLE_REASON_REJECTION,
  ORACLE_REASONS,
  poolDeviation,
  readFeed,
  readPool,
  usdcPegReason,
} from "./oracle.ts";

const NOW = 1_790_876_425n;
const MON = 3_436_820n; // $0.0343682, 8 decimals
const round = (over: Partial<FeedAnswer> = {}): FeedAnswer => ({
  decimals: 8,
  roundId: 5n,
  answer: MON,
  updatedAt: NOW - 10n,
  answeredInRound: 5n,
  ...over,
});
const mon = (over: Partial<FeedAnswer> = {}) => readFeed(round(over), "MON_USD", NOW);

describe("readFeed: the adapter's feed checks", () => {
  it("scales a fresh 8-decimal answer to a 1e18 price", () => {
    expect(mon()).toEqual({
      priceE18: 34_368_200_000_000_000n,
      updatedAt: NOW - 10n,
      reason: "OK",
    });
  });

  it("is strict at each feed's bound: MON/USD 300 s, USDC/USD 3,900 s (D-151, D-168)", () => {
    expect(mon({ updatedAt: NOW - 299n }).reason).toBe("OK");
    expect(mon({ updatedAt: NOW - 300n }).reason).toBe("STALE");
    const usdc = (age: bigint) =>
      readFeed(round({ answer: 100_000_000n, updatedAt: NOW - age }), "USDC_USD", NOW).reason;
    expect(usdc(3_899n)).toBe("OK");
    expect(usdc(3_900n)).toBe("STALE");
  });

  it("refuses every invalid answer with its own reason", () => {
    expect(readFeed(null, "MON_USD", NOW).reason).toBe("FEED_REVERTED");
    expect(mon({ decimals: 18 }).reason).toBe("DECIMALS_MISMATCH");
    expect(mon({ answer: 0n }).reason).toBe("ANSWER_NOT_POSITIVE");
    expect(mon({ answer: -5n }).reason).toBe("ANSWER_NOT_POSITIVE");
    expect(mon({ updatedAt: 0n }).reason).toBe("ROUND_INCOMPLETE");
    expect(mon({ answeredInRound: 4n }).reason).toBe("ROUND_INCOMPLETE");
    expect(mon({ updatedAt: NOW + 1n }).reason).toBe("FUTURE_TIMESTAMP");
    const max = ((1n << 128n) - 1n) / 10n ** 10n;
    expect(mon({ answer: max }).reason).toBe("OK");
    expect(mon({ answer: max + 1n }).reason).toBe("ANSWER_OUT_OF_RANGE");
  });

  it("returns no price unless the reading is OK", () => {
    for (const r of [mon({ answer: 0n }), mon({ updatedAt: NOW - 300n })])
      expect(r.priceE18).toBe(0n);
  });
});

describe("readPool and the 2% rule", () => {
  it("reads the pinned block's pool at $0.0343761", () => {
    expect(readPool(14_689_533_063_741_189_719_999n)).toEqual({
      priceE18: 34_376_116_674_083_669n,
      reason: "OK",
    });
  });

  it("refuses a pool it cannot read, a zero price or one out of range", () => {
    expect(readPool(null).reason).toBe("POOL_UNREADABLE");
    expect(readPool(0n).reason).toBe("POOL_UNREADABLE");
    expect(readPool(1n).reason).toBe("POOL_UNREADABLE");
    expect(readPool(1n << 160n).reason).toBe("POOL_UNREADABLE");
  });

  it("passes exactly 2% each way and refuses one wei more", () => {
    const oracle = mon();
    const o = oracle.priceE18 as bigint;
    const pool = (p: bigint) => ({ priceE18: p as never, reason: "OK" as const });
    expect(poolDeviation(oracle, pool(o + o / 50n))).toEqual({ bps: 200n, reason: "OK" });
    expect(poolDeviation(oracle, pool(o - o / 50n)).reason).toBe("OK");
    expect(poolDeviation(oracle, pool(o + o / 50n + 1n))).toEqual({
      bps: 200n,
      reason: "POOL_DEVIATION",
    });
    expect(poolDeviation(oracle, pool(o - o / 50n - 1n)).reason).toBe("POOL_DEVIATION");
  });

  it("reports an unusable oracle before the pool", () => {
    expect(poolDeviation(mon({ updatedAt: NOW - 300n }), readPool(null)).reason).toBe("STALE");
    expect(poolDeviation(mon(), readPool(null)).reason).toBe("POOL_UNREADABLE");
  });
});

describe("the USDC depeg guard", () => {
  const peg = (answer: bigint, age = 60n) =>
    usdcPegReason(readFeed(round({ answer, updatedAt: NOW - age }), "USDC_USD", NOW));

  it("allows exactly 1% either side and refuses beyond (A-34)", () => {
    expect(peg(99_000_000n)).toBe("OK");
    expect(peg(101_000_000n)).toBe("OK");
    expect(peg(98_999_999n)).toBe("USDC_DEPEGGED");
    expect(peg(101_000_001n)).toBe("USDC_DEPEGGED");
  });

  it("refuses a stale or invalid USDC/USD before judging the peg", () => {
    expect(peg(90_000_000n, 3_900n)).toBe("STALE");
    expect(peg(0n)).toBe("ANSWER_NOT_POSITIVE");
  });
});

describe("reason codes for an intent", () => {
  it("maps every unusable price to ORACLE_STALE and the pool to ORACLE_POOL_DEVIATION", () => {
    for (const r of ORACLE_REASONS) {
      const code = ORACLE_REASON_REJECTION[r];
      if (r === "OK" || r === "USDC_DEPEGGED") expect(code).toBeNull();
      else if (r.startsWith("POOL_")) expect(code).toBe("ORACLE_POOL_DEVIATION");
      else expect(code).toBe("ORACLE_STALE");
    }
  });
});

describe("checkOracle agrees with the adapter on an absurd price", () => {
  it("refuses a price above 2^128 - 1 as the adapter does", () => {
    const at = (priceE18: bigint) =>
      checkOracle(
        fixtureState({
          oracle: {
            WMON: {
              priceE18: priceE18 as PriceE18,
              updatedAt: FIXTURE_NOW - 60,
              poolPriceE18: priceE18 as PriceE18,
            },
          },
        }),
        "WMON",
        FIXTURE_NOW,
      ).map((r) => r.code);
    expect(at((1n << 128n) - 1n)).toEqual([]);
    expect(at(1n << 128n)).toEqual(["ORACLE_STALE"]);
  });
});
