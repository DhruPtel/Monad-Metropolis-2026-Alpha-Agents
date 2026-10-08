import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOAL_INPUT,
  GoalInputSchema,
  REASONING_MODEL_FACTS,
  RESEARCH_INTENSITY_FACTS,
  RISK_PRESET_FACTS,
} from "./goals.ts";

const LITELLM_CONFIG = fileURLToPath(
  new URL("../../../infra/litellm/config.yaml", import.meta.url),
);

describe("the goal's fields (P3-U1)", () => {
  it("the default goal is valid and starts at Light (D-299)", () => {
    expect(GoalInputSchema.parse(DEFAULT_GOAL_INPUT)).toEqual(DEFAULT_GOAL_INPUT);
    expect(DEFAULT_GOAL_INPUT.research.intensity).toBe("LIGHT");
    expect(DEFAULT_GOAL_INPUT.research.dailyBudgetUsdcE6).toBe("1000000");
  });

  it("every reasoning model is an alias the LiteLLM gateway serves", () => {
    const served = [...readFileSync(LITELLM_CONFIG, "utf8").matchAll(/model_name:\s*(\S+)/g)].map(
      (m) => m[1],
    );
    for (const f of Object.values(REASONING_MODEL_FACTS)) expect(served).toContain(f.alias);
  });

  it("keeps each preset's default inside its range and each intensity's budget inside its own", () => {
    for (const p of Object.values(RISK_PRESET_FACTS)) {
      expect(p.defaultTargetBps).toBeGreaterThanOrEqual(p.targetMinBps);
      expect(p.defaultTargetBps).toBeLessThanOrEqual(p.targetMaxBps);
    }
    for (const i of Object.values(RESEARCH_INTENSITY_FACTS)) {
      expect(i.defaultDailyBudgetUsdcE6).toBeGreaterThanOrEqual(i.minDailyBudgetUsdcE6);
      expect(i.defaultDailyBudgetUsdcE6).toBeLessThanOrEqual(i.maxDailyBudgetUsdcE6);
    }
  });
});
