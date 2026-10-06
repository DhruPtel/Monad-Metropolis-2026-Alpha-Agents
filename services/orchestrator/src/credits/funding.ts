import { type Hex, hexToBytes } from "viem";
import { HDKey, type HDAccount, hdKeyToAccount } from "viem/accounts";
import type { Store } from "../store.ts";

/**
 * Funding addresses (D-207): one EOA per agent, derived from the platform's
 * FUNDING_ADDRESS_SEED at m/44'/60'/0'/0/<agentId>. Only the orchestrator
 * holds the seed; everyone else reads the recorded address. A KMS key per
 * agent replaces the seed before the beta (PB-U1).
 */
export const fundingPath = (agentId: number): `m/44'/60'/${string}` => {
  if (!Number.isSafeInteger(agentId) || agentId < 1 || agentId >= 2 ** 31)
    throw new RangeError(`invalid agent ID ${agentId}`);
  return `m/44'/60'/0'/0/${agentId}`;
};

export class FundingKeys {
  private readonly root: HDKey;

  constructor(seed: Hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(seed)) throw new Error("the funding seed must be 32 bytes");
    this.root = HDKey.fromMasterSeed(hexToBytes(seed));
  }

  /** The agent's signing account. Never logged; used only for refunds this unit. */
  account(agentId: number): HDAccount {
    return hdKeyToAccount(this.root, { path: fundingPath(agentId) });
  }

  address(agentId: number): Hex {
    return this.account(agentId).address;
  }
}

/** Records a funding address for every indexed agent that has none; returns how many it added. */
export async function ensureFundingAddresses(
  store: Store,
  keys: FundingKeys,
  chainId: number,
): Promise<number> {
  const missing = await store.db
    .selectFrom("indexer.agents as a")
    .leftJoin("platform.funding_addresses as f", (j) =>
      j.onRef("f.chain_id", "=", "a.chain_id").onRef("f.agent_id", "=", "a.agent_id"),
    )
    .select("a.agent_id")
    .where("a.chain_id", "=", chainId)
    .where("f.agent_id", "is", null)
    .execute();
  for (const { agent_id } of missing) {
    await store.db
      .insertInto("platform.funding_addresses")
      .values({
        chain_id: chainId,
        agent_id,
        address: keys.address(agent_id).toLowerCase(),
        derivation_path: fundingPath(agent_id),
      })
      .onConflict((oc) => oc.columns(["chain_id", "agent_id"]).doNothing())
      .execute();
  }
  return missing.length;
}

export async function fundingAddressOf(
  store: Store,
  chainId: number,
  agentId: number,
): Promise<Hex | null> {
  const row = await store.db
    .selectFrom("platform.funding_addresses")
    .select("address")
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .executeTakeFirst();
  return (row?.address as Hex | undefined) ?? null;
}
