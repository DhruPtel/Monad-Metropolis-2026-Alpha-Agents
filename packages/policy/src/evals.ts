import { readFileSync } from "node:fs";
import type { RebalanceBandsParams } from "./goals.ts";
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
