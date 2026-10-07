import { describe, expect, it } from "vitest";
import * as breaker from "./breaker.ts";

const T0 = 1_790_876_425n;
const DAY = 86_400n;
const ONE = 10n ** 18n; // $1.00 per WMON, and one USDC per unit
const usdc = (whole: bigint) => whole * 1_000_000n;
const wmon = (whole: bigint) => whole * 10n ** 18n;
const price = (cents: bigint) => (cents * ONE) / 100n;

/** 50 WMON at $1: 50 units worth 1 USDC each, poked once. */
function wmonAccount() {
  const s = breaker.deposit(breaker.emptyAccount(), "WMON", wmon(50n), ONE);
  return breaker.poke(s, ONE, T0).state;
}

describe("internal units (D-233)", () => {
  it("mints one unit per USDC on the first deposit", () => {
    const s = breaker.deposit(breaker.emptyAccount(), "USDC", usdc(40n), 0n);
    expect(s.units).toBe(40n * ONE);
    expect(breaker.perUnitE18(breaker.navAt(s, 0n), s.units)).toBe(ONE);
  });

  it("never lets a flow lower the value per unit, at any size or order", () => {
    let seed = 7;
    const rand = (n: bigint) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return BigInt(seed) % n;
    };
    const px = price(37n);
    let s = breaker.deposit(breaker.emptyAccount(), "USDC", usdc(10n), px);
    for (let i = 0; i < 400; i++) {
      const before = breaker.perUnitE18(breaker.navAt(s, px), s.units);
      const token = rand(2n) === 0n ? "USDC" : "WMON";
      const held = token === "USDC" ? s.usdc : s.wmon;
      if (rand(2n) === 0n && held > 0n) s = breaker.withdraw(s, token, 1n + rand(held));
      else s = breaker.deposit(s, token, 1n + rand(token === "USDC" ? usdc(5n) : wmon(20n)), px);
      if (s.units === 0n) continue;
      expect(breaker.perUnitE18(breaker.navAt(s, px), s.units)).toBeGreaterThanOrEqual(before);
    }
  });

  it("starts afresh when the account is emptied", () => {
    const s = breaker.withdraw(wmonAccount(), "WMON", wmon(50n));
    expect(s.units).toBe(0n);
    expect(breaker.peakOf(s.buckets, T0)).toBe(0n);
  });
});

describe("the circuit breaker", () => {
  it("trips REDUCE_ONLY at exactly 10% and PAUSED at exactly 20%", () => {
    const s = wmonAccount();
    expect(breaker.poke(s, price(90n) + 2n * 10n ** 10n, T0).state.mode).toBe("NORMAL");
    const ten = breaker.poke(s, price(90n), T0);
    expect(ten.state.mode).toBe("REDUCE_ONLY");
    expect(breaker.poke(ten.state, price(80n) + 2n * 10n ** 10n, T0).state.mode).toBe(
      "REDUCE_ONLY",
    );
    expect(breaker.poke(ten.state, price(80n), T0).state.mode).toBe("PAUSED");
  });

  it("never loosens on its own, and the owner's unpause starts the peak afresh", () => {
    const paused = breaker.poke(wmonAccount(), price(70n), T0).state;
    expect(breaker.poke(paused, price(200n), T0).state.mode).toBe("PAUSED");
    const reviewed = breaker.unpause(paused);
    expect(reviewed.mode).toBe("NORMAL");
    expect(breaker.poke(reviewed, price(70n), T0).state.mode).toBe("NORMAL");
  });

  it("keeps a peak for 7 days and forgets it on the 8th", () => {
    const s = wmonAccount();
    expect(breaker.poke(s, price(90n), T0 + 7n * DAY).state.mode).toBe("REDUCE_ONLY");
    expect(breaker.poke(s, price(90n), T0 + 8n * DAY).state.mode).toBe("NORMAL");
  });

  it("refuses new risk in a drawdown nobody has poked yet", () => {
    const s = wmonAccount();
    expect(breaker.breakerModeNow(s, usdc(44n), T0)).toBe("REDUCE_ONLY");
    expect(breaker.breakerModeNow(s, usdc(46n), T0)).toBe("NORMAL");
  });

  it("does not let a deposit after a drop hide it", () => {
    const s = breaker.deposit(wmonAccount(), "USDC", usdc(40n), price(85n));
    expect(breaker.poke(s, price(85n), T0).state.mode).toBe("REDUCE_ONLY");
  });
});
