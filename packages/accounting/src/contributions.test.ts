import { describe, expect, it } from "vitest";
import { ownShare, shareOf } from "./contributions.ts";

const usdc = (whole: bigint) => whole * 1_000_000n;

describe("contribution shares (D-242)", () => {
  it("pays the sole contributor everything", () => {
    const w = {
      contributed: usdc(10n),
      consumed: 0n,
      totalContributed: usdc(10n),
      totalConsumed: 0n,
    };
    expect(ownShare(w, usdc(7n))).toEqual({ amount: usdc(7n), basis: usdc(10n) });
  });

  it("pays each contributor only its own share, rounding down", () => {
    // Owner 30, a fan 70; 50 left.
    const owner = {
      contributed: usdc(30n),
      consumed: 0n,
      totalContributed: usdc(100n),
      totalConsumed: 0n,
    };
    expect(ownShare(owner, usdc(50n)).amount).toBe(usdc(15n));
    const odd = { contributed: 1n, consumed: 0n, totalContributed: 3n, totalConsumed: 0n };
    expect(ownShare(odd, 2n).amount).toBe(0n); // 2/3 rounds down
  });

  it("leaves every other share unchanged after one contributor is refunded", () => {
    // Owner 30, fan 70, 50 left: the owner takes 15; then 35 left is all the fan's.
    const total = usdc(100n);
    const first = ownShare(
      { contributed: usdc(30n), consumed: 0n, totalContributed: total, totalConsumed: 0n },
      usdc(50n),
    );
    const fan = ownShare(
      { contributed: usdc(70n), consumed: 0n, totalContributed: total, totalConsumed: first.basis },
      usdc(50n) - first.amount,
    );
    expect(fan.amount).toBe(usdc(35n));
    // And the owner has nothing left to claim until it contributes again.
    const again = ownShare(
      {
        contributed: usdc(30n),
        consumed: first.basis,
        totalContributed: total,
        totalConsumed: first.basis,
      },
      usdc(35n),
    );
    expect(again).toEqual({ amount: 0n, basis: 0n });
  });

  it("splits each part of the pool by the same weight", () => {
    const w = {
      contributed: usdc(25n),
      consumed: 0n,
      totalContributed: usdc(100n),
      totalConsumed: 0n,
    };
    const s = ownShare(w, usdc(40n));
    expect(shareOf(usdc(30n), s, w) + shareOf(usdc(10n), s, w)).toBe(s.amount);
  });

  it("refuses impossible weights", () => {
    expect(() =>
      ownShare({ contributed: 1n, consumed: 2n, totalContributed: 5n, totalConsumed: 0n }, 1n),
    ).toThrow();
    expect(() =>
      ownShare({ contributed: 9n, consumed: 0n, totalContributed: 5n, totalConsumed: 0n }, 1n),
    ).toThrow();
  });
});
