import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REJECTION_CODES, type RejectionCode } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import * as ex from "./executor-v3.ts";
import {
  EXECUTOR_V3_FIXTURE_PATH,
  buildFixture,
  fixtureJson,
  fixtureStates,
  routeFor,
} from "./executor-v3-parity.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, "utf8");

/**
 * F-U4: Executor v3's verdict offchain (executor-v3.ts) against the contract
 * (chains/monad/test/fund/ExecutorV3Parity.t.sol replays the same file).
 */
describe("Executor v3 parity with the contract (F-U4)", () => {
  it("the committed fixture is what the policy package answers now (pnpm policy:parity rewrites it)", () => {
    expect(read(EXECUTOR_V3_FIXTURE_PATH)).toBe(fixtureJson());
  });

  it("uses the contract's constants", () => {
    const src = read("chains/monad/src/fund/ExecutorV3.sol");
    const constant = (name: string) =>
      Number((new RegExp(`constant ${name} = ([0-9_]+)`).exec(src)?.[1] ?? "").replaceAll("_", ""));
    expect(constant("SCHEMA_VERSION")).toBe(ex.CONSTANTS.schemaVersion);
    expect(constant("MAX_HOPS")).toBe(ex.CONSTANTS.maxHops);
    expect(constant("RING_SIZE")).toBe(ex.CONSTANTS.ringSize);
    expect(constant("ACCOUNT_CLASS_A_POSITION_BPS")).toBe(ex.CONSTANTS.accountClassAPositionBps);
    expect(constant("ACCOUNT_CLASS_A_TOTAL_BPS")).toBe(ex.CONSTANTS.accountClassATotalBps);
    expect(src).toContain("MAX_SESSION = 30 days");
    // P7-U2: a vault grant's "no expiry" is the largest signed 64-bit value (D-241).
    expect(src).toContain("NO_EXPIRY = 9_007_199_254_740_991");
    expect(src).toContain("drawdown >= 2_000");
    expect(src).toContain("drawdown >= 1_000");
  });

  it("covers every limit the market can break, and trades that go through", () => {
    const f = buildFixture();
    const seen = new Set(f.cases.map((c) => c.reason));
    const covered: RejectionCode[] = [
      "ASSET_NOT_ALLOWED",
      "VENUE_NOT_ALLOWED",
      "TRADE_SIZE_EXCEEDED",
      "CONCENTRATION_CAP",
      "USDC_FLOOR",
      "SLIPPAGE_TOO_HIGH",
      "DAILY_TRADE_LIMIT",
      "TURNOVER_CAP",
      "ORACLE_STALE",
      "ORACLE_POOL_DEVIATION",
      "INSUFFICIENT_BALANCE",
      "REDUCE_ONLY_MODE",
      "PAUSED",
      "DEADLINE_EXPIRED",
      "DEADLINE_TOO_FAR",
      "INTENT_INVALID",
      "ROUTE_INVALID",
      "NOT_OPTED_IN",
      "TOKEN_SELL_ONLY",
      "TOKEN_FROZEN",
      "ATTESTATION_REQUIRED",
      "ATTESTATION_INVALID",
      "ATTESTOR_UNAVAILABLE",
      "CLASS_A_POSITION_CAP",
      "CLASS_A_TOTAL_CAP",
    ];
    for (const code of covered) expect(seen, code).toContain(REJECTION_CODES.indexOf(code));
    const passing = f.cases.filter((c) => c.reason === 255);
    expect(passing.length).toBeGreaterThan(30);
    expect(passing.some((c) => c.tokenIn === "A" && c.tokenOut === "B")).toBe(true);
    expect(passing.some((c) => ["C", "D", "E", "F"].includes(c.tokenOut))).toBe(true);
    // D-365: an opted-out account sells its screened token through its pool, and cannot buy one.
    const byName = (name: string) => f.cases.find((c) => c.name === name)?.reason;
    expect(byName("a sale of D after opting out still goes through its pool")).toBe(255);
    expect(byName("a sale of D for WMON after opting out, through its pool and a core one")).toBe(
      255,
    );
    expect(byName("a swap of D into E after opting out is a buy of a screened token")).toBe(
      REJECTION_CODES.indexOf("NOT_OPTED_IN"),
    );
    expect(byName("a sell-only token still sells")).toBe(255);
    expect(f.policyHash).toBe(ex.PARITY_POLICY_HASH);
  });

  it("refuses a buy of a sell-only screened token with that one reason, opted in or not (F-T2)", () => {
    const st = fixtureStates().find((x) => x.name === "a sell-only token refuses a buy");
    expect(st).toBeDefined();
    if (!st) return;
    expect(ex.blockers(st.intent, { ...st.market, optedIn: true })).toEqual(["TOKEN_SELL_ONLY"]);
    expect(ex.blockers(st.intent, { ...st.market, optedIn: false })).toEqual(["TOKEN_SELL_ONLY"]);
  });

  it("refuses a vault any class A or screened token by name, and nothing else changes for it (P7-U2, D-338)", () => {
    const states = fixtureStates();
    const find = (name: string) => {
      const st = states.find((x) => x.name === name);
      expect(st, name).toBeDefined();
      return st as NonNullable<typeof st>;
    };
    const classA = find("a class A buy of C");
    expect(ex.preCheck(classA.intent, classA.market)).toBeNull();
    expect(ex.preCheck(classA.intent, { ...classA.market, isVault: true })).toBe(
      "ASSET_NOT_ALLOWED",
    );
    expect(ex.blockers(classA.intent, { ...classA.market, isVault: true })).toEqual([
      "ASSET_NOT_ALLOWED",
    ]);
    const screened = find("a screened buy of D with the opt-in");
    expect(ex.preCheck(screened.intent, { ...screened.market, isVault: true })).toBe(
      "ASSET_NOT_ALLOWED",
    );
    const wmon = find("a valid buy of WMON");
    expect(ex.preCheck(wmon.intent, { ...wmon.market, isVault: true })).toBe(
      ex.preCheck(wmon.intent, wmon.market),
    );
    // A closing vault trades as reduce-only: a buy is refused, a sale into USDC is not.
    expect(ex.preCheck(wmon.intent, { ...wmon.market, isVault: true, mode: "WIND_DOWN" })).toBe(
      "REDUCE_ONLY_MODE",
    );
    expect(ex.blockers(wmon.intent, { ...wmon.market, mode: "WIND_DOWN" })).toContain(
      "REDUCE_ONLY_MODE",
    );
  });

  it("names its first refusal first in the blockers, on every fixture case", () => {
    for (const st of fixtureStates()) {
      const first = ex.preCheck(st.intent, st.market);
      const all = ex.blockers(st.intent, st.market);
      if (first === null) expect(all, st.name).toEqual([]);
      else expect(all[0], st.name).toBe(first);
    }
  });

  it("routes through the base's pools like the forge base", () => {
    expect(routeFor("USDC", "WMON").map((h) => `${h.a}/${h.b}`)).toEqual(["USDC/WMON"]);
    expect(routeFor("A", "B").map((h) => `${h.a}/${h.b}`)).toEqual([
      "A/WMON",
      "USDC/WMON",
      "B/USDC",
    ]);
    expect(routeFor("USDC", "C").length).toBe(2);
    expect(routeFor("D", "C").length).toBe(3);
    expect(ex.routeFeeBps(routeFor("A", "B"))).toBe(60n);
  });

  it("values the account as the custody core does", () => {
    const tokens: Record<string, ex.TokenRuleV3> = {
      USDC: {
        lane: "CORE",
        status: "BUYABLE",
        priceClass: "F",
        decimals: 6,
        maxPositionBps: 4_500,
      },
      WMON: {
        lane: "CORE",
        status: "BUYABLE",
        priceClass: "F",
        decimals: 18,
        maxPositionBps: 4_500,
      },
      C: { lane: "CORE", status: "BUYABLE", priceClass: "A", decimals: 18, maxPositionBps: 4_500 },
    };
    const v = ex.accountValues(
      [
        {
          token: "USDC",
          free: 700n * 10n ** 6n,
          costBasis: 700n * 10n ** 6n,
          priceE18: 10n ** 18n,
          priceUsable: true,
        },
        {
          token: "WMON",
          free: 150n * 10n ** 18n,
          costBasis: 300n * 10n ** 6n,
          priceE18: 2n * 10n ** 18n,
          priceUsable: true,
        },
        // C bought for 100 USDC, now worth 80: the caps see 80, the basis stays 100.
        {
          token: "C",
          free: 250n * 10n ** 18n,
          costBasis: 100n * 10n ** 6n,
          priceE18: 32n * 10n ** 16n,
          priceUsable: true,
        },
      ],
      tokens,
      "USDC",
    );
    expect(v).toEqual({
      nav: 1_080n * 10n ** 6n,
      capped: 1_080n * 10n ** 6n,
      totalBasis: 1_100n * 10n ** 6n,
      classABasis: 100n * 10n ** 6n,
    });
    expect(
      ex.accountValues(
        [{ token: "WMON", free: 1n, costBasis: 0n, priceE18: 0n, priceUsable: false }],
        tokens,
        "USDC",
      ),
    ).toBeNull();
  });
});
