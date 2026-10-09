import { describe, expect, it } from "vitest";
import { cycleLeaseMs, cyclePlan } from "./cycle.ts";
import {
  chargeWithinCeiling,
  cycleEnvelope,
  divesFor,
  stageCaps,
  stageCeilingUsdcE6,
  stageMayStart,
  stageModel,
  utcDayStart,
} from "./stages.ts";

describe("stage rules (P3-U4)", () => {
  it("routes the Scan to the cheap model and the other model stages to the goal's reasoning model", () => {
    expect(stageModel("SCAN", "research-strong")).toBe("scan-cheap");
    expect(stageModel("SCAN", "research-deep")).toBe("scan-cheap");
    for (const s of ["DIVE", "CHALLENGE", "ZOOM_OUT"] as const) {
      expect(stageModel(s, "research-strong")).toBe("research-strong");
      expect(stageModel(s, "research-deep")).toBe("research-deep");
    }
    expect(stageModel("TEST", "research-deep")).toBeNull();
  });

  it("caps each stage as A-51 sets them, with the wide Scan for an activation", () => {
    expect(stageCaps("SCAN", "ROUTINE")).toMatchObject({ turns: 10, paidCalls: 5, seconds: 300 });
    expect(stageCaps("SCAN", "ACTIVATION")).toMatchObject({
      turns: 16,
      paidCalls: 10,
      seconds: 480,
    });
    expect(stageCaps("DIVE", "ROUTINE")).toMatchObject({ turns: 16, paidCalls: 8, seconds: 600 });
    expect(stageCaps("CHALLENGE", "ROUTINE")).toMatchObject({
      turns: 6,
      paidCalls: 2,
      seconds: 240,
    });
    expect(stageCaps("ZOOM_OUT", "ROUTINE")).toMatchObject({
      turns: 10,
      paidCalls: 2,
      seconds: 360,
    });
    expect(stageCaps("TEST", "ROUTINE")).toEqual({ turns: 0, paidCalls: 0, tokens: 0, seconds: 0 });
    // Hermes takes turns and time only from config: the cycle's is its largest stage's.
    expect(cycleEnvelope("ROUTINE")).toEqual({ maxTurns: 16, runBudgetSeconds: 600 });
  });

  it("sets ceilings per stage, doubling the reasoning stages on Opus 5.5, and the Test is free", () => {
    const usdc = (n: number) => BigInt(Math.round(n * 1e6));
    expect(stageCeilingUsdcE6("SCAN", "ROUTINE", "research-deep")).toBe(usdc(0.3));
    expect(stageCeilingUsdcE6("SCAN", "ACTIVATION", "research-strong")).toBe(usdc(0.5));
    expect(stageCeilingUsdcE6("DIVE", "ROUTINE", "research-strong")).toBe(usdc(1.2));
    expect(stageCeilingUsdcE6("DIVE", "ROUTINE", "research-deep")).toBe(usdc(2.4));
    expect(stageCeilingUsdcE6("CHALLENGE", "ROUTINE", "research-deep")).toBe(usdc(0.6));
    expect(stageCeilingUsdcE6("ZOOM_OUT", "ROUTINE", "research-strong")).toBe(usdc(0.6));
    expect(stageCeilingUsdcE6("TEST", "ACTIVATION", "research-deep")).toBe(0n);
    // The sweep's ceiling as BUILD_PLAN states it: 3.80 USDC with Sonnet 5.5, 7.10 with Opus 5.5.
    expect(cyclePlan("ACTIVATION", "research-strong", 0).maxUsdcE6).toBe("3800000");
    expect(cyclePlan("ACTIVATION", "research-deep", 0).maxUsdcE6).toBe("7100000");
    expect(cycleLeaseMs("ROUTINE", 1)).toBe((5 + 10 + 4 + 6 + 15) * 60_000);
  });

  it("Dives on high themes and medium ones not dived in 48 hours, up to the day's Dives", () => {
    const themes = [
      { code: "LOW_ONE", materiality: "low" as const, asset: "WMON" as const },
      { code: "MED_FRESH", materiality: "medium" as const, asset: "WMON" as const },
      { code: "MED_SEEN", materiality: "medium" as const, asset: "USDC" as const },
      { code: "HIGH_ONE", materiality: "high" as const, asset: "WMON" as const },
    ];
    const routine = (divesPerDay: number, divesToday: number) =>
      divesFor({
        kind: "ROUTINE",
        themes,
        divesPerDay,
        divesToday,
        recentlyDived: ["MED_SEEN"],
      }).map((t) => t.code);
    expect(routine(4, 0)).toEqual(["HIGH_ONE", "MED_FRESH"]);
    expect(routine(1, 0)).toEqual(["HIGH_ONE"]);
    expect(routine(2, 2)).toEqual([]);
    // A quiet Scan earns no Dive: the routine cycle may stop there.
    expect(
      divesFor({
        kind: "ROUTINE",
        themes: themes.slice(0, 1),
        divesPerDay: 4,
        divesToday: 0,
        recentlyDived: [],
      }),
    ).toEqual([]);
    // The sweep Dives on its two most material themes whatever their level or the day's count.
    expect(
      divesFor({
        kind: "ACTIVATION",
        themes,
        divesPerDay: 1,
        divesToday: 1,
        recentlyDived: ["MED_SEEN"],
      }).map((t) => t.code),
    ).toEqual(["HIGH_ONE", "MED_FRESH"]);
  });

  it("starts a stage only when the day's budget and the credits above the reserve cover its whole ceiling", () => {
    const base = {
      ceilingUsdcE6: 1_200_000n,
      dailyBudgetUsdcE6: 2_500_000n,
      usedTodayUsdcE6: 1_000_000n,
      spendableUsdcE6: 5_000_000n,
      creditReserveUsdcE6: 1_000_000n,
    };
    expect(stageMayStart(base)).toEqual({ ok: true });
    expect(stageMayStart({ ...base, usedTodayUsdcE6: 1_400_000n })).toMatchObject({
      ok: false,
      code: "BUDGET_SHORT",
    });
    expect(stageMayStart({ ...base, spendableUsdcE6: 2_100_000n })).toMatchObject({
      ok: false,
      code: "CREDITS_SHORT",
    });
    expect(stageMayStart({ ...base, spendableUsdcE6: 2_200_000n })).toEqual({ ok: true });
    // A free stage (the Test) always may.
    expect(stageMayStart({ ...base, ceilingUsdcE6: 0n, spendableUsdcE6: 0n })).toEqual({
      ok: true,
    });
    const refused = stageMayStart({ ...base, usedTodayUsdcE6: 2_000_000n });
    expect(refused.ok ? "" : refused.message).toContain("0.5 USDC left of 2.5 USDC");
  });

  it("never charges a stage above its ceiling: the platform absorbs the rest", () => {
    expect(chargeWithinCeiling(100n, 0n, 300n)).toEqual({ charged: 100n, absorbed: 0n });
    expect(chargeWithinCeiling(100n, 250n, 300n)).toEqual({ charged: 50n, absorbed: 50n });
    expect(chargeWithinCeiling(100n, 300n, 300n)).toEqual({ charged: 0n, absorbed: 100n });
    expect(chargeWithinCeiling(100n, 400n, 300n)).toEqual({ charged: 0n, absorbed: 100n });
  });

  it("counts the research budget per UTC day", () => {
    expect(utcDayStart(new Date("2026-10-09T23:59:59.000Z")).toISOString()).toBe(
      "2026-10-09T00:00:00.000Z",
    );
  });
});
