import { DEFAULT_GOAL_INPUT, type GoalInput } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import { errorsByField, formFromGoal, goalChanged, goalFromForm, limitValue } from "./goal";

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
    expect(goalFromForm(form)).toEqual({ goal: DEFAULT_GOAL_INPUT, errors: null });
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
