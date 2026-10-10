import {
  type ChainReader,
  type ChainReaderV3,
  holdingPrice,
  tokenInfo,
} from "@alpha-agents/chain-tools";
import { ACCOUNT_MODES, type AccountMode } from "@alpha-agents/domain";
import { custodyV3 } from "@alpha-agents/policy";
import { SNAPSHOT_INTERVAL_MS, type SnapshotStore } from "@alpha-agents/trading";
import { isAddressEqual } from "viem";
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
  /** F-U5: the fund agent's v3 set; an agent on it is snapshotted with every held token (D-367). */
  readonly readerV3?: ChainReaderV3 | null;
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
    const v3 = this.o.readerV3;
    if (v3 && (await v3.custodyPath(agentId)) === "v3")
      return this.observeV3(v3, agentId, reason, intentId);
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

  /** A v3 account: its own value and every held token with its price and value as the account values it. */
  private async observeV3(
    v3: ChainReaderV3,
    agentId: number,
    reason: "interval" | "trade",
    intentId: string | null,
  ) {
    const [a, m] = await Promise.all([v3.agent(agentId), v3.market()]);
    if (!a?.account || !isMode(a.mode)) return false;
    const holdings = a.holdings.map((h) => {
      const px = holdingPrice(h, m);
      const priced = px.priceE18 > 0n;
      return {
        token: h.token,
        symbol: tokenInfo(m, h.token)?.symbol ?? h.token,
        decimals: h.decimals,
        amountRaw: h.balance.toString(),
        priceE18: priced ? px.priceE18.toString() : null,
        valueUsdcE6: priced
          ? custodyV3.valueE6(h.balance, px.priceE18, h.decimals).toString()
          : null,
        costBasisUsdcE6: isAddressEqual(h.token, m.usdc) ? null : h.costBasis.toString(),
      };
    });
    const usdc = a.holdings.find((h) => isAddressEqual(h.token, m.usdc))?.balance ?? 0n;
    const wmon = a.holdings.find((h) => isAddressEqual(h.token, m.wmon))?.balance ?? 0n;
    return this.o.snapshots.record(
      this.o.chainId,
      {
        agentId,
        account: a.account,
        block: a.block,
        timestamp: a.timestamp,
        usdc,
        wmon,
        mode: a.mode,
        monUsdE18: null,
        custody: "v3",
        valueUsdcE6: a.values?.nav ?? null,
        holdings,
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
