import {
  type ChainReader,
  type ChainReaderV3,
  holdingPrice,
  tokenInfo,
} from "@alpha-agents/chain-tools";
import { ACCOUNT_MODES, type AccountMode } from "@alpha-agents/domain";
import { custodyV3 } from "@alpha-agents/policy";
import {
  type AccountObservation,
  type AccountReadJson,
  type HoldingSnapshot,
  SNAPSHOT_INTERVAL_MS,
  type SnapshotStore,
  accountValueUsdc,
} from "@alpha-agents/trading";
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
  /** The v2 set's reader; null where only the fund agent's v3 set is deployed (CO-U1: Base, Arbitrum). */
  readonly reader: ChainReader | null;
  /** F-U5: the fund agent's v3 set; an agent on it is snapshotted with every held token (D-367). */
  readonly readerV3?: ChainReaderV3 | null;
  readonly everyMs?: number;
  readonly log: (line: string) => void;
}

const isMode = (m: string): m is AccountMode => (ACCOUNT_MODES as readonly string[]).includes(m);

/** One reading of an account (F-U11): what a snapshot records, with every held token. */
export interface AccountRead {
  readonly observation: AccountObservation;
  readonly holdings: readonly HoldingSnapshot[];
}

/** The reading as the orchestrator's account route answers it (packages/trading's AccountReadJson). */
export function accountReadJson(r: AccountRead): AccountReadJson {
  const o = r.observation;
  const value = o.custody === "v3" ? (o.valueUsdcE6 ?? null) : accountValueUsdc(o);
  return {
    agentId: String(o.agentId),
    custody: o.custody ?? "v2",
    account: o.account,
    block: o.block.toString(),
    timestamp: Number(o.timestamp),
    mode: o.mode,
    valueUsdcE6: value === null ? null : value.toString(),
    perUnitE18:
      o.perUnitE18 === undefined || o.perUnitE18 === null ? null : o.perUnitE18.toString(),
    holdings: r.holdings,
  };
}

export class SnapshotRecorder {
  private readonly o: SnapshotRecorderOptions;
  /** When each agent was last read, so an agent with no account is not re-read every pass. */
  private readonly checked = new Map<number, number>();

  constructor(o: SnapshotRecorderOptions) {
    this.o = o;
  }

  /** Reads one account and records it; false when the agent has no account (or no known mode). */
  async observe(agentId: number, reason: "interval" | "trade", intentId: string | null = null) {
    const r = await this.read(agentId);
    if (!r) return false;
    return this.o.snapshots.record(this.o.chainId, r.observation, reason, intentId);
  }

  /**
   * Reads one account without recording it (F-U11, the window's live
   * reading): null when the agent has no account or no known mode. A v3
   * account comes with every held token as the account values it; a v2
   * account with its two balances.
   */
  async read(agentId: number): Promise<AccountRead | null> {
    const v3 = this.o.readerV3;
    if (v3 && (await v3.custodyPath(agentId)) === "v3") return this.readV3(v3, agentId);
    const v2 = this.o.reader;
    if (!v2) return null;
    const [a, m] = await Promise.all([v2.agent(agentId), v2.market()]);
    if (!a?.account || !isMode(a.mode)) return null;
    const monUsdE18 = m.monUsd.reason === "OK" ? m.monUsd.priceE18 : null;
    const observation: AccountObservation = {
      agentId,
      account: a.account,
      block: a.block,
      timestamp: a.timestamp,
      usdc: a.usdc,
      wmon: a.wmon,
      mode: a.mode,
      monUsdE18,
      perUnitE18: a.breaker?.perUnit ?? null,
    };
    const holdings: HoldingSnapshot[] = [
      {
        token: v2.tokenOf("USDC"),
        symbol: "USDC",
        decimals: 6,
        amountRaw: a.usdc.toString(),
        priceE18: (10n ** 18n).toString(),
        valueUsdcE6: a.usdc.toString(),
        costBasisUsdcE6: null,
      },
      {
        token: v2.tokenOf("WMON"),
        symbol: "WMON",
        decimals: 18,
        amountRaw: a.wmon.toString(),
        priceE18: monUsdE18 === null ? null : monUsdE18.toString(),
        valueUsdcE6: monUsdE18 === null ? null : ((a.wmon * monUsdE18) / 10n ** 30n).toString(),
        // The v2 account keeps no cost basis.
        costBasisUsdcE6: null,
      },
    ];
    return { observation, holdings };
  }

  /** A v3 account: its own value and every held token with its price and value as the account values it. */
  private async readV3(v3: ChainReaderV3, agentId: number): Promise<AccountRead | null> {
    const [a, m] = await Promise.all([v3.agent(agentId), v3.market()]);
    if (!a?.account || !isMode(a.mode)) return null;
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
    return {
      observation: {
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
        perUnitE18: a.breaker?.perUnit ?? null,
      },
      holdings,
    };
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
