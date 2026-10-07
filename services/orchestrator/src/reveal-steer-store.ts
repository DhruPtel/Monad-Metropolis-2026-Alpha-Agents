import { randomUUID } from "node:crypto";
import { type Db, type RevealSteerTable, dbAddress } from "@alpha-agents/db";
import type { SteerOutcome, SteerRecord, SteerStore, SteerTarget } from "./reveal-steer.ts";

/**
 * Steered reveals in Postgres (`platform.reveal_steers`), so a restart of the
 * orchestrator keeps them. Local fork only: nothing creates a steer elsewhere.
 */
type Row = Pick<
  RevealSteerTable,
  | "steer_id"
  | "target_kind"
  | "wallet"
  | "agent_id"
  | "agent_owner"
  | "species"
  | "status"
  | "applied_agent_id"
  | "note"
> & { created_at: Date };

function toRecord(r: Row): SteerRecord {
  const target: SteerTarget =
    r.target_kind === "wallet"
      ? { kind: "wallet", wallet: r.wallet ?? "" }
      : { kind: "agent", agentId: r.agent_id ?? 0, owner: r.agent_owner ?? "" };
  return {
    steerId: r.steer_id,
    target,
    species: r.species,
    status: r.status,
    appliedAgentId: r.applied_agent_id,
    note: r.note,
    createdAt: new Date(r.created_at),
  };
}

const COLUMNS = [
  "steer_id",
  "target_kind",
  "wallet",
  "agent_id",
  "agent_owner",
  "species",
  "status",
  "applied_agent_id",
  "note",
  "created_at",
] as const;

export class DbSteerStore implements SteerStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async pending(chainId: number): Promise<SteerRecord[]> {
    const rows = await this.db
      .selectFrom("platform.reveal_steers")
      .select(COLUMNS)
      .where("chain_id", "=", chainId)
      .where("status", "=", "pending")
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toRecord);
  }

  async recent(chainId: number, limit: number): Promise<SteerRecord[]> {
    const rows = await this.db
      .selectFrom("platform.reveal_steers")
      .select(COLUMNS)
      .where("chain_id", "=", chainId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map(toRecord);
  }

  async create(chainId: number, target: SteerTarget, species: number): Promise<SteerRecord> {
    return this.db.transaction().execute(async (tx) => {
      let cancel = tx
        .updateTable("platform.reveal_steers")
        .set({ status: "cancelled", note: "replaced by a newer choice", resolved_at: new Date() })
        .where("chain_id", "=", chainId)
        .where("status", "=", "pending")
        .where("target_kind", "=", target.kind);
      cancel =
        target.kind === "wallet"
          ? cancel.where("wallet", "=", dbAddress(target.wallet))
          : cancel.where("agent_id", "=", target.agentId);
      await cancel.execute();
      const row = await tx
        .insertInto("platform.reveal_steers")
        .values({
          steer_id: randomUUID(),
          chain_id: chainId,
          target_kind: target.kind,
          wallet: target.kind === "wallet" ? dbAddress(target.wallet) : null,
          agent_id: target.kind === "agent" ? target.agentId : null,
          agent_owner: target.kind === "agent" ? dbAddress(target.owner) : null,
          species,
          status: "pending",
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return toRecord(row);
    });
  }

  async resolve(steerId: string, outcome: SteerOutcome): Promise<boolean> {
    const r = await this.db
      .updateTable("platform.reveal_steers")
      .set({
        status: outcome.status,
        applied_agent_id: outcome.agentId ?? null,
        note: outcome.note,
        resolved_at: new Date(),
      })
      .where("steer_id", "=", steerId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }
}
