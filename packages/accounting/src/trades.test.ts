import { describe, expect, it } from "vitest";
import { assertJournalEntry, tradeEntry } from "./trades.ts";

const fill = {
  environment: "fork" as const,
  entryId: "00000000-0000-4000-8000-000000000001",
  actionId: `0x${"ab".repeat(32)}` as const,
  occurredAt: 1_790_876_425,
  assetIn: "USDC" as const,
  assetOut: "WMON" as const,
  amountIn: 5_000_000n,
  amountOut: 160_000_000_000_000_000n,
};

describe("trade entries (P2-U4)", () => {
  it("moves each asset between the account and the venue, balanced per asset", () => {
    const e = tradeEntry(fill);
    expect(() => assertJournalEntry(e)).not.toThrow();
    expect(e.kind).toBe("trade");
    expect(e.actionId).toBe(fill.actionId);
    expect(e.lines).toEqual([
      { account: "personal_account", asset: "USDC", amountRaw: -5_000_000n },
      { account: "venue", asset: "USDC", amountRaw: 5_000_000n },
      { account: "venue", asset: "WMON", amountRaw: -160_000_000_000_000_000n },
      { account: "personal_account", asset: "WMON", amountRaw: 160_000_000_000_000_000n },
    ]);
  });

  it("refuses a trade of one asset for itself or of nothing", () => {
    expect(() => tradeEntry({ ...fill, assetOut: "USDC" })).toThrow(RangeError);
    expect(() => tradeEntry({ ...fill, amountOut: 0n })).toThrow(RangeError);
  });

  it("the check refuses an unbalanced entry", () => {
    const e = tradeEntry(fill);
    const broken = { ...e, lines: e.lines.slice(0, 3) };
    expect(() => assertJournalEntry(broken)).toThrow(/WMON lines sum to/);
  });
});
