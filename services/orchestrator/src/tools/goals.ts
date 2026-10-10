import type { ChainReader } from "@alpha-agents/chain-tools";
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
export function goalsReader(db: Db, chain: ChainReader | null): GoalsReader {
  const goals = new GoalStore(db);
  return {
    async read(identity: AgentIdentity) {
      const live = chain ? await liveLimits(chain, identity.agentId) : null;
      const view = await goals.view(identity.chainId, identity.agentId, live?.ownerEpoch ?? null);
      return goalsAndLimitsJson(view, live);
    },
  };
}

async function liveLimits(chain: ChainReader, agentId: number): Promise<LiveGoalLimits | null> {
  const [m, a] = await Promise.all([chain.market(), chain.agent(agentId)]);
  if (!a) return null;
  return {
    ownerEpoch: a.ownerEpoch,
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
