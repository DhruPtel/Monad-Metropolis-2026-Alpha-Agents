import { describe, expect, it } from "vitest";
import { type PickCall, type PickPosition, mapToStandIns, standInOrder } from "./standins.ts";

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

  it("maps picks by conviction with the model's weights exactly, and says how each executes", () => {
    const m = mapToStandIns({
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

  it("never adds weight: a small plan stays small and the rest stays in cash, no floor (2026-10-16)", () => {
    const kept = mapToStandIns({
      picks: [pick(WMON, 2_000)],
      calls: [call(WMON, "WMON", 55)],
      standIns: STAND_INS,
      current: [{ token: WMON, targetWeightBps: 2_000 }],
      symbols: { [TALPHA]: "TALPHA", [TBETA]: "TBETA" },
    });
    expect(weights(kept)).toEqual({ [WMON]: 2_000 });
    expect(kept.cashTargetBps).toBe(8_000);
    expect(kept.calls).toEqual([expect.objectContaining({ symbol: "WMON", action: "HOLD" })]);
    expect(kept.notProposed.map((n) => n.symbol)).toEqual(["TALPHA", "TBETA"]);
  });

  it("cuts a weight past the contract's cap to the cap, keeps the cut in cash and says so; never moves it", () => {
    const m = mapToStandIns({
      picks: [pick(WETH, 6_000), pick(WBTC, 3_000)],
      calls: [call(WETH, "WETH", 90), call(WBTC, "WBTC", 70)],
      standIns: STAND_INS,
      current: [],
      symbols: { [TBETA]: "TBETA" },
    });
    expect(weights(m)).toEqual({ [WMON]: 4_000, [TALPHA]: 3_000 });
    expect(m.cashTargetBps).toBe(3_000);
    expect(m.pairs[0]).toEqual({
      real: "WETH",
      standIn: "WMON",
      weightBps: 4_000,
      cappedFromBps: 6_000,
    });
    expect(m.calls[0]?.reason).toContain(
      "Capped at 40% from 60% by this deploy's per-token limit; the rest stays in cash.",
    );
  });

  it("leaves a pick with no stand-in left out, its weight in cash", () => {
    const m = mapToStandIns({
      picks: [pick(WETH, 3_000), pick(WBTC, 3_000), pick(SOL, 2_000), pick(AUSD, 1_000)],
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
    expect(weights(m)).toEqual({ [WMON]: 3_000, [TALPHA]: 3_000, [TBETA]: 2_000 });
    expect(m.cashTargetBps).toBe(2_000);
    expect(m.notProposed.find((n) => n.symbol === "AUSD")?.reason).toMatch(/stays in cash/);
  });

  it("keeps a stand-in the model picked on its own token, and exits a held one no pick maps to", () => {
    const m = mapToStandIns({
      picks: [pick(TBETA, 3_000), pick(WETH, 4_000)],
      calls: [call(TBETA, "TBETA", 50), call(WETH, "WETH", 80)],
      standIns: STAND_INS,
      current: [
        { token: TALPHA, targetWeightBps: 3_000 },
        { token: TBETA, targetWeightBps: 3_000 },
      ],
      symbols: { [TALPHA]: "TALPHA" },
    });
    expect(weights(m)).toEqual({ [WMON]: 4_000, [TBETA]: 3_000 });
    expect(m.calls.find((c) => c.token === TBETA)).toMatchObject({
      standInFor: null,
      action: "HOLD",
    });
    expect(m.calls.find((c) => c.token === TALPHA)).toMatchObject({ action: "EXIT" });
  });

  it("writes symbols, never addresses, wherever a call names a token", () => {
    const m = mapToStandIns({
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

  it("counts a pick on the testnet's WMON as MON, ranked by conviction with the rest (2026-10-16)", () => {
    const MON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
    const m = mapToStandIns({
      picks: [pick(WMON, 2_000), pick(WETH, 5_000)],
      calls: [call(WMON, "WMON", 35), call(WETH, "WETH", 80)],
      standIns: STAND_INS,
      current: [{ token: WMON, targetWeightBps: 2_000 }],
      symbols: {},
      realOf: { [WMON]: { token: MON, symbol: "MON" } },
    });
    // WETH leads, so it executes as WMON; MON follows on TALPHA, never kept on its old slot.
    expect(m.lines).toEqual([
      "WETH 40%, executes as WMON on testnet",
      "MON 20%, executes as TALPHA on testnet",
    ]);
    expect(m.calls.find((c) => c.token === WMON)).toMatchObject({
      action: "ADD",
      standInFor: { symbol: "WETH" },
    });
  });
});
