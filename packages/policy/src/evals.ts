import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { valueE6 } from "./custody.ts";
import type { RebalanceBandsParams } from "./goals.ts";
import {
  type PortfolioDecision,
  type PortfolioState,
  type PortfolioToken,
  TARGET_PORTFOLIO_ID,
  TARGET_PORTFOLIO_V1,
  amountForValue,
  portfolioParamsFromJson,
} from "./portfolio.ts";
import { type BandsState, STRATEGY_TEMPLATE_RULES, type TemplateDecision } from "./templates.ts";

/**
 * The evals format (P3-U3, Q-28): recorded scenarios of account, prices,
 * volatility, quote and parameters, each with the action and reason the
 * template must give. Kept as JSON in packages/policy/evals, one file per
 * template, so the runner's tests and later the audit's dynamic test (P6-U4)
 * run the same set, and a new rule version must pass every scenario of the
 * version it replaces unless a scenario is deliberately changed. Imported as
 * `@alpha-agents/policy/evals`, apart from the package's main entry, because
 * it reads files and the main entry also runs in the browser.
 */
export interface EvalScenario {
  readonly name: string;
  readonly description: string;
  readonly params: Record<string, string | number>;
  readonly state: {
    readonly usdcRaw: string;
    readonly wmonRaw: string;
    readonly priceE18: string | null;
    readonly volatility24hPct: number | null;
    readonly limits: BandsState["limits"];
  };
  /** The venue's output for the leg, raw units of the bought asset; null when no leg is expected. */
  readonly quote: string | null;
  readonly expect:
    | { readonly action: "hold"; readonly code: string }
    | { readonly action: "trade"; readonly sell: "USDC" | "WMON"; readonly amountIn: string };
}

export interface EvalFile {
  readonly template: keyof typeof STRATEGY_TEMPLATE_RULES;
  readonly format: 1;
  readonly note: string;
  readonly scenarios: readonly EvalScenario[];
}

export function loadEvals(template: keyof typeof STRATEGY_TEMPLATE_RULES): EvalFile {
  return JSON.parse(
    readFileSync(new URL(`../evals/${template}.json`, import.meta.url), "utf8"),
  ) as EvalFile;
}

const WMON_VALUE_SCALE = 10n ** 30n;

/** Runs one scenario through the template: plan, then the cost check on the recorded quote. */
export function runEval(file: EvalFile, s: EvalScenario): TemplateDecision {
  const t = STRATEGY_TEMPLATE_RULES[file.template];
  const p = s.params;
  const params: RebalanceBandsParams = {
    targetWmonBps: Number(p.targetWmonBps),
    bandHalfWidthBps: Number(p.bandHalfWidthBps),
    minTradeUsdcE6: BigInt(p.minTradeUsdcE6 ?? 0),
    volatilityBrakeBps: Number(p.volatilityBrakeBps),
    costHurdleBps: Number(p.costHurdleBps),
    maxLegBps: Number(p.maxLegBps),
  };
  const priceE18 = s.state.priceE18 === null ? null : BigInt(s.state.priceE18);
  const d = t.plan(params, {
    usdcRaw: BigInt(s.state.usdcRaw),
    wmonRaw: BigInt(s.state.wmonRaw),
    priceE18,
    volatility24hPct: s.state.volatility24hPct,
    limits: s.state.limits,
  });
  if (d.action !== "trade" || s.quote === null || priceE18 === null) return d;
  const oracleOut =
    d.leg.sell === "USDC"
      ? (d.leg.amountIn * WMON_VALUE_SCALE) / priceE18
      : (d.leg.amountIn * priceE18) / WMON_VALUE_SCALE;
  return t.checkCost(params, d, { oracleOut, quotedOut: BigInt(s.quote) });
}

/** Whether a decision is what the scenario expects. */
export function evalPasses(s: EvalScenario, d: TemplateDecision): boolean {
  if (s.expect.action === "hold") return d.action === "hold" && d.code === s.expect.code;
  return (
    d.action === "trade" &&
    d.leg.sell === s.expect.sell &&
    d.leg.amountIn === BigInt(s.expect.amountIn)
  );
}

/**
 * The evals of `target_portfolio@1` (F-U6): the same idea over many tokens.
 * A scenario is every registered token with the account's holding of it, the
 * plan, the quote for the expected leg, and the action the rule must give.
 */
export interface PortfolioEvalToken {
  readonly token: Hex;
  readonly symbol: string;
  readonly decimals: number;
  readonly balanceRaw: string;
  readonly priceE18: string | null;
  readonly priceClass: PortfolioToken["priceClass"];
  readonly status: PortfolioToken["status"];
  readonly capBps: number;
  readonly screenFresh: boolean | null;
  readonly volatility24hPct: number | null;
}

export interface PortfolioEvalScenario {
  readonly name: string;
  readonly description: string;
  readonly params: Record<string, unknown>;
  readonly state: {
    readonly usdc: Hex;
    readonly wmon: Hex;
    readonly tokens: readonly PortfolioEvalToken[];
    readonly limits: PortfolioState["limits"];
  };
  /** The venue's output for the expected leg, raw units of the token bought; null when no leg is expected. */
  readonly quote: string | null;
  readonly expect:
    | { readonly action: "hold"; readonly code: string }
    | {
        readonly action: "trade";
        readonly sell: string;
        readonly buy: string;
        readonly amountIn: string;
      };
}

export interface PortfolioEvalFile {
  readonly template: typeof TARGET_PORTFOLIO_ID;
  readonly format: 2;
  readonly note: string;
  readonly scenarios: readonly PortfolioEvalScenario[];
}

export function loadPortfolioEvals(): PortfolioEvalFile {
  return JSON.parse(
    readFileSync(new URL(`../evals/${TARGET_PORTFOLIO_ID}.json`, import.meta.url), "utf8"),
  ) as PortfolioEvalFile;
}

/** Runs one portfolio scenario: the plan, then the cost check on the recorded quote. */
export function runPortfolioEval(s: PortfolioEvalScenario): PortfolioDecision {
  const params = portfolioParamsFromJson(s.params);
  const state: PortfolioState = {
    usdc: s.state.usdc,
    wmon: s.state.wmon,
    limits: s.state.limits,
    tokens: s.state.tokens.map((t) => ({
      ...t,
      balanceRaw: BigInt(t.balanceRaw),
      priceE18: t.priceE18 === null ? null : BigInt(t.priceE18),
    })),
  };
  const d = TARGET_PORTFOLIO_V1.plan(params, state);
  if (d.action !== "trade" || s.quote === null) return d;
  const sold = state.tokens.find((t) => t.token === d.leg.sell);
  const bought = state.tokens.find((t) => t.token === d.leg.buy);
  if (!sold?.priceE18 || !bought?.priceE18) return d;
  const oracleOut =
    d.leg.direction === "buy"
      ? amountForValue(d.leg.amountIn, bought.priceE18, bought.decimals)
      : valueE6(d.leg.amountIn, sold.priceE18, sold.decimals);
  return TARGET_PORTFOLIO_V1.checkCost(params, d, { oracleOut, quotedOut: BigInt(s.quote) });
}

export function portfolioEvalPasses(s: PortfolioEvalScenario, d: PortfolioDecision): boolean {
  if (s.expect.action === "hold") return d.action === "hold" && d.code === s.expect.code;
  return (
    d.action === "trade" &&
    d.leg.sellSymbol === s.expect.sell &&
    d.leg.buySymbol === s.expect.buy &&
    d.leg.amountIn === BigInt(s.expect.amountIn)
  );
}
