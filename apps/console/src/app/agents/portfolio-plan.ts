import type { PortfolioPlanParams, PortfolioPosition, PortfolioTokenView } from "./extension";

/**
 * The console's target portfolio form (F-U6): a draft in the units an owner
 * reads (percent and points), turned into the orchestrator's parameters, and
 * the plan's summary line. Pure, so it is tested without a browser.
 */
export interface PositionDraft {
  readonly token: string;
  readonly weight: string;
  readonly band: string;
  readonly thesisId: string;
  readonly killCriterion: string;
  readonly recheckAt: string;
}

export interface PortfolioDraft {
  readonly positions: readonly PositionDraft[];
  readonly cash: string;
  readonly minTrade: string;
  readonly brake: string;
  readonly cost: string;
  readonly maxLeg: string;
}

const inThirtyDays = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

export const emptyPosition = (token = ""): PositionDraft => ({
  token,
  weight: "",
  band: "3",
  thesisId: "",
  killCriterion: "",
  recheckAt: inThirtyDays(),
});

/** A draft from a served plan, or an empty one with the shared fields' defaults. */
export function portfolioDraftOf(
  params: Omit<PortfolioPlanParams, "template"> | null,
  defaults: {
    minTradeUsdcE6: string;
    volatilityBrakeBps: number;
    costHurdleBps: number;
    maxLegBps: number;
  },
): PortfolioDraft {
  if (!params)
    return {
      positions: [emptyPosition()],
      cash: "50",
      minTrade: String(Number(defaults.minTradeUsdcE6) / 1_000_000),
      brake: String(defaults.volatilityBrakeBps / 100),
      cost: String(defaults.costHurdleBps),
      maxLeg: String(defaults.maxLegBps / 100),
    };
  return {
    positions: params.positions.map((p) => ({
      token: p.token,
      weight: String(p.targetWeightBps / 100),
      band: String(p.bandBps / 100),
      thesisId: p.thesisId,
      killCriterion: p.exit.killCriterion,
      recheckAt: p.exit.recheckAt.slice(0, 10),
    })),
    cash: String(params.cashTargetBps / 100),
    minTrade: String(Number(params.minTradeUsdcE6) / 1_000_000),
    brake: String(params.volatilityBrakeBps / 100),
    cost: String(params.costHurdleBps),
    maxLeg: String(params.maxLegBps / 100),
  };
}

/** The draft as the orchestrator's parameters, or the first thing wrong with it. */
export function toPortfolioParams(d: PortfolioDraft): PortfolioPlanParams | { error: string } {
  const num = (v: string, label: string) => {
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n) || n < 0)
      throw new Error(`${label} must be a number of 0 or more.`);
    return n;
  };
  try {
    const positions: PortfolioPosition[] = d.positions.map((p, i) => {
      const n = i + 1;
      if (!/^0x[0-9a-fA-F]{40}$/.test(p.token)) throw new Error(`Position ${n} needs a token.`);
      if (p.thesisId.trim() === "") throw new Error(`Position ${n} needs a thesis ID.`);
      if (p.killCriterion.trim() === "") throw new Error(`Position ${n} needs a kill criterion.`);
      const recheck = Date.parse(p.recheckAt);
      if (Number.isNaN(recheck)) throw new Error(`Position ${n} needs a recheck date.`);
      return {
        token: p.token.toLowerCase(),
        targetWeightBps: Math.round(num(p.weight, `Position ${n}'s weight`) * 100),
        bandBps: Math.round(num(p.band, `Position ${n}'s band`) * 100),
        thesisId: p.thesisId.trim(),
        exit: {
          killCriterion: p.killCriterion.trim(),
          recheckAt: new Date(recheck).toISOString(),
        },
      };
    });
    return {
      template: "target_portfolio@1",
      positions,
      cashTargetBps: Math.round(num(d.cash, "The cash target") * 100),
      minTradeUsdcE6: String(Math.round(num(d.minTrade, "Minimum trade") * 1_000_000)),
      volatilityBrakeBps: Math.round(num(d.brake, "Volatility brake") * 100),
      costHurdleBps: Math.round(num(d.cost, "Cost limit")),
      maxLegBps: Math.round(num(d.maxLeg, "Largest leg") * 100),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The weights and the cash target added up, in percent, so the form can show the gap to 100%. */
export function draftTotalPercent(d: PortfolioDraft): number {
  const sum = d.positions.reduce((s, p) => s + (Number(p.weight) || 0), 0) + (Number(d.cash) || 0);
  return Math.round(sum * 100) / 100;
}

/** One line for a portfolio plan: each position's symbol and weight, then the cash. */
export function portfolioSummary(
  params: Omit<PortfolioPlanParams, "template">,
  tokens: readonly PortfolioTokenView[],
): string {
  const symbol = (token: string) =>
    tokens.find((t) => t.token.toLowerCase() === token.toLowerCase())?.symbol ??
    `${token.slice(0, 6)}..${token.slice(-4)}`;
  const parts = params.positions.map(
    (p) => `${symbol(p.token)} ${p.targetWeightBps / 100}% ±${p.bandBps / 100}`,
  );
  return `${parts.join(", ")}${parts.length ? ", " : ""}cash ${params.cashTargetBps / 100}%`;
}
