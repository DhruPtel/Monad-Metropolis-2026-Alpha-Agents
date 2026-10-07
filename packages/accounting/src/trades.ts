import type { AssetId } from "@alpha-agents/domain";
import { type JournalEntry, JournalEntrySchema } from "./journal.ts";

/**
 * A reconciled swap (P2-U4): the account pays `amountIn` of one asset to the
 * venue and receives `amountOut` of the other. Written only after the signer
 * has matched the Executor's event against the account's balance deltas, so
 * the ledger never records a trade the chain does not show.
 */
export interface TradeFill {
  readonly environment: JournalEntry["environment"];
  readonly entryId: string;
  readonly actionId: `0x${string}`;
  readonly occurredAt: number;
  readonly assetIn: AssetId;
  readonly assetOut: AssetId;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export function tradeEntry(f: TradeFill): JournalEntry {
  if (f.assetIn === f.assetOut) throw new RangeError("a trade swaps two different assets");
  if (f.amountIn <= 0n || f.amountOut <= 0n) throw new RangeError("a trade moves both assets");
  return {
    environment: f.environment,
    entryId: f.entryId,
    actionId: f.actionId as JournalEntry["actionId"],
    occurredAt: f.occurredAt,
    kind: "trade",
    lines: [
      { account: "personal_account", asset: f.assetIn, amountRaw: -f.amountIn },
      { account: "venue", asset: f.assetIn, amountRaw: f.amountIn },
      { account: "venue", asset: f.assetOut, amountRaw: -f.amountOut },
      { account: "personal_account", asset: f.assetOut, amountRaw: f.amountOut },
    ],
  };
}

/** Throws unless the entry is balanced and well formed (the journal schema). */
export function assertJournalEntry(entry: JournalEntry): void {
  const parsed = JournalEntrySchema.safeParse({
    ...entry,
    lines: entry.lines.map((l) => ({ ...l, amountRaw: l.amountRaw.toString() })),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`refusing an unbalanced or malformed ledger entry: ${issues.join("; ")}`);
  }
}
