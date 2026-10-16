import { describe, expect, it } from "vitest";
import type { ResearchJson } from "@/api/client";
import { refusedShort, shortNotice, stoppedShort, stoppedShortText } from "./research-short";

type Cycle = ResearchJson["cycles"][number];

const cycle = (over: Partial<Cycle> = {}): Cycle => ({
  cycleId: "cycle-1",
  kind: "ACTIVATION",
  status: "stopped",
  startedAt: null,
  finishedAt: "2026-10-16T17:50:52.990Z",
  chargedUsdcE6: "0",
  stopReason: "CREDITS_SHORT",
  stages: [
    {
      stage: "SCAN",
      themeCode: null,
      status: "skipped",
      stopReason: "CREDITS_SHORT",
      chargedUsdcE6: "0",
      ceilingUsdcE6: "450000",
    },
  ],
  ...over,
});

const research = {
  credits: { availableUsdcE6: "169892", runNeedsUsdcE6: "2350000" },
  budget: {
    dailyBudgetUsdcE6: "1000000",
    usedTodayUsdcE6: "1000000",
    divesPerDay: 1,
    divesToday: 1,
  },
} as unknown as ResearchJson;

describe("research stopped short (2026-10-16)", () => {
  it("names the reason and the stage a run stopped before, and Activity says so", () => {
    expect(stoppedShort(cycle())).toEqual({ reason: "CREDITS_SHORT", stage: "SCAN" });
    expect(stoppedShortText(cycle())).toBe("stopped at Scan: not enough credits");
    const budget = cycle({
      stopReason: "BUDGET_SHORT",
      stages: [
        {
          stage: "SCAN",
          themeCode: null,
          status: "completed",
          chargedUsdcE6: "400000",
          ceilingUsdcE6: "450000",
        },
        {
          stage: "DIVE",
          themeCode: "x",
          status: "skipped",
          stopReason: "BUDGET_SHORT",
          chargedUsdcE6: "0",
          ceilingUsdcE6: "450000",
        },
      ],
    });
    expect(stoppedShortText(budget)).toBe("stopped at Dive: research budget used up");
    expect(shortNotice(research, budget)).toEqual({
      reason: "BUDGET_SHORT",
      usedUsdcE6: "1000000",
      budgetUsdcE6: "1000000",
      stage: "DIVE",
    });
    expect(shortNotice(research, cycle())).toEqual({
      reason: "CREDITS_SHORT",
      availableUsdcE6: "169892",
      neededUsdcE6: "2350000",
      stage: "SCAN",
    });
  });

  it("is quiet for any other end, and for a server without stop reasons", () => {
    expect(
      stoppedShort(cycle({ status: "completed", stopReason: "COMPLETED", stages: [] })),
    ).toBeNull();
    const old: Cycle = { ...cycle({ stages: [] }) };
    delete (old as { stopReason?: string | null }).stopReason;
    expect(stoppedShort(old)).toBeNull();
    expect(shortNotice(research, null)).toBeNull();
  });

  it("turns a Research now refused for credits into the notice, before any run", () => {
    expect(
      refusedShort("credits_short", { availableUsdcE6: "169892", neededUsdcE6: "2350000" }, null),
    ).toEqual({
      reason: "CREDITS_SHORT",
      availableUsdcE6: "169892",
      neededUsdcE6: "2350000",
      stage: null,
    });
    expect(refusedShort("credits_exhausted", {}, research)).toEqual({
      reason: "CREDITS_SHORT",
      availableUsdcE6: "0",
      neededUsdcE6: "2350000",
      stage: null,
    });
    expect(refusedShort("cycle_open", {}, research)).toBeNull();
  });
});
