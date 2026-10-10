import type { RejectionCode, RunnerHoldCode } from "@alpha-agents/domain";
import { type Hex, isAddressEqual, keccak256, toBytes } from "viem";
import { CUSTODY_V3, valueE6 } from "./custody.ts";

/** The custody core's valuation (USDC base units of an amount at a price), for the runner and the Test. */
export { valueE6 };
import type { TokenStatusV3 } from "./executor-v3.ts";
import { type GoalError, canonicalJson } from "./goals.ts";

/**
 * `target_portfolio@1` (F-U6, D-344): the agent's plan is a set of positions,
 * each with a target weight, a band, the thesis it rests on and an exit plan,
 * plus a cash target in USDC. The rule is deterministic and sizes every leg
 * itself (D-297, D-335): each minute it compares holdings with targets and
 * makes at most one leg, sells first (the most overweight position, or any
 * position whose token the registry moved to sell-only), then buys (the most
 * underweight), each leg capped by the per-trade limit, the position's cap and
 * the cash floor, always against USDC (a position-to-position change is a
 * sale and then a buy, routed through USDC). It holds back with a reason
 * code; the Executor's own rules and the trade flow apply after it, through
 * the same checks as `propose_swap`. `rebalance_bands@1` stays as the
 * two-asset case.
 */
export interface PortfolioPosition {
  /** The token's address, lowercase. */
  readonly token: Hex;
  readonly targetWeightBps: number;
  /** The band's half-width: inside target ± band the position holds. */
  readonly bandBps: number;
  /** The thesis brief the position rests on (D-284). */
  readonly thesisId: string;
  readonly exit: {
    readonly killCriterion: string;
    /** When the thesis is checked again, ISO time. */
    readonly recheckAt: string;
    /** Trim back to the target once the position's share passes this, even inside the band. */
    readonly trimAboveBps?: number;
  };
}

export interface TargetPortfolioParams {
  readonly positions: readonly PortfolioPosition[];
  /** The USDC the plan keeps, basis points of the account's value; weights and cash sum to 100%. */
  readonly cashTargetBps: number;
  /** The smallest leg worth trading, USDC base units. */
  readonly minTradeUsdcE6: bigint;
  /** Annualized 24-hour volatility of the token bought above which its buys hold, basis points. */
  readonly volatilityBrakeBps: number;
  /** The most a leg may cost against the oracle (fee and price impact), basis points. */
  readonly costHurdleBps: number;
  /** The largest leg, basis points of the account's value; never above the per-trade cap. */
  readonly maxLegBps: number;
}

type Bound = readonly [min: bigint, max: bigint];

/** The template's own bounds; the Test stage's envelope narrows them per aggressiveness (A-60). */
export const TARGET_PORTFOLIO_V1_BOUNDS = Object.freeze({
  positions: [0n, 12n] as Bound,
  targetWeightBps: [0n, BigInt(CUSTODY_V3.maxAssetBps)] as Bound,
  bandBps: [50n, 2_000n] as Bound,
  cashTargetBps: [0n, 10_000n] as Bound,
  minTradeUsdcE6: [100_000n, 100_000_000n] as Bound,
  volatilityBrakeBps: [2_000n, 30_000n] as Bound,
  costHurdleBps: [5n, BigInt(CUSTODY_V3.maxSlippageBps)] as Bound,
  maxLegBps: [10n, BigInt(CUSTODY_V3.maxTradeBps)] as Bound,
});

export const TARGET_PORTFOLIO_ID = "target_portfolio@1";

const BPS = 10_000n;
/** A leg is sized half a percent under its cap (as `rebalance_bands@1` does). */
const CAP_MARGIN_BPS = 50n;

function bound(field: string, value: bigint, [lo, hi]: Bound, label: string): GoalError | null {
  if (value >= lo && value <= hi) return null;
  return {
    field,
    code: "OUT_OF_TEMPLATE_BOUNDS",
    message: `${label} must be between ${lo} and ${hi}.`,
  };
}

/** Every parameter outside the template's own bounds or its shape rules; empty when valid. */
export function checkTargetPortfolioParams(p: TargetPortfolioParams): GoalError[] {
  const out: GoalError[] = [];
  const b = TARGET_PORTFOLIO_V1_BOUNDS;
  const push = (e: GoalError | null) => {
    if (e) out.push(e);
  };
  push(bound("positions", BigInt(p.positions.length), b.positions, "The number of positions"));
  push(bound("cashTargetBps", BigInt(p.cashTargetBps), b.cashTargetBps, "The cash target"));
  push(bound("minTradeUsdcE6", p.minTradeUsdcE6, b.minTradeUsdcE6, "The minimum trade"));
  push(
    bound(
      "volatilityBrakeBps",
      BigInt(p.volatilityBrakeBps),
      b.volatilityBrakeBps,
      "The volatility brake",
    ),
  );
  push(bound("costHurdleBps", BigInt(p.costHurdleBps), b.costHurdleBps, "The cost limit"));
  push(bound("maxLegBps", BigInt(p.maxLegBps), b.maxLegBps, "The largest leg"));
  const seen = new Set<string>();
  let weights = 0;
  p.positions.forEach((pos, i) => {
    const f = `positions.${i}`;
    if (!/^0x[0-9a-f]{40}$/.test(pos.token))
      out.push({
        field: `${f}.token`,
        code: "INVALID_FIELD",
        message: "A position's token is its lowercase address.",
      });
    if (seen.has(pos.token))
      out.push({
        field: `${f}.token`,
        code: "INVALID_FIELD",
        message: "A token appears once in a plan.",
      });
    seen.add(pos.token);
    push(bound(`${f}.targetWeightBps`, BigInt(pos.targetWeightBps), b.targetWeightBps, "A weight"));
    push(bound(`${f}.bandBps`, BigInt(pos.bandBps), b.bandBps, "A band"));
    if (pos.thesisId.trim() === "")
      out.push({
        field: `${f}.thesisId`,
        code: "INVALID_FIELD",
        message: "Every position names the thesis it rests on.",
      });
    if (pos.exit.killCriterion.trim() === "")
      out.push({
        field: `${f}.exit.killCriterion`,
        code: "INVALID_FIELD",
        message: "Every position has a kill criterion.",
      });
    if (Number.isNaN(Date.parse(pos.exit.recheckAt)))
      out.push({
        field: `${f}.exit.recheckAt`,
        code: "INVALID_FIELD",
        message: "A recheck time is an ISO date.",
      });
    if (pos.exit.trimAboveBps !== undefined && pos.exit.trimAboveBps <= pos.targetWeightBps)
      out.push({
        field: `${f}.exit.trimAboveBps`,
        code: "INVALID_FIELD",
        message: "A trim level sits above the position's target.",
      });
    weights += pos.targetWeightBps;
  });
  if (weights + p.cashTargetBps !== 10_000)
    out.push({
      field: "cashTargetBps",
      code: "INVALID_FIELD",
      message: `The weights and the cash target must add up to 100%, not ${(weights + p.cashTargetBps) / 100}%.`,
    });
  return out;
}

/** A registered token as the rule reads it, with the account's holding of it (zero when not held). */
export interface PortfolioToken {
  readonly token: Hex;
  readonly symbol: string;
  readonly decimals: number;
  readonly balanceRaw: bigint;
  /** The USDC value of one whole token scaled by 1e18; null when the token has no usable price now. */
  readonly priceE18: bigint | null;
  readonly priceClass: "USDC" | "F" | "A" | "NONE";
  readonly status: TokenStatusV3;
  /** The registry's cap on this token, basis points of the account's value. */
  readonly capBps: number;
  /** Whether a passing screen no older than the platform's bound exists; null when the platform does not know. */
  readonly screenFresh: boolean | null;
  /** The token's annualized 24-hour volatility in percent; null when there is no reading. */
  readonly volatility24hPct: number | null;
}

export interface PortfolioState {
  readonly usdc: Hex;
  readonly wmon: Hex;
  /** Every registered token, the held ones with their balance. */
  readonly tokens: readonly PortfolioToken[];
  readonly limits: {
    readonly maxTradeBps: number;
    readonly maxAssetBps: number;
    readonly minUsdcBps: number;
  };
}

export type PortfolioHoldCode =
  RunnerHoldCode | Extract<RejectionCode, "ORACLE_STALE" | "TOKEN_FROZEN">;

export interface PortfolioLeg {
  readonly sell: Hex;
  readonly buy: Hex;
  readonly sellSymbol: string;
  readonly buySymbol: string;
  /** In the sold token's raw units. */
  readonly amountIn: bigint;
  /** The leg's value at the oracle price, USDC base units. */
  readonly valueUsdcE6: bigint;
  /** The position the leg moves, and which way. */
  readonly position: Hex;
  readonly direction: "sell" | "buy";
}

export interface PositionFact {
  readonly token: Hex;
  readonly symbol: string;
  readonly targetBps: number;
  readonly bandBps: number;
  /** The position's share of the account now; null when its value is unreadable. */
  readonly shareBps: number | null;
  readonly valueUsdcE6: string;
  readonly status: TokenStatusV3;
}

/** What the rule saw and computed, kept with every decision so it can be explained. */
export interface PortfolioFacts {
  readonly totalValueUsdcE6: string;
  readonly cashShareBps: number | null;
  readonly cashTargetBps: number;
  readonly positions: readonly PositionFact[];
  /** The position the decision is about (the leg's, or the one that held). */
  readonly position: Hex | null;
  readonly legValueUsdcE6: string | null;
  readonly costBps: number | null;
  readonly skipped: readonly { readonly token: Hex; readonly code: string }[];
}

export type PortfolioDecision =
  | { readonly action: "hold"; readonly code: PortfolioHoldCode; readonly facts: PortfolioFacts }
  | { readonly action: "trade"; readonly leg: PortfolioLeg; readonly facts: PortfolioFacts };

export interface PortfolioTemplate {
  readonly id: typeof TARGET_PORTFOLIO_ID;
  readonly label: string;
  readonly ruleVersion: number;
  readonly bounds: typeof TARGET_PORTFOLIO_V1_BOUNDS;
  check(params: TargetPortfolioParams): GoalError[];
  plan(params: TargetPortfolioParams, state: PortfolioState): PortfolioDecision;
  checkCost(
    params: TargetPortfolioParams,
    decision: Extract<PortfolioDecision, { action: "trade" }>,
    quote: { readonly oracleOut: bigint; readonly quotedOut: bigint },
  ): PortfolioDecision;
}

const same = (a: Hex, b: Hex) => isAddressEqual(a, b);

/** The raw amount of a token worth `valueE6` USDC at its price (the inverse of `valueE6`). */
export function amountForValue(valueUsdcE6: bigint, priceE18: bigint, decimals: number): bigint {
  return (valueUsdcE6 * 10n ** BigInt(decimals + 12)) / priceE18;
}

interface Seen {
  readonly t: PortfolioToken;
  readonly valueE6: bigint;
  readonly shareBps: number;
  readonly targetBps: number;
  readonly bandBps: number;
  readonly trimAboveBps: number | null;
  readonly inPlan: boolean;
}

const targetPortfolioV1: PortfolioTemplate = {
  id: TARGET_PORTFOLIO_ID,
  label: "Target portfolio",
  ruleVersion: 1,
  bounds: TARGET_PORTFOLIO_V1_BOUNDS,
  check: checkTargetPortfolioParams,

  plan(p: TargetPortfolioParams, s: PortfolioState): PortfolioDecision {
    const skipped: { token: Hex; code: string }[] = [];
    const byToken = (token: Hex) => s.tokens.find((t) => same(t.token, token)) ?? null;
    const usdc = byToken(s.usdc);
    const facts = (over: Partial<PortfolioFacts>): PortfolioFacts => ({
      totalValueUsdcE6: "0",
      cashShareBps: null,
      cashTargetBps: p.cashTargetBps,
      positions: [],
      position: null,
      legValueUsdcE6: null,
      costBps: null,
      skipped,
      ...over,
    });
    if (!usdc) return { action: "hold", code: "ORACLE_STALE", facts: facts({}) };
    // Every held token's value; a held class F token with no price makes the whole account
    // unreadable, as the custody core's own views fail closed then.
    let total = 0n;
    const values = new Map<string, bigint>();
    for (const t of s.tokens) {
      if (t.balanceRaw === 0n) continue;
      if (same(t.token, s.usdc)) {
        values.set(t.token.toLowerCase(), t.balanceRaw);
        total += t.balanceRaw;
        continue;
      }
      if (t.priceE18 === null || t.priceE18 <= 0n)
        return { action: "hold", code: "ORACLE_STALE", facts: facts({}) };
      const v = valueE6(t.balanceRaw, t.priceE18, t.decimals);
      values.set(t.token.toLowerCase(), v);
      total += v;
    }
    if (total === 0n) return { action: "hold", code: "BELOW_MIN_TRADE", facts: facts({}) };
    const shareOf = (v: bigint) => Number((v * BPS) / total);
    const cashShare = shareOf(values.get(s.usdc.toLowerCase()) ?? 0n);

    // Every position in the plan, and every held token the plan no longer names (target 0).
    const seen: Seen[] = [];
    for (const pos of p.positions) {
      const t = byToken(pos.token);
      if (!t) {
        skipped.push({ token: pos.token, code: "TOKEN_NOT_REGISTERED" });
        continue;
      }
      const v = values.get(t.token.toLowerCase()) ?? 0n;
      seen.push({
        t,
        valueE6: v,
        shareBps: shareOf(v),
        targetBps: t.status === "SELL_ONLY" || t.status === "FROZEN" ? 0 : pos.targetWeightBps,
        bandBps: pos.bandBps,
        trimAboveBps: pos.exit.trimAboveBps ?? null,
        inPlan: true,
      });
    }
    for (const t of s.tokens) {
      if (t.balanceRaw === 0n || same(t.token, s.usdc)) continue;
      if (seen.some((x) => same(x.t.token, t.token))) continue;
      seen.push({
        t,
        valueE6: values.get(t.token.toLowerCase()) ?? 0n,
        shareBps: shareOf(values.get(t.token.toLowerCase()) ?? 0n),
        targetBps: 0,
        bandBps: 0,
        trimAboveBps: null,
        inPlan: false,
      });
    }
    const positionFacts: PositionFact[] = seen.map((x) => ({
      token: x.t.token,
      symbol: x.t.symbol,
      targetBps: x.targetBps,
      bandBps: x.bandBps,
      shareBps: x.shareBps,
      valueUsdcE6: x.valueE6.toString(),
      status: x.t.status,
    }));
    const base = facts({
      totalValueUsdcE6: total.toString(),
      cashShareBps: cashShare,
      positions: positionFacts,
    });
    const capBps = BigInt(Math.min(p.maxLegBps, s.limits.maxTradeBps));
    const legCap = (total * capBps * (BPS - CAP_MARGIN_BPS)) / (BPS * BPS);

    // The first reason a candidate could not move, kept for the hold when no leg is found.
    let held: PortfolioHoldCode | null = null;
    let heldFor: Hex | null = null;
    const hold = (code: PortfolioHoldCode, token: Hex) => {
      if (held === null) {
        held = code;
        heldFor = token;
      }
      skipped.push({ token, code });
    };

    // Sells first: the most overweight position, a trim level passed, or a token the registry
    // moved to sell-only (its target is zero above). A frozen token cannot move at all.
    const sells = seen
      .filter((x) => x.valueE6 > 0n)
      .map((x) => {
        const excess = x.shareBps - x.targetBps;
        const trim = x.trimAboveBps !== null && x.shareBps > x.trimAboveBps;
        const beyond = excess > x.bandBps || (x.targetBps === 0 && x.valueE6 > 0n) || trim;
        return { x, excess, beyond };
      })
      .filter((c) => c.beyond)
      .sort((a, b) => b.excess - a.excess);
    for (const c of sells) {
      const t = c.x.t;
      if (t.status === "FROZEN") {
        hold("TOKEN_FROZEN", t.token);
        continue;
      }
      if (t.priceE18 === null) {
        hold("ORACLE_STALE", t.token);
        continue;
      }
      const toTarget = (BigInt(c.excess) * total) / BPS;
      let legValue = toTarget < legCap ? toTarget : legCap;
      if (legValue > c.x.valueE6) legValue = c.x.valueE6;
      if (legValue < p.minTradeUsdcE6) {
        hold("BELOW_MIN_TRADE", t.token);
        continue;
      }
      let amountIn = amountForValue(legValue, t.priceE18, t.decimals);
      if (amountIn > t.balanceRaw) amountIn = t.balanceRaw;
      return {
        action: "trade",
        leg: {
          sell: t.token,
          buy: s.usdc,
          sellSymbol: t.symbol,
          buySymbol: usdc.symbol,
          amountIn,
          valueUsdcE6: legValue,
          position: t.token,
          direction: "sell",
        },
        facts: { ...base, position: t.token, legValueUsdcE6: legValue.toString() },
      };
    }

    // Then buys: the most underweight position, inside its cap and above the cash floor.
    const floor = (total * BigInt(s.limits.minUsdcBps)) / BPS;
    const cash = values.get(s.usdc.toLowerCase()) ?? 0n;
    const spendable = cash > floor ? cash - floor : 0n;
    const buys = seen
      .filter((x) => x.inPlan)
      .map((x) => ({ x, deficit: x.targetBps - x.shareBps }))
      .filter((c) => c.deficit > c.x.bandBps)
      .sort((a, b) => b.deficit - a.deficit);
    for (const c of buys) {
      const t = c.x.t;
      if (t.status !== "BUYABLE") {
        hold(t.status === "FROZEN" ? "TOKEN_FROZEN" : "CAP_REACHED", t.token);
        continue;
      }
      if (t.priceClass === "A") {
        hold("ATTESTATION_UNAVAILABLE", t.token);
        continue;
      }
      if (t.priceE18 === null || t.priceE18 <= 0n) {
        hold("ORACLE_STALE", t.token);
        continue;
      }
      if (t.screenFresh === false) {
        hold("SCREEN_STALE", t.token);
        continue;
      }
      const positionCap = (total * BigInt(Math.min(t.capBps, s.limits.maxAssetBps))) / BPS;
      const room = positionCap > c.x.valueE6 ? positionCap - c.x.valueE6 : 0n;
      if (room < p.minTradeUsdcE6) {
        hold("CAP_REACHED", t.token);
        continue;
      }
      if (spendable < p.minTradeUsdcE6) {
        hold("CASH_FLOOR", t.token);
        continue;
      }
      const toTarget = (BigInt(c.deficit) * total) / BPS;
      let legValue = toTarget < legCap ? toTarget : legCap;
      if (legValue > room) legValue = room;
      if (legValue > spendable) legValue = spendable;
      if (legValue < p.minTradeUsdcE6) {
        hold("BELOW_MIN_TRADE", t.token);
        continue;
      }
      // The brake is per token: a reading above it holds the buy; MON's reading is required
      // for WMON, as before, while another token without a reading is not held (A-74).
      if (t.volatility24hPct === null) {
        if (same(t.token, s.wmon)) {
          hold("VOLATILITY_UNAVAILABLE", t.token);
          continue;
        }
      } else if (t.volatility24hPct * 100 > p.volatilityBrakeBps) {
        hold("VOLATILITY_BRAKE", t.token);
        continue;
      }
      return {
        action: "trade",
        leg: {
          sell: s.usdc,
          buy: t.token,
          sellSymbol: usdc.symbol,
          buySymbol: t.symbol,
          amountIn: legValue,
          valueUsdcE6: legValue,
          position: t.token,
          direction: "buy",
        },
        facts: { ...base, position: t.token, legValueUsdcE6: legValue.toString() },
      };
    }
    if (held !== null) return { action: "hold", code: held, facts: { ...base, position: heldFor } };
    return { action: "hold", code: "IN_BAND", facts: base };
  },

  checkCost(
    p: TargetPortfolioParams,
    d: Extract<PortfolioDecision, { action: "trade" }>,
    quote: { readonly oracleOut: bigint; readonly quotedOut: bigint },
  ): PortfolioDecision {
    if (quote.oracleOut <= 0n) return d;
    const lost = quote.oracleOut - quote.quotedOut;
    const costBps = lost <= 0n ? 0 : Number((lost * BPS) / quote.oracleOut);
    const facts = { ...d.facts, costBps };
    if (costBps > p.costHurdleBps) return { action: "hold", code: "COST_HURDLE", facts };
    return { ...d, facts };
  },
};
export const TARGET_PORTFOLIO_V1: PortfolioTemplate = Object.freeze(targetPortfolioV1);

/** The template's fingerprint, pinned by a test like `rebalance_bands@1`'s. */
export function portfolioFingerprint(): `0x${string}` {
  const t = TARGET_PORTFOLIO_V1;
  return keccak256(
    toBytes(canonicalJson({ id: t.id, ruleVersion: t.ruleVersion, bounds: t.bounds })),
  );
}

/** A portfolio plan's parameters as canonical JSON (bigints as decimal strings) and their hash. */
export function portfolioParamsJson(p: TargetPortfolioParams): string {
  return canonicalJson({
    positions: p.positions.map((pos) => ({
      token: pos.token.toLowerCase(),
      targetWeightBps: pos.targetWeightBps,
      bandBps: pos.bandBps,
      thesisId: pos.thesisId,
      exit: {
        killCriterion: pos.exit.killCriterion,
        recheckAt: pos.exit.recheckAt,
        ...(pos.exit.trimAboveBps === undefined ? {} : { trimAboveBps: pos.exit.trimAboveBps }),
      },
    })),
    cashTargetBps: p.cashTargetBps,
    minTradeUsdcE6: p.minTradeUsdcE6.toString(),
    volatilityBrakeBps: p.volatilityBrakeBps,
    costHurdleBps: p.costHurdleBps,
    maxLegBps: p.maxLegBps,
  });
}

export function portfolioParamsHash(p: TargetPortfolioParams): `0x${string}` {
  return keccak256(
    toBytes(
      canonicalJson({ template: TARGET_PORTFOLIO_ID, params: JSON.parse(portfolioParamsJson(p)) }),
    ),
  );
}

/** Parameters from their stored JSON (bigints as decimal strings). */
export function portfolioParamsFromJson(raw: Record<string, unknown>): TargetPortfolioParams {
  const positions = Array.isArray(raw.positions)
    ? (raw.positions as Record<string, unknown>[])
    : [];
  return {
    positions: positions.map((pos) => {
      const exit = (pos.exit ?? {}) as Record<string, unknown>;
      return {
        token: String(pos.token).toLowerCase() as Hex,
        targetWeightBps: Number(pos.targetWeightBps),
        bandBps: Number(pos.bandBps),
        thesisId: String(pos.thesisId ?? ""),
        exit: {
          killCriterion: String(exit.killCriterion ?? ""),
          recheckAt: String(exit.recheckAt ?? ""),
          ...(exit.trimAboveBps === undefined || exit.trimAboveBps === null
            ? {}
            : { trimAboveBps: Number(exit.trimAboveBps) }),
        },
      };
    }),
    cashTargetBps: Number(raw.cashTargetBps),
    minTradeUsdcE6: BigInt(String(raw.minTradeUsdcE6 ?? 0)),
    volatilityBrakeBps: Number(raw.volatilityBrakeBps),
    costHurdleBps: Number(raw.costHurdleBps),
    maxLegBps: Number(raw.maxLegBps),
  };
}
