import { ENVIRONMENTS, type EnvironmentId } from "@alpha-agents/config";
import {
  SIGNER_REASON_CODES,
  SIGNER_REASON_MESSAGES,
  type SignerReasonCode,
} from "@alpha-agents/domain";
import { type Hex, decodeFunctionData, isAddressEqual, toFunctionSelector } from "viem";
import { EXECUTOR_ABI, SWAP_INTENT_TUPLE, type SwapIntentArgs } from "./abi.ts";

/**
 * What the signer will sign (P2-U4): a call to the Executor's swap entry
 * point and nothing else. Every request is checked here before a key is asked
 * for a signature, and again by the outbox at signing time, so a refused
 * request is never signed. The Executor and the custody core are the
 * financial boundary (FINAL_PLAN 3); this is the signer's own, narrower one.
 */

/** The chain each environment's signer will sign for (D-195, D-243). */
export const CHAIN_PINS: Readonly<Record<EnvironmentId, number>> = {
  local: ENVIRONMENTS.local.chainId,
  testnet: ENVIRONMENTS.testnet.chainId,
  beta: ENVIRONMENTS.beta.chainId,
};

/**
 * A swap's gas limit (A-38). The P2-U2 swap on the real v4 pool used about
 * 1.0M gas; Monad charges the limit, not the gas used, so the limit stays
 * close to it. Per-tier caps come later.
 */
export const SWAP_GAS_LIMIT = 1_100_000n;

/** The most the signer pays per gas (A-38): 500 gwei, about 0.55 MON for a whole swap. */
export const MAX_FEE_PER_GAS_CAP = 500_000_000_000n;
/** The most priority fee per gas (A-38). */
export const MAX_PRIORITY_FEE_CAP = 10_000_000_000n;

export const SWAP_SELECTOR = toFunctionSelector(`function swap(${SWAP_INTENT_TUPLE} i)`);

/** Why the signer refused to sign: the first nine of packages/domain's SIGNER_REASON_CODES. */
export const SIGNER_REFUSALS = SIGNER_REASON_CODES.slice(0, 9) as readonly SignerRefusal[];
export type SignerRefusal = Extract<
  SignerReasonCode,
  | "CHAIN_NOT_PINNED"
  | "CONTRACT_CREATION"
  | "TARGET_NOT_ALLOWED"
  | "FUNCTION_NOT_ALLOWED"
  | "VALUE_NOT_ALLOWED"
  | "INTENT_MALFORMED"
  | "AGENT_MISMATCH"
  | "GAS_LIMIT_EXCEEDED"
  | "FEE_CAP_EXCEEDED"
>;
export const SIGNER_REFUSAL_MESSAGES: Readonly<Record<SignerRefusal, string>> =
  SIGNER_REASON_MESSAGES;

/** A transaction the signer is asked to sign. */
export interface SignRequest {
  readonly chainId: number;
  readonly to: Hex | null;
  readonly data: Hex;
  readonly value: bigint;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface PolicyContext {
  readonly environment: EnvironmentId;
  readonly executor: Hex;
  /** The agent whose key would sign. */
  readonly agentId: number;
}

export type PolicyVerdict =
  | { readonly ok: true; readonly intent: SwapIntentArgs }
  | { readonly ok: false; readonly code: SignerRefusal; readonly message: string };

const refuse = (code: SignerRefusal): PolicyVerdict => ({
  ok: false,
  code,
  message: SIGNER_REFUSAL_MESSAGES[code],
});

/** The signer's allowlist, chain pin, gas limit and fee caps, in that order. */
export function checkSignRequest(req: SignRequest, ctx: PolicyContext): PolicyVerdict {
  const pin = CHAIN_PINS[ctx.environment];
  if (req.chainId !== pin) return refuse("CHAIN_NOT_PINNED");
  if (req.to === null) return refuse("CONTRACT_CREATION");
  if (!isAddressEqual(req.to, ctx.executor)) return refuse("TARGET_NOT_ALLOWED");
  if (req.data.slice(0, 10).toLowerCase() !== SWAP_SELECTOR) return refuse("FUNCTION_NOT_ALLOWED");
  if (req.value !== 0n) return refuse("VALUE_NOT_ALLOWED");
  let intent: SwapIntentArgs;
  try {
    const decoded = decodeFunctionData({ abi: EXECUTOR_ABI, data: req.data });
    if (decoded.functionName !== "swap") return refuse("FUNCTION_NOT_ALLOWED");
    intent = decoded.args[0] as SwapIntentArgs;
  } catch {
    return refuse("INTENT_MALFORMED");
  }
  if (intent.chainId !== BigInt(pin) || intent.agentId !== BigInt(ctx.agentId))
    return refuse("AGENT_MISMATCH");
  if (req.gas > SWAP_GAS_LIMIT || req.gas <= 0n) return refuse("GAS_LIMIT_EXCEEDED");
  if (
    req.maxFeePerGas > MAX_FEE_PER_GAS_CAP ||
    req.maxPriorityFeePerGas > MAX_PRIORITY_FEE_CAP ||
    req.maxPriorityFeePerGas > req.maxFeePerGas
  )
    return refuse("FEE_CAP_EXCEEDED");
  return { ok: true, intent };
}
