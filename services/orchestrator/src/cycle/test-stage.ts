import {
  type EffectiveLimits,
  REBALANCE_BANDS_V1,
  REBALANCE_BANDS_V1_BOUNDS,
  type RebalanceBandsParams,
  checkPlan,
} from "@alpha-agents/policy";
import { evalPasses, loadEvals, runEval } from "@alpha-agents/policy/evals";

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
  if (p.targetWmonBps > h.maxWmonShareBps)
    out.push({
      code: "HARD_LIMIT",
      field: "targetWmonBps",
      message: `The target WMON share may not exceed the hard limit of ${pct(h.maxWmonShareBps)}.`,
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
        maxWmonShareBps: hard.maxWmonShareBps,
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
    if (legBps > hard.maxTradeBps || (d.leg.sell === "USDC" && shareAfter > hard.maxWmonShareBps))
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
    h.maxWmonShareBps,
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
