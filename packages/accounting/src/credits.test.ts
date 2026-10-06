import { describe, expect, it } from "vitest";
import {
  CREDIT_CAP_USDC_E6,
  agentCredits,
  chargeFor,
  depositEntry,
  keyBudgetUsd,
  refundEntry,
  reversalEntry,
  spendable,
  splitDeposit,
  usageEntry,
  usageReversalEntry,
  usdToPicos,
} from "./credits.ts";
import { JournalEntrySchema } from "./journal.ts";

const base = (n: number) => ({
  environment: "fork" as const,
  entryId: `4f0b8a0e-6c1d-4f1e-9a54-3d2f0c9b7e${n.toString().padStart(2, "0")}`,
  occurredAt: 1_790_000_000,
  agentId: 7,
});
/** Every built entry must pass the journal's own double-entry check. */
const valid = <T>(entry: T) => {
  const parsed = JournalEntrySchema.safeParse({
    ...entry,
    lines: (entry as { lines: { amountRaw: bigint }[] }).lines.map((l) => ({
      ...l,
      amountRaw: l.amountRaw.toString(),
    })),
  });
  if (!parsed.success) throw new Error(parsed.error.message);
  return entry;
};

describe("the price table (Assumption A-27)", () => {
  it("charges provider cost plus 25%, rounded up to a micro-USDC", () => {
    // The H-10 spike's real call: 0.00448 USD at the provider.
    expect(usdToPicos(0.004480000000000002)).toBe(4_480_000_000n);
    expect(chargeFor(4_480_000_000n)).toBe(5_600n);
    expect(chargeFor(1n)).toBe(1n);
    expect(chargeFor(0n)).toBe(0n);
    expect(() => usdToPicos(-1)).toThrow();
    expect(() => usdToPicos(Number.NaN)).toThrow();
  });

  it("gives a key exactly the provider cost the remaining credits buy", () => {
    expect(keyBudgetUsd(0n, 5_000_000n)).toBe(4);
    // Already metered 0.00448, and 1.25 USDC left: 0.00448 + 1.
    expect(keyBudgetUsd(4_480_000_000n, 1_250_000n)).toBeCloseTo(1.00448, 10);
    // At zero (or overdrawn) the budget is what was already spent: the next call is refused.
    expect(keyBudgetUsd(4_480_000_000n, 0n)).toBeCloseTo(0.00448, 10);
    expect(keyBudgetUsd(4_480_000_000n, -10n)).toBeCloseTo(0.00448, 10);
  });
});

describe("the beta cap (Assumption A-28)", () => {
  it("credits up to the cap and holds the rest", () => {
    expect(splitDeposit(10_000_000n, 0n)).toEqual({ credited: 10_000_000n, held: 0n });
    expect(splitDeposit(10_000_000n, 45_000_000n)).toEqual({
      credited: 5_000_000n,
      held: 5_000_000n,
    });
    expect(splitDeposit(10_000_000n, CREDIT_CAP_USDC_E6)).toEqual({
      credited: 0n,
      held: 10_000_000n,
    });
    // An overdrawn agent: the deposit fills the overdraft first, all of it credited.
    expect(splitDeposit(1_000_000n, -500n)).toEqual({ credited: 1_000_000n, held: 0n });
    expect(() => splitDeposit(0n, 0n)).toThrow();
  });
});

describe("credit journal entries balance (D-208)", () => {
  it("builds valid double entries and keeps the funding address equal to what is owed", () => {
    const entries = [
      valid(depositEntry(base(1), 45_000_000n, 0n)),
      valid(depositEntry(base(2), 5_000_000n, 3_000_000n)),
      valid(usageEntry(base(3), 5_600n)),
    ];
    expect(entries[1]?.kind).toBe("deposit_held");
    let c = agentCredits(entries.flatMap((e) => e.lines));
    expect(c).toEqual({
      credits: 49_994_400n,
      held: 3_000_000n,
      unsettled: 5_600n,
      fundingAddress: 53_000_000n,
    });
    expect(c.fundingAddress).toBe(c.credits + c.held + c.unsettled);
    expect(spendable(c)).toBe(49_994_400n);

    entries.push(valid(refundEntry(base(4), c.credits, c.held)));
    c = agentCredits(entries.flatMap((e) => e.lines));
    expect(c).toEqual({ credits: 0n, held: 0n, unsettled: 5_600n, fundingAddress: 5_600n });
    expect(spendable(c)).toBe(0n);
  });

  it("reverses a deposit exactly", () => {
    const deposit = depositEntry(base(5), 2_000_000n, 0n);
    const reversal = valid(reversalEntry(base(6), deposit));
    expect(agentCredits([...deposit.lines, ...reversal.lines])).toEqual({
      credits: 0n,
      held: 0n,
      unsettled: 0n,
      fundingAddress: 0n,
    });
  });

  it("reverses a tool call's usage charge exactly", () => {
    const deposit = depositEntry(base(10), 1_000_000n, 0n);
    const charge = usageEntry(base(11), 10_000n);
    const back = valid(usageReversalEntry(base(12), 10_000n));
    expect(back.kind).toBe("usage_reversed");
    expect(agentCredits([...deposit.lines, ...charge.lines, ...back.lines])).toEqual({
      credits: 1_000_000n,
      held: 0n,
      unsettled: 0n,
      fundingAddress: 1_000_000n,
    });
  });

  it("never shows an overdrawn agent as having credits", () => {
    const c = agentCredits([
      ...depositEntry(base(7), 1_000n, 0n).lines,
      ...usageEntry(base(8), 1_500n).lines,
    ]);
    expect(c.credits).toBe(-500n);
    expect(spendable(c)).toBe(0n);
  });

  it("refuses an agent account line without its agent, and an agent on a platform account", () => {
    const bad = {
      ...usageEntry(base(9), 10n),
      lines: [
        { account: "agent_credits", asset: "USDC", amountRaw: "10" },
        { account: "usage_unsettled", asset: "USDC", amountRaw: "-10", agentId: 7 },
      ],
    };
    expect(JournalEntrySchema.safeParse(bad).success).toBe(false);
    const wrong = {
      ...bad,
      lines: [
        { account: "venue", asset: "USDC", amountRaw: "10", agentId: 7 },
        { account: "usage_unsettled", asset: "USDC", amountRaw: "-10", agentId: 7 },
      ],
    };
    expect(JournalEntrySchema.safeParse(wrong).success).toBe(false);
  });
});
