import { ENVIRONMENT_LABELS, type EnvironmentLabel } from "@alpha-agents/config";
import { z } from "zod";
import { AccountKindSchema, AccountRefSchema } from "./accounts.ts";
import { AmountRawSchema, UsdcE6Schema } from "./amounts.ts";
import {
  ActionIdSchema,
  AddressSchema,
  AgentIdSchema,
  Bytes32Schema,
  ClientRequestIdSchema,
  ConfigEpochSchema,
  IntentIdSchema,
  OwnerEpochSchema,
  UnixSecondsSchema,
} from "./ids.ts";
import { IntentSchema } from "./intents.ts";
import { AccountModeSchema, AgentStateSchema, VAULT_ONLY_MODES } from "./modes.ts";
import { REJECTION_CODES } from "./reasons.ts";
import { TierSchema } from "./tiers.ts";

export type { EnvironmentLabel };
export const EnvironmentLabelSchema = z.enum(ENVIRONMENT_LABELS);

/**
 * Every record and event carries the environment it belongs to (BUILD_PLAN build
 * rules; D-030): fork, testnet or mainnet-beta. Records from different
 * environments are never mixed or compared.
 */
const record = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ environment: EnvironmentLabelSchema, ...shape }).strict();

export const AgentRecordSchema = record({
  agentId: AgentIdSchema,
  tier: TierSchema,
  owner: AddressSchema,
  tokenBoundAccount: AddressSchema,
  ownerEpoch: OwnerEpochSchema,
  configEpoch: ConfigEpochSchema,
  state: AgentStateSchema,
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

export const AccountRecordSchema = record({
  agentId: AgentIdSchema,
  kind: AccountKindSchema,
  address: AddressSchema,
  /** Capital accounts have a mode; the funding address has none. */
  mode: AccountModeSchema.nullable(),
}).superRefine((a, ctx) => {
  if (a.kind === "funding_address" && a.mode !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["mode"],
      message: "a funding address has no account mode",
    });
  }
  if (a.kind !== "funding_address" && a.mode === null) {
    ctx.addIssue({
      code: "custom",
      path: ["mode"],
      message: "a capital account always has a mode",
    });
  }
  if (a.kind === "personal_account" && a.mode !== null && VAULT_ONLY_MODES.includes(a.mode)) {
    ctx.addIssue({
      code: "custom",
      path: ["mode"],
      message: `${a.mode} exists only on a StrategyVault`,
    });
  }
});
export type AccountRecord = z.infer<typeof AccountRecordSchema>;

/** Intent lifecycle. A timed-out submission is `unknown`, never `failed`, until reconciled. */
export const INTENT_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "submitted",
  "unknown",
  "settled",
  "failed",
  "expired",
  "cancelled",
] as const;
export const IntentStatusSchema = z.enum(INTENT_STATUSES);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

export const RejectionCodeSchema = z.enum(REJECTION_CODES);

export const IntentRecordSchema = record({
  intentId: IntentIdSchema,
  agentId: AgentIdSchema,
  clientRequestId: ClientRequestIdSchema,
  intent: IntentSchema,
  status: IntentStatusSchema,
  rejections: z.array(RejectionCodeSchema),
  createdAt: UnixSecondsSchema,
});
export type IntentRecord = z.infer<typeof IntentRecordSchema>;

const event = <K extends string, T extends z.ZodRawShape>(type: K, shape: T) =>
  record({ type: z.literal(type), occurredAt: UnixSecondsSchema, ...shape });

/** Chain and ledger events, as the indexer and the ledger record them. */
export const DomainEventSchema = z.discriminatedUnion("type", [
  event("AgentMinted", {
    agentId: AgentIdSchema,
    owner: AddressSchema,
    tier: TierSchema,
    tokenBoundAccount: AddressSchema,
  }),
  event("OwnerEpochBumped", {
    agentId: AgentIdSchema,
    epoch: OwnerEpochSchema,
    from: AddressSchema,
    to: AddressSchema,
  }),
  event("BuildActivated", {
    agentId: AgentIdSchema,
    configEpoch: ConfigEpochSchema,
    buildHash: Bytes32Schema,
  }),
  event("IntentExecuted", {
    actionId: ActionIdSchema,
    account: AccountRefSchema,
    tokenIn: AddressSchema,
    tokenOut: AddressSchema,
    amountIn: AmountRawSchema,
    amountOut: AmountRawSchema,
    navBeforeUsdcE6: UsdcE6Schema,
    navAfterUsdcE6: UsdcE6Schema,
  }),
  event("IntentRejected", { actionId: ActionIdSchema, reasonCode: RejectionCodeSchema }),
  event("CreditsReceived", {
    agentId: AgentIdSchema,
    amountUsdcE6: UsdcE6Schema,
    transactionHash: Bytes32Schema,
  }),
  event("UsageSettled", {
    agentId: AgentIdSchema,
    amountUsdcE6: UsdcE6Schema,
    periodId: z.number().int().nonnegative(),
    usageHash: Bytes32Schema,
  }),
  event("CreditsRefunded", {
    agentId: AgentIdSchema,
    amountUsdcE6: UsdcE6Schema,
    to: AddressSchema,
  }),
  event("CreditsExhausted", { agentId: AgentIdSchema }),
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;

/** Every record schema, so a test can prove each one requires the environment label. */
export const RECORD_SCHEMAS = {
  AgentRecord: AgentRecordSchema,
  AccountRecord: AccountRecordSchema,
  IntentRecord: IntentRecordSchema,
  DomainEvent: DomainEventSchema,
} as const;
