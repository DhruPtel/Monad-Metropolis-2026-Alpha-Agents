import type { Db } from "@alpha-agents/db";
import { type OwnerKeyView, type PaidDataSourceId, keyHint } from "@alpha-agents/domain";
import type { Hex } from "viem";
import { openSecret, sealSecret } from "./sealed.ts";

/**
 * An owner's own keys for paid data sources (BK-U1): one sealed row per
 * agent and source. The list never carries the key or its ciphertext; `open`
 * is for the platform's tool servers alone, which use the key for that
 * agent's calls and never hand it to the sandbox.
 */
export class OwnerKeyStore {
  readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** What the owner sees: present or not, the hint, when it was added; never the key. */
  async list(chainId: number, agentId: number): Promise<OwnerKeyView[]> {
    const rows = await this.db
      .selectFrom("platform.owner_keys")
      .select(["provider", "key_hint", "added_at"])
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .execute();
    return rows.map((r) => ({
      provider: r.provider,
      present: true,
      hint: r.key_hint,
      addedAt: r.added_at.toISOString(),
    }));
  }

  /** Seals and stores the key; a key already stored for the source is replaced. */
  async save(a: {
    chainId: number;
    agentId: number;
    provider: PaidDataSourceId;
    key: string;
    secret: string;
    addedBy: Hex;
  }): Promise<OwnerKeyView> {
    const at = this.now();
    const row = await this.db
      .insertInto("platform.owner_keys")
      .values({
        chain_id: a.chainId,
        agent_id: a.agentId,
        provider: a.provider,
        ciphertext: sealSecret(a.key, a.secret),
        key_hint: keyHint(a.key),
        added_by: a.addedBy.toLowerCase(),
        added_at: at,
        updated_at: at,
      })
      .onConflict((oc) =>
        oc.columns(["chain_id", "agent_id", "provider"]).doUpdateSet({
          ciphertext: sealSecret(a.key, a.secret),
          key_hint: keyHint(a.key),
          added_by: a.addedBy.toLowerCase(),
          added_at: at,
          updated_at: at,
        }),
      )
      .returning(["provider", "key_hint", "added_at"])
      .executeTakeFirstOrThrow();
    return {
      provider: row.provider,
      present: true,
      hint: row.key_hint,
      addedAt: row.added_at.toISOString(),
    };
  }

  /** The key itself, for the platform's tool servers; null when none is stored. */
  async open(
    chainId: number,
    agentId: number,
    provider: PaidDataSourceId,
    secret: string,
  ): Promise<string | null> {
    const row = await this.db
      .selectFrom("platform.owner_keys")
      .select("ciphertext")
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("provider", "=", provider)
      .executeTakeFirst();
    return row ? openSecret(row.ciphertext, secret) : null;
  }

  /** Deletes the key outright: nothing of it stays. Returns false when there was none. */
  async remove(chainId: number, agentId: number, provider: PaidDataSourceId): Promise<boolean> {
    const r = await this.db
      .deleteFrom("platform.owner_keys")
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("provider", "=", provider)
      .executeTakeFirst();
    return Number(r.numDeletedRows) > 0;
  }
}
