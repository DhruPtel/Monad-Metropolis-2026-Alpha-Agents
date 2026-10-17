import type { ZoomOutDecision } from "@alpha-agents/platform-tools";
import { describe, expect, it } from "vitest";
import { allocationFindings, planShapeFindings, rationaleFindings } from "./rationale.ts";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const shared = { minTradeUsdc: "1", volatilityBrakeBps: 20_000, costHurdleBps: 40, maxLegBps: 900 };
const position = (token: string, targetWeightBps: number) => ({
  token,
  targetWeightBps,
  bandBps: 300,
  thesisId: "T",
  exit: { killCriterion: "k", recheckAt: "2026-11-01" },
});
const propose = (positions: { token: string; targetWeightBps: number }[]): ZoomOutDecision => ({
  kind: "PROPOSE",
  template: "target_portfolio@1",
  params: {
    positions: positions.map((p) => position(p.token, p.targetWeightBps)),
    cashTargetBps: 5_000,
    ...shared,
  },
});
const current = [
  { token: A, targetWeightBps: 2_000 },
  { token: B, targetWeightBps: 1_500 },
];
const call = (token: string, symbol: string, action: "ADD" | "HOLD" | "TRIM" | "EXIT") => ({
  token,
  symbol,
  action,
});

describe("the Zoom out's position calls against its decision (F-U8)", () => {
  it("accepts calls that match the draft and the plan in force, whatever the address case", () => {
    const decision = propose([
      { token: A.toUpperCase().replace("0X", "0x"), targetWeightBps: 2_500 },
      { token: C, targetWeightBps: 1_000 },
    ]);
    expect(
      rationaleFindings({
        positions: [call(A, "AAA", "ADD"), call(B, "BBB", "EXIT"), call(C, "CCC", "ADD")],
        decision,
        current,
      }),
    ).toEqual([]);
    expect(
      rationaleFindings({
        positions: [call(A, "AAA", "HOLD"), call(B, "BBB", "TRIM")],
        decision: propose([
          { token: A, targetWeightBps: 2_000 },
          { token: B, targetWeightBps: 1_000 },
        ]),
        current,
      }),
    ).toEqual([]);
  });

  it("names every call that does not match: a hold that moves, a trim that leaves, an exit still in, a missing call", () => {
    const decision = propose([
      { token: A, targetWeightBps: 2_500 },
      { token: C, targetWeightBps: 1_000 },
    ]);
    expect(
      rationaleFindings({
        positions: [call(A, "AAA", "HOLD"), call(B, "BBB", "TRIM"), call(C, "CCC", "EXIT")],
        decision,
        current,
      }),
    ).toEqual([
      `AAA (${A}) is called HOLD but its weight changes (2000 to 2500 bps)`,
      `BBB (${B}) is called TRIM but is not in the proposal (an EXIT?)`,
      `CCC (${C}) is called EXIT but is still in the proposal`,
    ]);
    expect(rationaleFindings({ positions: [call(A, "AAA", "ADD")], decision, current })).toEqual([
      `${C} is in the proposal without a call in the RATIONALE`,
      `${B} leaves the plan without an EXIT call in the RATIONALE`,
    ]);
    expect(
      rationaleFindings({
        positions: [call(A, "AAA", "TRIM"), call(B, "BBB", "EXIT"), call(C, "CCC", "HOLD")],
        decision,
        current,
      }),
    ).toEqual([
      `AAA (${A}) is called TRIM but its weight does not fall (2000 to 2500 bps)`,
      `CCC (${C}) is called HOLD but is new to the plan (an ADD?)`,
    ]);
  });

  it("asks for no calls on a NO_CHANGE decision or a two-asset proposal", () => {
    expect(
      rationaleFindings({
        positions: [call(A, "AAA", "HOLD")],
        decision: { kind: "NO_CHANGE", reasonCode: "EVIDENCE_THIN" },
        current,
      }),
    ).toEqual([]);
    const bands: ZoomOutDecision = {
      kind: "PROPOSE",
      template: "rebalance_bands@1",
      params: { targetWmonBps: 2_000, bandHalfWidthBps: 500, ...shared },
    };
    expect(rationaleFindings({ positions: [], decision: bands, current: [] })).toEqual([]);
    expect(
      rationaleFindings({ positions: [call(A, "AAA", "ADD")], decision: bands, current: [] }),
    ).toEqual([
      "position calls belong to a target portfolio; a rebalance_bands@1 proposal has none",
    ]);
  });
});

describe("the agent's own allocation and cash, each with its reason (2026-10-16)", () => {
  it("asks for why this allocation and why this much cash, whatever the share invested", () => {
    expect(allocationFindings({ allocationNote: null, cashNote: null })).toEqual([
      "say why this allocation in the RATIONALE's allocationNote: why these positions at these weights, from the research",
      "say why this much cash in the RATIONALE's cashNote, from the research",
    ]);
    expect(
      allocationFindings({
        allocationNote: "WETH carries the strongest thesis, so it takes the most weight.",
        cashNote: "  ",
      }),
    ).toEqual(["say why this much cash in the RATIONALE's cashNote, from the research"]);
    expect(
      allocationFindings({
        allocationNote: "One thesis stands; the second weakened to half its weight.",
        cashNote: "The market read is risk-off, so 70% waits in USDC for a better entry.",
      }),
    ).toEqual([]);
  });
});

describe("a plan is a decision (2026-10-17)", () => {
  const pos = (weights: number[]) =>
    weights.map((targetWeightBps, i) => ({
      token: `0x${String(i).padStart(40, "0")}`,
      targetWeightBps,
    }));
  it("refuses every position at the same weight, but not one position or a ranked set", () => {
    const equal = planShapeFindings({
      positions: pos([2_500, 2_500, 2_500]),
      repeatsCurrent: false,
      allocationNote: "Three ideas.",
      portfolioView: "Spread.",
    });
    expect(equal).toHaveLength(1);
    expect(equal[0]).toContain("every position has the same weight (2500 bps)");
    expect(
      planShapeFindings({
        positions: pos([4_000, 2_500, 1_500]),
        repeatsCurrent: false,
        allocationNote: "Ranked by expected return times confidence.",
        portfolioView: "x",
      }),
    ).toEqual([]);
    expect(
      planShapeFindings({
        positions: pos([2_000]),
        repeatsCurrent: false,
        allocationNote: "One.",
        portfolioView: "x",
      }),
    ).toEqual([]);
  });
  it("refuses a repeat of the plan in force unless the allocation note says why it is kept", () => {
    const base = { positions: pos([4_000, 2_000]), repeatsCurrent: true, portfolioView: "x" };
    const silent = planShapeFindings({ ...base, allocationNote: "WETH leads on expected return." });
    expect(silent).toHaveLength(1);
    expect(silent[0]).toContain("repeats the plan the runner follows");
    expect(
      planShapeFindings({
        ...base,
        allocationNote: "The research leads to the same allocation again: WETH still ranks first.",
      }),
    ).toEqual([]);
    expect(
      planShapeFindings({
        ...base,
        allocationNote: "x",
        portfolioView: "Nothing changed; the plan is kept.",
      }),
    ).toEqual([]);
  });
});
