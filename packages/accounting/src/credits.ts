import type { UsdcE6 } from "@alpha-agents/domain";
import type { JournalEntry } from "./journal.ts";

/**
 * Credits arithmetic (P1-U6, FINAL_PLAN 4.1.10 and 4.3.5): the price table,
 * the beta cap, the budget a gateway key gets, and the double-entry entries
 * for deposits, usage, refunds and reversals. Pure functions over integers:
 * USDC base units (6 decimals) and provider cost in picodollars, never floats
 * once a value enters here.
 *
 * Signs follow the journal: assets positive, what the platform owes negative.
 * For one agent, at every point:
 *   funding_address = credits + held + unsettled (as positive amounts owed)
 * which is the onchain USDC the funding address must hold until sweeps exist.
 */

/** Assumption A-27 (Q-09 open): model calls cost provider cost plus 25%, 1 USD = 1 USDC. */
export const CREDIT_MARKUP_BPS = 12_500n;
/** Assumption A-28: the beta cap on an agent's spendable credits, 50 USDC (D-144 beta guard). */
export const CREDIT_CAP_USDC_E6 = 50_000_000n as UsdcE6;

/** D-222: a Scan runs only with at least this much spendable (0.15 USDC, A-31's low end). */
export const SCAN_MIN_CREDITS_USDC_E6 = 150_000n as UsdcE6;
/** A-31: what a Scan costs, measured in P1-U7's live run, shown before an owner runs one. */
export const SCAN_COST_ESTIMATE_USDC_E6 = {
  low: 150_000n as UsdcE6,
  high: 300_000n as UsdcE6,
} as const;

const PICOS_PER_MICRO = 1_000_000n;

/** A LiteLLM cost in USD (a float in its API) as integer picodollars. */
export function usdToPicos(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`invalid cost ${usd}`);
  return BigInt(Math.round(usd * 1e12));
}

/** What a call costs in credits: provider cost with the markup, rounded up to a micro-USDC. */
export function chargeFor(providerPicos: bigint): UsdcE6 {
  const denom = 10_000n * PICOS_PER_MICRO;
  return ((providerPicos * CREDIT_MARKUP_BPS + denom - 1n) / denom) as UsdcE6;
}

/**
 * The gateway budget, in USD, for a key already charged for `meteredPicos` of
 * provider cost: that spend plus what the remaining credits buy at provider
 * cost. LiteLLM's own spend counter runs ahead of the metered logs, so its
 * headroom is exactly the credits not yet charged (rounded down).
 */
export function keyBudgetUsd(meteredPicos: bigint, availableE6: bigint): number {
  const buyable =
    availableE6 > 0n ? (availableE6 * PICOS_PER_MICRO * 10_000n) / CREDIT_MARKUP_BPS : 0n;
  return Number(meteredPicos + buyable) / 1e12;
}

export interface AgentCredits {
  /** Spendable credits; negative when a last call overshot (filled first by the next deposit). */
  readonly credits: bigint;
  /** Deposits above the cap, held at the funding address and returned by a refund. */
  readonly held: bigint;
  /** Metered usage not yet swept to the treasury. */
  readonly unsettled: bigint;
  /** USDC the ledger says the funding address holds. */
  readonly fundingAddress: bigint;
}

/** Spendable credits, never below zero. Zero means credits_exhausted (D-129). */
export const spendable = (c: AgentCredits): UsdcE6 => (c.credits > 0n ? c.credits : 0n) as UsdcE6;

/** How a deposit splits between credits and the held balance under the cap. */
export function splitDeposit(amount: bigint, credits: bigint, cap: bigint = CREDIT_CAP_USDC_E6) {
  if (amount <= 0n) throw new RangeError("a deposit is positive");
  const room = cap - credits > 0n ? cap - credits : 0n;
  const credited = amount < room ? amount : room;
  return { credited, held: amount - credited };
}

interface Base {
  readonly environment: JournalEntry["environment"];
  readonly entryId: string;
  readonly occurredAt: number;
  readonly agentId: number;
}

type Account = JournalEntry["lines"][number]["account"];
const line = (account: Account, amount: bigint, agentId: number) => ({
  account,
  asset: "USDC" as const,
  amountRaw: amount,
  agentId,
});

/** USDC received at the funding address: credited up to the cap, the rest held. */
export function depositEntry(b: Base, credited: bigint, held: bigint): JournalEntry {
  return {
    environment: b.environment,
    entryId: b.entryId,
    occurredAt: b.occurredAt,
    kind: held > 0n ? "deposit_held" : "credits_received",
    lines: [
      line("funding_address", credited + held, b.agentId),
      ...(credited > 0n ? [line("agent_credits", -credited, b.agentId)] : []),
      ...(held > 0n ? [line("held_deposits", -held, b.agentId)] : []),
    ],
  };
}

/** Metered usage: credits owed to the agent become usage owed to the platform. */
export function usageEntry(b: Base, charge: bigint): JournalEntry {
  return {
    environment: b.environment,
    entryId: b.entryId,
    occurredAt: b.occurredAt,
    kind: "usage_metered",
    lines: [line("agent_credits", charge, b.agentId), line("usage_unsettled", -charge, b.agentId)],
  };
}

/** Takes back a usage charge for a call that was not served (D-215): the usage entry negated. */
export function usageReversalEntry(b: Base, charge: bigint): JournalEntry {
  return { ...usageEntry(b, -charge), kind: "usage_reversed" };
}

/** A refund: the credits and held balance leave the funding address for the owner. */
export function refundEntry(b: Base, credits: bigint, held: bigint): JournalEntry {
  return {
    environment: b.environment,
    entryId: b.entryId,
    occurredAt: b.occurredAt,
    kind: "credits_refunded",
    lines: [
      ...(credits > 0n ? [line("agent_credits", credits, b.agentId)] : []),
      ...(held > 0n ? [line("held_deposits", held, b.agentId)] : []),
      line("funding_address", -(credits + held), b.agentId),
    ],
  };
}

/** Reverses an entry whose source left the chain (a reorg): every line negated. */
export function reversalEntry(b: Omit<Base, "agentId">, original: JournalEntry): JournalEntry {
  return {
    environment: b.environment,
    entryId: b.entryId,
    occurredAt: b.occurredAt,
    kind: "deposit_reversed",
    lines: original.lines.map((l) => ({ ...l, amountRaw: -l.amountRaw })),
  };
}

/** Balances of one agent's accounts from its journal lines. */
export function agentCredits(
  lines: readonly { account: string; amountRaw: bigint }[],
): AgentCredits {
  const sum = (account: string) =>
    lines.filter((l) => l.account === account).reduce((a, l) => a + l.amountRaw, 0n);
  return {
    credits: -sum("agent_credits"),
    held: -sum("held_deposits"),
    unsettled: -sum("usage_unsettled"),
    fundingAddress: sum("funding_address"),
  };
}
