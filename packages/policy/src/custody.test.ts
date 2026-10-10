import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CUSTODY_REFERENCE_PRICES,
  CUSTODY_T0,
  CUSTODY_TOKENS,
  CUSTODY_TOKEN_SPECS,
  CUSTODY_V3,
  type CustodyState,
  buildCustodyCases,
  deposit,
  emptyCustody,
  mockFill,
  poke,
  swap,
  valuation,
  valueE6,
  withdraw,
} from "./custody.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const feeds = { USDC: E18, WMON: 2n * E18, A: 6n * E18, B: 40n * E18 };
const ctx = (now = CUSTODY_T0) => ({ now, feeds, attested: {} });

/** 600 USDC and 50 A (300 USDC): the forge base's trading account. */
function trading(): CustodyState {
  let s = emptyCustody();
  s = deposit(s, "USDC", 600n * E6, ctx()).state;
  s = deposit(s, "A", 50n * E18, ctx()).state;
  return s;
}

describe("the custody core v3 model (F-U3)", () => {
  it("uses the contract's constants", () => {
    const core = read("chains/monad/src/fund/CustodyCoreV3.sol");
    const constant = (name: string) =>
      Number(
        /\d[\d_]*/
          .exec(new RegExp(`constant ${name} = ([\\d_]+)`).exec(core)?.[1] ?? "")?.[0]
          .replaceAll("_", "") ?? NaN,
      );
    expect(constant("MAX_TRADE_BPS")).toBe(CUSTODY_V3.maxTradeBps);
    expect(constant("MAX_ASSET_BPS")).toBe(CUSTODY_V3.maxAssetBps);
    expect(constant("MAX_CLASS_A_POSITION_BPS")).toBe(CUSTODY_V3.maxClassAPositionBps);
    expect(constant("MAX_CLASS_A_TOTAL_BPS")).toBe(CUSTODY_V3.maxClassATotalBps);
    expect(constant("MAX_SLIPPAGE_BPS")).toBe(CUSTODY_V3.maxSlippageBps);
    expect(constant("MAX_DEPEG_BPS")).toBe(CUSTODY_V3.maxDepegBps);
    expect(constant("MAX_HELD_TOKENS")).toBe(CUSTODY_V3.maxHeldTokens);
    expect(constant("MAX_DECIMALS")).toBe(CUSTODY_V3.maxDecimals);
    expect(constant("BREAKER_REDUCE_ONLY_BPS")).toBe(CUSTODY_V3.breakerReduceOnlyBps);
    expect(constant("BREAKER_PAUSE_BPS")).toBe(CUSTODY_V3.breakerPauseBps);
    expect(constant("PEAK_DAYS")).toBe(CUSTODY_V3.peakDays);
    expect(core).toContain("ATTESTED_PRICE_TTL = 24 hours");
    expect(CUSTODY_V3.attestedPriceTtlSeconds).toBe(86_400);
  });

  it("values an amount at a price with the token's decimals, rounding down", () => {
    expect(valueE6(10n * E18, 6n * E18, 18)).toBe(60n * E6);
    expect(valueE6(10n ** 8n, 40n * E18, 8)).toBe(40n * E6);
    expect(valueE6(1n, 6n * E18, 18)).toBe(0n);
    expect(valueE6(5n * E6, E18, 6)).toBe(5n * E6);
  });

  it("deposits mint one unit per USDC and build the basis", () => {
    const s = trading();
    expect(s.held).toEqual(["USDC", "A"]);
    expect(s.units).toBe(900n * 10n ** 18n);
    expect(s.principal).toBe(900n * E6);
    expect(s.positions.A.costBasis).toBe(300n * E6);
    expect(s.positions.A.lastPriceE18).toBe(6n * E18);
    const v = valuation(s, ctx());
    expect(v.nav).toBe(900n * E6);
    expect(v.capped).toBe(900n * E6);
    expect(v.totalBasis).toBe(900n * E6);
    expect(v.classABasis).toBe(0n);
  });

  it("moves the basis with the USDC paid and caps class A by it", () => {
    let s = trading();
    const reference = { ...CUSTODY_REFERENCE_PRICES };
    const r1 = swap(
      s,
      { tokenIn: "USDC", tokenOut: "C", amountIn: 100n * E6, outputBps: 10_000n, reference },
      ctx(),
    );
    expect(r1.outcome).toEqual({ ok: true });
    s = r1.state;
    expect(s.positions.C.amount).toBe(250n * E18);
    expect(s.positions.C.costBasis).toBe(100n * E6);
    const r2 = swap(
      s,
      { tokenIn: "USDC", tokenOut: "C", amountIn: 35n * E6, outputBps: 10_000n, reference },
      ctx(),
    );
    expect(r2.outcome).toEqual({ ok: true });
    const r3 = swap(
      r2.state,
      { tokenIn: "USDC", tokenOut: "C", amountIn: 1n, outputBps: 10_000n, reference },
      ctx(),
    );
    expect(r3.outcome).toEqual({ ok: false, failure: "ClassAPositionTooLarge" });
    expect(r3.state).toBe(r2.state);
    // A sale takes its share of the basis; selling the rest removes the token.
    const half = (337_500n * E18) / 2000n;
    const r4 = swap(
      r2.state,
      { tokenIn: "C", tokenOut: "USDC", amountIn: half, outputBps: 10_000n, reference },
      ctx(),
    );
    expect(r4.outcome).toEqual({ ok: true });
    expect(r4.state.positions.C.costBasis).toBe(67_500_000n);
    const r5 = swap(
      r4.state,
      { tokenIn: "C", tokenOut: "USDC", amountIn: half, outputBps: 10_000n, reference },
      ctx(),
    );
    expect(r5.outcome).toEqual({ ok: true });
    expect(r5.state.held).toEqual(["USDC", "A"]);
    expect(r5.state.positions.C.costBasis).toBe(0n);
  });

  it("refuses a screened token before the opt-in, a slow fill, an oversized trade and too much class F", () => {
    const s = trading();
    const reference = { ...CUSTODY_REFERENCE_PRICES };
    const buyD = {
      tokenIn: "USDC" as const,
      tokenOut: "D" as const,
      amountIn: 50n * E6,
      outputBps: 10_000n,
      reference,
    };
    expect(swap(s, buyD, ctx()).outcome).toEqual({ ok: false, failure: "NotBuyable" });
    expect(swap({ ...s, optIn: true }, buyD, ctx()).outcome).toEqual({ ok: true });
    expect(
      swap(
        s,
        { tokenIn: "A", tokenOut: "USDC", amountIn: 15n * E18, outputBps: 9_899n, reference },
        ctx(),
      ).outcome,
    ).toEqual({ ok: false, failure: "SlippageTooHigh" });
    expect(
      swap(
        s,
        {
          tokenIn: "A",
          tokenOut: "USDC",
          amountIn: 18_000_000_166_666_666_667n,
          outputBps: 10_000n,
          reference,
        },
        ctx(),
      ).outcome,
    ).toEqual({ ok: false, failure: "TradeTooLarge" });
    const near = swap(
      s,
      { tokenIn: "USDC", tokenOut: "A", amountIn: 105n * E6, outputBps: 10_000n, reference },
      ctx(),
    );
    expect(near.outcome).toEqual({ ok: true });
    expect(
      swap(
        near.state,
        { tokenIn: "USDC", tokenOut: "A", amountIn: 1_200_000n, outputBps: 10_000n, reference },
        ctx(),
      ).outcome,
    ).toEqual({ ok: false, failure: "ConcentrationTooHigh" });
  });

  it("counts a class A token at zero a day after its attestation, and the breaker tightens", () => {
    let s = trading();
    const reference = { ...CUSTODY_REFERENCE_PRICES };
    for (const amount of [100n * E6, 35n * E6]) {
      s = swap(
        s,
        { tokenIn: "USDC", tokenOut: "C", amountIn: amount, outputBps: 10_000n, reference },
        ctx(),
      ).state;
    }
    const p1 = poke(s, ctx());
    expect(p1.nav).toBe(900n * E6);
    const later = CUSTODY_T0 + 86_400n;
    expect(valuation(p1.state, ctx(later - 1n)).nav).toBe(900n * E6);
    expect(valuation(p1.state, ctx(later)).nav).toBe(765n * E6);
    const p2 = poke(p1.state, ctx(later));
    expect(p2.state.mode).toBe("REDUCE_ONLY");
    const p3 = poke(p2.state, { ...ctx(later), attested: { C: reference.C } });
    expect(p3.nav).toBe(900n * E6);
    expect(p3.state.mode).toBe("REDUCE_ONLY");
  });

  it("burns units for a withdrawal at the last prices and never lowers the value per unit", () => {
    let s = trading();
    s = withdraw(s, "A", 25n * E18);
    expect(s.units).toBe(750n * E18);
    expect(s.positions.A.costBasis).toBe(150n * E6);
    s = withdraw(s, "USDC", 600n * E6);
    // A's withdrawal lowered nothing; USDC's lowered 600.
    expect(s.principal).toBe(300n * E6);
    s = withdraw(s, "A", 25n * E18);
    expect(s.units).toBe(0n);
    expect(s.principal).toBe(0n);
    expect(s.held).toEqual(["USDC"]);
  });

  it("fills as the mock venue does", () => {
    expect(mockFill("USDC", "A", 60n * E6, E18, 6n * E18, 10_000n)).toBe(10n * E18);
    expect(mockFill("A", "B", 10n * E18, 6n * E18, 40n * E18, 10_000n)).toBe(15n * 10n ** 7n);
    expect(mockFill("USDC", "C", 100n * E6, E18, 4n * 10n ** 17n, 9_900n)).toBe(
      2_475n * 10n ** 17n,
    );
  });

  it("builds a fixture that covers every outcome and every op", () => {
    const cases = buildCustodyCases();
    const steps = cases.flatMap((c) => c.steps);
    const failures = new Set(steps.filter((s) => !s.ok).map((s) => s.failure));
    for (const f of [
      "NotBuyable",
      "TradeTooLarge",
      "SlippageTooHigh",
      "ConcentrationTooHigh",
      "ClassAPositionTooLarge",
      "ClassATooLarge",
      "ReduceOnly",
      "PersonalCapExceeded",
    ]) {
      expect(failures, f).toContain(f);
    }
    const ops = new Set(steps.map((s) => s.op));
    expect(ops).toEqual(
      new Set([
        "deposit",
        "withdraw",
        "swap",
        "attest",
        "price",
        "warp",
        "poke",
        "optIn",
        "unpause",
      ]),
    );
    const modes = new Set(steps.map((s) => s.mode));
    expect(modes).toEqual(new Set([0, 1, 2]));
    expect(cases.every((c) => c.stepCount === c.steps.length)).toBe(true);
    expect(
      CUSTODY_TOKENS.every((t) => CUSTODY_TOKEN_SPECS[t].decimals <= CUSTODY_V3.maxDecimals),
    ).toBe(true);
  });
});
