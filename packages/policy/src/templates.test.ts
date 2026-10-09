import { RUNNER_HOLD_CODES } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import { evalPasses, loadEvals, runEval } from "./evals.ts";
import { type RebalanceBandsParams, translateGoal } from "./goals.ts";
import { DEFAULT_GOAL_INPUT, RISK_PRESETS } from "@alpha-agents/domain";
import {
  REBALANCE_BANDS_V1,
  STRATEGY_TEMPLATE_RULES,
  paramsHash,
  templateFingerprint,
} from "./templates.ts";

const evals = loadEvals("rebalance_bands@1");

describe("rebalance_bands@1's evals (P3-U3, Q-28)", () => {
  it.each(evals.scenarios.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    const d = runEval(evals, s);
    expect(
      evalPasses(s, d),
      `${s.description} Got ${JSON.stringify(d, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`,
    ).toBe(true);
  });

  it("covers every hold reason the rule can give, and both trade directions", () => {
    const holds = new Set(
      evals.scenarios.flatMap((s) => (s.expect.action === "hold" ? [s.expect.code] : [])),
    );
    for (const code of [
      "IN_BAND",
      "BELOW_MIN_TRADE",
      "VOLATILITY_BRAKE",
      "VOLATILITY_UNAVAILABLE",
      "COST_HURDLE",
      "ORACLE_STALE",
    ])
      expect(holds, code).toContain(code);
    const sells = new Set(
      evals.scenarios.flatMap((s) => (s.expect.action === "trade" ? [s.expect.sell] : [])),
    );
    expect([...sells].sort()).toEqual(["USDC", "WMON"]);
    for (const h of holds) if (h !== "ORACLE_STALE") expect(RUNNER_HOLD_CODES).toContain(h);
  });
});

describe("the template's parameters and immutability", () => {
  const ok: RebalanceBandsParams = {
    targetWmonBps: 2_000,
    bandHalfWidthBps: 500,
    minTradeUsdcE6: 500_000n,
    volatilityBrakeBps: 20_000,
    costHurdleBps: 40,
    maxLegBps: 1_000,
  };

  it("accepts a set inside the bounds and refuses each parameter outside them", () => {
    expect(REBALANCE_BANDS_V1.check(ok)).toEqual([]);
    const bad: [keyof RebalanceBandsParams, number | bigint][] = [
      ["targetWmonBps", 4_001],
      ["bandHalfWidthBps", 99],
      ["minTradeUsdcE6", 99_999n],
      ["volatilityBrakeBps", 30_001],
      ["costHurdleBps", 51],
      ["maxLegBps", 1_001],
    ];
    for (const [k, v] of bad)
      expect(REBALANCE_BANDS_V1.check({ ...ok, [k]: v }).map((e) => e.field)).toEqual([
        `template.params.${k}`,
      ]);
  });

  it("every preset's defaults sit inside the bounds, with the measured brakes (A-58)", () => {
    const brakes: number[] = [];
    for (const riskPreset of RISK_PRESETS) {
      const r = translateGoal({ ...DEFAULT_GOAL_INPUT, riskPreset });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      expect(REBALANCE_BANDS_V1.check(r.config.template.params)).toEqual([]);
      brakes.push(r.config.template.params.volatilityBrakeBps);
    }
    expect(brakes).toEqual([15_000, 20_000, 25_000]);
  });

  it("is frozen, and its published fingerprint never changes (a new rule is a new version)", () => {
    expect(Object.isFrozen(REBALANCE_BANDS_V1)).toBe(true);
    expect(Object.isFrozen(STRATEGY_TEMPLATE_RULES)).toBe(true);
    expect(templateFingerprint(REBALANCE_BANDS_V1 as never)).toBe(
      "0x82fff8be0efafffe8b3b01d5f57b4f80982c5b13f8336c59f4379f3abfe2ba97",
    );
  });

  it("hashes a plan's parameters deterministically", () => {
    expect(paramsHash("rebalance_bands@1", ok)).toBe(paramsHash("rebalance_bands@1", { ...ok }));
    expect(paramsHash("rebalance_bands@1", ok)).not.toBe(
      paramsHash("rebalance_bands@1", { ...ok, targetWmonBps: 2_100 }),
    );
  });
});
