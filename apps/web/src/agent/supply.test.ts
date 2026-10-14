import { AGENT_MAX_SUPPLY, SPECIES, TIER_SUPPLY } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import { type SupplyReading, formatOdds, summarizeSupply } from "./supply";

const fresh = (): number[] => SPECIES.map((s) => s.count);
const reading = (remaining: number[], totalMinted: number): SupplyReading => ({
  maxSupply: AGENT_MAX_SUPPLY,
  totalMinted,
  remaining,
});
const tier = (r: SupplyReading, id: "base" | "medium" | "pro") => {
  const t = summarizeSupply(r).tiers.find((x) => x.tier === id);
  if (!t) throw new Error(`no ${id} tier`);
  return t;
};
const BEE = 14;

describe("summarizeSupply", () => {
  it("before any mint: 500, 300 and 200 left, at 50%, 30% and 20% (NFT-U1)", () => {
    const s = summarizeSupply(reading(fresh(), 0));
    expect(s).toMatchObject({ minted: 0, leftToMint: 1000, awaitingReveal: 0, soldOut: false });
    expect(s.tiers.map((t) => [t.tier, t.slots, t.total, t.remaining, t.odds])).toEqual([
      ["base", 3, 500, 500, 0.5],
      ["medium", 5, 300, 300, 0.3],
      ["pro", 8, 200, 200, 0.2],
    ]);
    expect(s.tiers.map((t) => t.total)).toEqual([
      TIER_SUPPLY.base,
      TIER_SUPPLY.medium,
      TIER_SUPPLY.pro,
    ]);
  });

  it("lists every species under its tier with its own remaining count", () => {
    const remaining = fresh();
    remaining[BEE - 1] -= 1;
    const pro = tier(reading(remaining, 1), "pro");
    // CO-U1: ten drawn pro species and three at a count of 0, Butterfly among the drawn.
    expect(pro.species).toHaveLength(13);
    expect(pro.species.find((s) => s.species.slug === "bee")?.remaining).toBe(26);
    expect(pro.remaining).toBe(199);
    // Every species sits under its own tier, each tier in onchain order (the
    // nine species NFT-U1 appended follow the first 25 within their tiers).
    const all = summarizeSupply(reading(remaining, 1)).tiers.flatMap((t) => t.species);
    expect([...all.map((s) => s.species.index)].sort((a, b) => a - b)).toEqual(
      SPECIES.map((s) => s.index),
    );
    for (const t of summarizeSupply(reading(remaining, 1)).tiers) {
      expect(t.species.every((s) => s.species.tier === t.tier)).toBe(true);
      expect(t.species.map((s) => s.species.index)).toEqual(
        SPECIES.filter((s) => s.tier === t.tier).map((s) => s.index),
      );
    }
  });

  it("odds use the deck left, so a revealed pro lowers the pro odds", () => {
    const remaining = fresh();
    remaining[BEE - 1] -= 1;
    const r = reading(remaining, 1);
    expect(tier(r, "pro").odds).toBeCloseTo(199 / 999, 12);
    expect(tier(r, "base").odds).toBeCloseTo(500 / 999, 12);
    const sum = summarizeSupply(r).tiers.reduce((acc, t) => acc + (t.odds ?? 0), 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("counts minted agents that are not revealed yet", () => {
    const remaining = fresh();
    remaining[BEE - 1] -= 1;
    // Three minted, one revealed: the deck has 999 slots and two are pending.
    const s = summarizeSupply(reading(remaining, 3));
    expect(s).toMatchObject({ minted: 3, leftToMint: 997, awaitingReveal: 2 });
  });

  it("a sold-out tier has 0% odds while the others share the rest", () => {
    const remaining = fresh();
    for (const s of SPECIES) if (s.tier === "pro") remaining[s.index - 1] = 0;
    const r = reading(remaining, 100);
    expect(tier(r, "pro")).toMatchObject({ remaining: 0, odds: 0 });
    expect(tier(r, "base").odds).toBeCloseTo(500 / 800, 12);
    expect(tier(r, "medium").odds).toBeCloseTo(300 / 800, 12);
    expect(summarizeSupply(r).soldOut).toBe(false);
  });

  it("the whole supply sold out: nothing to mint and no odds, even with reveals pending", () => {
    const remaining = SPECIES.map(() => 0);
    remaining[0] = 4; // four minted agents still waiting for their reveal
    const s = summarizeSupply(reading(remaining, 1000));
    expect(s).toMatchObject({ leftToMint: 0, soldOut: true, awaitingReveal: 4 });
    expect(s.tiers.map((t) => t.odds)).toEqual([null, null, null]);
  });

  it("the whole supply minted and revealed", () => {
    const s = summarizeSupply(
      reading(
        SPECIES.map(() => 0),
        1000,
      ),
    );
    expect(s).toMatchObject({ leftToMint: 0, soldOut: true, awaitingReveal: 0 });
    expect(s.tiers.map((t) => [t.remaining, t.odds])).toEqual([
      [0, null],
      [0, null],
      [0, null],
    ]);
  });

  it("one slot left: that tier is certain", () => {
    const remaining = SPECIES.map(() => 0);
    remaining[BEE] = 1; // species 15, the praying mantis, a pro 1-of-1
    const s = summarizeSupply(reading(remaining, 999));
    expect(s.leftToMint).toBe(1);
    expect(s.tiers.map((t) => t.odds)).toEqual([0, 0, 1]);
  });

  it("refuses a reading without every species", () => {
    expect(() => summarizeSupply(reading([1, 2, 3], 0))).toThrow(RangeError);
  });
});

describe("formatOdds", () => {
  it.each([
    [null, "None left"],
    [0, "0%"],
    [1, "100%"],
    [0.6, "60.0%"],
    [99 / 999, "9.9%"],
    [1 / 999, "0.1%"],
    [0.0004, "<0.1%"],
    [0.9996, ">99.9%"],
  ])("%s reads %s", (odds, text) => {
    expect(formatOdds(odds)).toBe(text);
  });
});
