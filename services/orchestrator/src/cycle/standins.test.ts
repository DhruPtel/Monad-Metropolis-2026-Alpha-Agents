import { describe, expect, it } from "vitest";
import {
  type PickCall,
  type PickPosition,
  mapToStandIns,
  standInOrder,
  testnetInvestedRange,
} from "./standins.ts";

const WMON = "0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541";
const TALPHA = "0xd4eb3fef2a9ebe27d59d4188b6d20bb21220c03c";
const TBETA = "0x57ca16ca75e968bd3ff712c729e6e5f6940cc010";
const USDC = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const WETH = "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242";
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const AUSD = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";
const SOL = "0xea17e5a9efebf1477db45082d67010e2245217f1";

const STAND_INS = [
  { token: WMON, symbol: "WMON", capBps: 4_000 },
  { token: TALPHA, symbol: "TALPHA", capBps: 4_000 },
  { token: TBETA, symbol: "TBETA", capBps: 4_000 },
];
const pick = (token: string, w: number, thesisId = "t"): PickPosition => ({
  token,
  targetWeightBps: w,
  bandBps: 300,
  thesisId,
  exit: { killCriterion: "the thesis breaks", recheckAt: "2026-10-23T00:00:00Z" },
});
const call = (token: string, symbol: string, conviction: number): PickCall => ({
  token,
  symbol,
  action: "ADD",
  themeCode: `theme-${symbol}`,
  reason: `${symbol} from the research`,
  conviction,
});
const weights = (m: ReturnType<typeof mapToStandIns>) =>
  Object.fromEntries(m.positions.map((p) => [p.token, p.targetWeightBps]));

describe("the testnet stand-in mapping (2026-10-16)", () => {
  it("orders the stand-ins: the wrapped native, then the others by symbol, never a stablecoin", () => {
    const order = standInOrder(
      [
        { token: TBETA, symbol: "TBETA", capBps: 4_000, buyable: true },
        { token: USDC, symbol: "USDC", capBps: 10_000, buyable: true },
        { token: TALPHA, symbol: "TALPHA", capBps: 4_000, buyable: true },
        { token: WMON, symbol: "WMON", capBps: 4_000, buyable: true },
        { token: SOL, symbol: "SOL", capBps: 4_000, buyable: false },
      ],
      WMON,
      (s) => s === "USDC",
    );
    expect(order.map((s) => s.symbol)).toEqual(["WMON", "TALPHA", "TBETA"]);
  });

  it("maps picks by conviction, keeps each weight, and says how each executes", () => {
    const m = mapToStandIns({
      level: "AGGRESSIVE",
      picks: [pick(WBTC, 3_000), pick(WETH, 4_000), pick(AUSD, 2_500)],
      calls: [call(WBTC, "WBTC", 70), call(WETH, "WETH", 85), call(AUSD, "SOL", 60)],
      standIns: STAND_INS,
      current: [],
      symbols: {},
    });
    expect(weights(m)).toEqual({ [WMON]: 4_000, [TALPHA]: 3_000, [TBETA]: 2_500 });
    expect(m.cashTargetBps).toBe(500);
    expect(m.lines).toEqual([
      "WETH 40%, executes as WMON on testnet",
      "WBTC 30%, executes as TALPHA on testnet",
      "SOL 25%, executes as TBETA on testnet",
    ]);
    expect(m.calls.map((c) => [c.symbol, c.action, c.conviction, c.standInFor?.symbol])).toEqual([
      ["WMON", "ADD", 85, "WETH"],
      ["TALPHA", "ADD", 70, "WBTC"],
      ["TBETA", "ADD", 60, "SOL"],
    ]);
    expect(m.notProposed.map((n) => n.symbol)).toEqual(["WETH", "WBTC", "SOL"]);
  });

  it("never invests below the floor on testnet: an Aggressive 20% becomes at least 90%, by conviction then the next stand-in", () => {
    expect(testnetInvestedRange("AGGRESSIVE")).toEqual({ min: 9_000, max: 9_500 });
    // The reported case: 20% WMON kept on an Aggressive goal.
    const kept = mapToStandIns({
      level: "AGGRESSIVE",
      picks: [pick(WMON, 2_000)],
      calls: [call(WMON, "WMON", 55)],
      standIns: STAND_INS,
      current: [{ token: WMON, targetWeightBps: 2_000 }],
      symbols: { [TALPHA]: "TALPHA", [TBETA]: "TBETA" },
    });
    expect(weights(kept)).toEqual({ [WMON]: 4_000, [TALPHA]: 2_500, [TBETA]: 2_500 });
    expect(kept.cashTargetBps).toBe(1_000);
    expect(kept.calls.map((c) => [c.symbol, c.action])).toEqual([
      ["WMON", "ADD"],
      ["TALPHA", "ADD"],
      ["TBETA", "ADD"],
    ]);
    // Two picks: the top pick fills to its cap, the next by conviction, the rest the next stand-in.
    const two = mapToStandIns({
      level: "AGGRESSIVE",
      picks: [pick(WETH, 2_000), pick(WBTC, 1_000)],
      calls: [call(WETH, "WETH", 80), call(WBTC, "WBTC", 40)],
      standIns: STAND_INS,
      current: [],
      symbols: { [TBETA]: "TBETA" },
    });
    expect(weights(two)).toEqual({ [WMON]: 4_000, [TALPHA]: 4_000, [TBETA]: 1_000 });
    expect(two.cashTargetBps).toBe(1_000);
    expect(two.calls.find((c) => c.token === TBETA)).toMatchObject({
      standInFor: null,
      conviction: null,
      reason: "Fills the goal's invested range on testnet; it carries no pick of its own.",
    });
    // A Balanced plan only lifts to its range's floor.
    const balanced = mapToStandIns({
      level: "BALANCED",
      picks: [pick(WETH, 1_000)],
      calls: [call(WETH, "WETH", 80)],
      standIns: STAND_INS,
      current: [],
      symbols: {},
    });
    expect(balanced.cashTargetBps).toBe(6_000);
  });

  it("caps each stand-in, trims the lowest conviction past the range's top, and lets an extra pick's weight go to the others", () => {
    const m = mapToStandIns({
      level: "AGGRESSIVE",
      picks: [pick(WETH, 6_000), pick(WBTC, 3_500), pick(SOL, 3_000), pick(AUSD, 1_000)],
      calls: [
        call(WETH, "WETH", 90),
        call(WBTC, "WBTC", 70),
        call(SOL, "SOL", 50),
        call(AUSD, "AUSD", 30),
      ],
      standIns: STAND_INS,
      current: [],
      symbols: {},
    });
    // WETH capped at 40%; 40 + 35 + 30 = 105% is past 95%, so SOL gives 10 points back.
    expect(weights(m)).toEqual({ [WMON]: 4_000, [TALPHA]: 3_500, [TBETA]: 2_000 });
    expect(m.cashTargetBps).toBe(500);
    expect(m.notProposed.find((n) => n.symbol === "AUSD")?.reason).toMatch(/No tradable stand-in/);
  });

  it("keeps a stand-in the model picked on its own token, and fills from a held stand-in no pick maps to", () => {
    const m = mapToStandIns({
      level: "AGGRESSIVE",
      picks: [pick(TBETA, 3_000), pick(WETH, 4_000)],
      calls: [call(TBETA, "TBETA", 50), call(WETH, "WETH", 80)],
      standIns: STAND_INS,
      current: [
        { token: TALPHA, targetWeightBps: 3_000 },
        { token: TBETA, targetWeightBps: 3_000 },
      ],
      symbols: { [TALPHA]: "TALPHA" },
    });
    // WETH takes WMON; TBETA stays TBETA and fills to its cap; the last 10 points go to TALPHA.
    expect(weights(m)).toEqual({ [WMON]: 4_000, [TALPHA]: 1_000, [TBETA]: 4_000 });
    expect(m.calls.find((c) => c.token === TBETA)).toMatchObject({
      standInFor: null,
      action: "ADD",
    });
    expect(m.calls.find((c) => c.token === TALPHA)).toMatchObject({
      action: "TRIM",
      standInFor: null,
    });
  });

  it("exits a held stand-in the plan no longer needs", () => {
    const m = mapToStandIns({
      level: "AGGRESSIVE",
      picks: [pick(WETH, 4_000), pick(WBTC, 4_000), pick(SOL, 1_000)],
      calls: [call(WETH, "WETH", 80), call(WBTC, "WBTC", 70), call(SOL, "SOL", 60)],
      standIns: STAND_INS.slice(0, 3),
      current: [{ token: "0x1111111111111111111111111111111111111111", targetWeightBps: 2_000 }],
      symbols: { "0x1111111111111111111111111111111111111111": "OLD" },
    });
    expect(m.calls.find((c) => c.symbol === "OLD")).toMatchObject({ action: "EXIT" });
  });

  it("writes symbols, never addresses, wherever a call names a token", () => {
    const m = mapToStandIns({
      level: "AGGRESSIVE",
      picks: [pick(WETH, 9_000)],
      calls: [call(WETH, "WETH", 80)],
      standIns: STAND_INS,
      current: [],
      symbols: { [TALPHA]: "TALPHA", [TBETA]: "TBETA" },
    });
    for (const c of m.calls) expect(c.symbol).not.toMatch(/^0x/);
    for (const n of m.notProposed) expect(n.symbol).not.toMatch(/^0x/);
    expect(m.lines.join(" ")).not.toMatch(/0x/);
  });
});
