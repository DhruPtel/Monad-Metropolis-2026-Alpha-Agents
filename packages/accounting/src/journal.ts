import {
  ActionIdSchema,
  AmountRawSchema,
  AssetIdSchema,
  EnvironmentLabelSchema,
  PriceE18Schema,
  UnixSecondsSchema,
  type UsdcE6,
  UsdcE6Schema,
} from "@alpha-agents/domain";
import { z } from "zod";

/**
 * The accounting ledger's journal entries (FINAL_PLAN 3, "the durable action and
 * accounting ledger"). Double entry: every entry's lines sum to zero per asset,
 * so a trade, a deposit or a credit sweep can never create or lose value in the
 * books. Amounts are signed raw token amounts, never floating point.
 */
export const LEDGER_ACCOUNTS = [
  "personal_account",
  "strategy_vault",
  "funding_address",
  "owner_wallet",
  "venue",
  "platform_treasury",
  "gas_treasury",
  // Credits (P1-U6, D-208). Balances are signed: assets positive, what the platform owes
  // negative. funding_address is the USDC the agent's funding address holds;
  // agent_credits is the spendable credit the platform owes the agent; held_deposits is
  // USDC above the beta cap, owed back and not spendable; usage_unsettled is metered usage
  // not yet swept to the treasury.
  "agent_credits",
  "held_deposits",
  "usage_unsettled",
] as const;

/** Accounts that belong to one agent: their lines carry its ID. */
export const AGENT_ACCOUNTS = [
  "funding_address",
  "agent_credits",
  "held_deposits",
  "usage_unsettled",
] as const;

export const JOURNAL_KINDS = [
  "trade",
  "deposit",
  "withdrawal",
  "credits_received",
  "usage_settled",
  "credits_refunded",
  "gas_topup",
  "usage_metered",
  "deposit_held",
  "deposit_reversed",
  "usage_reversed",
] as const;

const signedRaw = z
  .string()
  .regex(/^-?(0|[1-9]\d*)$/, "must be a signed decimal integer string")
  .refine((s) => s !== "-0", "must not be -0")
  .transform((s) => BigInt(s));

/**
 * A registered token the fund agent trades (F-U5): its lowercase address,
 * since the journal names only USDC and WMON by symbol. A line's asset is
 * either, and the entry balances per asset whichever form names it.
 */
export const TokenAssetSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "a lowercase 0x-prefixed 20-byte address");
export type TokenAsset = z.infer<typeof TokenAssetSchema>;
export const JournalAssetSchema = z.union([AssetIdSchema, z.literal("NATIVE"), TokenAssetSchema]);
export type JournalAsset = z.infer<typeof JournalAssetSchema>;

const JournalLineSchema = z
  .object({
    account: z.enum(LEDGER_ACCOUNTS),
    asset: JournalAssetSchema,
    /** Positive into the account, negative out of it. */
    amountRaw: signedRaw,
    /** The agent an agent-scoped account belongs to (AGENT_ACCOUNTS). */
    agentId: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((line, ctx) => {
    const scoped = (AGENT_ACCOUNTS as readonly string[]).includes(line.account);
    if (scoped && line.agentId === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["agentId"],
        message: `${line.account} needs an agentId`,
      });
    if (!scoped && line.agentId !== undefined)
      ctx.addIssue({ code: "custom", path: ["agentId"], message: `${line.account} has no agent` });
  });

export const JournalEntrySchema = z
  .object({
    environment: EnvironmentLabelSchema,
    entryId: z.uuid(),
    /** The Executor action or ledger action this entry records, when there is one. */
    actionId: ActionIdSchema.optional(),
    occurredAt: UnixSecondsSchema,
    kind: z.enum(JOURNAL_KINDS),
    lines: z.array(JournalLineSchema).min(2),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const sums = new Map<string, bigint>();
    for (const line of entry.lines) {
      if (line.amountRaw === 0n)
        ctx.addIssue({ code: "custom", path: ["lines"], message: "a line moves nothing" });
      sums.set(line.asset, (sums.get(line.asset) ?? 0n) + line.amountRaw);
    }
    for (const [asset, sum] of sums) {
      if (sum !== 0n) {
        ctx.addIssue({
          code: "custom",
          path: ["lines"],
          message: `${asset} lines sum to ${sum}, not zero`,
        });
      }
    }
  });
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/**
 * A valuation of one account at one block. NAV is either fresh or unavailable,
 * never a stale number (FINAL_PLAN 6.4): when any price or balance read fails,
 * `navUsdcE6` is null and the reason says why.
 */
const HoldingSchema = z
  .object({
    asset: AssetIdSchema,
    amountRaw: AmountRawSchema,
    priceE18: PriceE18Schema.nullable(),
    valueUsdcE6: UsdcE6Schema.nullable(),
  })
  .strict();

const asOf = z
  .object({ block: z.number().int().nonnegative(), timestamp: UnixSecondsSchema })
  .strict();

export const ValuationSchema = z.discriminatedUnion("status", [
  z
    .object({
      environment: EnvironmentLabelSchema,
      account: z.enum(["personal_account", "strategy_vault"]),
      asOf,
      status: z.literal("fresh"),
      navUsdcE6: UsdcE6Schema,
      holdings: z.array(HoldingSchema),
    })
    .strict()
    .superRefine((v, ctx) => {
      let sum = 0n;
      for (const h of v.holdings) {
        if (h.valueUsdcE6 === null || h.priceE18 === null) {
          ctx.addIssue({
            code: "custom",
            path: ["holdings"],
            message: `${h.asset} has no value in a fresh valuation`,
          });
          return;
        }
        sum += h.valueUsdcE6;
      }
      if (sum !== v.navUsdcE6) {
        ctx.addIssue({
          code: "custom",
          path: ["navUsdcE6"],
          message: `NAV ${v.navUsdcE6} is not the sum of holdings ${sum}`,
        });
      }
    }),
  z
    .object({
      environment: EnvironmentLabelSchema,
      account: z.enum(["personal_account", "strategy_vault"]),
      asOf,
      status: z.literal("unavailable"),
      navUsdcE6: z.null(),
      reason: z.enum(["oracle_stale", "oracle_reverted", "balance_read_failed"]),
      holdings: z.array(HoldingSchema),
    })
    .strict(),
]);
export type Valuation = z.infer<typeof ValuationSchema>;

/** An agent's credits (FINAL_PLAN 4.1.10). All in USDC base units. */
export interface CreditsBalance {
  /** The funding address's onchain USDC balance. */
  readonly balanceUsdcE6: UsdcE6;
  /** Metered usage not yet swept to the treasury. */
  readonly unsettledUsdcE6: UsdcE6;
  /** Open reservations for calls in flight. */
  readonly reservedUsdcE6: UsdcE6;
}

/**
 * Available credits: balance minus unsettled usage minus open reservations,
 * never below zero. Zero means `credits_exhausted` and agent state RESTRICTED.
 */
export function availableCredits(c: CreditsBalance): UsdcE6 {
  const available = c.balanceUsdcE6 - c.unsettledUsdcE6 - c.reservedUsdcE6;
  return (available > 0n ? available : 0n) as UsdcE6;
}

export function creditsExhausted(c: CreditsBalance): boolean {
  return availableCredits(c) === 0n;
}
