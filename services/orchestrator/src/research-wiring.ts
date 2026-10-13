import type { Db } from "@alpha-agents/db";
import { type ChainReaderV3, tokenInfo } from "@alpha-agents/chain-tools";
import type { CreditService } from "./credits/service.ts";
import type { GoalStore, PlanStore } from "@alpha-agents/trading";
import { stageCeilingUsdcE6, stageMayStart, utcDayStart } from "./cycle/stages.ts";
import type { CycleStore } from "./cycle/store.ts";
import type { TokenRegistry } from "./tokens/registry.ts";
import type {
  AgentRef,
  Observation,
  ResearchStore,
  SchedulerDeps,
  WatcherDeps,
} from "./research-loop.ts";

/**
 * The research loop's readers over the platform (P3-U10): what the scheduler
 * needs to decide and queue work, and the one observation the watcher takes
 * of an agent's market, account, plan and blocked trades. Everything here is
 * a read; the loop's decisions live in research-loop.ts and are tested with
 * fakes of these.
 */
export interface ResearchWiring {
  readonly chainId: number;
  readonly db: Db;
  readonly research: ResearchStore;
  readonly cycles: CycleStore;
  readonly goals: GoalStore;
  readonly plans: PlanStore;
  readonly credits: CreditService;
  readonly readerV3: ChainReaderV3 | null;
  readonly registry: TokenRegistry | null;
  readonly volatility24hPct: (() => Promise<number | null>) | null;
  readonly enqueue: SchedulerDeps["enqueue"];
  readonly log: (line: string) => void;
}

const DAY_MS = 24 * 3_600_000;

export function schedulerDeps(w: ResearchWiring): SchedulerDeps {
  return {
    chainId: w.chainId,
    research: w.research,
    log: w.log,
    enqueue: w.enqueue,
    goalOf: async (ref) => {
      const goal = await w.goals.currentGoal(ref.chainId, ref.agentId);
      if (!goal) return null;
      return {
        intensity: goal.config.research.intensity,
        aggressiveness: goal.config.aggressiveness,
        dailyBudgetUsdcE6: BigInt(goal.config.research.dailyBudgetUsdcE6),
      };
    },
    openCycle: async (ref) => (await w.cycles.openCycle(ref)) !== null,
    lastStages: (ref) => w.cycles.lastStages(ref),
    budgetRoom: async (ref, kind) => {
      const goal = await w.goals.currentGoal(ref.chainId, ref.agentId);
      if (!goal) return { fits: false, reason: "CANNOT_START" };
      const credits = await w.credits.creditsOf(ref.agentId);
      if (credits.restricted) return { fits: false, reason: "NO_CREDITS" };
      const stage = kind === "REVIEW" ? "ZOOM_OUT" : "SCAN";
      const alias = goal.config.model.alias;
      const ceiling = /^research-(low|medium|high)$/.test(alias)
        ? stageCeilingUsdcE6(
            stage,
            kind,
            alias as "research-low" | "research-medium" | "research-high",
          )
        : 0n;
      const now = new Date();
      const check = stageMayStart({
        ceilingUsdcE6: ceiling,
        dailyBudgetUsdcE6: BigInt(goal.config.research.dailyBudgetUsdcE6),
        usedTodayUsdcE6: await w.cycles.usedToday(ref, utcDayStart(now)),
        spendableUsdcE6: credits.spendable,
        creditReserveUsdcE6: BigInt(goal.config.creditReserveUsdcE6),
      });
      return check.ok ? { fits: true, reason: null } : { fits: false, reason: check.code };
    },
  };
}

/** The volatility brake the plan in force trades under, else the goal's two-asset brake. */
async function brakeOf(w: ResearchWiring, ref: AgentRef): Promise<number | null> {
  const plan = await w.plans.active(ref.chainId, ref.agentId);
  if (plan) return plan.params.volatilityBrakeBps;
  const goal = await w.goals.currentGoal(ref.chainId, ref.agentId);
  return goal ? goal.config.template.params.volatilityBrakeBps : null;
}

export function watcherDeps(w: ResearchWiring): WatcherDeps {
  return {
    chainId: w.chainId,
    research: w.research,
    log: w.log,
    goalOf: async (ref) => {
      const goal = await w.goals.currentGoal(ref.chainId, ref.agentId);
      if (!goal) return null;
      return {
        intensity: goal.config.research.intensity,
        aggressiveness: goal.config.aggressiveness,
        brakeBps: await brakeOf(w, ref),
      };
    },
    lastZoomOutAt: async (ref) => (await w.cycles.lastStages(ref)).zoomOutAt,
    observe: (ref, now, since) => observe(w, ref, now, since),
  };
}

/** One observation of the agent (null off the fund set or without an account). */
export async function observe(
  w: ResearchWiring,
  ref: AgentRef,
  now: Date,
  since: Date | null,
): Promise<Observation | null> {
  const v3 = w.readerV3;
  if (!v3) return null;
  const goal = await w.goals.currentGoal(ref.chainId, ref.agentId);
  if (!goal) return null;
  const [m, a] = await Promise.all([v3.market(), v3.agent(ref.agentId)]);
  if (!a?.account) return null;
  const priceOf = (token: string) => {
    const p = m.prices[token.toLowerCase()];
    return p && p.reason === "OK" ? p.priceE18 : null;
  };
  const usdc = m.usdc.toLowerCase();
  const held = [];
  for (const h of a.holdings) {
    if (h.balance === 0n || h.token.toLowerCase() === usdc) continue;
    const row = w.registry
      ? await w.registry.store.token(w.chainId, h.token).catch(() => null)
      : null;
    held.push({
      token: h.token,
      symbol: tokenInfo(m, h.token)?.symbol ?? row?.symbol ?? h.token,
      priceE18: priceOf(h.token),
      liquidityUsd: row ? row.liquidityUsd : null,
      screenVerdict: row?.screen?.verdict ?? null,
      registryStatus: row?.registryStatus ?? null,
    });
  }
  const plan = await w.plans.active(ref.chainId, ref.agentId);
  const rechecks =
    plan && plan.template === "target_portfolio@1"
      ? plan.params.positions
          .map((p) => ({
            token: p.token,
            symbol: tokenInfo(m, p.token)?.symbol ?? p.token,
            at: new Date(p.exit.recheckAt),
          }))
          .filter((r) => !Number.isNaN(r.at.getTime()))
      : [];
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const rejected = await w.db
    .selectFrom("platform.intents")
    .select(["reason_codes"])
    .where("chain_id", "=", ref.chainId)
    .where("agent_id", "=", ref.agentId)
    .where("status", "=", "rejected")
    .where("created_at", ">", dayAgo)
    .execute();
  const blockedIn24h: Record<string, number> = {};
  for (const r of rejected) {
    const code = (r.reason_codes as string[])[0] ?? "UNKNOWN";
    blockedIn24h[code] = (blockedIn24h[code] ?? 0) + 1;
  }
  const settled = since
    ? await w.db
        .selectFrom("platform.intents")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("chain_id", "=", ref.chainId)
        .where("agent_id", "=", ref.agentId)
        .where("status", "in", ["confirmed", "reconciled"])
        .where("created_at", ">", since)
        .executeTakeFirst()
    : null;
  return {
    at: now,
    monUsdE18: priceOf(m.wmon),
    volatility24hPct: w.volatility24hPct ? await w.volatility24hPct().catch(() => null) : null,
    mode: a.mode,
    navUsdcE6: a.values?.nav ?? null,
    goalEpoch: goal.strategyEpoch.toString(),
    blockedIn24h,
    settledSinceBaseline: Number(settled?.n ?? 0),
    held,
    rechecks,
  };
}
