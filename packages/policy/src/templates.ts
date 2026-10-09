import type { RejectionCode, RunnerHoldCode } from "@alpha-agents/domain";
import { keccak256, toBytes } from "viem";
import {
  type GoalError,
  REBALANCE_BANDS_V1_BOUNDS,
  type RebalanceBandsParams,
  canonicalJson,
  checkTemplateParams,
} from "./goals.ts";

/**
 * Strategy templates (P3-U3, D-090, D-094): a template has an ID with its
 * major version, typed parameters with hard bounds, and a deterministic rule
 * that turns the account's state and the market into one hold, with its
 * reason, or one trade leg. No model sizes a trade (D-297). A published
 * template is immutable: its fingerprint (ID, bounds and rule version) is
 * pinned by a test, so a change to a rule is a new version, never an edit.
 *
 * The rule decides in two steps so it stays pure: `plan` sizes the leg from
 * balances, price and volatility; the runner then quotes that leg on the
 * venue and `checkCost` holds it when it would cost more than the plan allows.
 * Everything else that can stop a leg (the account's mode, the breaker, the
 * rolling window, turnover, oracle deviation, gas, arming) is the Executor's
 * and the trade flow's, applied by the runner through the same checks as
 * `propose_swap`.
 */
export type TemplateHoldCode = RunnerHoldCode | Extract<RejectionCode, "ORACLE_STALE">;

export interface TemplateLeg {
  readonly sell: "USDC" | "WMON";
  readonly buy: "USDC" | "WMON";
  /** In the sold asset's raw units. */
  readonly amountIn: bigint;
  /** The leg's value at the oracle price, USDC base units. */
  readonly valueUsdcE6: bigint;
}

/** What the rule saw and computed, kept with every decision so it can be explained. */
export interface DecisionFacts {
  readonly totalValueUsdcE6: string;
  readonly wmonShareBps: number | null;
  readonly targetWmonBps: number;
  readonly bandHalfWidthBps: number;
  readonly volatility24hPct: number | null;
  readonly legValueUsdcE6: string | null;
  readonly costBps: number | null;
}

export type TemplateDecision =
  | { readonly action: "hold"; readonly code: TemplateHoldCode; readonly facts: DecisionFacts }
  | { readonly action: "trade"; readonly leg: TemplateLeg; readonly facts: DecisionFacts };

/** The account and market as the rule reads them. */
export interface BandsState {
  readonly usdcRaw: bigint;
  readonly wmonRaw: bigint;
  /** MON in USD from the oracle, 18 decimals; null when the price is not usable. */
  readonly priceE18: bigint | null;
  /** MON's annualized 24-hour realized volatility, percent; null when it could not be read. */
  readonly volatility24hPct: number | null;
  /** The limits the account trades under: each the hard limit or the owner's stricter value. */
  readonly limits: {
    readonly maxTradeBps: number;
    readonly maxWmonShareBps: number;
    readonly minUsdcShareBps: number;
  };
}

export interface StrategyTemplate<P> {
  readonly id: string;
  readonly label: string;
  /** Bumped with any change to the rule; a published value never changes (the fingerprint). */
  readonly ruleVersion: number;
  readonly bounds: Readonly<Record<keyof P, readonly [bigint, bigint]>>;
  /** Each parameter outside the bounds, with its field; empty when the set is valid. */
  check(params: P): GoalError[];
  plan(params: P, state: BandsState): TemplateDecision;
  checkCost(
    params: P,
    decision: Extract<TemplateDecision, { action: "trade" }>,
    quote: { readonly oracleOut: bigint; readonly quotedOut: bigint },
  ): TemplateDecision;
}

const BPS = 10_000n;
const WMON_VALUE_SCALE = 10n ** 30n;
/**
 * A leg is sized half a percent under its cap, so a small price move between
 * the decision and the Executor's own check does not push it over the
 * per-trade limit.
 */
const CAP_MARGIN_BPS = 50n;

const clampN = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * `rebalance_bands@1` (D-029): keep the account's WMON share near a target.
 * Inside `target ± band` it holds `IN_BAND`. Outside, it trades back toward
 * the target itself, not the band's edge, in one leg capped at the plan's
 * largest leg and the per-trade limit (legs above the cap are sequential,
 * one per decision, D-096). A leg under the minimum trade holds; a buy holds
 * above the volatility brake (a sale never does); a leg that would cost more
 * than the cost limit against the oracle holds (A-58).
 */
const rebalanceBandsV1: StrategyTemplate<RebalanceBandsParams> = {
  id: "rebalance_bands@1",
  label: "Band rebalancer",
  ruleVersion: 1,
  bounds: REBALANCE_BANDS_V1_BOUNDS,
  check: checkTemplateParams,

  plan(p: RebalanceBandsParams, s: BandsState): TemplateDecision {
    const facts = (over: Partial<DecisionFacts>): DecisionFacts => ({
      totalValueUsdcE6: "0",
      wmonShareBps: null,
      targetWmonBps: p.targetWmonBps,
      bandHalfWidthBps: p.bandHalfWidthBps,
      volatility24hPct: s.volatility24hPct,
      legValueUsdcE6: null,
      costBps: null,
      ...over,
    });
    if (s.priceE18 === null || s.priceE18 <= 0n)
      return { action: "hold", code: "ORACLE_STALE", facts: facts({}) };
    const wmonValue = (s.wmonRaw * s.priceE18) / WMON_VALUE_SCALE;
    const total = s.usdcRaw + wmonValue;
    if (total === 0n) return { action: "hold", code: "BELOW_MIN_TRADE", facts: facts({}) };
    const share = Number((wmonValue * BPS) / total);
    // The target can never sit past the account's own limits.
    const target = clampN(
      p.targetWmonBps,
      0,
      Math.min(s.limits.maxWmonShareBps, 10_000 - s.limits.minUsdcShareBps),
    );
    const seen = facts({
      totalValueUsdcE6: total.toString(),
      wmonShareBps: share,
      targetWmonBps: target,
    });
    if (Math.abs(share - target) <= p.bandHalfWidthBps)
      return { action: "hold", code: "IN_BAND", facts: seen };

    const buy = share < target;
    const toTarget = (BigInt(Math.abs(target - share)) * total) / BPS;
    const capBps = BigInt(Math.min(p.maxLegBps, s.limits.maxTradeBps));
    const cap = (total * capBps * (BPS - CAP_MARGIN_BPS)) / (BPS * BPS);
    let legValue = toTarget < cap ? toTarget : cap;
    if (buy && legValue > s.usdcRaw) legValue = s.usdcRaw;
    if (!buy && legValue > wmonValue) legValue = wmonValue;
    const sized = { ...seen, legValueUsdcE6: legValue.toString() };
    if (legValue < p.minTradeUsdcE6)
      return { action: "hold", code: "BELOW_MIN_TRADE", facts: sized };
    if (buy) {
      if (s.volatility24hPct === null)
        return { action: "hold", code: "VOLATILITY_UNAVAILABLE", facts: sized };
      if (s.volatility24hPct * 100 > p.volatilityBrakeBps)
        return { action: "hold", code: "VOLATILITY_BRAKE", facts: sized };
      return {
        action: "trade",
        leg: { sell: "USDC", buy: "WMON", amountIn: legValue, valueUsdcE6: legValue },
        facts: sized,
      };
    }
    let amountIn = (legValue * WMON_VALUE_SCALE) / s.priceE18;
    if (amountIn > s.wmonRaw) amountIn = s.wmonRaw;
    return {
      action: "trade",
      leg: { sell: "WMON", buy: "USDC", amountIn, valueUsdcE6: legValue },
      facts: sized,
    };
  },

  checkCost(
    p: RebalanceBandsParams,
    d: Extract<TemplateDecision, { action: "trade" }>,
    quote: { readonly oracleOut: bigint; readonly quotedOut: bigint },
  ): TemplateDecision {
    if (quote.oracleOut <= 0n) return d;
    const lost = quote.oracleOut - quote.quotedOut;
    const costBps = lost <= 0n ? 0 : Number((lost * BPS) / quote.oracleOut);
    const facts = { ...d.facts, costBps };
    if (costBps > p.costHurdleBps) return { action: "hold", code: "COST_HURDLE", facts };
    return { ...d, facts };
  },
};
export const REBALANCE_BANDS_V1: StrategyTemplate<RebalanceBandsParams> =
  Object.freeze(rebalanceBandsV1);

/** Every published template by ID. Adding one is a new entry; an entry never changes. */
export const STRATEGY_TEMPLATE_RULES = Object.freeze({
  "rebalance_bands@1": REBALANCE_BANDS_V1,
});
export type TemplateId = keyof typeof STRATEGY_TEMPLATE_RULES;

/** A template's fingerprint: its ID, rule version and bounds. A test pins each published one. */
export function templateFingerprint(t: StrategyTemplate<unknown>): `0x${string}` {
  return keccak256(
    toBytes(canonicalJson({ id: t.id, ruleVersion: t.ruleVersion, bounds: t.bounds })),
  );
}

/** A plan's parameters by hash, as `platform.strategy_params` records them (until BuildRegistry). */
export function paramsHash(template: string, params: RebalanceBandsParams): `0x${string}` {
  return keccak256(toBytes(canonicalJson({ template, params })));
}

/** The goal's limits a plan must sit inside (from the translated goal, P3-U1). */
export interface PlanLimits {
  readonly targetRange: { readonly minBps: number; readonly maxBps: number };
  readonly ownerLimits: { readonly maxTradeBps: number; readonly maxSlippageBps: number };
}

/**
 * A plan's parameters checked against the template's bounds and the goal:
 * the target inside the goal's range, the largest leg no larger than the
 * owner's largest trade, and the cost limit no looser than the owner's
 * slippage limit. Empty when the plan can be set.
 */
export function checkPlan(params: RebalanceBandsParams, goal: PlanLimits): GoalError[] {
  const out = checkTemplateParams(params);
  const { minBps, maxBps } = goal.targetRange;
  if (params.targetWmonBps < minBps || params.targetWmonBps > maxBps)
    out.push({
      field: "template.params.targetWmonBps",
      code: "OUT_OF_TEMPLATE_BOUNDS",
      message: `The target WMON share must be within the goal's range, ${minBps / 100}% to ${maxBps / 100}%.`,
    });
  if (params.maxLegBps > goal.ownerLimits.maxTradeBps)
    out.push({
      field: "template.params.maxLegBps",
      code: "LOOSER_THAN_HARD_LIMIT",
      message: `The largest leg may not exceed the owner's largest trade, ${goal.ownerLimits.maxTradeBps / 100}% of the account.`,
    });
  if (params.costHurdleBps > goal.ownerLimits.maxSlippageBps)
    out.push({
      field: "template.params.costHurdleBps",
      code: "LOOSER_THAN_HARD_LIMIT",
      message: `The cost limit may not exceed the owner's slippage limit, ${goal.ownerLimits.maxSlippageBps / 100}%.`,
    });
  return out;
}
