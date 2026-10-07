import type { Kysely } from "kysely";
import type { Database } from "./schema.ts";

/**
 * One contributor's weights in an agent's credits (D-242), shaped like
 * @alpha-agents/accounting's ContributionWeights: the USDC each sender sent to
 * the funding address, from the index, and the basis of the refunds already
 * signed or sent (a reverted refund consumed nothing). Shared by the
 * orchestrator, which pays a refund, and the control API, which shows it.
 */
export async function readContributionWeights(
  db: Kysely<Database>,
  chainId: number,
  agentId: number,
  contributor: string,
): Promise<{
  contributed: bigint;
  consumed: bigint;
  totalContributed: bigint;
  totalConsumed: bigint;
}> {
  const sent = await db
    .selectFrom("indexer.usdc_transfers")
    .select(["from_address", "value"])
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .where("account", "=", "funding")
    .where("direction", "=", "in")
    .execute();
  const refunded = await db
    .selectFrom("platform.refunds")
    .select(["owner", "contribution_basis_usdc_e6"])
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .where("status", "in", ["signed", "sent"])
    .execute();
  const who = contributor.toLowerCase();
  let contributed = 0n;
  let totalContributed = 0n;
  for (const t of sent) {
    const v = BigInt(t.value);
    totalContributed += v;
    if (t.from_address.toLowerCase() === who) contributed += v;
  }
  let consumed = 0n;
  let totalConsumed = 0n;
  for (const r of refunded) {
    const b = BigInt(r.contribution_basis_usdc_e6 ?? "0");
    totalConsumed += b;
    if (r.owner.toLowerCase() === who) consumed += b;
  }
  return { contributed, consumed, totalContributed, totalConsumed };
}
