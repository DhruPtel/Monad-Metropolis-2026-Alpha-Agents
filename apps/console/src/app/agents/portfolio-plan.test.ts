import { describe, expect, it } from "vitest";
import {
  draftTotalPercent,
  emptyPosition,
  portfolioDraftOf,
  portfolioSummary,
  toPortfolioParams,
} from "./portfolio-plan";

const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const DEFAULTS = {
  minTradeUsdcE6: "500000",
  volatilityBrakeBps: 20_000,
  costHurdleBps: 40,
  maxLegBps: 1_000,
};
const TOKENS = [
  {
    token: WMON,
    symbol: "WMON",
    decimals: 18,
    class: "F",
    lane: "CORE",
    status: "BUYABLE",
    capBps: 4_000,
  },
  {
    token: WBTC,
    symbol: "WBTC",
    decimals: 8,
    class: "F",
    lane: "CORE",
    status: "BUYABLE",
    capBps: 1_500,
  },
];

describe("the console's target portfolio form (F-U6)", () => {
  it("turns a draft into the orchestrator's parameters, in basis points and base units", () => {
    const params = toPortfolioParams({
      positions: [
        {
          ...emptyPosition(WMON),
          weight: "30",
          band: "3",
          thesisId: "t-wmon",
          killCriterion: "MON loses its yield",
          recheckAt: "2026-11-01",
        },
        {
          ...emptyPosition(WBTC),
          weight: "20",
          band: "2.5",
          thesisId: "t-wbtc",
          killCriterion: "The bridge fails",
          recheckAt: "2026-11-15",
        },
      ],
      cash: "50",
      minTrade: "0.5",
      brake: "200",
      cost: "40",
      maxLeg: "10",
    });
    expect(params).toMatchObject({
      template: "target_portfolio@1",
      cashTargetBps: 5_000,
      minTradeUsdcE6: "500000",
      volatilityBrakeBps: 20_000,
      costHurdleBps: 40,
      maxLegBps: 1_000,
    });
    if ("error" in params) throw new Error(params.error);
    expect(params.positions[0]).toEqual({
      token: WMON.toLowerCase(),
      targetWeightBps: 3_000,
      bandBps: 300,
      thesisId: "t-wmon",
      exit: { killCriterion: "MON loses its yield", recheckAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(params.positions[1]).toMatchObject({ targetWeightBps: 2_000, bandBps: 250 });
  });

  it("names the first thing wrong with a draft", () => {
    const first = { ...emptyPosition(""), weight: "30", thesisId: "t", killCriterion: "k" };
    const base = {
      positions: [first],
      cash: "70",
      minTrade: "0.5",
      brake: "200",
      cost: "40",
      maxLeg: "10",
    };
    expect(toPortfolioParams(base)).toEqual({ error: "Position 1 needs a token." });
    expect(
      toPortfolioParams({
        ...base,
        positions: [{ ...first, token: WMON, thesisId: " " }],
      }),
    ).toEqual({ error: "Position 1 needs a thesis ID." });
    expect(
      toPortfolioParams({
        ...base,
        positions: [{ ...first, token: WMON, killCriterion: "" }],
      }),
    ).toEqual({ error: "Position 1 needs a kill criterion." });
    expect(
      toPortfolioParams({
        ...base,
        positions: [{ ...first, token: WMON, recheckAt: "soon" }],
      }),
    ).toEqual({ error: "Position 1 needs a recheck date." });
    expect(
      toPortfolioParams({
        ...base,
        positions: [{ ...first, token: WMON, weight: "x" }],
      }),
    ).toEqual({
      error: "Position 1's weight must be a number of 0 or more.",
    });
    expect(
      toPortfolioParams({ ...base, positions: [{ ...first, token: WMON }], cash: "" }),
    ).toEqual({
      error: "The cash target must be a number of 0 or more.",
    });
  });

  it("adds the weights and the cash so the form shows the gap to 100%", () => {
    const d = portfolioDraftOf(null, DEFAULTS);
    expect(draftTotalPercent(d)).toBe(50);
    expect(d.positions).toHaveLength(1);
    expect(d.minTrade).toBe("0.5");
    expect(d.maxLeg).toBe("10");
    expect(
      draftTotalPercent({
        ...d,
        positions: [
          { ...emptyPosition(WMON), weight: "30.5" },
          { ...emptyPosition(WBTC), weight: "19.5" },
        ],
      }),
    ).toBe(100);
  });

  it("prefills from a served plan and summarizes it by symbol", () => {
    const params = {
      positions: [
        {
          token: WMON.toLowerCase(),
          targetWeightBps: 3_000,
          bandBps: 300,
          thesisId: "t-wmon",
          exit: { killCriterion: "k", recheckAt: "2026-11-01T00:00:00.000Z" },
        },
        {
          token: "0x00000000000000000000000000000000000000c9",
          targetWeightBps: 1_000,
          bandBps: 200,
          thesisId: "t-x",
          exit: { killCriterion: "k", recheckAt: "2026-11-01T00:00:00.000Z" },
        },
      ],
      cashTargetBps: 6_000,
      minTradeUsdcE6: "1000000",
      volatilityBrakeBps: 15_000,
      costHurdleBps: 30,
      maxLegBps: 800,
    };
    const d = portfolioDraftOf(params, DEFAULTS);
    expect(d.positions[0]).toMatchObject({
      token: WMON.toLowerCase(),
      weight: "30",
      band: "3",
      recheckAt: "2026-11-01",
    });
    expect(d).toMatchObject({ cash: "60", minTrade: "1", brake: "150", cost: "30", maxLeg: "8" });
    expect(portfolioSummary(params, TOKENS)).toBe("WMON 30% ±3, 0x0000..00c9 10% ±2, cash 60%");
    expect(portfolioSummary({ ...params, positions: [] }, TOKENS)).toBe("cash 60%");
  });
});
