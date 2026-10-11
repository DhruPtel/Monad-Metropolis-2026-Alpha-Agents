import type { TargetPortfolioParams } from "@alpha-agents/policy";
import { valueE6 } from "@alpha-agents/policy";
import type { ProposalEvaluation } from "@alpha-agents/trading";
import { type Hex, isAddressEqual } from "viem";
import { type TestFindingV2, type TestInputsV2, checkPortfolioProposal } from "./test-stage.ts";

/**
 * One rule set for a target portfolio (F-T2): everything the Test stage v2
 * checks (the template's bounds, the registry, the screens, the envelope,
 * the hard limits, the depth, the turnover, the cooldown, the evals) and the
 * cost to move against the plan's own cost hurdle. The research Test stage,
 * the proposal evaluator and the console's draft check all call
 * `checkTargetPortfolio`, so a plan one accepts the others accept too,
 * unless the account or the market changed in between; the fingerprint
 * taken with each verdict lets the evaluator name exactly what changed.
 */
export type PlanCost = ProposalEvaluation["cost"];

export interface PlanVerdict {
  readonly findings: TestFindingV2[];
  readonly cost: PlanCost;
  readonly fingerprint: PlanInputsFingerprint;
}

/** What the rules read: the account and the market as of one read, in a comparable form. */
export interface PlanInputsFingerprint {
  readonly block: string;
  readonly mode: string;
  readonly optedIn: boolean;
  readonly aggressiveness: string;
  readonly policyHash: string;
  readonly paused: boolean;
  readonly attestorSet: boolean;
  readonly holdings: readonly { token: string; balance: string; costBasis: string }[];
  readonly prices: readonly { token: string; priceE18: string; reason: string }[];
  readonly tokens: readonly {
    token: string;
    lane: string;
    status: string;
    priceClass: string;
    maxPositionBps: number;
  }[];
  readonly lastAgentChangeAt: string | null;
}

const BPS = 10_000n;
const lower = (a: string) => a.toLowerCase();

/** The estimated cost of moving the account to the plan: one leg per token whose value moves by at least the minimum trade. */
export async function estimateMoveCost(
  p: TargetPortfolioParams,
  t: TestInputsV2,
): Promise<PlanCost> {
  const values = new Map<string, bigint>();
  let nav = 0n;
  for (const h of t.agent.holdings) {
    if (h.balance === 0n) continue;
    let v: bigint;
    if (isAddressEqual(h.token as Hex, t.market.usdc)) v = h.balance;
    else {
      const price = t.market.prices[lower(h.token)];
      if (!price || price.priceE18 <= 0n || price.reason !== "OK") return null;
      v = valueE6(h.balance, price.priceE18, h.decimals);
    }
    values.set(lower(h.token), v);
    nav += v;
  }
  if (nav === 0n)
    return {
      legs: 0,
      turnoverUsdcE6: "0",
      estimatedCostUsdcE6: "0",
      costBps: 0,
      basis: "an empty account moves nothing",
    };
  let legs = 0;
  let turnover = 0n;
  let cost = 0n;
  const targets = new Map(p.positions.map((x) => [lower(x.token), x]));
  const tokens = new Set([...values.keys(), ...targets.keys()]);
  tokens.delete(lower(t.market.usdc));
  for (const token of tokens) {
    const target = ((targets.get(token)?.targetWeightBps ?? 0) * Number(nav)) / Number(BPS);
    const now = Number(values.get(token) ?? 0n);
    const delta = BigInt(Math.round(target - now));
    const size = delta < 0n ? -delta : delta;
    if (size < p.minTradeUsdcE6) continue;
    legs += 1;
    turnover += size;
    if (delta > 0n) {
      const out = await t.quoteBuy(token as Hex, size);
      const price = t.market.prices[token];
      const info = t.market.tokens.find((x) => lower(x.token) === token);
      if (out !== null && price && price.priceE18 > 0n && info) {
        const got = valueE6(out, price.priceE18, info.decimals);
        cost += got < size ? size - got : 0n;
      } else cost += (size * BigInt(p.costHurdleBps)) / BPS;
    } else cost += (size * BigInt(p.costHurdleBps)) / BPS;
  }
  return {
    legs,
    turnoverUsdcE6: turnover.toString(),
    estimatedCostUsdcE6: cost.toString(),
    costBps: turnover > 0n ? Number((cost * BPS) / turnover) : 0,
    basis:
      "buys quoted at today's depth against the oracle price, sells counted at the plan's cost hurdle; one leg per token whose value moves by at least the minimum trade",
  };
}

/** The account and the market the rules read, as of this read. */
export function inputsFingerprint(t: TestInputsV2): PlanInputsFingerprint {
  const byToken = <T extends { token: string }>(xs: readonly T[]) =>
    [...xs].sort((a, b) => lower(a.token).localeCompare(lower(b.token)));
  return {
    block: t.market.block.toString(),
    mode: t.agent.mode,
    optedIn: t.agent.screenedOptIn,
    aggressiveness: t.aggressiveness,
    policyHash: t.market.policyHash,
    paused: t.market.paused,
    attestorSet: t.market.attestorSet,
    holdings: byToken(
      t.agent.holdings
        .filter((h) => h.balance > 0n)
        .map((h) => ({
          token: lower(h.token),
          balance: h.balance.toString(),
          costBasis: h.costBasis.toString(),
        })),
    ),
    prices: byToken(
      Object.entries(t.market.prices).map(([token, p]) => ({
        token: lower(token),
        priceE18: p.priceE18.toString(),
        reason: p.reason,
      })),
    ),
    tokens: byToken(
      t.market.tokens.map((x) => ({
        token: lower(x.token),
        lane: x.lane,
        status: x.status,
        priceClass: x.priceClass,
        maxPositionBps: x.maxPositionBps,
      })),
    ),
    lastAgentChangeAt: t.lastAgentChangeAt ? t.lastAgentChangeAt.toISOString() : null,
  };
}

/** What changed between two reads, in the owner's words; empty when nothing the rules read changed. */
export function whatChanged(
  before: PlanInputsFingerprint,
  after: PlanInputsFingerprint,
  symbols: Readonly<Record<string, string>> = {},
): string[] {
  const name = (token: string) =>
    symbols[lower(token)] ?? `${token.slice(0, 6)}..${token.slice(-4)}`;
  const out: string[] = [];
  if (before.mode !== after.mode)
    out.push(`the account's mode changed from ${before.mode} to ${after.mode}`);
  if (before.optedIn !== after.optedIn)
    out.push(
      `the owner ${after.optedIn ? "opted into" : "opted out of"} the screened lane on chain`,
    );
  if (before.aggressiveness !== after.aggressiveness)
    out.push(
      `the goal's aggressiveness changed from ${before.aggressiveness} to ${after.aggressiveness}`,
    );
  if (before.policyHash !== after.policyHash) out.push("the Executor's policy changed");
  if (before.paused !== after.paused)
    out.push(after.paused ? "the Executor was paused" : "the Executor was unpaused");
  if (before.attestorSet !== after.attestorSet)
    out.push(after.attestorSet ? "a price attestor was set" : "the price attestor was unset");
  if (before.lastAgentChangeAt !== after.lastAgentChangeAt)
    out.push("a plan was set in between, which starts the cooldown again");
  const diff = <T extends { token: string }>(
    a: readonly T[],
    b: readonly T[],
    describe: (x: T | undefined, y: T | undefined, token: string) => string | null,
  ) => {
    const tokens = new Set([...a.map((x) => x.token), ...b.map((x) => x.token)]);
    for (const token of [...tokens].sort()) {
      const line = describe(
        a.find((x) => x.token === token),
        b.find((x) => x.token === token),
        token,
      );
      if (line) out.push(line);
    }
  };
  diff(before.holdings, after.holdings, (x, y, token) =>
    x?.balance === y?.balance && x?.costBasis === y?.costBasis
      ? null
      : `the account's ${name(token)} balance changed from ${x?.balance ?? "0"} to ${y?.balance ?? "0"} (basis ${x?.costBasis ?? "0"} to ${y?.costBasis ?? "0"})`,
  );
  diff(before.prices, after.prices, (x, y, token) =>
    x?.priceE18 === y?.priceE18 && x?.reason === y?.reason
      ? null
      : `${name(token)}'s price moved from ${x?.priceE18 ?? "none"} (${x?.reason ?? "none"}) to ${y?.priceE18 ?? "none"} (${y?.reason ?? "none"})`,
  );
  diff(before.tokens, after.tokens, (x, y, token) =>
    x?.lane === y?.lane &&
    x?.status === y?.status &&
    x?.priceClass === y?.priceClass &&
    x?.maxPositionBps === y?.maxPositionBps
      ? null
      : `${name(token)} in the registry changed from ${x ? `${x.lane} ${x.status} class ${x.priceClass} cap ${x.maxPositionBps}` : "unregistered"} to ${y ? `${y.lane} ${y.status} class ${y.priceClass} cap ${y.maxPositionBps}` : "unregistered"}`,
  );
  if (out.length === 0 && before.block !== after.block)
    out.push(
      `the chain moved from block ${before.block} to ${after.block}, so the venues' quotes may differ`,
    );
  return out;
}

/**
 * The verdict on a target portfolio: every Test v2 rule, then the cost to
 * move against the plan's cost hurdle, with the fingerprint of what was read.
 */
export async function checkTargetPortfolio(
  p: TargetPortfolioParams,
  t: TestInputsV2,
): Promise<PlanVerdict> {
  const findings = await checkPortfolioProposal(p, t);
  const cost = await estimateMoveCost(p, t);
  if (cost && cost.legs > 0 && cost.costBps > p.costHurdleBps)
    findings.push({
      code: "COST_HURDLE",
      field: "params.costHurdleBps",
      message: `Moving to this portfolio would cost about ${(cost.costBps / 100).toFixed(2)}% of the ${cost.legs} legs' value at today's depth, above the plan's own cost hurdle of ${(p.costHurdleBps / 100).toFixed(2)}%; raise the hurdle, move less, or wait for depth.`,
    });
  return { findings, cost, fingerprint: inputsFingerprint(t) };
}

/** The evaluator's finding when a plan the Test accepted fails now: what changed since, named. */
export function stateChangedFinding(
  tested: PlanInputsFingerprint,
  now: PlanInputsFingerprint,
  symbols: Readonly<Record<string, string>> = {},
): TestFindingV2 {
  const changed = whatChanged(tested, now, symbols);
  return {
    code: "STATE_CHANGED",
    field: "inputs",
    message:
      changed.length > 0
        ? `Since the Test accepted this plan: ${changed.join("; ")}.`
        : "Nothing the Test read has changed since it accepted this plan; the venues' quotes may have moved.",
  };
}
