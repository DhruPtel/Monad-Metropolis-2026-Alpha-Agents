import { RUNNER_HOLD_CODES } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import { loadPortfolioEvals, portfolioEvalPasses, runPortfolioEval } from "./evals.ts";
import {
  type PortfolioPosition,
  TARGET_PORTFOLIO_V1,
  type TargetPortfolioParams,
  checkTargetPortfolioParams,
  portfolioFingerprint,
  portfolioParamsFromJson,
  portfolioParamsHash,
  portfolioParamsJson,
} from "./portfolio.ts";

const WMON = "0x00000000000000000000000000000000000000c2";
const WBTC = "0x00000000000000000000000000000000000000c3";
const evals = loadPortfolioEvals();

const WMON_POSITION: PortfolioPosition = {
  token: WMON,
  targetWeightBps: 3_000,
  bandBps: 300,
  thesisId: "t-wmon",
  exit: { killCriterion: "MON loses its staking yield", recheckAt: "2026-11-01T00:00:00.000Z" },
};
const WBTC_POSITION: PortfolioPosition = {
  token: WBTC,
  targetWeightBps: 2_000,
  bandBps: 300,
  thesisId: "t-wbtc",
  exit: {
    killCriterion: "The bridge's reserves fall short",
    recheckAt: "2026-11-01T00:00:00.000Z",
    trimAboveBps: 2_500,
  },
};
const ok: TargetPortfolioParams = {
  positions: [WMON_POSITION, WBTC_POSITION],
  cashTargetBps: 5_000,
  minTradeUsdcE6: 500_000n,
  volatilityBrakeBps: 20_000,
  costHurdleBps: 40,
  maxLegBps: 1_000,
};

describe("target_portfolio@1's evals (F-U6, D-344)", () => {
  it.each(evals.scenarios.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    const d = runPortfolioEval(s);
    expect(
      portfolioEvalPasses(s, d),
      `${s.description} Got ${JSON.stringify(d, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`,
    ).toBe(true);
  });

  it("covers every hold reason the rule can give, sells and buys, and a routed cost check", () => {
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
      "SCREEN_STALE",
      "ATTESTATION_UNAVAILABLE",
      "CAP_REACHED",
      "CASH_FLOOR",
      "TOKEN_FROZEN",
    ])
      expect(holds, code).toContain(code);
    const trades = evals.scenarios.flatMap((s) =>
      s.expect.action === "trade" ? [`${s.expect.sell}>${s.expect.buy}`] : [],
    );
    expect(trades).toContain("USDC>WMON");
    expect(trades).toContain("WMON>USDC");
    expect(trades).toContain("WBTC>USDC");
    expect(trades).toContain("USDC>WBTC");
    expect(evals.scenarios.some((s) => s.quote !== null && s.expect.action === "trade")).toBe(true);
  });

  it("names every runner hold code it uses in the domain's list", () => {
    for (const code of ["SCREEN_STALE", "ATTESTATION_UNAVAILABLE", "CAP_REACHED", "CASH_FLOOR"])
      expect(RUNNER_HOLD_CODES).toContain(code);
  });

  it("is frozen, and its published fingerprint never changes (a new rule is a new version)", () => {
    expect(Object.isFrozen(TARGET_PORTFOLIO_V1)).toBe(true);
    expect(portfolioFingerprint()).toBe(
      "0x26e28815c22ca30018cd7f9077ade45a9eed9700ddcdb94a55d9635bd31b17fd",
    );
  });

  it("checks a plan's shape: weights and cash sum to 100%, tokens once, a trim level above the target", () => {
    expect(checkTargetPortfolioParams(ok)).toEqual([]);
    expect(checkTargetPortfolioParams({ ...ok, cashTargetBps: 4_000 }).map((e) => e.field)).toEqual(
      ["cashTargetBps"],
    );
    const twice = { ...ok, positions: [WMON_POSITION, { ...WMON_POSITION, thesisId: "x" }] };
    expect(
      checkTargetPortfolioParams({ ...twice, cashTargetBps: 4_000 }).map((e) => e.field),
    ).toEqual(["positions.1.token"]);
    const trim = {
      ...ok,
      positions: [
        WMON_POSITION,
        { ...WBTC_POSITION, exit: { ...WBTC_POSITION.exit, trimAboveBps: 1_000 } },
      ],
    };
    expect(checkTargetPortfolioParams(trim).map((e) => e.field)).toEqual([
      "positions.1.exit.trimAboveBps",
    ]);
    const bad = {
      ...ok,
      positions: [
        {
          ...WMON_POSITION,
          token: "0xABC" as never,
          thesisId: " ",
          exit: { killCriterion: "", recheckAt: "soon" },
        },
        WBTC_POSITION,
      ],
    };
    expect(checkTargetPortfolioParams(bad).map((e) => e.field)).toEqual([
      "positions.0.token",
      "positions.0.thesisId",
      "positions.0.exit.killCriterion",
      "positions.0.exit.recheckAt",
    ]);
    expect(checkTargetPortfolioParams({ ...ok, maxLegBps: 1_300 }).map((e) => e.field)).toEqual([
      "maxLegBps",
    ]);
    expect(
      checkTargetPortfolioParams({
        ...ok,
        positions: Array.from({ length: 13 }, (_, i) => ({
          ...WMON_POSITION,
          token: `0x${String(i + 1).padStart(40, "0")}` as never,
          targetWeightBps: i === 0 ? 2_000 : 250,
        })),
        cashTargetBps: 5_000,
      }).map((e) => e.field),
    ).toEqual(["positions"]);
  });

  it("round-trips and hashes a plan's parameters deterministically", () => {
    const json = portfolioParamsJson(ok);
    expect(portfolioParamsFromJson(JSON.parse(json))).toEqual(ok);
    expect(portfolioParamsHash(ok)).toBe(portfolioParamsHash({ ...ok }));
    expect(portfolioParamsHash(ok)).not.toBe(portfolioParamsHash({ ...ok, cashTargetBps: 5_100 }));
    // Key order does not matter: the hash is over canonical JSON.
    const reordered = Object.fromEntries(Object.entries(ok).reverse()) as TargetPortfolioParams;
    expect(portfolioParamsHash(ok)).toBe(portfolioParamsHash(reordered));
  });

  it("explains every decision with the positions it saw", () => {
    const s = evals.scenarios.find((x) => x.name === "overweight-sells-first");
    if (!s) throw new Error("scenario missing");
    const d = runPortfolioEval(s);
    expect(d.facts.totalValueUsdcE6).toBe("100000000");
    expect(d.facts.cashShareBps).toBe(4_000);
    expect(d.facts.positions.map((p) => [p.symbol, p.shareBps, p.targetBps])).toEqual([
      ["WMON", 4_500, 3_000],
      ["WBTC", 1_500, 2_000],
    ]);
    expect(d.facts.position).toBe(WMON);
    if (d.action !== "trade") throw new Error("expected a leg");
    expect(d.leg.direction).toBe("sell");
    expect(d.leg.valueUsdcE6).toBe(9_950_000n);
  });
});
