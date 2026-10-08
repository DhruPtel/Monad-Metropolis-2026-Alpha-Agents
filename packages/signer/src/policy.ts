import { ENVIRONMENTS, type EnvironmentId } from "@alpha-agents/config";
import {
  SIGNER_REASON_CODES,
  SIGNER_REASON_MESSAGES,
  type SignerReasonCode,
} from "@alpha-agents/domain";
import { type Hex, decodeFunctionData, isAddressEqual, toFunctionSelector } from "viem";
import { ERC20_ABI, EXECUTOR_ABI, SWAP_INTENT_TUPLE, type SwapIntentArgs } from "./abi.ts";

/**
 * What the signer will sign (P2-U4, P2-U5 step 0): a call to the Executor's
 * swap entry point, and a USDC transfer from an agent's funding address that
 * is either a refund to the agent's current owner or a credit settlement to
 * the platform treasury (FINAL_PLAN 4.2.2). Nothing else. Every request is checked here before a key is asked
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
 * A swap's gas limit (A-38, revised in P2-EC). Monad charges the limit, not
 * the gas used, so it stays close to the measured cost: an account's first
 * swap writes fresh storage (the trade ring buffer, the peak buckets) and used
 * 1,070,401 gas inside the call on the P2-EC testnet pool (about 1,097,000 in
 * all), a later sale 975,571, and the P2-U2 fork swap about 1,036,000. The old
 * 1.1M left about 3,000 gas of margin on a first trade; 1.3M leaves about 18%,
 * at 0.134 MON per swap at 103 gwei. Per-tier caps come later.
 */
export const SWAP_GAS_LIMIT = 1_300_000n;

/** The most the signer pays per gas (A-38): 500 gwei, about 0.65 MON for a whole swap. */
export const MAX_FEE_PER_GAS_CAP = 500_000_000_000n;
/** The most priority fee per gas (A-38). */
export const MAX_PRIORITY_FEE_CAP = 10_000_000_000n;

/**
 * A USDC transfer's gas limit (A-41). Under Monad's gas model (cold storage
 * and account access cost more than on Ethereum) a FiatToken transfer from a
 * funding address used 100,106 to 100,310 gas on the fork, measured in the
 * P2-U5 live check (L-122); Monad charges the limit, so it stays at about
 * one and a half times that.
 */
export const TRANSFER_GAS_LIMIT = 150_000n;

export const SWAP_SELECTOR = toFunctionSelector(`function swap(${SWAP_INTENT_TUPLE} i)`);
export const TRANSFER_SELECTOR = toFunctionSelector(
  "function transfer(address to, uint256 amount)",
);

/** The kinds of transaction the signer's outbox holds. */
export const TRANSACTION_KINDS = ["executor_swap", "usdc_refund", "usdc_settlement"] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];
export type TransferKind = Exclude<TransactionKind, "executor_swap">;

/** Why the signer refused to sign: the first ten of packages/domain's SIGNER_REASON_CODES. */
export const SIGNER_REFUSALS = SIGNER_REASON_CODES.slice(0, 10) as readonly SignerRefusal[];
export type SignerRefusal = Extract<
  SignerReasonCode,
  | "CHAIN_NOT_PINNED"
  | "CONTRACT_CREATION"
  | "TARGET_NOT_ALLOWED"
  | "FUNCTION_NOT_ALLOWED"
  | "VALUE_NOT_ALLOWED"
  | "INTENT_MALFORMED"
  | "AGENT_MISMATCH"
  | "RECIPIENT_NOT_ALLOWED"
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

export interface TransferContext {
  readonly environment: EnvironmentId;
  readonly usdc: Hex;
  readonly kind: TransferKind;
  /**
   * Who may be paid: for a refund, the agent's current owner as the caller
   * read it on chain; for a settlement, the platform treasury. Null refuses.
   */
  readonly recipient: Hex | null;
}

export type TransferVerdict =
  | { readonly ok: true; readonly to: Hex; readonly amount: bigint }
  | { readonly ok: false; readonly code: SignerRefusal; readonly message: string };

/** A USDC transfer's allowlist: the chain pin, USDC, `transfer`, the one allowed recipient, the gas limit and the fee caps. */
export function checkTransferRequest(req: SignRequest, ctx: TransferContext): TransferVerdict {
  const no = (code: SignerRefusal): TransferVerdict => ({
    ok: false,
    code,
    message: SIGNER_REFUSAL_MESSAGES[code],
  });
  if (req.chainId !== CHAIN_PINS[ctx.environment]) return no("CHAIN_NOT_PINNED");
  if (req.to === null) return no("CONTRACT_CREATION");
  if (!isAddressEqual(req.to, ctx.usdc)) return no("TARGET_NOT_ALLOWED");
  if (req.data.slice(0, 10).toLowerCase() !== TRANSFER_SELECTOR) return no("FUNCTION_NOT_ALLOWED");
  if (req.value !== 0n) return no("VALUE_NOT_ALLOWED");
  let to: Hex;
  let amount: bigint;
  try {
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: req.data });
    if (decoded.functionName !== "transfer") return no("FUNCTION_NOT_ALLOWED");
    [to, amount] = decoded.args as readonly [Hex, bigint];
  } catch {
    return no("INTENT_MALFORMED");
  }
  if (amount === 0n) return no("INTENT_MALFORMED");
  if (ctx.recipient === null || !isAddressEqual(to, ctx.recipient))
    return no("RECIPIENT_NOT_ALLOWED");
  if (req.gas > TRANSFER_GAS_LIMIT || req.gas <= 0n) return no("GAS_LIMIT_EXCEEDED");
  if (
    req.maxFeePerGas > MAX_FEE_PER_GAS_CAP ||
    req.maxPriorityFeePerGas > MAX_PRIORITY_FEE_CAP ||
    req.maxPriorityFeePerGas > req.maxFeePerGas
  )
    return no("FEE_CAP_EXCEEDED");
  return { ok: true, to, amount };
}
