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

describe("trade entries for registered tokens (F-U5)", () => {
  it("names a token by its lowercase address and balances per asset", () => {
    const cbbtc = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
    const entry = tradeEntry({
      environment: "fork",
      entryId: "7b6a2a9e-2f6c-4f3b-9a1d-2f3e4d5c6b7a",
      actionId: `0x${"ab".repeat(32)}`,
      occurredAt: 1_790_000_000,
      assetIn: "USDC",
      assetOut: cbbtc,
      amountIn: 5_000_000n,
      amountOut: 4_001n,
    });
    expect(() => assertJournalEntry(entry)).not.toThrow();
    expect(entry.lines.map((l) => l.asset)).toEqual(["USDC", "USDC", cbbtc, cbbtc]);
    expect(() =>
      assertJournalEntry({
        ...entry,
        lines: entry.lines.map((l) => ({ ...l, asset: cbbtc.toUpperCase() })),
      }),
    ).toThrow(/malformed/);
  });
});
