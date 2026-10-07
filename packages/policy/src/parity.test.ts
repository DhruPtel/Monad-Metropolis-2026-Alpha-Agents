import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PEAK_DAYS } from "./breaker.ts";
import { LAUNCH_LIMITS } from "./limits.ts";
import { ORACLE_REASONS } from "./oracle.ts";
import { REJECTION_CODES } from "@alpha-agents/domain";
import {
  EXECUTOR_FIXTURE_PATH,
  PARITY_FIXTURE_PATH,
  buildExecutorFixture,
  buildParityFixture,
  executorFixtureStates,
  executorParityJson,
  parityJson,
} from "./parity.ts";
import * as executor from "./executor.ts";

const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");

/**
 * P2-U3: the offchain oracle and breaker checks must match the contracts'.
 * This side checks that the committed fixture is exactly what this package
 * answers now; chains/monad/test/oracle/Parity.t.sol checks that the
 * contracts answer the same. A change to either side alone fails one of them.
 */
describe("oracle and breaker parity with the contracts (P2-U3)", () => {
  it("the committed fixture is what the policy package answers now (pnpm policy:parity rewrites it)", () => {
    expect(read(PARITY_FIXTURE_PATH)).toBe(parityJson());
  });

  it("lists the oracle reasons in the Solidity enum's order", () => {
    const body = /enum OracleReason \{([^}]*)\}/.exec(
      read("chains/monad/src/interfaces/IOracle.sol"),
    )?.[1];
    const names = (body ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("///"))
      .map((l) => l.replace(",", ""));
    expect(names).toEqual([...ORACLE_REASONS]);
  });

  it("uses the custody core's breaker constants", () => {
    const core = read("chains/monad/src/custody/CustodyCore.sol");
    const constant = (name: string) =>
      Number(new RegExp(`${name} = ([0-9_]+);`).exec(core)?.[1]?.replaceAll("_", ""));
    expect(constant("BREAKER_REDUCE_ONLY_BPS")).toBe(LAUNCH_LIMITS.breakerReduceOnlyBps);
    expect(constant("BREAKER_PAUSE_BPS")).toBe(LAUNCH_LIMITS.breakerPauseBps);
    expect(constant("PEAK_DAYS")).toBe(PEAK_DAYS);
  });

  it("covers every reason and every breaker mode, so agreement means something", () => {
    const f = buildParityFixture();
    const reasons = new Set([
      ...f.feedCases.map((c) => c.reason),
      ...f.poolCases.map((c) => c.poolReason),
      ...f.poolCases.map((c) => c.deviationReason),
      ...f.pegCases.map((c) => c.reason),
    ]);
    // UNKNOWN_ASSET cannot come from a feed or the pool; its own forge test covers it.
    const expected = ORACLE_REASONS.map((_, i) => i).filter(
      (i) => ORACLE_REASONS[i] !== "UNKNOWN_ASSET",
    );
    expect([...reasons].sort((a, b) => a - b)).toEqual(expected);
    const modes = new Set(f.breakerCases.flatMap((c) => c.steps.map((s) => s.mode)));
    expect([...modes].sort()).toEqual([0, 1, 2]);
    const ops = new Set(f.breakerCases.flatMap((c) => c.steps.map((s) => s.op)));
    expect([...ops].sort()).toEqual(
      ["deposit", "monDown", "monUp", "poke", "price", "unpause", "withdraw", "withdrawAll"].sort(),
    );
    expect(f.breakerCases.every((c) => c.stepCount === c.steps.length)).toBe(true);
  });
});

/**
 * P2-U2: the Executor's verdict offchain (executor.ts) against the contract
 * (chains/monad/test/executor/ExecutorParity.t.sol replays the same file).
 */
describe("executor parity with the contract (P2-U2)", () => {
  it("the committed fixture is what the policy package answers now (pnpm policy:parity rewrites it)", () => {
    expect(read(EXECUTOR_FIXTURE_PATH)).toBe(executorParityJson());
  });

  it("covers every limit the market can break, and trades that go through", () => {
    const f = buildExecutorFixture();
    const seen = new Set(f.cases.map((c) => c.reason));
    const reachable = [
      "ASSET_NOT_ALLOWED",
      "VENUE_NOT_ALLOWED",
      "TRADE_SIZE_EXCEEDED",
      "CONCENTRATION_CAP",
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
    ] as const;
    for (const code of reachable) expect(seen, code).toContain(REJECTION_CODES.indexOf(code));
    expect(seen).toContain(255);
    expect(f.cases.filter((c) => c.reason === 255).length).toBeGreaterThan(20);
  });
});

describe("every blocking rule at once (P2-U5, tradable_now)", () => {
  it("names the Executor's own first refusal first, on every fixture case", () => {
    for (const s of executorFixtureStates()) {
      const pre = executor.executorPreCheck(s.trade, s.market);
      const all = executor.executorBlockers(s.trade, s.market);
      expect(all[0] ?? null, s.name).toBe(pre);
      expect(new Set(all).size, s.name).toBe(all.length);
    }
  });

  it("lists every rule a trade breaks, not only the first", () => {
    const s = must(executorFixtureStates().find((c) => c.name === "a valid sale"));
    const blocked = executor.executorBlockers(
      { ...s.trade, amountIn: s.market.wmon * 10n, minAmountOut: 1n },
      { ...s.market, mode: "PAUSED", oracleReason: "STALE" },
    );
    expect(blocked).toEqual(
      expect.arrayContaining([
        "PAUSED",
        "ORACLE_STALE",
        "INSUFFICIENT_BALANCE",
        "TRADE_SIZE_EXCEEDED",
      ]),
    );
  });

  it("finds when the oldest trade leaves the rolling window", () => {
    const w = executor.rollingWindow(
      {
        now: 1_000n,
        trades: [
          { at: 900n, valueUsdcE6: 5n },
          { at: 0n, valueUsdcE6: 9n },
        ],
      },
      { windowSeconds: 200 },
    );
    expect(w).toEqual({ count: 1, turnover: 5n, oldestLeavesAt: 1_100n });
  });
});
