import { type AgentCredits, type JournalEntry, JournalEntrySchema } from "@alpha-agents/accounting";
import { type Db, insertJournal, sql } from "@alpha-agents/db";

/**
 * The credit ledger in Postgres (D-208). Every entry is checked by
 * packages/accounting's journal schema (lines sum to zero, agent accounts name
 * their agent) before it is written, and carries an idempotency key from its
 * source, so posting the same deposit, request or refund twice writes it once.
 */
/** A transaction: Kysely's Transaction is a Kysely, so it is used as a Db. */
type Trx = Db;

export interface PostMeta {
  readonly chainId: number;
  readonly agentId: number;
  readonly idempotencyKey: string;
  readonly source: Record<string, unknown>;
}

export class Ledger {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Writes an entry once. `alsoWrite` runs in the same transaction (a usage
   * receipt, a refund's signed transaction). Returns false when the key was
   * already posted, and then writes nothing at all.
   */
  async post(
    entry: JournalEntry,
    meta: PostMeta,
    alsoWrite?: (trx: Trx) => Promise<void>,
  ): Promise<boolean> {
    const parsed = JournalEntrySchema.safeParse({
      ...entry,
      lines: entry.lines.map((l) => ({ ...l, amountRaw: l.amountRaw.toString() })),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`refusing an unbalanced or malformed ledger entry: ${issues.join("; ")}`);
    }
    return this.db.transaction().execute(async (trx) => {
      const written = await insertJournal(trx, {
        entryId: entry.entryId,
        chainId: meta.chainId,
        agentId: meta.agentId,
        kind: entry.kind,
        idempotencyKey: meta.idempotencyKey,
        occurredAt: new Date(entry.occurredAt * 1000),
        source: meta.source,
        lines: entry.lines.map((l) => ({
          account: l.account,
          asset: l.asset,
          amount: l.amountRaw,
          agentId: l.agentId ?? null,
        })),
      });
      if (!written) return false;
      if (alsoWrite) await alsoWrite(trx);
      return true;
    });
  }

  async posted(idempotencyKey: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("platform.ledger_entries")
      .select("entry_id")
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** One agent's balances, summed from its lines. */
  async balances(chainId: number, agentId: number): Promise<AgentCredits> {
    const rows = await this.db
      .selectFrom("platform.ledger_lines")
      .select(["account", sql<string>`sum(amount)`.as("total")])
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .groupBy("account")
      .execute();
    const sum = (account: string) => BigInt(rows.find((r) => r.account === account)?.total ?? "0");
    return {
      credits: -sum("agent_credits"),
      held: -sum("held_deposits"),
      unsettled: -sum("usage_unsettled"),
      fundingAddress: sum("funding_address"),
    };
  }

  /** Whether every entry in the ledger balances: the sum of all lines per asset is zero. */
  async balanced(chainId: number): Promise<boolean> {
    const rows = await this.db
      .selectFrom("platform.ledger_lines")
      .select(["asset", sql<string>`sum(amount)`.as("total")])
      .where("chain_id", "=", chainId)
      .groupBy("asset")
      .execute();
    return rows.every((r) => BigInt(r.total) === 0n);
  }

  /** The agent's most recent entries, newest first, with their net effect on credits. */
  async recent(chainId: number, agentId: number, limit = 20) {
    const rows = await this.db
      .selectFrom("platform.ledger_entries as e")
      .leftJoin("platform.ledger_lines as l", (j) =>
        j.onRef("l.entry_id", "=", "e.entry_id").on("l.account", "=", "agent_credits"),
      )
      .select([
        "e.entry_id",
        "e.kind",
        "e.occurred_at",
        "e.source",
        sql<string | null>`sum(l.amount)`.as("credits_delta"),
      ])
      .where("e.chain_id", "=", chainId)
      .where("e.agent_id", "=", agentId)
      .groupBy(["e.entry_id", "e.kind", "e.occurred_at", "e.source", "e.created_at"])
      .orderBy("e.created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      entryId: r.entry_id,
      kind: r.kind,
      occurredAt: r.occurred_at,
      source: r.source,
      // Lines store what the platform owes as negative; flip so a deposit reads positive.
      creditsDelta: r.credits_delta === null ? 0n : -BigInt(r.credits_delta),
    }));
  }
}

export type { Trx };
