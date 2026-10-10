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

/**
 * Executor v3 trade gas (F-U4, A-69), from evidence/f-u4/GAS.md: on Monad's real
 * feeds a trade's gas grows with the tokens the account holds (each is valued
 * several times per trade) more than with the route's hops. Monad charges the
 * limit a transaction sets (L-136), so the signer sets the smallest limit with a
 * margin over the measured maxima: 29% over one hop with four tokens
 * (2,128,234), 29% over three hops with six (2,974,751).
 */
export const EXECUTOR_V3_GAS = Object.freeze({
  base: 1_000_000,
  perHop: 150_000,
  perHeldToken: 400_000,
  maxHops: 3,
  maxHeldTokens: 16,
});

/** The gas limit for an Executor v3 swap of `hops` pools on an account holding `heldTokensAfter` tokens once it settles. */
export function executorV3SwapGasLimit(hops: number, heldTokensAfter: number): bigint {
  if (!Number.isInteger(hops) || hops < 1 || hops > EXECUTOR_V3_GAS.maxHops)
    throw new RangeError(`a route has 1 to ${EXECUTOR_V3_GAS.maxHops} hops, not ${hops}`);
  if (
    !Number.isInteger(heldTokensAfter) ||
    heldTokensAfter < 1 ||
    heldTokensAfter > EXECUTOR_V3_GAS.maxHeldTokens
  )
    throw new RangeError(
      `an account holds 1 to ${EXECUTOR_V3_GAS.maxHeldTokens} tokens, not ${heldTokensAfter}`,
    );
  return BigInt(
    EXECUTOR_V3_GAS.base +
      EXECUTOR_V3_GAS.perHop * hops +
      EXECUTOR_V3_GAS.perHeldToken * heldTokensAfter,
  );
}
