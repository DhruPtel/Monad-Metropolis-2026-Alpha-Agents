import type { ChainReader, ChainReaderV3 } from "@alpha-agents/chain-tools";
import type { Db } from "@alpha-agents/db";
import type { GoalsReader } from "@alpha-agents/platform-tools";
import type { AgentIdentity } from "@alpha-agents/tool-server";
import { GoalStore, type LiveGoalLimits, goalsAndLimitsJson } from "@alpha-agents/trading";

/**
 * `get_goals_and_limits` for the platform tools server (P3-U1): the goal the
 * agent's current owner saved, read with the ownership epoch of a fresh chain
 * read (a goal another owner saved does not apply), and the Executor's live
 * limits and the account's mode from the same read. Where the trading
 * contracts are not deployed the live part is null and the current goal is
 * taken as it is.
 */
export function goalsReader(
  db: Db,
  chain: ChainReader | null,
  readerV3: ChainReaderV3 | null = null,
): GoalsReader {
  const goals = new GoalStore(db);
  return {
    async read(identity: AgentIdentity) {
      const live = chain ? await liveLimits(chain, identity.agentId, readerV3) : null;
      const view = await goals.view(identity.chainId, identity.agentId, live?.ownerEpoch ?? null);
      return goalsAndLimitsJson(view, live);
    },
  };
}

async function liveLimits(
  chain: ChainReader,
  agentId: number,
  readerV3: ChainReaderV3 | null,
): Promise<LiveGoalLimits | null> {
  const [m, a, v3] = await Promise.all([
    chain.market(),
    chain.agent(agentId),
    // F-U12: the screened-lane opt-in as the chain records it, from the v3 account.
    readerV3 ? readerV3.agent(agentId).catch(() => null) : Promise.resolve(null),
  ]);
  if (!a) return null;
  return {
    ownerEpoch: a.ownerEpoch,
    screenedOptIn: v3?.account ? v3.screenedOptIn : null,
    limits: {
      maxTradeBps: m.policy.maxTradeBps,
      maxPositionBps: m.policy.maxAssetBps,
      minUsdcShareBps: m.policy.minUsdcBps,
      maxSlippageBps: m.policy.maxSlippageBps,
      maxTradesPer24h: m.policy.maxTradesPerWindow,
    },
    mode: a.account ? a.mode : null,
    executorPaused: m.paused,
    block: a.block,
    timestamp: a.timestamp,
  };
}
