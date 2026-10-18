import type { Db } from "@alpha-agents/db";
import { type GasSweep, SWAP_GAS_LIMIT } from "@alpha-agents/signer";

/**
 * 2026-10-18 (owner): on the testnet stacks an agent's key keeps at most one
 * leg's most gas cost; the rest goes back to the deployer that topped it up.
 * A pass every minute: each key with no trade on its way keeps the most its
 * largest recent swap can cost at today's fees, and the signer sweeps the rest
 * (Signer.sweepGas, which leaves alone a key with a transaction in flight or
 * one sent in the last 30 seconds). A key the next leg finds short is topped
 * up again (trade-flow.ts), so a sweep never stops a trade.
 */

/** Below this a sweep is not worth its own gas (a transfer costs about 0.002 MON on Monad testnet). */
export const SWEEP_MIN_WEI = 10n ** 16n;
/** The swaps a key's largest recent limit is read from. */
const RECENT_SWAPS = 10;

export interface SweepKey {
  readonly agentId: number;
  /** A trade is approved or on its way: the trade flow needs the key's gas now. */
  readonly busy: boolean;
  /** The largest gas limit of the key's recent swaps, if any. */
  readonly largestGas: bigint | null;
}

export interface GasSweeperOptions {
  readonly keys: () => Promise<readonly SweepKey[]>;
  readonly sweep: (agentId: number, o: { keepWei: bigint; minWei: bigint }) => Promise<GasSweep>;
  /** One swap's most cost at this limit and today's fees, as the trade flow prices it. */
  readonly swapCost: (gas: bigint) => Promise<bigint>;
  readonly log: (line: string) => void;
}

export interface SweepOutcome {
  readonly agentId: number;
  readonly keepWei: bigint;
  readonly result: GasSweep;
}

export async function sweepPass(o: GasSweeperOptions): Promise<SweepOutcome[]> {
  const out: SweepOutcome[] = [];
  for (const k of await o.keys()) {
    if (k.busy) continue;
    const keepWei = await o.swapCost(k.largestGas ?? SWAP_GAS_LIMIT);
    try {
      const result = await o.sweep(k.agentId, { keepWei, minWei: SWEEP_MIN_WEI });
      out.push({ agentId: k.agentId, keepWei, result });
      if (result.swept)
        o.log(
          `gas sweep: agent ${k.agentId} returned ${result.wei} wei to the deployer and keeps ${result.kept} (one leg at most ${keepWei}) (${result.hash})`,
        );
    } catch (err) {
      o.log(
        `gas sweep: agent ${k.agentId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** The keys on this chain, whether a trade is on its way, and their largest recent swap limit. */
export async function sweepKeysFrom(db: Db, chainId: number): Promise<SweepKey[]> {
  const keys = await db
    .selectFrom("platform.signer_keys")
    .select(["agent_id", "address"])
    .where("chain_id", "=", chainId)
    .orderBy("agent_id")
    .execute();
  const busy = new Set(
    (
      await db
        .selectFrom("platform.intents")
        .select("agent_id")
        .where("chain_id", "=", chainId)
        .where("status", "in", ["approved", "submitted", "confirmed"])
        .execute()
    ).map((r) => r.agent_id),
  );
  const out: SweepKey[] = [];
  for (const k of keys) {
    const recent = await db
      .selectFrom("platform.signer_outbox")
      .select("gas_limit")
      .where("chain_id", "=", chainId)
      .where("key_address", "=", k.address)
      .where("kind", "=", "executor_swap")
      .where("gas_limit", "is not", null)
      .orderBy("created_at", "desc")
      .limit(RECENT_SWAPS)
      .execute();
    const limits = recent.map((r) => BigInt(r.gas_limit as string));
    out.push({
      agentId: k.agent_id,
      busy: busy.has(k.agent_id),
      largestGas: limits.length > 0 ? limits.reduce((a, b) => (a > b ? a : b)) : null,
    });
  }
  return out;
}
