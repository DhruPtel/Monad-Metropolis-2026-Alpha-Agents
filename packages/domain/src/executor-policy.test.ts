import { describe, expect, it } from "vitest";
import {
  EXECUTOR_V3_GAS,
  type ExecutorPolicyV3,
  executorPolicyHash,
  executorPolicyHashV3,
  executorV3SwapGasLimit,
} from "./executor-policy.ts";

const LAUNCH_V3: ExecutorPolicyV3 = {
  maxTradeBps: 1_000,
  maxAssetBps: 4_000,
  minUsdcBps: 1_000,
  maxSlippageBps: 50,
  maxSlippageClassABps: 100,
  maxClassAPositionBps: 1_500,
  maxClassATotalBps: 5_000,
  maxTurnoverBps: 10_000,
  maxTradesPerWindow: 20,
  windowSeconds: 86_400,
  deadlineSeconds: 120,
};

describe("Executor policy hashes (P2-U2, F-U4)", () => {
  it("hashes a v3 policy differently from the v2 policy with the same limits", () => {
    const v2 = executorPolicyHash({
      maxTradeBps: 1_000,
      maxAssetBps: 4_000,
      minUsdcBps: 1_000,
      maxSlippageBps: 50,
      maxTurnoverBps: 10_000,
      maxTradesPerWindow: 20,
      windowSeconds: 86_400,
      deadlineSeconds: 120,
    });
    const v3 = executorPolicyHashV3(LAUNCH_V3);
    expect(v3).toMatch(/^0x[0-9a-f]{64}$/);
    expect(v3).not.toBe(v2);
  });

  it("changes with any field, as the contract's keccak256(abi.encode(policy)) does", () => {
    const base = executorPolicyHashV3(LAUNCH_V3);
    for (const key of Object.keys(LAUNCH_V3) as (keyof ExecutorPolicyV3)[]) {
      expect(executorPolicyHashV3({ ...LAUNCH_V3, [key]: LAUNCH_V3[key] + 1 }), key).not.toBe(base);
    }
  });
});

describe("Executor v3 trade gas limits (F-U4, A-69)", () => {
  it("covers the measured maxima of evidence/f-u4/GAS.md with a margin", () => {
    expect(executorV3SwapGasLimit(1, 4)).toBe(2_750_000n);
    expect(executorV3SwapGasLimit(2, 5)).toBe(3_300_000n);
    expect(executorV3SwapGasLimit(3, 6)).toBe(3_850_000n);
    expect(executorV3SwapGasLimit(3, 16)).toBe(7_850_000n);
    expect(executorV3SwapGasLimit(1, 4)).toBeGreaterThan(2_128_234n);
    expect(executorV3SwapGasLimit(3, 6)).toBeGreaterThan(2_974_751n);
    expect(EXECUTOR_V3_GAS.maxHops).toBe(3);
    expect(EXECUTOR_V3_GAS.maxHeldTokens).toBe(16);
  });

  it("refuses a route or a portfolio the Executor cannot have", () => {
    expect(() => executorV3SwapGasLimit(0, 4)).toThrow(RangeError);
    expect(() => executorV3SwapGasLimit(4, 4)).toThrow(RangeError);
    expect(() => executorV3SwapGasLimit(1, 17)).toThrow(RangeError);
    expect(() => executorV3SwapGasLimit(1.5, 4)).toThrow(RangeError);
  });
});
