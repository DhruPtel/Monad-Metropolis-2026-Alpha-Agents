import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGGRESSIVENESS_ENVELOPES,
  AGGRESSIVENESS_FACTS,
  AGGRESSIVENESS_LEVELS,
  DEFAULT_GOAL_INPUT,
  GoalInputSchema,
  MODEL_TIER_FACTS,
  RESEARCH_INTENSITY_FACTS,
  SCAN_ALIAS,
  isLegacyGoalInput,
  migrateLegacyGoalInput,
} from "./goals.ts";

const LITELLM_CONFIG = fileURLToPath(
  new URL("../../../infra/litellm/config.yaml", import.meta.url),
);

describe("the goal's fields (P3-U1, F-U7)", () => {
  it("the default goal is valid: Balanced, Medium, core lane only, Light (D-299, D-345)", () => {
    expect(GoalInputSchema.parse(DEFAULT_GOAL_INPUT)).toEqual(DEFAULT_GOAL_INPUT);
    expect(DEFAULT_GOAL_INPUT).toMatchObject({
      aggressiveness: "BALANCED",
      modelTier: "MEDIUM",
      screenedOptIn: false,
      excludedTokens: [],
    });
    expect(DEFAULT_GOAL_INPUT.research.intensity).toBe("LIGHT");
    expect(DEFAULT_GOAL_INPUT.research.dailyBudgetUsdcE6).toBe("1000000");
  });

  it("every model tier and the Scan's alias are aliases the LiteLLM gateway serves (D-353)", () => {
    const served = [...readFileSync(LITELLM_CONFIG, "utf8").matchAll(/model_name:\s*(\S+)/g)].map(
      (m) => m[1],
    );
    for (const f of Object.values(MODEL_TIER_FACTS)) expect(served).toContain(f.alias);
    expect(served).toContain(SCAN_ALIAS);
    expect(MODEL_TIER_FACTS.LOW.model).toBe("Claude Haiku 4.5");
    expect(MODEL_TIER_FACTS.MEDIUM.model).toBe("Claude Sonnet 5.5");
    expect(MODEL_TIER_FACTS.HIGH.model).toBe("Claude Opus 5.5");
  });

  it("keeps each level's envelope consistent (A-60) and each intensity's budget inside its own", () => {
    for (const level of AGGRESSIVENESS_LEVELS) {
      const e = AGGRESSIVENESS_ENVELOPES[level];
      expect(e.maxClassAPositionBps).toBeLessThanOrEqual(e.maxClassATotalBps);
      expect(e.maxClassAPositionBps).toBeLessThanOrEqual(e.maxPositionBps);
      expect(e.classAAllowed).toBe(e.maxClassATotalBps > 0);
      expect(AGGRESSIVENESS_FACTS[level].brief.length).toBeGreaterThan(80);
      expect(AGGRESSIVENESS_FACTS[level].brief).not.toMatch(/—/);
    }
    expect(AGGRESSIVENESS_ENVELOPES.CONSERVATIVE.maxPositions).toBe(8);
    expect(AGGRESSIVENESS_ENVELOPES.AGGRESSIVE.maxPositions).toBe(12);
    for (const i of Object.values(RESEARCH_INTENSITY_FACTS)) {
      expect(i.defaultDailyBudgetUsdcE6).toBeGreaterThanOrEqual(i.minDailyBudgetUsdcE6);
      expect(i.defaultDailyBudgetUsdcE6).toBeLessThanOrEqual(i.maxDailyBudgetUsdcE6);
    }
  });

  it("refuses free text, unknown fields, a bad address and more than 32 exclusions", () => {
    const parse = (over: Record<string, unknown>) =>
      GoalInputSchema.safeParse({ ...DEFAULT_GOAL_INPUT, ...over }).success;
    expect(parse({ note: "buy the dip" })).toBe(false);
    expect(parse({ aggressiveness: "YOLO" })).toBe(false);
    expect(parse({ modelTier: "claude-fable-5-1" })).toBe(false);
    expect(parse({ excludedTokens: ["WBTC"] })).toBe(false);
    expect(parse({ excludedTokens: ["0x0555e30da8f98308edb960aa94c0db47230d2b9c"] })).toBe(true);
    expect(
      parse({
        excludedTokens: Array.from({ length: 33 }, (_, i) => `0x${String(i).padStart(40, "0")}`),
      }),
    ).toBe(false);
    expect(parse({ screenedOptIn: "yes" })).toBe(false);
  });

  it("migrates a goal saved before F-U7 to Conservative, keeping its limits and settings (D-345)", () => {
    const legacy = {
      template: "rebalance_bands@1",
      riskPreset: "GROWTH",
      allowedAssets: { wmon: true },
      stricterLimits: {
        maxTradeBps: 500,
        maxWmonShareBps: 2_500,
        minUsdcShareBps: null,
        maxSlippageBps: 30,
        maxTradesPer24h: 6,
      },
      reasoningModel: "DEEP",
      research: { intensity: "STANDARD", dailyBudgetUsdcE6: "2500000" },
      creditReserveUsdcE6: "2000000",
      planChanges: "APPLY_AND_TELL",
    };
    expect(isLegacyGoalInput(legacy)).toBe(true);
    expect(isLegacyGoalInput(DEFAULT_GOAL_INPUT)).toBe(false);
    const migrated = migrateLegacyGoalInput(legacy);
    expect(GoalInputSchema.parse(migrated)).toEqual(migrated);
    expect(migrated).toEqual({
      aggressiveness: "CONSERVATIVE",
      modelTier: "HIGH",
      screenedOptIn: false,
      excludedTokens: [],
      stricterLimits: {
        maxTradeBps: 500,
        maxPositionBps: 2_500,
        minUsdcShareBps: null,
        maxSlippageBps: 30,
        maxTradesPer24h: 6,
      },
      research: { intensity: "STANDARD", dailyBudgetUsdcE6: "2500000" },
      creditReserveUsdcE6: "2000000",
      planChanges: "APPLY_AND_TELL",
    });
    // A Standard reasoning model becomes Medium; a broken field falls back to the default.
    expect(migrateLegacyGoalInput({ reasoningModel: "STANDARD", research: {} })).toMatchObject({
      modelTier: "MEDIUM",
      research: { intensity: "LIGHT", dailyBudgetUsdcE6: "1000000" },
      planChanges: "ASK_FIRST",
    });
  });
});
