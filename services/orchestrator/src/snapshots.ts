import type { ChainReader } from "@alpha-agents/chain-tools";
import { ACCOUNT_MODES, type AccountMode } from "@alpha-agents/domain";
import { SNAPSHOT_INTERVAL_MS, type SnapshotStore } from "@alpha-agents/trading";
import type { Store } from "./store.ts";

/**
 * Records value snapshots (Phase 2 tuning) for W-3's charts: an interval pass
 * over the indexed agents that have a PersonalAccount, each at most once per
 * interval (the database says which are due before anything is read), and one
 * snapshot after every settled trade. Each reads what the portfolio route
 * reads for the account (its balances and mode) and the oracle's MON price,
 * which the chain tools' reader caches across agents.
 */
export interface SnapshotRecorderOptions {
  readonly chainId: number;
  readonly store: Store;
  readonly snapshots: SnapshotStore;
  readonly reader: ChainReader;
  readonly everyMs?: number;
  readonly log: (line: string) => void;
}

const isMode = (m: string): m is AccountMode => (ACCOUNT_MODES as readonly string[]).includes(m);

export class SnapshotRecorder {
  private readonly o: SnapshotRecorderOptions;
  /** When each agent was last read, so an agent with no account is not re-read every pass. */
  private readonly checked = new Map<number, number>();

  constructor(o: SnapshotRecorderOptions) {
    this.o = o;
  }

  /** Reads one account and records it; false when the agent has no account (or no known mode). */
  async observe(agentId: number, reason: "interval" | "trade", intentId: string | null = null) {
    const [a, m] = await Promise.all([this.o.reader.agent(agentId), this.o.reader.market()]);
    if (!a?.account || !isMode(a.mode)) return false;
    return this.o.snapshots.record(
      this.o.chainId,
      {
        agentId,
        account: a.account,
        block: a.block,
        timestamp: a.timestamp,
        usdc: a.usdc,
        wmon: a.wmon,
        mode: a.mode,
        monUsdE18: m.monUsd.reason === "OK" ? m.monUsd.priceE18 : null,
      },
      reason,
      intentId,
    );
  }

  /** One interval pass: every indexed agent whose snapshot is due. Returns how many were recorded. */
  async tick(): Promise<number> {
    const agents = await this.o.store.db
      .selectFrom("indexer.agents")
      .select("agent_id")
      .where("chain_id", "=", this.o.chainId)
      .orderBy("agent_id")
      .execute();
    const every = this.o.everyMs ?? SNAPSHOT_INTERVAL_MS;
    let n = 0;
    for (const { agent_id } of agents) {
      const at = this.checked.get(agent_id);
      if (at !== undefined && Date.now() - at < every) continue;
      if (!(await this.o.snapshots.due(this.o.chainId, agent_id, every))) continue;
      this.checked.set(agent_id, Date.now());
      try {
        if (await this.observe(agent_id, "interval")) n += 1;
      } catch (err) {
        this.o.log(
          `agent ${agent_id}: no value snapshot: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
        );
      }
    }
    return n;
  }
}
