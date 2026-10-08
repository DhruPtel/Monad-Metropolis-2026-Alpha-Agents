import type { EnvironmentId } from "@alpha-agents/config";
import { z } from "zod";
import { AccountRefSchema } from "./accounts.ts";
import { type AmountRaw, AmountRawSchema, BPS_DENOMINATOR, BpsSchema } from "./amounts.ts";
import { ASSET_ADDRESS_ID, type AssetId, AssetIdSchema } from "./assets.ts";
import { type VerifiedAddress, signingAddress } from "./address-book.ts";
import {
  type ActionId,
  type Address,
  type AgentId,
  type Bytes32,
  ClientRequestIdSchema,
  type ConfigEpoch,
  type OwnerEpoch,
  type UnixSeconds,
} from "./ids.ts";

/**
 * Typed intents: what an agent proposes through `chain.propose_swap` and
 * `chain.propose_rebalance` (FINAL_PLAN 4.4.2). An intent names assets from the
 * enum and amounts; it never carries calldata, a target, a recipient or any
 * address. Every schema is strict, so an unknown field such as `to`, `data` or
 * `calldata` fails validation instead of being dropped.
 *
 * Bounds here are structural. The launch limits (for example 0.5% slippage) live
 * in packages/policy, and at runtime come from the Executor's views.
 */
export const INTENT_SCHEMA_VERSION = 1;

/** Field names no intent may ever carry (FINAL_PLAN 4.4.1, 4.1.7). */
export const FORBIDDEN_INTENT_FIELDS = [
  "to",
  "data",
  "calldata",
  "serializedTransaction",
  "recipient",
  "target",
  "selector",
  "operation",
  "value",
  "address",
  "agentId",
  "owner",
  "wallet",
] as const;

const reason = z.string().trim().min(1).max(500);

const positiveAmount = AmountRawSchema.refine((v) => v > 0n, "must be greater than zero");

export const SwapIntentSchema = z
  .object({
    kind: z.literal("swap"),
    schemaVersion: z.literal(INTENT_SCHEMA_VERSION),
    account: AccountRefSchema,
    sell: AssetIdSchema,
    buy: AssetIdSchema,
    sellAmountRaw: positiveAmount,
    maxSlippageBps: BpsSchema.optional(),
    /** Stored and shown to the owner; never executed. */
    reason,
    clientRequestId: ClientRequestIdSchema,
  })
  .strict()
  .refine((i) => i.sell !== i.buy, { path: ["buy"], message: "must differ from sell" });
export type SwapIntent = z.infer<typeof SwapIntentSchema>;

export const RebalanceTargetSchema = z
  .object({ asset: AssetIdSchema, targetBps: BpsSchema })
  .strict();

export const RebalanceIntentSchema = z
  .object({
    kind: z.literal("rebalance"),
    schemaVersion: z.literal(INTENT_SCHEMA_VERSION),
    account: AccountRefSchema,
    targets: z.array(RebalanceTargetSchema).min(1),
    toleranceBps: BpsSchema.optional(),
    reason,
    clientRequestId: ClientRequestIdSchema,
  })
  .strict()
  .superRefine((i, ctx) => {
    const assets = i.targets.map((t) => t.asset);
    if (new Set(assets).size !== assets.length) {
      ctx.addIssue({ code: "custom", path: ["targets"], message: "each asset may appear once" });
    }
    const total = i.targets.reduce((sum, t) => sum + t.targetBps, 0);
    if (total !== BPS_DENOMINATOR) {
      ctx.addIssue({ code: "custom", path: ["targets"], message: "targetBps must sum to 10000" });
    }
  });
export type RebalanceIntent = z.infer<typeof RebalanceIntentSchema>;
export type RebalanceTarget = z.infer<typeof RebalanceTargetSchema>;

export const IntentSchema = z.union([SwapIntentSchema, RebalanceIntentSchema]);
export type Intent = SwapIntent | RebalanceIntent;

/**
 * The signable form the Executor's `swap(SwapIntent)` takes (FINAL_PLAN 4.1.7).
 * Token fields are VerifiedAddress, so only addresses that passed the fork check
 * can reach a signature; there is no recipient, target, selector, operation or
 * value field.
 */
export interface ExecutorSwapIntent {
  readonly schemaVersion: typeof INTENT_SCHEMA_VERSION;
  readonly chainId: number;
  readonly agentId: AgentId;
  readonly account: Address;
  readonly actionId: ActionId;
  readonly ownerEpoch: OwnerEpoch;
  readonly configEpoch: ConfigEpoch;
  readonly policyHash: Bytes32;
  readonly adapterId: Bytes32;
  readonly tokenIn: VerifiedAddress;
  readonly tokenOut: VerifiedAddress;
  readonly amountIn: AmountRaw;
  readonly minAmountOut: AmountRaw;
  readonly deadline: UnixSeconds;
}

export interface ExecutorSwapContext {
  readonly environment: EnvironmentId;
  readonly chainId: number;
  readonly agentId: AgentId;
  readonly account: Address;
  readonly actionId: ActionId;
  readonly ownerEpoch: OwnerEpoch;
  readonly configEpoch: ConfigEpoch;
  readonly policyHash: Bytes32;
  readonly adapterId: Bytes32;
  readonly minAmountOut: AmountRaw;
  readonly deadline: UnixSeconds;
}

/** The token address to sign with for an asset. Throws if the address is not verified. */
export function signingToken(environment: EnvironmentId, asset: AssetId): VerifiedAddress {
  return signingAddress(environment, ASSET_ADDRESS_ID[asset]);
}

/** Builds the signable Executor intent for a validated swap intent. */
export function toExecutorSwap(intent: SwapIntent, ctx: ExecutorSwapContext): ExecutorSwapIntent {
  return {
    schemaVersion: INTENT_SCHEMA_VERSION,
    chainId: ctx.chainId,
    agentId: ctx.agentId,
    account: ctx.account,
    actionId: ctx.actionId,
    ownerEpoch: ctx.ownerEpoch,
    configEpoch: ctx.configEpoch,
    policyHash: ctx.policyHash,
    adapterId: ctx.adapterId,
    tokenIn: signingToken(ctx.environment, intent.sell),
    tokenOut: signingToken(ctx.environment, intent.buy),
    amountIn: intent.sellAmountRaw,
    minAmountOut: ctx.minAmountOut,
    deadline: ctx.deadline,
  };
}

/**
 * An intent's states (P2-U5): a proposal that passed every pre-check waits for
 * approval, one that did not is rejected with its reason codes, and a waiting
 * one expires if nobody approves it. The trade flow (P2-U6) moves an approved
 * intent through submitted to settled or failed.
 */
export const INTENT_STATES = [
  "awaiting_approval",
  "rejected",
  "expired",
  "approved",
  "submitted",
  "settled",
  "failed",
  "cancelled",
] as const;
export type IntentState = (typeof INTENT_STATES)[number];

export const INTENT_STATE_MEANINGS: Readonly<Record<IntentState, string>> = {
  awaiting_approval: "Passed every check; waits for the owner's approval and is not sent before",
  rejected: "Blocked by the checks when proposed; the reason codes say why",
  expired: "Nobody approved it in time; it will never be sent",
  approved: "Approved; waiting to be sent",
  submitted: "Sent to the chain through the signer",
  settled: "Executed and reconciled",
  failed: "Sent, but did not execute; the reason says why",
  cancelled: "Cancelled before it was sent",
};
