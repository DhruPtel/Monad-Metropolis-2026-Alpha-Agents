import {
  type EffectiveLimits,
  REBALANCE_BANDS_V1,
  REBALANCE_BANDS_V1_BOUNDS,
  type RebalanceBandsParams,
  checkPlan,
} from "@alpha-agents/policy";
import {
  evalPasses,
  loadEvals,
  loadPortfolioEvals,
  portfolioEvalPasses,
  runEval,
  runPortfolioEval,
} from "@alpha-agents/policy/evals";
import {
  AGGRESSIVENESS_ENVELOPES,
  type Aggressiveness,
  type AggressivenessEnvelope,
  isStableSymbol,
} from "@alpha-agents/domain";
import {
  type TargetPortfolioParams,
  amountForValue,
  checkTargetPortfolioParams,
  valueE6,
} from "@alpha-agents/policy";
import type { AgentStateV3, MarketStateV3 } from "@alpha-agents/chain-tools";
import { type Hex, isAddressEqual } from "viem";

/**
 * The Test stage (D-282, P3-U4): deterministic, no model. Before the Zoom out
 * it works out what the plan may change within, the envelope, and checks the
 * current plan; when the Zoom out proposes a plan, the same rules check the
 * proposal before its stage may end. The rules: the template's parameter
 * bounds, the goal's target range and the owner's limits, the hard limits,
 * the 24-hour cooldown after an accepted agent change, and the template's
 * recorded evals, which the proposed parameters must also pass without a leg
 * the hard limits forbid. Nothing here trades.
 */
export const COOLDOWN_MS = 24 * 3_600_000;

export const TEST_CODES = [
  "OUT_OF_BOUNDS",
  "OUTSIDE_PRESET",
  "OWNER_LIMIT",
  "HARD_LIMIT",
  "COOLDOWN",
  "EVAL_BREACH",
  "TEMPLATE_EVALS_FAIL",
] as const;
export type TestCode = (typeof TEST_CODES)[number];

export interface TestFinding {
  readonly code: TestCode;
  readonly field: string;
  readonly message: string;
}

export interface TestInputs {
  readonly targetRange: { readonly minBps: number; readonly maxBps: number };
  readonly hardLimits: EffectiveLimits;
  readonly ownerLimits: EffectiveLimits;
  /** When the agent's last accepted plan change was set, if any. */
  readonly lastAgentChangeAt: Date | null;
  readonly now: Date;
}

const pct = (bps: number) => `${bps / 100}%`;

/** A proposed (or current) plan checked against every rule; empty findings means it passes. */
export function checkProposal(p: RebalanceBandsParams, t: TestInputs): TestFinding[] {
  const out: TestFinding[] = [];
  for (const e of checkPlan(p, {
    targetRange: t.targetRange,
    ownerLimits: {
      maxTradeBps: t.ownerLimits.maxTradeBps,
      maxSlippageBps: t.ownerLimits.maxSlippageBps,
    },
  })) {
    const field = e.field.replace(/^template\.params\./, "");
    out.push({
      code:
        e.code === "OUT_OF_TEMPLATE_BOUNDS" &&
        field === "targetWmonBps" &&
        /goal's range/.test(e.message)
          ? "OUTSIDE_PRESET"
          : e.code === "LOOSER_THAN_HARD_LIMIT"
            ? "OWNER_LIMIT"
            : "OUT_OF_BOUNDS",
      field,
      message: e.message,
    });
  }
  const h = t.hardLimits;
  if (p.targetWmonBps > h.maxPositionBps)
    out.push({
      code: "HARD_LIMIT",
      field: "targetWmonBps",
      message: `The target WMON share may not exceed the hard limit of ${pct(h.maxPositionBps)}.`,
    });
  if (10_000 - p.targetWmonBps < h.minUsdcShareBps)
    out.push({
      code: "HARD_LIMIT",
      field: "targetWmonBps",
      message: `The target must leave at least ${pct(h.minUsdcShareBps)} in USDC.`,
    });
  if (p.maxLegBps > h.maxTradeBps)
    out.push({
      code: "HARD_LIMIT",
      field: "maxLegBps",
      message: `The largest leg may not exceed the hard per-trade limit of ${pct(h.maxTradeBps)}.`,
    });
  if (t.lastAgentChangeAt && t.now.getTime() - t.lastAgentChangeAt.getTime() < COOLDOWN_MS)
    out.push({
      code: "COOLDOWN",
      field: "plan",
      message: `An agent plan change was accepted at ${t.lastAgentChangeAt.toISOString()}; the next may come 24 hours after it.`,
    });
  out.push(...evalFindings(p, h));
  return out;
}

/**
 * The template's recorded evals: every scenario still gives its recorded
 * answer under the template's own parameters, and under the proposed ones no
 * scenario makes a leg larger than the hard per-trade limit or a buy that
 * takes WMON past its hard share.
 */
export function evalFindings(p: RebalanceBandsParams, hard: EffectiveLimits): TestFinding[] {
  const out: TestFinding[] = [];
  const file = loadEvals("rebalance_bands@1");
  const failing = file.scenarios.filter((s) => !evalPasses(s, runEval(file, s)));
  if (failing.length > 0)
    out.push({
      code: "TEMPLATE_EVALS_FAIL",
      field: "template",
      message: `The template no longer passes ${failing.length} of its recorded evals (${failing.map((s) => s.name).join(", ")}).`,
    });
  const breaches: string[] = [];
  for (const s of file.scenarios) {
    if (s.state.priceE18 === null) continue;
    const price = BigInt(s.state.priceE18);
    const usdc = BigInt(s.state.usdcRaw);
    const wmon = BigInt(s.state.wmonRaw);
    const d = REBALANCE_BANDS_V1.plan(p, {
      usdcRaw: usdc,
      wmonRaw: wmon,
      priceE18: price,
      volatility24hPct: s.state.volatility24hPct,
      limits: {
        maxTradeBps: hard.maxTradeBps,
        maxWmonShareBps: hard.maxPositionBps,
        minUsdcShareBps: hard.minUsdcShareBps,
      },
    });
    if (d.action !== "trade") continue;
    const total = usdc + (wmon * price) / 10n ** 30n;
    if (total === 0n) continue;
    const legBps = Number((d.leg.valueUsdcE6 * 10_000n) / total);
    const wmonAfter =
      d.leg.sell === "USDC"
        ? (wmon * price) / 10n ** 30n + d.leg.valueUsdcE6
        : (wmon * price) / 10n ** 30n - d.leg.valueUsdcE6;
    const shareAfter = Number((wmonAfter * 10_000n) / total);
    if (legBps > hard.maxTradeBps || (d.leg.sell === "USDC" && shareAfter > hard.maxPositionBps))
      breaches.push(s.name);
  }
  if (breaches.length > 0)
    out.push({
      code: "EVAL_BREACH",
      field: "params",
      message: `Under these parameters ${breaches.length} recorded scenario(s) would trade past a hard limit (${breaches.join(", ")}).`,
    });
  return out;
}

/** What the Zoom out may change the plan within: every bound, intersected. */
export function testEnvelope(current: RebalanceBandsParams | null, t: TestInputs) {
  const b = REBALANCE_BANDS_V1_BOUNDS;
  const h = t.hardLimits;
  const o = t.ownerLimits;
  const minTarget = Math.max(Number(b.targetWmonBps[0]), t.targetRange.minBps);
  const maxTarget = Math.min(
    Number(b.targetWmonBps[1]),
    t.targetRange.maxBps,
    h.maxPositionBps,
    10_000 - h.minUsdcShareBps,
  );
  const cooldownUntil =
    t.lastAgentChangeAt && t.now.getTime() - t.lastAgentChangeAt.getTime() < COOLDOWN_MS
      ? new Date(t.lastAgentChangeAt.getTime() + COOLDOWN_MS).toISOString()
      : null;
  return {
    template: "rebalance_bands@1",
    ranges: {
      targetWmonBps: [minTarget, maxTarget],
      bandHalfWidthBps: [Number(b.bandHalfWidthBps[0]), Number(b.bandHalfWidthBps[1])],
      minTradeUsdc: [
        (Number(b.minTradeUsdcE6[0]) / 1e6).toString(),
        (Number(b.minTradeUsdcE6[1]) / 1e6).toString(),
      ],
      volatilityBrakeBps: [Number(b.volatilityBrakeBps[0]), Number(b.volatilityBrakeBps[1])],
      costHurdleBps: [
        Number(b.costHurdleBps[0]),
        Math.min(Number(b.costHurdleBps[1]), o.maxSlippageBps),
      ],
      maxLegBps: [
        Number(b.maxLegBps[0]),
        Math.min(Number(b.maxLegBps[1]), o.maxTradeBps, h.maxTradeBps),
      ],
    },
    cooldownUntil,
    mayProposeNow: cooldownUntil === null,
    currentPlanFindings: current ? checkProposal(current, { ...t, lastAgentChangeAt: null }) : [],
  };
}
export type TestEnvelope = ReturnType<typeof testEnvelope>;

/** A proposal's parameters as the Zoom out writes them (USDC as a decimal), in the template's units. */
export function proposalParams(p: {
  readonly targetWmonBps: number;
  readonly bandHalfWidthBps: number;
  readonly minTradeUsdc: string;
  readonly volatilityBrakeBps: number;
  readonly costHurdleBps: number;
  readonly maxLegBps: number;
}): RebalanceBandsParams {
  const [whole = "0", frac = ""] = p.minTradeUsdc.split(".");
  return {
    targetWmonBps: p.targetWmonBps,
    bandHalfWidthBps: p.bandHalfWidthBps,
    minTradeUsdcE6: BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6) || "0"),
    volatilityBrakeBps: p.volatilityBrakeBps,
    costHurdleBps: p.costHurdleBps,
    maxLegBps: p.maxLegBps,
  };
}

// ---- F-U6: the Test stage over a target portfolio (D-344) ----

export const TEST_CODES_V2 = [
  "OUT_OF_BOUNDS",
  "TOKEN_NOT_REGISTERED",
  "TOKEN_NOT_BUYABLE",
  "NOT_OPTED_IN",
  "SCREEN_STALE",
  "ENVELOPE_POSITIONS",
  "ENVELOPE_POSITION",
  "ENVELOPE_CLASS_A",
  "ENVELOPE_CLASS_A_TOTAL",
  "ENVELOPE_STABLE",
  "CLASS_A_COST_BASIS",
  "VALUES_UNUSABLE",
  "DEPTH",
  "TURNOVER",
  "HARD_LIMIT",
  "COOLDOWN",
  "TEMPLATE_EVALS_FAIL",
] as const;
export type TestCodeV2 = (typeof TEST_CODES_V2)[number];

export interface TestFindingV2 {
  readonly code: TestCodeV2;
  readonly field: string;
  readonly message: string;
}

export interface TestInputsV2 {
  readonly aggressiveness: Aggressiveness;
  readonly market: MarketStateV3;
  readonly agent: AgentStateV3;
  /** A passing screen no older than the platform's bound exists; null when the platform does not know. */
  readonly screenFresh: (token: Hex) => Promise<boolean | null>;
  /** The venue's output for a buy of the token with this much USDC along the best route; null without a route. */
  readonly quoteBuy: (token: Hex, usdcE6: bigint) => Promise<bigint | null>;
  readonly lastAgentChangeAt: Date | null;
  readonly now: Date;
}

const BPS = 10_000n;
const pctOf = (bps: number) => `${bps / 100}%`;

/** The account's value and each token's current value, or null while a held class F feed is unusable. */
function portfolioValues(t: TestInputsV2): { nav: bigint; values: Map<string, bigint> } | null {
  const values = new Map<string, bigint>();
  let nav = 0n;
  for (const h of t.agent.holdings) {
    if (h.balance === 0n) continue;
    if (isAddressEqual(h.token, t.market.usdc)) {
      values.set(h.token.toLowerCase(), h.balance);
      nav += h.balance;
      continue;
    }
    const price = t.market.prices[h.token.toLowerCase()];
    if (!price || price.priceE18 <= 0n || price.reason !== "OK") return null;
    const v = valueE6(h.balance, price.priceE18, h.decimals);
    values.set(h.token.toLowerCase(), v);
    nav += v;
  }
  return { nav, values };
}

/**
 * A proposed (or current) target portfolio checked against every rule the
 * plan says (D-344): the template's bounds, the registry (registered,
 * buyable, the lane's opt-in), a fresh passing screen per token, the
 * aggressiveness envelope (A-60: positions, per-position and class A caps,
 * the stablecoin minimum), the class A cost-basis cap, the hard limits, each
 * position's target size against its route's depth at the slippage limit,
 * the implied turnover against the 24-hour cap, the cooldown, and the
 * template's recorded evals. Empty findings means the plan may be set.
 */
export async function checkPortfolioProposal(
  p: TargetPortfolioParams,
  t: TestInputsV2,
): Promise<TestFindingV2[]> {
  const out: TestFindingV2[] = [];
  for (const e of checkTargetPortfolioParams(p))
    out.push({ code: "OUT_OF_BOUNDS", field: e.field, message: e.message });
  const env = AGGRESSIVENESS_ENVELOPES[t.aggressiveness];
  const m = t.market;
  const policy = m.policy;
  if (p.positions.length > env.maxPositions)
    out.push({
      code: "ENVELOPE_POSITIONS",
      field: "positions",
      message: `A ${env.label} plan holds at most ${env.maxPositions} positions, not ${p.positions.length}.`,
    });
  let classATotal = 0;
  let stable = p.cashTargetBps;
  const sized: {
    token: Hex;
    symbol: string;
    decimals: number;
    priceE18: bigint;
    targetBps: number;
  }[] = [];
  for (const [i, pos] of p.positions.entries()) {
    const f = `positions.${i}`;
    const token = m.tokens.find((x) => isAddressEqual(x.token, pos.token));
    if (!token) {
      out.push({
        code: "TOKEN_NOT_REGISTERED",
        field: `${f}.token`,
        message: `${pos.token} is not in the token registry.`,
      });
      continue;
    }
    const name = token.symbol;
    if (token.status !== "BUYABLE")
      out.push({
        code: "TOKEN_NOT_BUYABLE",
        field: `${f}.token`,
        message: `${name} is ${token.status.toLowerCase().replace("_", " ")} in the registry, so a plan cannot target it.`,
      });
    if (token.lane === "SCREENED" && !t.agent.screenedOptIn)
      out.push({
        code: "NOT_OPTED_IN",
        field: `${f}.token`,
        message: `${name} is in the screened lane, which this account has not opted into.`,
      });
    if (token.lane === "NONE")
      out.push({
        code: "TOKEN_NOT_BUYABLE",
        field: `${f}.token`,
        message: `${name} is in no lane of the registry.`,
      });
    if (isStableSymbol(name)) stable += pos.targetWeightBps;
    if (token.priceClass === "A") {
      classATotal += pos.targetWeightBps;
      if (!env.classAAllowed)
        out.push({
          code: "ENVELOPE_CLASS_A",
          field: `${f}.targetWeightBps`,
          message: `A ${env.label} plan holds class F tokens only; ${name} is priced by attestation (class A).`,
        });
      else if (pos.targetWeightBps > env.maxClassAPositionBps)
        out.push({
          code: "ENVELOPE_CLASS_A",
          field: `${f}.targetWeightBps`,
          message: `A ${env.label} plan weighs a class A position at most ${pctOf(env.maxClassAPositionBps)}; ${name} is ${pctOf(pos.targetWeightBps)}.`,
        });
      if (pos.targetWeightBps > policy.maxClassAPositionBps)
        out.push({
          code: "CLASS_A_COST_BASIS",
          field: `${f}.targetWeightBps`,
          message: `The Executor caps a class A position's cost basis at ${pctOf(policy.maxClassAPositionBps)} of the account; ${name} is ${pctOf(pos.targetWeightBps)}.`,
        });
    }
    const cap = Math.min(env.maxPositionBps, token.maxPositionBps, policy.maxAssetBps);
    if (pos.targetWeightBps > cap)
      out.push({
        code: "ENVELOPE_POSITION",
        field: `${f}.targetWeightBps`,
        message: `${name} may weigh at most ${pctOf(cap)} (the ${env.label} envelope, the registry's cap and the hard limit together); the plan says ${pctOf(pos.targetWeightBps)}.`,
      });
    const fresh = await t.screenFresh(token.token);
    if (fresh === false)
      out.push({
        code: "SCREEN_STALE",
        field: `${f}.token`,
        message: `${name} has no passing safety screen from the last six hours; the runner would not buy it (D-339).`,
      });
    const price = m.prices[token.token.toLowerCase()];
    if (token.priceClass === "F" && price && price.priceE18 > 0n && price.reason === "OK")
      sized.push({
        token: token.token,
        symbol: name,
        decimals: token.decimals,
        priceE18: price.priceE18,
        targetBps: pos.targetWeightBps,
      });
  }
  if (classATotal > env.maxClassATotalBps)
    out.push({
      code: "ENVELOPE_CLASS_A_TOTAL",
      field: "positions",
      message: `A ${env.label} plan holds at most ${pctOf(env.maxClassATotalBps)} in class A tokens together; the plan says ${pctOf(classATotal)}.`,
    });
  if (stable < env.minStableBps)
    out.push({
      code: "ENVELOPE_STABLE",
      field: "cashTargetBps",
      message: `A ${env.label} plan keeps at least ${pctOf(env.minStableBps)} in stablecoins (USDC cash and stablecoin positions); the plan keeps ${pctOf(stable)}.`,
    });
  if (p.cashTargetBps < policy.minUsdcBps)
    out.push({
      code: "HARD_LIMIT",
      field: "cashTargetBps",
      message: `The cash target may not sit under the Executor's USDC floor of ${pctOf(policy.minUsdcBps)}.`,
    });
  if (p.maxLegBps > policy.maxTradeBps)
    out.push({
      code: "HARD_LIMIT",
      field: "maxLegBps",
      message: `The largest leg may not exceed the hard per-trade limit of ${pctOf(policy.maxTradeBps)}.`,
    });
  if (p.costHurdleBps > policy.maxSlippageBps)
    out.push({
      code: "HARD_LIMIT",
      field: "costHurdleBps",
      message: `The cost limit may not exceed the slippage limit of ${pctOf(policy.maxSlippageBps)}.`,
    });
  if (t.lastAgentChangeAt && t.now.getTime() - t.lastAgentChangeAt.getTime() < COOLDOWN_MS)
    out.push({
      code: "COOLDOWN",
      field: "plan",
      message: `An agent plan change was accepted at ${t.lastAgentChangeAt.toISOString()}; the next may come 24 hours after it.`,
    });

  // Depth and turnover need the account's value now.
  const v = portfolioValues(t);
  if (!v) {
    out.push({
      code: "VALUES_UNUSABLE",
      field: "account",
      message:
        "The account's values cannot be read now (a held token's feed is unusable), so depth and turnover were not checked.",
    });
  } else if (v.nav > 0n) {
    let implied = 0n;
    for (const s of sized) {
      const target = (v.nav * BigInt(s.targetBps)) / BPS;
      const current = v.values.get(s.token.toLowerCase()) ?? 0n;
      implied += target > current ? target - current : current - target;
      if (target === 0n) continue;
      const out1 = await t.quoteBuy(s.token, target);
      const impliedOut = amountForValue(target, s.priceE18, s.decimals);
      const floor = (impliedOut * (BPS - BigInt(policy.maxSlippageBps))) / BPS;
      if (out1 === null)
        out.push({
          code: "DEPTH",
          field: `positions.${s.symbol}`,
          message: `No registered route reaches ${s.symbol} for a ${pctOf(s.targetBps)} position of this account.`,
        });
      else if (out1 < floor)
        out.push({
          code: "DEPTH",
          field: `positions.${s.symbol}`,
          message: `A ${pctOf(s.targetBps)} position in ${s.symbol} is too large for its pools: buying it in one go would cost more than the ${pctOf(policy.maxSlippageBps)} slippage limit, so the runner could not reach the target.`,
        });
    }
    // Every token the plan no longer names is sold as well.
    for (const [token, current] of v.values)
      if (
        !isAddressEqual(token as Hex, m.usdc) &&
        !p.positions.some((pos) => isAddressEqual(pos.token, token as Hex))
      )
        implied += current;
    const window = (v.nav * BigInt(policy.maxTurnoverBps)) / BPS;
    const left = window > t.agent.turnoverUsed ? window - t.agent.turnoverUsed : 0n;
    if (implied > left)
      out.push({
        code: "TURNOVER",
        field: "positions",
        message: `Reaching this plan means about ${(Number(implied) / 1e6).toFixed(2)} USDC of trades, more than the ${(Number(left) / 1e6).toFixed(2)} USDC the 24-hour turnover cap (${pctOf(policy.maxTurnoverBps)}) leaves now.`,
      });
  }
  const evals = loadPortfolioEvals();
  const failing = evals.scenarios.filter((s) => !portfolioEvalPasses(s, runPortfolioEval(s)));
  if (failing.length > 0)
    out.push({
      code: "TEMPLATE_EVALS_FAIL",
      field: "template",
      message: `The template no longer passes ${failing.length} of its recorded evals (${failing.map((s) => s.name).join(", ")}).`,
    });
  return out;
}

/** What the Zoom out may draft a target portfolio within: the envelope, the tokens it may name, and the cooldown. */
export function portfolioEnvelope(
  current: TargetPortfolioParams | null,
  t: Pick<TestInputsV2, "aggressiveness" | "market" | "agent" | "lastAgentChangeAt" | "now">,
): {
  template: "target_portfolio@1";
  aggressiveness: Aggressiveness;
  envelope: AggressivenessEnvelope;
  limits: { maxTradeBps: number; maxAssetBps: number; minUsdcBps: number; maxSlippageBps: number };
  tokens: {
    token: Hex;
    symbol: string;
    class: string;
    lane: string;
    status: string;
    capBps: number;
    buyable: boolean;
  }[];
  cooldownUntil: string | null;
  mayProposeNow: boolean;
  currentPositions: number;
} {
  const env = AGGRESSIVENESS_ENVELOPES[t.aggressiveness];
  const policy = t.market.policy;
  const cooldownUntil =
    t.lastAgentChangeAt && t.now.getTime() - t.lastAgentChangeAt.getTime() < COOLDOWN_MS
      ? new Date(t.lastAgentChangeAt.getTime() + COOLDOWN_MS).toISOString()
      : null;
  return {
    template: "target_portfolio@1",
    aggressiveness: t.aggressiveness,
    envelope: env,
    limits: {
      maxTradeBps: policy.maxTradeBps,
      maxAssetBps: policy.maxAssetBps,
      minUsdcBps: policy.minUsdcBps,
      maxSlippageBps: policy.maxSlippageBps,
    },
    tokens: t.market.tokens
      .filter((x) => !isAddressEqual(x.token, t.market.usdc))
      .map((x) => ({
        token: x.token,
        symbol: x.symbol,
        class: x.priceClass,
        lane: x.lane,
        status: x.status,
        capBps: Math.min(env.maxPositionBps, x.maxPositionBps, policy.maxAssetBps),
        buyable:
          x.status === "BUYABLE" &&
          (x.lane === "CORE" || (x.lane === "SCREENED" && t.agent.screenedOptIn)) &&
          (x.priceClass === "F" || (x.priceClass === "A" && env.classAAllowed)),
      })),
    cooldownUntil,
    mayProposeNow: cooldownUntil === null,
    currentPositions: current?.positions.length ?? 0,
  };
}
export type PortfolioEnvelope = ReturnType<typeof portfolioEnvelope>;
