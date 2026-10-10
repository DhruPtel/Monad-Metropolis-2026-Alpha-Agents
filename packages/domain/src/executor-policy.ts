import { encodeAbiParameters, keccak256 } from "viem";

/**
 * The Executor's policy (P2-U2): the launch hard limits as the contract holds
 * them, and the hash an intent names (`policyHash`). The field order is the
 * Solidity struct `Policy` in chains/monad/src/interfaces/IExecutor.sol, and
 * the hash is keccak256(abi.encode(policy)), as Executor._setPolicy computes it.
 */
export interface ExecutorPolicy {
  readonly maxTradeBps: number;
  readonly maxAssetBps: number;
  readonly minUsdcBps: number;
  readonly maxSlippageBps: number;
  readonly maxTurnoverBps: number;
  readonly maxTradesPerWindow: number;
  readonly windowSeconds: number;
  readonly deadlineSeconds: number;
}

/**
 * Executor v3's policy (F-U4): the v2 limits plus the slippage bound against an
 * attested price and the class A cost-basis caps (D-337, D-352). The field
 * order is the Solidity struct `PolicyV3` in
 * chains/monad/src/interfaces/IExecutorV3.sol, and the hash is
 * keccak256(abi.encode(policy)), as ExecutorV3._setPolicy computes it.
 */
export interface ExecutorPolicyV3 {
  readonly maxTradeBps: number;
  readonly maxAssetBps: number;
  readonly minUsdcBps: number;
  readonly maxSlippageBps: number;
  readonly maxSlippageClassABps: number;
  readonly maxClassAPositionBps: number;
  readonly maxClassATotalBps: number;
  readonly maxTurnoverBps: number;
  readonly maxTradesPerWindow: number;
  readonly windowSeconds: number;
  readonly deadlineSeconds: number;
}

export function executorPolicyHashV3(p: ExecutorPolicyV3): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "maxTradeBps", type: "uint16" },
            { name: "maxAssetBps", type: "uint16" },
            { name: "minUsdcBps", type: "uint16" },
            { name: "maxSlippageBps", type: "uint16" },
            { name: "maxSlippageClassABps", type: "uint16" },
            { name: "maxClassAPositionBps", type: "uint16" },
            { name: "maxClassATotalBps", type: "uint16" },
            { name: "maxTurnoverBps", type: "uint16" },
            { name: "maxTradesPerWindow", type: "uint8" },
            { name: "windowSeconds", type: "uint32" },
            { name: "deadlineSeconds", type: "uint32" },
          ],
        },
      ],
      [p],
    ),
  );
}

export function executorPolicyHash(p: ExecutorPolicy): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "maxTradeBps", type: "uint16" },
            { name: "maxAssetBps", type: "uint16" },
            { name: "minUsdcBps", type: "uint16" },
            { name: "maxSlippageBps", type: "uint16" },
            { name: "maxTurnoverBps", type: "uint16" },
            { name: "maxTradesPerWindow", type: "uint8" },
            { name: "windowSeconds", type: "uint32" },
            { name: "deadlineSeconds", type: "uint32" },
          ],
        },
      ],
      [p],
    ),
  );
}
