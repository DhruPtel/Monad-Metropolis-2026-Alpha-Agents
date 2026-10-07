import type { Kysely } from "kysely";
import type { Database } from "./schema.ts";

/** A journal entry ready to store: already checked by @alpha-agents/accounting's schema. */
export interface JournalRow {
  readonly entryId: string;
  readonly chainId: number;
  readonly agentId: number;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly source: Record<string, unknown>;
  readonly lines: readonly {
    readonly account: string;
    readonly asset: string;
    readonly amount: bigint;
    readonly agentId: number | null;
  }[];
}

/**
 * Writes one ledger entry and its lines, once per idempotency key. Run it
 * inside the caller's transaction so the entry lands with the state change it
 * records (a refund's signed transfer, a swap's reconciliation). Returns false,
 * having written nothing, when the key was already posted.
 */
export async function insertJournal(db: Kysely<Database>, e: JournalRow): Promise<boolean> {
  const inserted = await db
    .insertInto("platform.ledger_entries")
    .values({
      entry_id: e.entryId,
      chain_id: e.chainId,
      agent_id: e.agentId,
      kind: e.kind,
      idempotency_key: e.idempotencyKey,
      occurred_at: e.occurredAt,
      source: JSON.stringify(e.source),
    })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .returning("entry_id")
    .executeTakeFirst();
  if (!inserted) return false;
  await db
    .insertInto("platform.ledger_lines")
    .values(
      e.lines.map((l, i) => ({
        entry_id: e.entryId,
        line_no: i,
        chain_id: e.chainId,
        agent_id: l.agentId,
        account: l.account,
        asset: l.asset,
        amount: l.amount.toString(),
      })),
    )
    .execute();
  return true;
}
