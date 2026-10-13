import { ALLOCATION_DEFAULTS, DEFAULT_GOAL_INPUT, type GoalInput } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import {
  errorsByField,
  formFromGoal,
  goalChanged,
  goalFromForm,
  limitValue,
  rebalanceAllocation,
  withStyle,
} from "./goal";

const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";

describe("the Goal page's form (P3-U1, F-U7)", () => {
  it("round-trips the default goal through the form", () => {
    const form = formFromGoal(DEFAULT_GOAL_INPUT);
    expect(form).toMatchObject({
      aggressiveness: "BALANCED",
      modelTier: "MEDIUM",
      screenedOptIn: false,
      excludedTokens: [],
      intensity: "LIGHT",
      budgetText: "1.00",
      reserveText: "1.00",
      planChanges: "ASK_FIRST",
    });
    expect(Object.values(form.limits)).toEqual(["", "", "", "", ""]);
    // A goal saved before the split reads as its style's split and most positions.
    expect(goalFromForm(form)).toEqual({
      goal: { ...DEFAULT_GOAL_INPUT, allocation: ALLOCATION_DEFAULTS.BALANCED, maxPositions: 8 },
      errors: null,
    });
    expect(goalChanged(form, DEFAULT_GOAL_INPUT)).toBe(false);
  });

  it("reads limits as percentages or trades, and empty as the hard limit", () => {
    expect(limitValue("maxTradeBps", "5")).toBe(500);
    expect(limitValue("maxSlippageBps", "0.3")).toBe(30);
    expect(limitValue("maxTradesPer24h", "6")).toBe(6);
    expect(limitValue("maxTradeBps", " ")).toBeNull();
    expect(limitValue("maxTradeBps", "5.555")).toBeUndefined();
    expect(limitValue("maxTradesPer24h", "2.5")).toBeUndefined();
  });

  it("sends the owner's choices, limits and amounts in the API's units", () => {
    const form = {
      ...formFromGoal(DEFAULT_GOAL_INPUT),
      aggressiveness: "AGGRESSIVE" as const,
      modelTier: "HIGH" as const,
      screenedOptIn: true,
      excludedTokens: [WBTC.toUpperCase().replace("0X", "0x"), WBTC],
      limits: {
        ...formFromGoal(DEFAULT_GOAL_INPUT).limits,
        maxTradeBps: "5",
        maxTradesPer24h: "6",
      },
      intensity: "STANDARD" as const,
      budgetText: "2.5",
      reserveText: "0",
    };
    const { goal } = goalFromForm(form);
    expect(goal).toMatchObject({
      aggressiveness: "AGGRESSIVE",
      modelTier: "HIGH",
      screenedOptIn: true,
      excludedTokens: [WBTC],
      stricterLimits: { maxTradeBps: 500, maxTradesPer24h: 6, maxPositionBps: null },
      research: { intensity: "STANDARD", dailyBudgetUsdcE6: "2500000" },
      creditReserveUsdcE6: "0",
    });
    expect(goalChanged(form, DEFAULT_GOAL_INPUT)).toBe(true);
  });

  it("names each field that is not a number, and sends nothing", () => {
    const base = formFromGoal(DEFAULT_GOAL_INPUT);
    const r = goalFromForm({
      ...base,
      limits: { ...base.limits, minUsdcShareBps: "lots" },
      budgetText: "1.0000001",
    });
    expect(r.goal).toBeNull();
    expect(r.errors).toEqual({
      "stricterLimits.minUsdcShareBps":
        "Enter a percentage with at most 2 decimals, or leave it empty.",
      "research.dailyBudgetUsdcE6": "Enter an amount of USDC with at most 6 decimals.",
    });
  });

  it("compares with the saved goal whatever its key order or address case", () => {
    const saved = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(DEFAULT_GOAL_INPUT).reverse())),
    ) as GoalInput;
    expect(goalChanged(formFromGoal(DEFAULT_GOAL_INPUT), saved)).toBe(false);
    const excluded: GoalInput = { ...DEFAULT_GOAL_INPUT, excludedTokens: [WBTC] };
    expect(
      goalChanged(
        { ...formFromGoal(excluded), excludedTokens: [WBTC.toUpperCase().replace("0X", "0x")] },
        excluded,
      ),
    ).toBe(false);
  });

  it("keeps the first reason per field", () => {
    expect(
      errorsByField([
        { field: "aggressiveness", code: "INVALID_FIELD", message: "a" },
        { field: "aggressiveness", code: "INVALID_FIELD", message: "b" },
      ]),
    ).toEqual({ aggressiveness: "a" });
  });
});

describe("the allocation split and the style (2026-10-13)", () => {
  const a = { degenBps: 1_000, growthBps: 3_000, conservativeBps: 6_000 };
  const sum = (x: typeof a) => x.degenBps + x.growthBps + x.conservativeBps;

  it("keeps the three shares at 100% in 5% steps, the other two in their old proportion", () => {
    const r = rebalanceAllocation(a, "degenBps", 4_000);
    expect(r).toEqual({ degenBps: 4_000, growthBps: 2_000, conservativeBps: 4_000 });
    expect(sum(r)).toBe(10_000);
    expect(rebalanceAllocation(a, "conservativeBps", 10_000)).toEqual({
      degenBps: 0,
      growthBps: 0,
      conservativeBps: 10_000,
    });
    const fromZero = rebalanceAllocation(
      { degenBps: 0, growthBps: 0, conservativeBps: 10_000 },
      "conservativeBps",
      5_000,
    );
    expect(fromZero).toEqual({ degenBps: 2_500, growthBps: 2_500, conservativeBps: 5_000 });
    for (const v of [0, 500, 2_300, 7_777, 9_500])
      for (const k of ["degenBps", "growthBps", "conservativeBps"] as const) {
        const x = rebalanceAllocation(a, k, v);
        expect(sum(x)).toBe(10_000);
        expect(Object.values(x).every((n) => n % 500 === 0 && n >= 0)).toBe(true);
      }
  });

  it("sets a style's split and most positions, and the safety opt-in on for Aggressive", () => {
    const f = formFromGoal(DEFAULT_GOAL_INPUT);
    expect(f.allocation).toEqual(ALLOCATION_DEFAULTS.BALANCED);
    expect(f.maxPositions).toBe(8);
    const aggressive = withStyle(f, "AGGRESSIVE");
    expect(aggressive).toMatchObject({
      aggressiveness: "AGGRESSIVE",
      allocation: ALLOCATION_DEFAULTS.AGGRESSIVE,
      maxPositions: 12,
      screenedOptIn: true,
    });
    expect(withStyle(f, "CONSERVATIVE")).toMatchObject({ maxPositions: 5, screenedOptIn: false });
    expect(goalFromForm(aggressive).goal).toMatchObject({
      allocation: ALLOCATION_DEFAULTS.AGGRESSIVE,
      maxPositions: 12,
    });
  });

  it("treats a goal saved before the split as its style's split, not as a change", () => {
    expect(goalChanged(formFromGoal(DEFAULT_GOAL_INPUT), DEFAULT_GOAL_INPUT)).toBe(false);
  });
});
