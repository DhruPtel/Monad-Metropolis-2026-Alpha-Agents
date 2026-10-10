import type { ZoomOutDecision } from "@alpha-agents/platform-tools";
import { describe, expect, it } from "vitest";
import { rationaleFindings } from "./rationale.ts";

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
