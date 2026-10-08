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
 * An intent's states (P2-U5, P2-U6): a proposal that passed every pre-check
 * waits for approval, one that did not is rejected with its reason codes, and
 * a waiting one expires if nobody approves it. Once approved (by the owner, or
 * automatically when the agent is armed) the trade flow re-checks it and sends
 * it through the signer: submitted, confirmed when its receipt is in, and
 * reconciled (settled) only when the outbox matched the Executor's event to the
 * account's balances, at the finalized block off the fork. A trade refused at
 * submission, or one that reverted, is failed with its reason.
 */
export const INTENT_STATES = [
  "awaiting_approval",
  "approved",
  "submitted",
  "confirmed",
  "reconciled",
  "rejected",
  "expired",
  "failed",
  "cancelled",
] as const;
export type IntentState = (typeof INTENT_STATES)[number];

export const INTENT_STATE_MEANINGS: Readonly<Record<IntentState, string>> = {
  awaiting_approval: "Passed every check; waits for the owner's approval and is not sent before",
  approved: "Approved; checked again and sent at once",
  submitted: "Sent to the chain through the signer; waiting for its receipt",
  confirmed: "Executed on chain; waiting for reconciliation",
  reconciled: "Settled: the account's balances match the trade, in the ledger",
  rejected: "Blocked by the checks when proposed; the reason codes say why",
  expired: "Nobody approved it in time; it will never be sent",
  failed: "Refused when it was to be sent, or did not execute; the reason says why",
  cancelled: "Cancelled before it was sent",
};

/** The states in which an intent holds a trade slot in the rolling window (P2-U6). */
export const SLOT_HOLDING_INTENT_STATES: readonly IntentState[] = [
  "awaiting_approval",
  "approved",
  "submitted",
];

/**
 * An agent's arming (P2-U6, FINAL_PLAN 4.6.3): unarmed; armed by its owner's
 * session grant and waiting for the owner to approve a first trade; armed,
 * when passing proposals execute automatically. It ends on the grant's expiry,
 * a sale, a configuration change, a revoked grant or the owner's disarm.
 */
export const ARMING_STATES = ["unarmed", "awaiting_first_trade", "armed"] as const;
export type ArmingState = (typeof ARMING_STATES)[number];

export const ARMING_STATE_MEANINGS: Readonly<Record<ArmingState, string>> = {
  unarmed: "Every proposal waits for the owner's approval",
  awaiting_first_trade: "Trading permission granted; the owner approves the first trade to arm it",
  armed: "Proposals within the hard limits execute automatically",
};

export const ARMING_END_REASONS = [
  "expired",
  "sold",
  "config_changed",
  "revoked",
  "disarmed",
] as const;
export type ArmingEndReason = (typeof ARMING_END_REASONS)[number];

export const ARMING_END_MESSAGES: Readonly<Record<ArmingEndReason, string>> = {
  expired: "The trading permission expired; the owner renews it to arm the agent again.",
  sold: "The agent changed hands, which ends every trading permission.",
  config_changed: "The agent's configuration changed, which ends its trading permission.",
  revoked: "The trading permission was revoked on chain.",
  disarmed: "The owner disarmed the agent.",
};

/**
 * Reasons the trade flow gives that are not the Executor's (REJECTION_CODES
 * mirrors the Executor's enum and cannot grow without it): a funding address
 * with no MON for gas blocks a trade before it is sent (P2-EC notes, A-19); an
 * agent that is not armed waits for its owner; a trade the chain or the signer
 * did not carry out failed on the way; a trade proposed under an earlier goal
 * is never sent (the strategy epoch moved, D-281).
 */
export const TRADE_FLOW_CODES = [
  "GAS_UNFUNDED",
  "NOT_ARMED",
  "SEND_FAILED",
  "STRATEGY_EPOCH_STALE",
] as const;
export type TradeFlowCode = (typeof TRADE_FLOW_CODES)[number];

export const TRADE_FLOW_MESSAGES: Readonly<Record<TradeFlowCode, string>> = {
  GAS_UNFUNDED: "The agent's funding address has no MON to pay gas for the trade.",
  NOT_ARMED: "The agent is not armed, so each trade waits for the owner's approval.",
  SEND_FAILED: "The trade was sent but did not go through on chain.",
  STRATEGY_EPOCH_STALE:
    "The owner changed the agent's goal after this trade was proposed, so it was not sent.",
};
