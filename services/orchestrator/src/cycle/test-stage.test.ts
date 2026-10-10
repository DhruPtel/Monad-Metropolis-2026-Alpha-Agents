import { describe, expect, it } from "vitest";
import { type TestInputs, checkProposal, proposalParams, testEnvelope } from "./test-stage.ts";

/** A Balanced goal's limits (P3-U1's translator): target range 20% to 50%, hard limits of D-034. */
const inputs: TestInputs = {
  targetRange: { minBps: 2_000, maxBps: 5_000 },
  hardLimits: {
    maxTradeBps: 1_000,
    maxPositionBps: 4_000,
    minUsdcShareBps: 2_000,
    maxSlippageBps: 100,
    maxTradesPer24h: 20,
  },
  ownerLimits: {
    maxTradeBps: 800,
    maxPositionBps: 4_000,
    minUsdcShareBps: 2_000,
    maxSlippageBps: 45,
    maxTradesPer24h: 20,
  },
  lastAgentChangeAt: null,
  now: new Date("2026-10-09T12:00:00Z"),
};

const good = proposalParams({
  targetWmonBps: 3_000,
  bandHalfWidthBps: 500,
  minTradeUsdc: "1",
  volatilityBrakeBps: 20_000,
  costHurdleBps: 40,
  maxLegBps: 800,
});

const codes = (p: typeof good, t: TestInputs = inputs) => checkProposal(p, t).map((f) => f.code);

describe("the deterministic Test stage (D-282, P3-U4)", () => {
  it("passes a plan inside the template, the goal, the owner's and the hard limits, and the evals", () => {
    expect(checkProposal(good, inputs)).toEqual([]);
    expect(good.minTradeUsdcE6).toBe(1_000_000n);
  });

  it("rejects a plan change that breaks a template bound", () => {
    expect(codes({ ...good, bandHalfWidthBps: 50 })).toEqual(["OUT_OF_BOUNDS"]);
    expect(codes({ ...good, volatilityBrakeBps: 40_000 })).toEqual(["OUT_OF_BOUNDS"]);
  });

  it("rejects a target outside the goal's range, a leg past the owner's limit and a cost past the slippage limit", () => {
    expect(codes({ ...good, targetWmonBps: 1_500 })).toEqual(["OUTSIDE_PRESET"]);
    expect(codes({ ...good, maxLegBps: 900 })).toEqual(["OWNER_LIMIT"]);
    expect(codes({ ...good, costHurdleBps: 50 })).toEqual(["OWNER_LIMIT"]);
  });

  it("rejects a plan that breaks a hard limit even where the goal's range would allow it", () => {
    const wide = { ...inputs, targetRange: { minBps: 0, maxBps: 6_000 } };
    expect(codes({ ...good, targetWmonBps: 4_500 }, wide)).toContain("HARD_LIMIT");
    const ownerLoose = { ...inputs, ownerLimits: { ...inputs.ownerLimits, maxTradeBps: 1_200 } };
    expect(codes({ ...good, maxLegBps: 1_100 }, ownerLoose)).toContain("HARD_LIMIT");
  });

  it("holds the 24-hour cooldown after an accepted agent change", () => {
    const recent = { ...inputs, lastAgentChangeAt: new Date("2026-10-09T01:00:00Z") };
    expect(codes(good, recent)).toEqual(["COOLDOWN"]);
    const old = { ...inputs, lastAgentChangeAt: new Date("2026-10-08T11:00:00Z") };
    expect(codes(good, old)).toEqual([]);
  });

  it("gives the Zoom out the envelope: every bound intersected, and whether it may propose now", () => {
    const e = testEnvelope(good, {
      ...inputs,
      lastAgentChangeAt: new Date("2026-10-09T06:00:00Z"),
    });
    expect(e.ranges.targetWmonBps).toEqual([2_000, 4_000]);
    expect(e.ranges.maxLegBps).toEqual([10, 800]);
    expect(e.ranges.costHurdleBps).toEqual([5, 45]);
    expect(e.mayProposeNow).toBe(false);
    expect(e.cooldownUntil).toBe("2026-10-10T06:00:00.000Z");
    expect(e.currentPlanFindings).toEqual([]);
  });
});
