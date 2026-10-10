import {
  AGGRESSIVENESS_ENVELOPES,
  AGGRESSIVENESS_LEVELS,
  DEFAULT_GOAL_INPUT,
  type GoalInput,
  OWNER_LIMIT_FACTS,
  OWNER_LIMIT_FIELDS,
  RESEARCH_INTENSITIES,
  RESEARCH_INTENSITY_FACTS,
} from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import {
  BANDS_DEFAULTS,
  type GoalConfig,
  REBALANCE_BANDS_V1_BOUNDS,
  briefOf,
  canonicalJson,
  checkTemplateParams,
  costPreview,
  hardGoalLimits,
  ownerLimitRanges,
  translateGoal,
} from "./goals.ts";
import { LAUNCH_LIMITS } from "./limits.ts";

const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";

const goal = (over: Partial<GoalInput> = {}): GoalInput => ({
  ...structuredClone(DEFAULT_GOAL_INPUT),
  ...over,
});
const withLimit = (field: (typeof OWNER_LIMIT_FIELDS)[number], value: number | null) =>
  goal({ stricterLimits: { ...DEFAULT_GOAL_INPUT.stricterLimits, [field]: value } });

function ok(input: unknown): GoalConfig {
  const r = translateGoal(input);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.errors)}`);
  return r.config;
}
function refused(input: unknown) {
  const r = translateGoal(input);
  if (r.ok) throw new Error("expected a refusal");
  return r.errors;
}

describe("goal translator (P3-U1, F-U7)", () => {
  it("translates the default goal: Balanced, Medium, core lane only, Light at 1.00 USDC a day, ask first", () => {
    const c = ok(DEFAULT_GOAL_INPUT);
    expect(c.aggressiveness).toBe("BALANCED");
    expect(c.envelope).toEqual(AGGRESSIVENESS_ENVELOPES.BALANCED);
    expect(c.brief).toContain("Hold large caps");
    expect(c.brief).toContain("has not opted into the screened lane");
    expect(c.brief).toContain("No token is excluded");
    expect(c.template).toEqual({
      id: "rebalance_bands@1",
      params: {
        targetWmonBps: 2_000,
        bandHalfWidthBps: 500,
        minTradeUsdcE6: 500_000n,
        volatilityBrakeBps: 20_000,
        costHurdleBps: 40,
        maxLegBps: 1_000,
      },
    });
    expect(c.targetRange).toEqual({ minBps: 0, maxBps: 3_000 });
    expect(c.researchTriggerBps).toBe(1_500);
    expect(c.ownerLimits).toEqual(hardGoalLimits());
    expect(c.research).toEqual({
      intensity: "LIGHT",
      scanEveryHours: 12,
      divesPerDay: 1,
      dailyBudgetUsdcE6: 1_000_000n,
      monthlyMaxUsdcE6: 30_000_000n,
    });
    expect(c.model).toEqual({ choice: "MEDIUM", alias: "research-medium" });
    expect(c.creditReserveUsdcE6).toBe(1_000_000n);
    expect(c.planChanges).toEqual({ mode: "ASK_FIRST", workflowMode: "require_approval" });
    expect(c.policyHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it.each(AGGRESSIVENESS_LEVELS)(
    "%s: the two-asset fallback sits inside rebalance_bands@1's bounds and the level's range (A-75)",
    (level) => {
      const c = ok(goal({ aggressiveness: level }));
      const f = BANDS_DEFAULTS[level];
      expect(checkTemplateParams(c.template.params)).toEqual([]);
      expect(c.template.params.targetWmonBps).toBe(f.defaultTargetBps);
      expect(c.template.params.bandHalfWidthBps).toBe(f.bandHalfWidthBps);
      expect(c.targetRange).toEqual({ minBps: f.targetMinBps, maxBps: f.targetMaxBps });
      expect(c.researchTriggerBps).toBe(AGGRESSIVENESS_ENVELOPES[level].reviewTriggerBps);
      expect(f.targetMaxBps).toBeLessThanOrEqual(LAUNCH_LIMITS.maxAssetBps);
      expect(c.envelope).toEqual(AGGRESSIVENESS_ENVELOPES[level]);
    },
  );

  it("maps each model tier to its alias, and Apply and tell me to notify", () => {
    expect(ok(goal({ modelTier: "LOW" })).model.alias).toBe("research-low");
    expect(ok(goal({ modelTier: "HIGH", planChanges: "APPLY_AND_TELL" })).model).toEqual({
      choice: "HIGH",
      alias: "research-high",
    });
    expect(ok(goal({ planChanges: "APPLY_AND_TELL" })).planChanges.workflowMode).toBe("notify");
  });

  it("writes the brief from the level, the screened-lane choice and the exclusions, never the owner's words", () => {
    const c = ok(
      goal({ aggressiveness: "AGGRESSIVE", screenedOptIn: true, excludedTokens: [WBTC] }),
    );
    expect(c.brief).toContain("Consider anything that passes the safety check");
    expect(c.brief).toContain("opted into the screened lane");
    expect(c.brief).toContain(`Never buy these tokens, whatever the research says: ${WBTC}.`);
    expect(briefOf(goal({ aggressiveness: "CONSERVATIVE" }))).toContain("class F tokens only");
    // Exclusions are kept lowercase and once each, so the hash does not depend on how they were typed.
    const upper = ok(goal({ excludedTokens: [WBTC.toUpperCase().replace("0X", "0x"), WBTC] }));
    expect(upper.goal.excludedTokens).toEqual([WBTC]);
    expect(upper.policyHash).toBe(ok(goal({ excludedTokens: [WBTC] })).policyHash);
  });

  describe("stricter limits only tighten the hard limits", () => {
    const ranges = ownerLimitRanges();
    const hard = hardGoalLimits();

    it.each(OWNER_LIMIT_FIELDS)("%s: at the hard limit passes, one step looser is refused", (f) => {
      const looser = OWNER_LIMIT_FACTS[f].direction === "max" ? hard[f] + 1 : hard[f] - 1;
      expect(ok(withLimit(f, hard[f])).ownerLimits[f]).toBe(hard[f]);
      const errors = refused(withLimit(f, looser));
      expect(errors).toEqual([
        expect.objectContaining({ field: `stricterLimits.${f}`, code: "LOOSER_THAN_HARD_LIMIT" }),
      ]);
    });

    it.each(OWNER_LIMIT_FIELDS)(
      "%s: inside the bound applies; past the tightest is refused",
      (f) => {
        const facts = OWNER_LIMIT_FACTS[f];
        const inside = facts.direction === "max" ? hard[f] - 1 : hard[f] + 1;
        expect(ok(withLimit(f, inside)).ownerLimits[f]).toBe(inside);
        expect(ok(withLimit(f, facts.tightest)).ownerLimits[f]).toBe(facts.tightest);
        const past = facts.direction === "max" ? facts.tightest - 1 : facts.tightest + 1;
        if (past < 0) return; // 0 is the tightest for a share; a negative is refused as a field
        expect(refused(withLimit(f, past))).toEqual([
          expect.objectContaining({ field: `stricterLimits.${f}`, code: "TIGHTER_THAN_ALLOWED" }),
        ]);
      },
    );

    it("gives each limit's range from its tightest value to its hard limit", () => {
      expect(ranges).toEqual({
        maxTradeBps: { min: 10, max: 1_000 },
        maxPositionBps: { min: 0, max: 4_000 },
        minUsdcShareBps: { min: 1_000, max: 10_000 },
        maxSlippageBps: { min: 10, max: 50 },
        maxTradesPer24h: { min: 1, max: 20 },
      });
    });

    it("narrows the fallback's range and parameters to the owner's limits", () => {
      const c = ok(
        goal({
          aggressiveness: "AGGRESSIVE",
          stricterLimits: {
            maxTradeBps: 400,
            maxPositionBps: 2_500,
            minUsdcShareBps: 8_000,
            maxSlippageBps: 30,
            maxTradesPer24h: 6,
          },
        }),
      );
      // Aggressive's 30% default and 40% range, under at most 25% in one token and at least 80% USDC.
      expect(c.targetRange).toEqual({ minBps: 0, maxBps: 2_000 });
      expect(c.template.params.targetWmonBps).toBe(2_000);
      expect(c.template.params.maxLegBps).toBe(400);
      expect(c.template.params.costHurdleBps).toBe(30);
      expect(c.ownerLimits).toEqual({
        maxTradeBps: 400,
        maxPositionBps: 2_500,
        minUsdcShareBps: 8_000,
        maxSlippageBps: 30,
        maxTradesPer24h: 6,
      });
    });

    it("names every refused limit at once", () => {
      const errors = refused(
        goal({
          stricterLimits: {
            maxTradeBps: 1_001,
            maxPositionBps: 4_001,
            minUsdcShareBps: 999,
            maxSlippageBps: 51,
            maxTradesPer24h: 21,
          },
        }),
      );
      expect(errors.map((e) => e.field)).toEqual(
        OWNER_LIMIT_FIELDS.map((f) => `stricterLimits.${f}`),
      );
      expect(new Set(errors.map((e) => e.code))).toEqual(new Set(["LOOSER_THAN_HARD_LIMIT"]));
      expect(errors[0]?.message).toBe(
        "Largest trade can only tighten the hard limit of 10%; 10.01% would loosen it.",
      );
    });
  });

  describe("every field is validated", () => {
    it("refuses free text and unknown fields at every level", () => {
      expect(refused({ ...goal(), note: "buy the dip" })).toEqual([
        expect.objectContaining({
          field: "goal",
          code: "INVALID_FIELD",
          message: "Unknown field: note.",
        }),
      ]);
      expect(
        refused({ ...goal(), research: { ...goal().research, prompt: "be bold" } })[0],
      ).toMatchObject({ field: "research", code: "INVALID_FIELD" });
      expect(
        refused({ ...goal(), stricterLimits: { ...goal().stricterLimits, maxLeverage: 2 } })[0],
      ).toMatchObject({ field: "stricterLimits", code: "INVALID_FIELD" });
      // The old fields are gone: a goal in the old shape is refused, never read as free text.
      expect(
        refused({ ...goal(), template: "rebalance_bands@1", riskPreset: "GROWTH" })[0],
      ).toMatchObject({
        field: "goal",
        code: "INVALID_FIELD",
      });
    });

    it.each([
      ["aggressiveness", "YOLO"],
      ["modelTier", "claude-fable-5-1"],
      ["planChanges", "NEVER"],
      ["screenedOptIn", "yes"],
      ["excludedTokens", ["WBTC"]],
    ])("refuses %s = %j", (field, value) => {
      expect(refused({ ...goal(), [field]: value })[0]?.field).toMatch(new RegExp(`^${field}`));
    });

    it("refuses a missing field", () => {
      const rest: Record<string, unknown> = { ...goal() };
      delete rest.planChanges;
      expect(refused(rest)[0]).toMatchObject({ field: "planChanges", code: "INVALID_FIELD" });
    });

    it("refuses a stricter limit that is not a whole number", () => {
      expect(refused(withLimit("maxTradeBps", 12.5))[0]).toMatchObject({
        field: "stricterLimits.maxTradeBps",
        code: "INVALID_FIELD",
      });
      expect(refused(withLimit("maxTradesPer24h", -1))[0]?.code).toBe("INVALID_FIELD");
    });

    it.each(RESEARCH_INTENSITIES)(
      "%s: the daily budget passes at both ends of its range only",
      (i) => {
        const f = RESEARCH_INTENSITY_FACTS[i];
        const at = (e6: bigint) =>
          goal({ research: { intensity: i, dailyBudgetUsdcE6: e6.toString() } });
        expect(ok(at(f.minDailyBudgetUsdcE6)).research.dailyBudgetUsdcE6).toBe(
          f.minDailyBudgetUsdcE6,
        );
        expect(ok(at(f.maxDailyBudgetUsdcE6)).research.monthlyMaxUsdcE6).toBe(
          f.maxDailyBudgetUsdcE6 * 30n,
        );
        for (const e6 of [f.minDailyBudgetUsdcE6 - 1n, f.maxDailyBudgetUsdcE6 + 1n])
          expect(refused(at(e6))).toEqual([
            expect.objectContaining({
              field: "research.dailyBudgetUsdcE6",
              code: "BUDGET_OUT_OF_RANGE",
            }),
          ]);
      },
    );

    it("refuses an amount that is not whole base units", () => {
      for (const v of ["1.5", "-1", "01", "", "1e6", "9999999999999999"])
        expect(
          refused(goal({ research: { intensity: "LIGHT", dailyBudgetUsdcE6: v } }))[0]?.code,
        ).toBe("INVALID_FIELD");
    });

    it("takes a credit reserve from 0 to 20 USDC", () => {
      expect(ok(goal({ creditReserveUsdcE6: "0" })).creditReserveUsdcE6).toBe(0n);
      expect(ok(goal({ creditReserveUsdcE6: "20000000" })).creditReserveUsdcE6).toBe(20_000_000n);
      expect(refused(goal({ creditReserveUsdcE6: "20000001" }))).toEqual([
        expect.objectContaining({ field: "creditReserveUsdcE6", code: "RESERVE_OUT_OF_RANGE" }),
      ]);
    });
  });

  describe("policy hash", () => {
    it("is stable across runs and key orders", () => {
      const a = ok(goal());
      const reordered = Object.fromEntries(Object.entries(goal()).reverse());
      expect(ok(reordered).policyHash).toBe(a.policyHash);
      expect(ok(structuredClone(goal())).policyHash).toBe(a.policyHash);
    });

    it("changes with any field", () => {
      const base = ok(goal()).policyHash;
      const variants: GoalInput[] = [
        goal({ aggressiveness: "AGGRESSIVE" }),
        goal({ aggressiveness: "CONSERVATIVE" }),
        goal({ screenedOptIn: true }),
        goal({ excludedTokens: [WBTC] }),
        withLimit("maxTradeBps", 999),
        withLimit("maxPositionBps", 3_999),
        withLimit("minUsdcShareBps", 1_001),
        withLimit("maxSlippageBps", 49),
        withLimit("maxTradesPer24h", 19),
        goal({ modelTier: "HIGH" }),
        goal({ modelTier: "LOW" }),
        goal({ research: { intensity: "LIGHT", dailyBudgetUsdcE6: "1000001" } }),
        goal({ research: { intensity: "STANDARD", dailyBudgetUsdcE6: "1000000" } }),
        goal({ creditReserveUsdcE6: "1000001" }),
        goal({ planChanges: "APPLY_AND_TELL" }),
      ];
      const hashes = variants.map((v) => ok(v).policyHash);
      expect(new Set([base, ...hashes]).size).toBe(variants.length + 1);
    });

    it("refuses integer-like keys and sorts the rest", () => {
      expect(canonicalJson({ b: 1n, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":"1"}');
      expect(() => canonicalJson({ "1": "a" })).toThrow(/integer-like key/);
    });
  });

  it("renders the SOUL.md goal block from the configuration only: the brief, the envelope and the limits", () => {
    const c = ok(withLimit("maxTradesPer24h", 6));
    expect(c.soulBlock).toContain(
      "## Goal (set by the owner through the goal form; authoritative)",
    );
    expect(c.soulBlock).toContain("- Aggressiveness: Balanced");
    expect(c.soulBlock).toContain(`- Brief: ${c.brief}`);
    expect(c.soulBlock).toContain(
      "- Envelope the Test enforces on a target portfolio: at most 8 positions, at most 45% in any one, at least 15% in stablecoins, class A at most 8% each and 25% together",
    );
    expect(c.soulBlock).toContain("at most 6 trades in 24 hours");
    expect(c.soulBlock).toContain(
      "- Two-asset fallback: rebalance_bands@1, target WMON 20% within 0% to 30%",
    );
    expect(c.soulBlock).toContain("- Model tier: Medium (research-medium)");
    expect(c.soulBlock).toContain("at most 1.00 USDC a day");
    expect(c.soulBlock).toContain(`- Policy hash: ${c.policyHash}`);
    expect(ok(goal({ aggressiveness: "CONSERVATIVE" })).soulBlock).toContain("class F tokens only");
  });

  it("previews a month at each intensity's default budget (D-299)", () => {
    expect(costPreview().map((p) => [p.intensity, p.monthlyMaxUsdcE6])).toEqual([
      ["LIGHT", 30_000_000n],
      ["STANDARD", 75_000_000n],
      ["DEEP", 180_000_000n],
    ]);
  });

  it("keeps the template's bounds inside the hard limits", () => {
    expect(REBALANCE_BANDS_V1_BOUNDS.targetWmonBps[1]).toBe(BigInt(LAUNCH_LIMITS.maxAssetBps));
    expect(REBALANCE_BANDS_V1_BOUNDS.maxLegBps[1]).toBe(BigInt(LAUNCH_LIMITS.maxTradeBps));
    expect(REBALANCE_BANDS_V1_BOUNDS.costHurdleBps[1]).toBe(BigInt(LAUNCH_LIMITS.maxSlippageBps));
  });
});
