// @ts-check
import { describe, expect, it } from "vitest";
import {
  V4_ADAPTER_ID,
  atOraclePrice,
  bpsFrom,
  canaryIntent,
  fees,
  gasLimitFor,
  poolPriceE18,
  slippageBps,
  withinBudget,
} from "./canary-run.js";

const USDC = /** @type {`0x${string}`} */ ("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const WMON = /** @type {`0x${string}`} */ ("0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A");
const E18 = 10n ** 18n;

describe("the canary run's arithmetic (P2-EC part 2)", () => {
  it("sets fees as the signer does, within A-38's caps", () => {
    expect(fees(100_000_000_000n, 2_000_000_000n)).toEqual({
      maxFeePerGas: 202_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
    expect(fees(100_000_000_000n, 50_000_000_000n)?.maxPriorityFeePerGas).toBe(10_000_000_000n);
    expect(fees(300_000_000_000n, 1n)?.maxFeePerGas).toBe(500_000_000_000n);
    expect(fees(495_000_000_000n, 10_000_000_000n)).toBeNull();
  });

  it("limits gas to 110% of the estimate and holds the spend to the budget", () => {
    expect(gasLimitFor(100_000n)).toBe(110_000n);
    expect(gasLimitFor(21_001n)).toBe(23_102n);
    const budget = { budgetWei: 10n * E18, maxFeePerGas: 200_000_000_000n };
    expect(withinBudget({ ...budget, spentWei: 9n * E18, gas: 1_300_000n })).toBe(true);
    expect(withinBudget({ ...budget, spentWei: (99n * E18) / 10n, gas: 1_300_000n })).toBe(false);
  });

  it("reads the pool's USDC per MON from sqrtPriceX96, with MON as currency0", () => {
    // 1 MON = 0.025 USDC: 0.025e6 USDC units per 1e18 wei, so sqrt(2.5e-14) * 2^96.
    const sqrt = 12527072418752396559320n; // floor(sqrt(2.5e-14) * 2^96)
    const p = poolPriceE18(sqrt);
    expect(Number(p) / 1e18).toBeCloseTo(0.025, 6);
  });

  it("measures slippage and deviation against the oracle's price", () => {
    const price = (25n * E18) / 1000n; // 0.025 USDC per MON
    expect(atOraclePrice("buy", 450_000n, price)).toBe(18n * E18);
    expect(atOraclePrice("sell", 18n * E18, price)).toBe(450_000n);
    // 0.05% fee: 17.991 WMON for 0.45 USDC is 5 bps below the oracle's 18.
    expect(slippageBps("buy", 450_000n, (17_991n * E18) / 1000n, price)).toBe(5);
    expect(slippageBps("sell", 18n * E18, 449_775n, price)).toBe(5);
    // A better-than-oracle fill is negative slippage.
    expect(slippageBps("sell", 18n * E18, 450_450n, price)).toBe(-10);
    expect(bpsFrom(1_010n, 1_000n)).toBe(100);
    expect(bpsFrom(990n, 1_000n)).toBe(-100);
  });

  it("builds the canary's intent for agent 1 on the v4 adapter, deadline 120 s out", () => {
    const i = canaryIntent({
      chainId: 143,
      account: "0x0000000000000000000000000000000000000abc",
      step: "buy",
      runId: "r1",
      configEpoch: 0n,
      policyHash: `0x${"11".repeat(32)}`,
      tokenIn: USDC,
      tokenOut: WMON,
      amountIn: 450_000n,
      floor: 17n * E18,
      blockTime: 1_000n,
    });
    expect(i).toMatchObject({
      schemaVersion: 1,
      chainId: 143n,
      agentId: 1n,
      ownerEpoch: 0n,
      adapterId: V4_ADAPTER_ID,
      amountIn: 450_000n,
      minAmountOut: 17n * E18,
      deadline: 1_120n,
    });
    const again = canaryIntent({
      ...i,
      chainId: 143,
      step: "buy",
      runId: "r1",
      floor: 1n,
      blockTime: 1n,
      account: i.account,
      tokenIn: USDC,
      tokenOut: WMON,
      configEpoch: 0n,
      policyHash: i.policyHash,
      amountIn: 1n,
    });
    expect(again.actionId).toBe(i.actionId);
    expect(
      canaryIntent({
        ...i,
        chainId: 143,
        step: "sell",
        runId: "r1",
        floor: 1n,
        blockTime: 1n,
        account: i.account,
        tokenIn: WMON,
        tokenOut: USDC,
        configEpoch: 0n,
        policyHash: i.policyHash,
        amountIn: 1n,
      }).actionId,
    ).not.toBe(i.actionId);
  });
});
