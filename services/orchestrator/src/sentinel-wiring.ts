import { type Db, sql } from "@alpha-agents/db";
import { type ChainReaderV3, tokenInfo } from "@alpha-agents/chain-tools";
import type { AgentState } from "@alpha-agents/domain";
import type { GoalStore, PlanStore, TradeStore } from "@alpha-agents/trading";
import type { Hex } from "viem";
import type { CreditService } from "./credits/service.ts";
import type { TokenRegistry } from "./tokens/registry.ts";
import {
  type AgentRef,
  type SentinelChain,
  type SentinelDeps,
  type SentinelObservation,
  type SentinelRules,
  SentinelStore,
} from "./sentinel.ts";

/**
 * The Risk Sentinel's readers over the platform (P4-U2): one observation of
 * an agent from reads alone (no poke since CO-U1, 2026-10-19), the agent state
 * setter (with its change recorded, as a goal save or a plan does), and the
 * list of agents worth a look. Everything here is a read or a recorded state
 * change; the tightenings themselves go through the sentinel key.
 */
export interface SentinelWiring {
  readonly chainId: number;
  readonly db: Db;
  readonly store: SentinelStore;
  readonly rules: SentinelRules;
  readonly chain: SentinelChain | null;
  readonly readerV3: ChainReaderV3 | null;
  readonly registry: TokenRegistry | null;
  readonly credits: CreditService | null;
  readonly goals: GoalStore;
  readonly plans: PlanStore;
  readonly trades: TradeStore;
  /** The agent's funding address (its session key), for the gas check; null without a signer. */
  readonly fundingAddressOf: ((agentId: number) => Promise<Hex | null>) | null;
  readonly gas: {
    readonly balance: (address: Hex) => Promise<bigint>;
    readonly swapCost: () => Promise<bigint>;
  } | null;
  /** Whether the signer ran recently; null where no signer is configured. */
  readonly signerAlive: () => boolean | null;
  readonly log: (line: string) => void;
}

export function sentinelDeps(w: SentinelWiring): SentinelDeps {
  return {
    chainId: w.chainId,
    store: w.store,
    rules: w.rules,
    chain: w.chain,
    log: w.log,
    agents: async () => {
      // Every agent with a goal: the ones that may hold an account or run.
      const rows = await w.db
        .selectFrom("platform.agent_goals")
        .select("agent_id")
        .distinct()
        .where("chain_id", "=", w.chainId)
        .where("current", "=", true)
        .orderBy("agent_id")
        .execute();
      return rows.map((r) => r.agent_id);
    },
    observe: (ref, now) => observe(w, ref, now),
    setState: (ref, to, reason) => setAgentState(w.db, ref, to, reason),
    restState: async (ref) =>
      (await w.plans.active(ref.chainId, ref.agentId)) ? "RUNNING" : "READY",
  };
}

/** Sets the agent state and records the change, as the goal and plan stores do; null when unchanged. */
export async function setAgentState(
  db: Db,
  ref: AgentRef,
  to: AgentState,
  reason: string,
): Promise<{ from: AgentState } | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("platform.agent_states")
      .select(["state", "strategy_epoch"])
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.state === to) return null;
    await trx
      .updateTable("platform.agent_states")
      .set({ state: to, updated_at: sql`now()` })
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .execute();
    await trx
      .insertInto("platform.agent_state_changes")
      .values({
        chain_id: ref.chainId,
        agent_id: ref.agentId,
        from_state: row.state,
        to_state: to,
        reason,
        strategy_epoch: row.strategy_epoch,
      })
      .execute();
    return { from: row.state };
  });
}

/** One look at the agent, from reads alone. */
export async function observe(
  w: SentinelWiring,
  ref: AgentRef,
  now: Date,
): Promise<SentinelObservation | null> {
  const v3 = w.readerV3;
  const stateRow = await w.db
    .selectFrom("platform.agent_states")
    .select("state")
    .where("chain_id", "=", ref.chainId)
    .where("agent_id", "=", ref.agentId)
    .executeTakeFirst();
  const agentState = (stateRow?.state as AgentState | undefined) ?? null;
  const credits = w.credits ? await w.credits.creditsOf(ref.agentId).catch(() => null) : null;
  const arming = await w.trades.lastArming(ref.chainId, ref.agentId);
  const armingNow = arming && arming.status !== "ended" ? arming : null;
  if (!v3)
    return {
      at: now,
      account: null,
      mode: null,
      depositsClosed: null,
      drawdownBps: null,
      navReadable: true,
      held: [],
      creditsRestricted: credits ? credits.restricted : null,
      gasWei: null,
      gasNeededWei: null,
      signerAlive: w.signerAlive(),
      chainAgeSeconds: null,
      executorPaused: null,
      adapterAllowed: null,
      arming: armingNow
        ? { validUntil: armingNow.validUntil, ownerEpoch: armingNow.ownerEpoch }
        : null,
      ownerEpoch: null,
      agentState,
    };
  // CO-U1 (2026-10-19, owner): reads only. The account's breakerState values it at current
  // prices against its recorded peak, so a drawdown shows without a poke; the core's breaker
  // refuses new risk in an unpoked drawdown, and the sentinel tightens on its own rules.
  const [a, m] = await Promise.all([v3.agent(ref.agentId), v3.market()]);
  if (!a) return null;
  const usdc = m.usdc.toLowerCase();
  const held = [];
  for (const h of a.holdings) {
    if (h.balance === 0n || h.token.toLowerCase() === usdc) continue;
    const p = m.prices[h.token.toLowerCase()];
    const row = w.registry
      ? await w.registry.store.token(w.chainId, h.token).catch(() => null)
      : null;
    held.push({
      token: h.token,
      symbol: tokenInfo(m, h.token)?.symbol ?? row?.symbol ?? h.token,
      priceReason: p ? p.reason : "NO_FEED",
      priceAgeSeconds: p && p.reason === "OK" ? Number(m.timestamp - p.updatedAt) : null,
      screenVerdict: row?.screen?.verdict ?? null,
      registryStatus: row?.registryStatus ?? null,
      liquidityUsd: row ? row.liquidityUsd : null,
    });
  }
  const funding = w.fundingAddressOf
    ? await w.fundingAddressOf(ref.agentId).catch(() => null)
    : null;
  const [gasWei, gasNeededWei] =
    w.gas && funding
      ? await Promise.all([
          w.gas.balance(funding).catch(() => null),
          w.gas.swapCost().catch(() => null),
        ])
      : [null, null];
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  return {
    at: now,
    account: a.account,
    mode: a.account ? a.mode : null,
    depositsClosed: null,
    drawdownBps: a.account && a.breaker ? Number(a.breaker.drawdownBps) : null,
    navReadable: !a.account || a.values !== null,
    held,
    creditsRestricted: credits ? credits.restricted : null,
    gasWei,
    gasNeededWei,
    signerAlive: w.signerAlive(),
    chainAgeSeconds: Number(nowSeconds - m.timestamp),
    executorPaused: m.paused,
    adapterAllowed: m.adapterAllowed,
    arming: armingNow
      ? { validUntil: armingNow.validUntil, ownerEpoch: armingNow.ownerEpoch }
      : null,
    ownerEpoch: a.ownerEpoch,
    agentState,
  };
}
