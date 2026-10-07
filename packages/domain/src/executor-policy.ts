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
