import { createHash } from "node:crypto";
import {
  type Blocker,
  type ChainReader,
  type ChainReaderV3,
  type IntentStore,
  type MarketStateV3,
  assessTradeV3,
  blockersFor,
  minAmountOutV3,
  oracleImplied,
  proposalVerdict,
  resolveToken,
} from "@alpha-agents/chain-tools";
import {
  ASSET_DECIMALS,
  REJECTION_MESSAGES,
  type RejectionCode,
  RUNNER_HOLD_FACTS,
  type RunnerHoldCode,
  TRADE_FLOW_MESSAGES,
  executorV3SwapGasLimit,
} from "@alpha-agents/domain";
import {
  type PortfolioDecision,
  type PortfolioState,
  type PortfolioToken,
  REBALANCE_BANDS_V1,
  type TargetPortfolioParams,
  TARGET_PORTFOLIO_ID,
  TARGET_PORTFOLIO_V1,
  type TemplateDecision,
  type TradingProfile,
  LAUNCH_TRADING_PROFILE,
  amountForValue,
  gasCostUsdcE6,
  legCostWithGas,
  valueE6,
  withTradingProfile,
} from "@alpha-agents/policy";
import {
  type DecisionStore,
  type GoalStore,
  type NewDecision,
  type PlanStore,
  type RunnerDecision,
  type StoredBandsPlan,
  type StoredGoal,
  type StoredPlan,
  type StoredPortfolioPlan,
  type TradeStore,
  isPortfolioPlan,
} from "@alpha-agents/trading";
import type { AgentIdentity } from "@alpha-agents/tool-server";
import { type Hex, formatUnits, isAddressEqual } from "viem";
import type { RunnerFacts } from "./narrator.ts";
import type { TradeFlowGas } from "./trade-flow.ts";

/**
 * The template runner (P3-U3, D-094, D-290): every minute, for each agent
 * with an active plan, it reads the account, the prices and the limits and
 * decides one leg or one hold by the template's rule. It uses no model and
 * no sandbox and costs nothing (D-297: the model changes the plan, the runner
 * makes the trades). A leg goes through the same checks and intent store as
 * `propose_swap`, with source `template`, the plan's strategy epoch and a
 * deterministic client request ID, and then through the trade flow like any
 * proposal: approval while armed, every check again at submission, the
 * signer, the Executor and reconciliation. A leg larger than the per-trade
 * cap is split across ticks: one leg per decision, the next only once the
 * previous one has settled (D-096).
 *
 * F-U6 (D-344): a `target_portfolio@1` plan runs on the fund agent's v3 set:
 * every registered token with the account's holding, the registry's status
 * and cap, the platform's screen and the token's volatility go to the rule,
 * which sells first and buys second, always against USDC, one capped leg a
 * minute; the leg is quoted along the best registered route, checked by the
 * same v3 pre-check as `propose_swap`, and proposed as a v3 intent with its
 * route, so the trade flow sends it through Executor v3. `rebalance_bands@1`
 * keeps the two-asset path.
 *
 * Holds are recorded with their reason (the runner's, the Executor's or the
 * trade flow's), a new row only when the reason changes, and served through
 * why-not-traded. A plan set under an earlier strategy epoch never trades.
 */
export const RUNNER_EVERY_MS = 60_000;
/** A refused leg whose reasons give no time is tried again after this long. */
export const REFUSED_RETRY_MS = 10 * 60_000;
/** A leg waits for the owner (or the armed trade flow) as long as any proposal (A-43). */
export const RUNNER_INTENT_TTL_SECONDS = 1_800;

/** The intents of an agent that mean a leg is still on its way. */
const IN_FLIGHT = new Set(["awaiting_approval", "approved", "submitted", "confirmed"]);

/** Refusals that depend on the leg's size: the next check sizes the leg again at once. */
const SIZE_REFUSALS = new Set(["SLIPPAGE_TOO_HIGH", "SIMULATION_FAILED"]);
/** A fitted leg keeps this much of its value clear of the floor, for the pool moving before it lands. */
const LEG_HEADROOM_BPS = 15n;
/** The smallest leg the fitter tries, as a share of the leg the plan wants. */
const LEG_FLOOR_DIVISOR = 16n;
/** Other buys tried in one check when no size of the first fills. */
const OTHER_BUYS_TRIED = 2;

/**
 * 2026-10-17 (owner): the largest leg value up to `value` that `fits` accepts: the whole leg when
 * it fits, else halving between `floor` and it, at most `steps` more checks; null when not even
 * `floor` fits.
 */
export async function fitLegValue(
  value: bigint,
  floor: bigint,
  fits: (value: bigint) => Promise<boolean>,
  steps = 6,
): Promise<bigint | null> {
  if (await fits(value)) return value;
  const least = floor > 0n ? floor : 1n;
  if (least >= value || !(await fits(least))) return null;
  let lo = least;
  let hi = value;
  for (let i = 0; i < steps && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (await fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Holds worth an activity entry when they start: what an owner would want to know. */
const NOTABLE_HOLDS = new Set<string>([
  "VOLATILITY_BRAKE",
  "VOLATILITY_UNAVAILABLE",
  "COST_HURDLE",
  "OWNER_TRADE_LIMIT",
  "STRATEGY_EPOCH_STALE",
  "NOT_ARMED",
  "GAS_UNFUNDED",
  "ORACLE_STALE",
  "ORACLE_POOL_DEVIATION",
  "DAILY_TRADE_LIMIT",
  "TURNOVER_CAP",
  "REDUCE_ONLY_MODE",
  "PAUSED",
  "SCREEN_STALE",
  "ATTESTATION_UNAVAILABLE",
  "CAP_REACHED",
  "CASH_FLOOR",
  "TOKEN_FROZEN",
]);

const E18 = 10n ** 18n;

export interface RunnerNarrator {
  narrateEvent(chainId: number, agentId: number, key: string, facts: RunnerFacts): Promise<unknown>;
}

export interface TemplateRunnerOptions {
  readonly chainId: number;
  /** The v2 set's reader; null where only the fund agent's v3 set is deployed (CO-U1: Base, Arbitrum). */
  readonly reader: ChainReader | null;
  /** F-U6: the fund agent's v3 set, which a target portfolio runs on; null where it is not deployed. */
  readonly readerV3?: ChainReaderV3 | null;
  readonly plans: PlanStore;
  readonly decisions: DecisionStore;
  readonly goals: GoalStore;
  readonly trades: TradeStore;
  readonly intents: IntentStore;
  /** The agent's session key (its funding address, D-243), as the trade flow's signer gives it. */
  readonly sessionKeyOf: (agentId: number) => Promise<Hex | null>;
  /** MON's annualized 24-hour realized volatility in percent, or null when it cannot be read. */
  readonly volatility24hPct: () => Promise<number | null>;
  /**
   * CO-U1 (testnet stacks only): MON's volatility, annualized percent, used when the reading is
   * missing, so a buy goes ahead with a logged warning instead of holding VOLATILITY_UNAVAILABLE.
   * Unset (mainnet and the beta), a missing reading still holds buys.
   */
  readonly fallbackVolatility24hPct?: number | null;
  /** F-U6: another token's 24-hour volatility, or null without a reading; WMON's comes from `volatility24hPct`. */
  readonly volatilityOf?: ((token: Hex, symbol: string) => Promise<number | null>) | null;
  /** F-U6: whether a passing screen no older than the platform's bound exists for the token; null when unknown. */
  readonly screenFresh?: ((token: Hex) => Promise<boolean | null>) | null;
  /** Without `topUp` (off the fork) a funding address with too little MON holds GAS_UNFUNDED. */
  readonly gas?: TradeFlowGas | null;
  readonly narrator?: RunnerNarrator | null;
  readonly now?: () => Date;
  /**
   * The offchain trading profile (2026-10-13): the testnet profile on testnet alone, the
   * launch profile (the plan's own parameters, gas not counted) everywhere else.
   */
  readonly profile?: TradingProfile;
  /** MON's real USD price (18 decimals) for a leg's gas, when the profile counts gas; null when unreadable. */
  readonly gasMonUsdE18?: (() => Promise<bigint | null>) | null;
  readonly log: (line: string) => void;
}

const agentName = (agentId: number) => `Agent #${agentId}`;
const pct = (bps: number) => (bps / 100).toString();

/** The message and how a code clears, whichever list it is from. */
export function holdMessage(code: string): string {
  return (
    RUNNER_HOLD_FACTS[code as RunnerHoldCode]?.message ??
    TRADE_FLOW_MESSAGES[code as keyof typeof TRADE_FLOW_MESSAGES] ??
    REJECTION_MESSAGES[code as RejectionCode] ??
    code
  );
}

type Hold = (
  code: string,
  facts: Record<string, unknown>,
  codes?: readonly string[],
  block?: bigint | null,
) => Promise<RunnerDecision>;

export class TemplateRunner {
  private readonly o: TemplateRunnerOptions;
  private running = false;

  constructor(o: TemplateRunnerOptions) {
    this.o = o;
  }

  private now() {
    return this.o.now?.() ?? new Date();
  }

  /** One pass over every agent with an active plan. Returns each agent's decision. */
  async tick(): Promise<RunnerDecision[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const out: RunnerDecision[] = [];
      for (const plan of await this.o.plans.activePlans(this.o.chainId)) {
        try {
          out.push(await this.decide(plan));
        } catch (err) {
          this.o.log(
            `runner: agent ${plan.agentId}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
          );
        }
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  /** Decides one leg or one hold for the agent now (the console's "run now"); null without a plan. */
  async runAgent(agentId: number): Promise<RunnerDecision | null> {
    const plan = await this.o.plans.active(this.o.chainId, agentId);
    return plan ? this.decide(plan) : null;
  }

  private async decide(plan: StoredPlan): Promise<RunnerDecision> {
    const { chainId } = this.o;
    const agentId = plan.agentId;
    const base = {
      chainId,
      agentId,
      paramId: plan.paramId,
      strategyEpoch: plan.strategyEpoch,
    };
    const hold: Hold = (code, facts, codes = [code], block = null) =>
      this.record(plan, {
        ...base,
        outcome: "hold",
        code,
        codes,
        leg: null,
        intentId: null,
        facts,
        block,
      });

    // A plan set before the goal changed never trades (D-281).
    const epoch = await this.o.trades.strategyEpoch(chainId, agentId);
    if (plan.strategyEpoch !== epoch)
      return hold("STRATEGY_EPOCH_STALE", {
        planEpoch: plan.strategyEpoch.toString(),
        epoch: epoch.toString(),
      });
    const goal = await this.o.goals.currentGoal(chainId, agentId);
    if (!goal) return hold("NO_PLAN", {});
    const arming = await this.o.trades.openArming(chainId, agentId);
    if (!arming) return hold("NOT_ARMED", {});
    const open = (await this.o.trades.intents(chainId, agentId, 20)).filter((i) =>
      IN_FLIGHT.has(i.status),
    );
    if (open.length > 0)
      return hold("LEG_PENDING", { intents: open.map((i) => `${i.intentId}:${i.status}`) });
    // A leg the trade flow refused at submission (plan item 5): hold with its reasons, and try
    // again only once they can have cleared by waiting; a reason only the owner or the platform
    // clears holds until the plan changes.
    const refused = await this.lastRefusedLeg(agentId, plan.paramId);
    if (refused) return hold(refused.code, refused.facts, refused.codes);

    if (isPortfolioPlan(plan)) return this.decidePortfolio(plan, goal, hold, base);
    // RUN-FIX: a band plan for an agent whose money is in a fund-set account runs through the
    // fund set's path, as the equivalent one-position portfolio plan; the v2 path would read
    // the older account, find nothing there and hold with BELOW_MIN_TRADE forever.
    const wmon = await this.fundSetWmon(agentId);
    return wmon
      ? this.decidePortfolio(bandsAsPortfolio(plan, wmon), goal, hold, base)
      : this.decideBands(plan, goal, hold, base);
  }

  /** WMON's address on the fund agent's set when the agent has an account there; null otherwise. */
  private async fundSetWmon(agentId: number): Promise<Hex | null> {
    const reader = this.o.readerV3;
    if (!reader) return null;
    const [m, a] = await Promise.all([reader.market(), reader.agent(agentId)]);
    return a?.account ? m.wmon : null;
  }

  /** The two-asset template on the v2 set (P3-U3). */
  private async decideBands(
    plan: StoredBandsPlan,
    goal: StoredGoal,
    hold: Hold,
    base: Pick<NewDecision, "chainId" | "agentId" | "paramId" | "strategyEpoch">,
  ): Promise<RunnerDecision> {
    const agentId = plan.agentId;
    const v2 = this.o.reader;
    if (!v2) return hold("NO_PLAN", { reason: "the v2 set is not deployed here" });
    const [m, a] = await Promise.all([v2.market(), v2.agent(agentId)]);
    if (!a) return hold("NO_PLAN", { reason: "the agent is not on this chain" });
    // The owner's limits from the goal: each the hard limit or a stricter value (P3-U1).
    const owner = goal.config.ownerLimits;
    const dayAgo = a.timestamp - 86_400n;
    const tradesToday = a.trades.filter((t) => t.at > dayAgo && t.at > 0n).length;
    if (tradesToday >= owner.maxTradesPer24h)
      return hold(
        "OWNER_TRADE_LIMIT",
        { tradesToday, limit: owner.maxTradesPer24h },
        undefined,
        a.block,
      );

    const params = withTradingProfile(plan.params, this.profile);
    const priceE18 = m.monUsd.priceE18 > 0n ? m.monUsd.priceE18 : null;
    const volatility = await this.monVolatility(plan.agentId);
    let d: TemplateDecision = REBALANCE_BANDS_V1.plan(params, {
      usdcRaw: a.usdc,
      wmonRaw: a.wmon,
      priceE18,
      volatility24hPct: volatility,
      limits: {
        maxTradeBps: owner.maxTradeBps,
        maxWmonShareBps: owner.maxPositionBps,
        minUsdcShareBps: owner.minUsdcShareBps,
      },
    });
    if (d.action === "hold") return hold(d.code, { ...d.facts }, undefined, a.block);

    const leg = d.leg;
    const quote = await v2.quote(leg.sell, leg.amountIn).catch(() => null);
    if (quote && priceE18 !== null) {
      d = REBALANCE_BANDS_V1.checkCost(params, d, {
        oracleOut: oracleImplied(leg.sell, leg.amountIn, priceE18),
        quotedOut: quote.amountOut,
      });
      if (d.action === "hold") return hold(d.code, { ...d.facts }, undefined, a.block);
    }
    const gasCost = await this.gasCostHold(d.leg.valueUsdcE6, d.facts.costBps, params, undefined);
    if (gasCost) return hold("COST_HURDLE", { ...d.facts, ...gasCost }, undefined, a.block);
    // Every check propose_swap runs, on the same reads (the Executor's rules, slots, the grant).
    const [key, reserved] = await Promise.all([
      this.o.sessionKeyOf(agentId),
      this.o.intents.reservedSlots(this.identity(agentId)),
    ]);
    const blockers: Blocker[] = blockersFor(leg.sell, leg.amountIn, a, m, quote, key, reserved);
    const verdict = proposalVerdict(blockers);
    if (verdict.rejecting.length > 0) {
      const codes = verdict.rejecting.map((b) => b.code);
      return hold(codes[0] as string, { ...d.facts, blockers: verdict.rejecting }, codes, a.block);
    }
    const unfunded = await this.gasHold(key, undefined);
    if (unfunded) return hold("GAS_UNFUNDED", { ...d.facts, ...unfunded }, undefined, a.block);

    const identity = this.identity(agentId);
    const requestId = createHash("sha256")
      .update(`${plan.paramId}:${leg.sell}:${leg.amountIn}:${a.block}`)
      .digest("hex")
      .slice(0, 32);
    const share = d.facts.wmonShareBps;
    const { record } = await this.o.intents.propose(
      identity,
      {
        idempotencyKey: `template:${agentId}:${requestId}`,
        account: a.account,
        sell: leg.sell,
        buy: leg.buy,
        amountIn: leg.amountIn,
        reason: `The runner rebalances toward the plan's ${pct(params.targetWmonBps)}% WMON target${share === null ? "" : `; the account is at ${pct(share)}%`}.`,
        clientRequestId: `template-${requestId}`,
        status: verdict.status,
        reasonCodes: [],
        blockers,
        checks: {
          template: plan.template,
          paramId: plan.paramId,
          paramsHash: plan.paramsHash,
          block: a.block.toString(),
          ...(quote ? { expectedOut: quote.amountOut.toString() } : {}),
          facts: d.facts,
        },
        ownerEpoch: a.ownerEpoch,
        configEpoch: a.configEpoch,
        expiresAt: new Date(this.now().getTime() + RUNNER_INTENT_TTL_SECONDS * 1000),
        source: "template",
        strategyEpoch: plan.strategyEpoch,
      },
      3,
    );
    return this.record(plan, {
      ...base,
      outcome: "leg",
      code: "LEG",
      codes: [],
      leg: {
        sell: leg.sell,
        buy: leg.buy,
        amountIn: leg.amountIn.toString(),
        valueUsdcE6: leg.valueUsdcE6.toString(),
      },
      intentId: record.intentId,
      facts: { ...d.facts },
      block: a.block,
    });
  }

  /** The target portfolio on the fund agent's v3 set (F-U6, D-344). */
  private async decidePortfolio(
    plan: StoredPortfolioPlan,
    goal: StoredGoal,
    hold: Hold,
    base: Pick<NewDecision, "chainId" | "agentId" | "paramId" | "strategyEpoch">,
  ): Promise<RunnerDecision> {
    const agentId = plan.agentId;
    const reader = this.o.readerV3;
    if (!reader)
      return hold("NO_PLAN", { reason: "the fund agent's set is not deployed on this chain" });
    const [m, a] = await Promise.all([reader.market(), reader.agent(agentId)]);
    if (!a?.account) return hold("NO_PLAN", { reason: "the agent has no fund account yet" });
    const owner = goal.config.ownerLimits;
    const dayAgo = a.timestamp - 86_400n;
    const tradesToday = a.trades.filter((t) => t.at > dayAgo && t.at > 0n).length;
    if (tradesToday >= owner.maxTradesPer24h)
      return hold(
        "OWNER_TRADE_LIMIT",
        { tradesToday, limit: owner.maxTradesPer24h },
        undefined,
        a.block,
      );

    // Every registered token as the rule reads it: the holding, the registry's status and cap,
    // the price, and for the plan's own tokens the platform's screen and the volatility reading.
    const held = new Map(a.holdings.map((h) => [h.token.toLowerCase(), h]));
    const inPlan = (token: Hex) =>
      plan.params.positions.some((p) => isAddressEqual(p.token, token));
    const tokens: PortfolioToken[] = [];
    for (const t of m.tokens) {
      const usdc = isAddressEqual(t.token, m.usdc);
      const price = m.prices[t.token.toLowerCase()];
      const planned = inPlan(t.token);
      tokens.push({
        token: t.token,
        symbol: t.symbol,
        decimals: t.decimals,
        balanceRaw: held.get(t.token.toLowerCase())?.balance ?? 0n,
        priceE18: usdc
          ? E18
          : price && price.reason === "OK" && price.priceE18 > 0n
            ? price.priceE18
            : null,
        priceClass: usdc ? "USDC" : t.priceClass,
        status: t.status,
        capBps: t.maxPositionBps,
        screenFresh:
          planned && this.o.screenFresh
            ? await this.o.screenFresh(t.token).catch(() => null)
            : null,
        volatility24hPct: planned ? await this.volatilityOf(t.token, t.symbol, m.wmon) : null,
      });
    }
    const state: PortfolioState = {
      usdc: m.usdc,
      wmon: m.wmon,
      tokens,
      limits: {
        maxTradeBps: Math.min(m.policy.maxTradeBps, Number(owner.maxTradeBps)),
        maxAssetBps: m.policy.maxAssetBps,
        minUsdcBps: Math.max(m.policy.minUsdcBps, Number(owner.minUsdcShareBps)),
      },
    };
    const params = withTradingProfile(plan.params, this.profile);
    const planned = TARGET_PORTFOLIO_V1.plan(params, state);
    if (planned.action === "hold")
      return hold(planned.code, { ...planned.facts }, undefined, a.block);
    // 2026-10-17 (owner): quote first, then size: a leg larger than its pools fill within the
    // slippage limit is made smaller, and a buy no size of which fills gives way to the next.
    const sized = await this.sizeLeg(agentId, m, a.screenedOptIn, params, state, planned);
    let d: PortfolioDecision = sized.decision;

    // The leg along its best registered route, through the same pre-check as propose_swap.
    const leg = sized.decision.leg;
    const [key, reserved] = await Promise.all([
      this.o.sessionKeyOf(agentId),
      this.o.intents.reservedSlots(this.identity(agentId)),
    ]);
    const assessed = await assessTradeV3(
      reader,
      agentId,
      leg.sell,
      leg.buy,
      leg.amountIn,
      key,
      reserved,
    );
    const quote = assessed?.quote ?? null;
    const sold = tokens.find((t) => isAddressEqual(t.token, leg.sell));
    const bought = tokens.find((t) => isAddressEqual(t.token, leg.buy));
    if (quote && sold?.priceE18 && bought?.priceE18) {
      const oracleOut =
        leg.direction === "buy"
          ? amountForValue(leg.amountIn, bought.priceE18, bought.decimals)
          : valueE6(leg.amountIn, sold.priceE18, sold.decimals);
      d = TARGET_PORTFOLIO_V1.checkCost(params, d, { oracleOut, quotedOut: quote.amountOut });
      if (d.action === "hold") return hold(d.code, { ...d.facts }, undefined, a.block);
    }
    const blockers: Blocker[] = assessed ? [...assessed.blockers] : [];
    const verdict = proposalVerdict(blockers);
    if (verdict.rejecting.length > 0) {
      const codes = verdict.rejecting.map((b) => b.code);
      return hold(codes[0] as string, { ...d.facts, blockers: verdict.rejecting }, codes, a.block);
    }
    // Gas for this route: its hops and the tokens held once the bought one has joined (A-69).
    const hops = quote?.route.length ?? 1;
    const heldAfter =
      a.holdings.filter((h) => h.balance > 0n).length +
      (a.holdings.some((h) => isAddressEqual(h.token, leg.buy) && h.balance > 0n) ? 0 : 1);
    const gasLimit = executorV3SwapGasLimit(hops, Math.min(Math.max(heldAfter, 1), 16));
    const gasCost = await this.gasCostHold(leg.valueUsdcE6, d.facts.costBps, params, gasLimit);
    if (gasCost) return hold("COST_HURDLE", { ...d.facts, ...gasCost }, undefined, a.block);
    const unfunded = await this.gasHold(key, gasLimit);
    if (unfunded) return hold("GAS_UNFUNDED", { ...d.facts, ...unfunded }, undefined, a.block);

    const identity = this.identity(agentId);
    const requestId = createHash("sha256")
      .update(`${plan.paramId}:${leg.sell}:${leg.amountIn}:${a.block}`)
      .digest("hex")
      .slice(0, 32);
    const position = d.facts.positions.find((p) => isAddressEqual(p.token, leg.position));
    const target = position ? `${pct(position.targetBps)}%` : "its";
    const at =
      position?.shareBps === null || position === undefined
        ? ""
        : ` from ${pct(position.shareBps)}%`;
    const route = quote?.route.map((p) => p.poolId) ?? null;
    const { record } = await this.o.intents.propose(
      identity,
      {
        idempotencyKey: `template:${agentId}:${requestId}`,
        account: a.account,
        sell: leg.sellSymbol,
        buy: leg.buySymbol,
        custody: "v3",
        sellToken: leg.sell,
        buyToken: leg.buy,
        route,
        amountIn: leg.amountIn,
        reason: `${
          leg.direction === "buy"
            ? `The runner buys ${leg.buySymbol} toward the plan's ${target} target${at}.`
            : `The runner sells ${leg.sellSymbol} toward the plan's ${target} target${at}.`
        }${
          sized.wantedUsdcE6 !== null
            ? ` A smaller leg than the ${formatUnits(sized.wantedUsdcE6, 6)} USDC the plan wants: the pools fill about ${formatUnits(leg.valueUsdcE6, 6)} USDC within the slippage limit now, and the next legs follow.`
            : ""
        }`,
        clientRequestId: `template-${requestId}`,
        status: verdict.status,
        reasonCodes: [],
        blockers,
        checks: {
          template: plan.template,
          paramId: plan.paramId,
          paramsHash: plan.paramsHash,
          custody: "v3",
          sellDecimals: sold?.decimals ?? 18,
          buyDecimals: bought?.decimals ?? 18,
          hops,
          route,
          block: a.block.toString(),
          ...(quote ? { expectedOut: quote.amountOut.toString() } : {}),
          facts: d.facts,
        },
        ownerEpoch: a.ownerEpoch,
        configEpoch: a.configEpoch,
        expiresAt: new Date(this.now().getTime() + RUNNER_INTENT_TTL_SECONDS * 1000),
        source: "template",
        strategyEpoch: plan.strategyEpoch,
      },
      3,
    );
    return this.record(plan, {
      ...base,
      outcome: "leg",
      code: "LEG",
      codes: [],
      leg: {
        sell: leg.sellSymbol,
        buy: leg.buySymbol,
        amountIn: leg.amountIn.toString(),
        valueUsdcE6: leg.valueUsdcE6.toString(),
        sellToken: leg.sell,
        buyToken: leg.buy,
        position: leg.position,
      },
      intentId: record.intentId,
      facts: {
        ...d.facts,
        sellDecimals: sold?.decimals ?? 18,
        buyDecimals: bought?.decimals ?? 18,
      },
      block: a.block,
    });
  }

  /**
   * 2026-10-17 (owner): the leg sized to what its pools fill within the slippage limit and the
   * cost limit, the floor kept clear by a little headroom. When no size of a buy fills, the next
   * underweight buy is tried; when none fills, the plan's own leg goes on, so the pre-check
   * names the reason it holds. `wantedUsdcE6` is the plan's leg when the sent one is smaller.
   */
  private async sizeLeg(
    agentId: number,
    m: MarketStateV3,
    optedIn: boolean,
    params: TargetPortfolioParams,
    state: PortfolioState,
    first: Extract<PortfolioDecision, { action: "trade" }>,
  ): Promise<{
    decision: Extract<PortfolioDecision, { action: "trade" }>;
    wantedUsdcE6: bigint | null;
  }> {
    const passed: Hex[] = [];
    let d = first;
    for (let tried = 0; tried <= OTHER_BUYS_TRIED; tried++) {
      const want = d.leg.valueUsdcE6;
      const floor =
        want / LEG_FLOOR_DIVISOR > params.minTradeUsdcE6
          ? want / LEG_FLOOR_DIVISOR
          : params.minTradeUsdcE6;
      const fits = this.legFits(m, optedIn, params, state, d.leg);
      const value = fits ? await fitLegValue(want, floor, fits) : want;
      if (value !== null) {
        if (value === want) return { decision: d, wantedUsdcE6: null };
        return { decision: resizeLeg(d, value, state), wantedUsdcE6: want };
      }
      if (d.leg.direction !== "buy") break;
      passed.push(d.leg.buy);
      // The same rule with the buys that cannot fill set aside, as a stale screen sets one aside.
      const next = TARGET_PORTFOLIO_V1.plan(params, {
        ...state,
        tokens: state.tokens.map((t) =>
          passed.some((p) => isAddressEqual(p, t.token)) ? { ...t, screenFresh: false } : t,
        ),
      });
      if (next.action !== "trade") break;
      this.o.log(
        `runner: agent ${agentId}: no size of the ${d.leg.buySymbol} buy fills within the slippage limit now; trying ${next.leg.buySymbol}`,
      );
      d = next;
    }
    return { decision: first, wantedUsdcE6: null };
  }

  /** Whether a leg of this value fills within the floor (with headroom) and the cost limit; null without prices. */
  private legFits(
    m: MarketStateV3,
    optedIn: boolean,
    params: TargetPortfolioParams,
    state: PortfolioState,
    leg: Extract<PortfolioDecision, { action: "trade" }>["leg"],
  ): ((value: bigint) => Promise<boolean>) | null {
    const reader = this.o.readerV3;
    const sold = state.tokens.find((t) => isAddressEqual(t.token, leg.sell));
    const bought = state.tokens.find((t) => isAddressEqual(t.token, leg.buy));
    if (!reader || !sold?.priceE18 || !bought?.priceE18) return null;
    const sell = resolveToken(m, leg.sell);
    const buy = resolveToken(m, leg.buy);
    const rules = {
      optedIn,
      intoUsdc: isAddressEqual(leg.buy, m.usdc),
      sellsScreened: sell.lane === "SCREENED",
    };
    return async (value) => {
      const amountIn = legAmount(leg.direction, value, sold);
      if (amountIn <= 0n) return false;
      const q = await reader.bestRoute(leg.sell, leg.buy, amountIn, rules).catch(() => null);
      if (!q) return false;
      const oracleOut =
        leg.direction === "buy"
          ? amountForValue(amountIn, bought.priceE18 as bigint, bought.decimals)
          : valueE6(amountIn, sold.priceE18 as bigint, sold.decimals);
      if (oracleOut <= 0n) return false;
      const floor = minAmountOutV3(m, sell, buy, amountIn, q.amountOut);
      if (q.amountOut < floor + (oracleOut * LEG_HEADROOM_BPS) / 10_000n) return false;
      const lost = oracleOut - q.amountOut;
      return lost <= 0n || (lost * 10_000n) / oracleOut <= BigInt(params.costHurdleBps);
    };
  }

  /** MON's reading, or the testnet fallback with a warning when it is missing (CO-U1). */
  private async monVolatility(agentId: number | null): Promise<number | null> {
    const reading = await this.o.volatility24hPct().catch(() => null);
    const fallback = this.o.fallbackVolatility24hPct ?? null;
    if (reading !== null || fallback === null) return reading;
    this.o.log(
      `runner${agentId === null ? "" : `: agent ${agentId}`}: warning: MON's volatility could not be read; using ${fallback}% annualized (testnet fallback) instead of holding buys`,
    );
    return fallback;
  }

  /** A token's 24-hour volatility: MON's reading for WMON, the per-token source for the rest. */
  private async volatilityOf(token: Hex, symbol: string, wmon: Hex): Promise<number | null> {
    if (isAddressEqual(token, wmon)) return this.monVolatility(null);
    const source = this.o.volatilityOf;
    return source ? source(token, symbol).catch(() => null) : null;
  }

  /** Off the fork a funding address short of gas MON would only be refused at submission. */
  private get profile(): TradingProfile {
    return this.o.profile ?? LAUNCH_TRADING_PROFILE;
  }

  /**
   * The testnet profile's cost with gas (2026-10-13): the leg's gas in USDC at MON's real price,
   * added to its price impact and fees, against the cost limit. The facts of a leg that costs
   * too much, or null when it passes or the profile does not count gas. Without a reading of
   * MON's price the leg is judged on impact and fees alone.
   */
  private async gasCostHold(
    legValueUsdcE6: bigint,
    costBps: number | null,
    params: { readonly costHurdleBps: number },
    gasLimit: bigint | undefined,
  ): Promise<Record<string, unknown> | null> {
    const gas = this.o.gas;
    if (!this.profile.countsGas || !gas || !this.o.gasMonUsdE18) return null;
    const [wei, monUsdE18] = await Promise.all([
      gas.swapCost(gasLimit).catch(() => null),
      this.o.gasMonUsdE18().catch(() => null),
    ]);
    if (wei === null || monUsdE18 === null || monUsdE18 <= 0n) return null;
    const gasUsdcE6 = gasCostUsdcE6(wei, monUsdE18);
    const r = legCostWithGas({
      legValueUsdcE6,
      costBps: costBps ?? 0,
      gasUsdcE6,
      hurdleBps: params.costHurdleBps,
    });
    return r.passes
      ? null
      : {
          gasUsdcE6: gasUsdcE6.toString(),
          gasBps: r.gasBps,
          costWithGasBps: r.totalBps,
          costHurdleBps: params.costHurdleBps,
        };
  }

  private async gasHold(
    key: Hex | null,
    gasLimit: bigint | undefined,
  ): Promise<{ gasWei: string; needWei: string } | null> {
    const gas = this.o.gas;
    if (!gas || gas.topUp || !key) return null;
    const [have, need] = await Promise.all([gas.balance(key), gas.swapCost(gasLimit)]);
    return have < need ? { gasWei: have.toString(), needWei: need.toString() } : null;
  }

  /** The latest refused leg of this plan, while its reasons still hold the runner back. */
  private async lastRefusedLeg(agentId: number, paramId: string) {
    const last = (await this.o.trades.intents(this.o.chainId, agentId, 20)).find(
      (i) => i.source === "template",
    );
    if (!last || (last.status !== "rejected" && last.status !== "failed")) return null;
    // A leg of an earlier plan never holds a new one back.
    const row = await this.o.trades.db
      .selectFrom("platform.intents")
      .select("checks")
      .where("intent_id", "=", last.intentId)
      .executeTakeFirst();
    if ((row?.checks as { paramId?: unknown } | undefined)?.paramId !== paramId) return null;
    const codes = last.blockers.length > 0 ? last.blockers.map((b) => b.code) : ["SEND_FAILED"];
    // 2026-10-17 (owner): a leg refused for its size is sized again at the next check, smaller.
    if (codes.every((c) => SIZE_REFUSALS.has(c))) return null;
    const facts = { intentId: last.intentId, refusedAt: last.updatedAt.toISOString() };
    if (last.blockers.some((b) => b.clears === "by_the_owner" || b.clears === "by_the_platform"))
      return { code: codes[0] as string, codes, facts };
    const times = last.blockers
      .map((b) => (b.clearsAt ? Date.parse(b.clearsAt) : Number.NaN))
      .filter((t) => !Number.isNaN(t));
    const until =
      times.length > 0 ? Math.max(...times) : last.updatedAt.getTime() + REFUSED_RETRY_MS;
    if (this.now().getTime() >= until) return null;
    return {
      code: codes[0] as string,
      codes,
      facts: { ...facts, retryAt: new Date(until).toISOString() },
    };
  }

  /** The runner acts as the agent with a platform identity, not a sandbox lease (D-290). */
  private identity(agentId: number): AgentIdentity {
    return {
      chainId: this.o.chainId,
      agentId,
      tier: "platform",
      leaseId: `template-runner:${agentId}`,
    };
  }

  private async record(plan: StoredPlan, d: NewDecision): Promise<RunnerDecision> {
    const previous = await this.o.decisions.latest(d.chainId, d.agentId);
    const { decision, changed } = await this.o.decisions.record(d, this.now());
    if (changed) {
      this.o.log(
        `runner: agent ${d.agentId}: ${d.outcome === "leg" ? `leg ${d.leg?.amountIn} ${d.leg?.sell}` : `hold ${d.code}`}`,
      );
      this.narrate(plan, decision, previous);
    }
    return decision;
  }

  /** An entry for a leg, a notable hold as it starts, and the account back in band after legs. */
  private narrate(plan: StoredPlan, d: RunnerDecision, previous: RunnerDecision | null) {
    const narrator = this.o.narrator;
    if (!narrator) return;
    const event: RunnerFacts["event"] | null =
      d.outcome === "leg"
        ? "leg"
        : d.code === "IN_BAND"
          ? previous && previous.outcome !== "hold"
            ? "in_band"
            : previous?.code === "LEG_PENDING"
              ? "in_band"
              : null
          : NOTABLE_HOLDS.has(d.code)
            ? "hold"
            : null;
    if (!event) return;
    const facts = isPortfolioPlan(plan) ? this.portfolioFacts(d) : this.bandsFacts(plan, d);
    void narrator
      .narrateEvent(d.chainId, d.agentId, `runner:${d.agentId}:${d.decisionId}`, {
        agent: agentName(d.agentId),
        activity: "runner",
        event,
        ...facts,
        reason: d.outcome === "hold" ? { code: d.code, message: holdMessage(d.code) } : null,
      })
      .catch((err: unknown) =>
        this.o.log(
          `runner: agent ${d.agentId}: no activity entry: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
        ),
      );
  }

  private bandsFacts(
    plan: StoredBandsPlan,
    d: RunnerDecision,
  ): Omit<RunnerFacts, "agent" | "activity" | "event" | "reason"> {
    const share = d.facts.wmonShareBps;
    return {
      asset: "WMON",
      targetPercent: pct(plan.params.targetWmonBps),
      bandPercent: pct(plan.params.bandHalfWidthBps),
      wmonSharePercent: typeof share === "number" ? pct(share) : null,
      sell: d.leg
        ? {
            asset: d.leg.sell,
            amount: formatUnits(
              BigInt(d.leg.amountIn),
              ASSET_DECIMALS[d.leg.sell as keyof typeof ASSET_DECIMALS] ?? 18,
            ),
          }
        : null,
      buy: d.leg?.buy ?? null,
    };
  }

  /** The position the decision is about, from the facts the rule recorded. */
  private portfolioFacts(
    d: RunnerDecision,
  ): Omit<RunnerFacts, "agent" | "activity" | "event" | "reason"> {
    const positions = (d.facts.positions ?? []) as readonly {
      token: string;
      symbol: string;
      targetBps: number;
      bandBps: number;
      shareBps: number | null;
    }[];
    const about = d.facts.position as string | null | undefined;
    const p = positions.find((x) => about && x.token.toLowerCase() === about.toLowerCase());
    const sellDecimals = (d.facts.sellDecimals as number | undefined) ?? null;
    return {
      asset: p?.symbol ?? null,
      targetPercent: p ? pct(p.targetBps) : "0",
      bandPercent: p ? pct(p.bandBps) : "0",
      wmonSharePercent: p && typeof p.shareBps === "number" ? pct(p.shareBps) : null,
      sell: d.leg
        ? {
            asset: d.leg.sell,
            amount:
              sellDecimals === null
                ? d.leg.amountIn
                : formatUnits(BigInt(d.leg.amountIn), sellDecimals),
          }
        : null,
      buy: d.leg?.buy ?? null,
    };
  }
}

/**
 * RUN-FIX: a band plan as the fund set's portfolio plan: WMON at the band's target, the band as
 * the position's range, the rest in USDC, and the same minimum trade, brake, cost hurdle and
 * largest leg. The thesis and exit fields are the portfolio check's, never read by its rule;
 * they name the band plan so a record built from them says where they came from.
 */
export function bandsAsPortfolio(plan: StoredBandsPlan, wmon: Hex): StoredPortfolioPlan {
  const p = plan.params;
  return {
    paramId: plan.paramId,
    chainId: plan.chainId,
    agentId: plan.agentId,
    paramsHash: plan.paramsHash,
    strategyEpoch: plan.strategyEpoch,
    setBy: plan.setBy,
    setByAddress: plan.setByAddress,
    createdAt: plan.createdAt,
    template: TARGET_PORTFOLIO_ID,
    params: {
      positions: [
        {
          token: wmon.toLowerCase() as Hex,
          targetWeightBps: p.targetWmonBps,
          bandBps: p.bandHalfWidthBps,
          thesisId: `band-plan:${plan.paramId}`,
          exit: {
            killCriterion: "the band plan's own range",
            recheckAt: new Date(plan.createdAt.getTime() + 30 * 86_400_000).toISOString(),
          },
        },
      ],
      cashTargetBps: 10_000 - p.targetWmonBps,
      minTradeUsdcE6: p.minTradeUsdcE6,
      volatilityBrakeBps: p.volatilityBrakeBps,
      costHurdleBps: p.costHurdleBps,
      maxLegBps: p.maxLegBps,
    },
  };
}

/** The raw amount a leg of this value moves: USDC itself for a buy, the sold token at its price, never above the balance. */
function legAmount(
  direction: "buy" | "sell",
  value: bigint,
  sold: Pick<PortfolioToken, "priceE18" | "decimals" | "balanceRaw">,
): bigint {
  if (direction === "buy") return value;
  if (!sold.priceE18) return 0n;
  const amount = amountForValue(value, sold.priceE18, sold.decimals);
  return amount > sold.balanceRaw ? sold.balanceRaw : amount;
}

/** The decision with its leg made smaller (2026-10-17). */
function resizeLeg(
  d: Extract<PortfolioDecision, { action: "trade" }>,
  value: bigint,
  state: PortfolioState,
): Extract<PortfolioDecision, { action: "trade" }> {
  const sold = state.tokens.find((t) => isAddressEqual(t.token, d.leg.sell));
  const amountIn = sold ? legAmount(d.leg.direction, value, sold) : d.leg.amountIn;
  return {
    ...d,
    leg: { ...d.leg, amountIn, valueUsdcE6: value },
    facts: { ...d.facts, legValueUsdcE6: value.toString() },
  };
}
