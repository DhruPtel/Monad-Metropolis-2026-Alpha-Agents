import {
  type ListedToken,
  MONAD_BASE_TOKENS,
  SCREEN_CHECK_CODES,
  SCREEN_RULES,
  type ScreenCheck,
  type ScreenVerdict,
  lookAlike,
  reviewedToken,
  screenVerdict,
} from "@alpha-agents/domain";
import { GOPLUS_POWER_FLAGS, type GoPlusReport } from "@alpha-agents/market";
import { parseAbi } from "viem";
import {
  type ForkSimulator,
  type Route,
  type RoutePool,
  type Simulation,
  chooseRoute,
} from "./simulate.ts";
import { staticChecks } from "./static-checks.ts";

/**
 * One token screen (F-U1, D-339): the route, the simulated buy, transfer and
 * sell with the round trip's cost, the owner powers and upgradeability, the
 * route pool's liquidity and age, look-alike names, and GoPlus as a second
 * opinion. Every check passes, fails or is skipped with one plain sentence
 * and its evidence; any failure refuses the token, and a required check that
 * did not pass refuses it too. The screen is deterministic platform code:
 * nothing an agent writes reaches it but the token's address.
 */
export interface ScreenTarget {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

export interface ScreenInput {
  readonly token: ScreenTarget;
  readonly pools: readonly (RoutePool & { readonly routable: boolean })[];
  readonly listings: readonly ListedToken[];
}

export interface ScreenDeps {
  /** Runs the simulation and static reads on the screen fork, reverted afterwards. */
  readonly onFork: <T>(fn: (sim: ForkSimulator, block: bigint) => Promise<T>) => Promise<T>;
  /** GoPlus's report; null when it is unavailable, which skips that check. */
  readonly goplus: (address: string) => Promise<GoPlusReport | null>;
  readonly now: () => number;
}

export interface ScreenOutcome {
  readonly verdict: ScreenVerdict;
  readonly checks: readonly ScreenCheck[];
  readonly route: (Route & { readonly simulation: Simulation | null }) | null;
  readonly forkBlock: number | null;
  readonly durationMs: number;
}

const MON_USD_FEED = "0xBcD78f76005B7515837af6b50c7C52BCf73822fb" as const;
const FEED = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

const pct = (b: number) => `${(b / 100).toFixed(2)}%`;
const units = (raw: string, decimals: number) => {
  const n = Number(raw) / 10 ** decimals;
  return n >= 1000 ? n.toFixed(0) : n.toPrecision(6);
};

/** The reference amount of the base asset: A-63's USD size, valued by Chainlink on the fork. */
async function referenceAmount(sim: ForkSimulator, route: Route, block: bigint): Promise<bigint> {
  if (route.base === MONAD_BASE_TOKENS.USDC)
    return BigInt(SCREEN_RULES.referenceSizeUsd) * 10n ** 6n;
  const [, answer] = await sim.publicClient.readContract({
    address: MON_USD_FEED,
    abi: FEED,
    functionName: "latestRoundData",
    blockNumber: block,
  });
  // MON/USD has 8 decimals; MON and WMON have 18.
  return (BigInt(SCREEN_RULES.referenceSizeUsd) * 10n ** 26n) / answer;
}

function taxCheck(
  code: "BUY" | "TRANSFER",
  step:
    | { ok: true; taxBps: number; quoted?: string; sent?: string; received: string }
    | { ok: false; error: string }
    | null,
  decimals: number,
): ScreenCheck {
  if (!step)
    return {
      code,
      status: "skipped",
      reason: "Not run: the buy delivered nothing to transfer.",
      evidence: {},
    };
  if (!step.ok)
    return {
      code,
      status: "fail",
      reason: `The ${code === "BUY" ? "buy" : "transfer"} reverted: ${step.error}.`,
      evidence: { error: step.error },
    };
  const expected = step.quoted ?? step.sent ?? "0";
  const evidence = {
    expected: units(expected, decimals),
    received: units(step.received, decimals),
    taxBps: step.taxBps,
  };
  if (step.taxBps > SCREEN_RULES.maxTaxBps)
    return {
      code,
      status: "fail",
      reason: `A ${code === "BUY" ? "buy" : "transfer"} tax of ${pct(step.taxBps)}, above the ${pct(SCREEN_RULES.maxTaxBps)} limit.`,
      evidence,
    };
  return {
    code,
    status: "pass",
    reason:
      step.taxBps <= SCREEN_RULES.taxToleranceBps
        ? `No ${code === "BUY" ? "buy" : "transfer"} tax: received what was ${code === "BUY" ? "quoted" : "sent"}.`
        : `A ${code === "BUY" ? "buy" : "transfer"} shortfall of ${pct(step.taxBps)}, within the ${pct(SCREEN_RULES.maxTaxBps)} limit.`,
    evidence,
  };
}

function simulationChecks(
  route: Route | null,
  sim: Simulation | null,
  token: ScreenTarget,
): ScreenCheck[] {
  if (!route || !sim) {
    const why = route
      ? "The simulation could not run."
      : "Not run: there is no route to a base asset.";
    return (["BUY", "TRANSFER", "SELL", "ROUND_TRIP"] as const).map((code) => ({
      code,
      status: "skipped",
      reason: why,
      evidence: {},
    }));
  }
  const baseDecimals = route.baseSymbol === "USDC" ? 6 : 18;
  const buy = taxCheck("BUY", sim.buy, token.decimals);
  const transfer = taxCheck("TRANSFER", sim.transfer, token.decimals);
  const sell: ScreenCheck = (() => {
    const s = sim.sell;
    if (!s)
      return {
        code: "SELL",
        status: "skipped",
        reason: "Not run: the buy delivered nothing to sell.",
        evidence: {},
      };
    if (!s.ok)
      return {
        code: "SELL",
        status: "fail",
        reason: `Unsellable: the sell reverted (${s.error}).`,
        evidence: { error: s.error },
      };
    const evidence = {
      quoted: units(s.quoted, baseDecimals),
      received: units(s.received, baseDecimals),
      taxBps: s.taxBps,
      leftover: s.leftover ?? "0",
    };
    if (s.leftover && s.leftover !== "0")
      return {
        code: "SELL",
        status: "fail",
        reason: "The whole balance could not be sold.",
        evidence,
      };
    if (s.taxBps > SCREEN_RULES.maxTaxBps)
      return {
        code: "SELL",
        status: "fail",
        reason: `A sell tax of ${pct(s.taxBps)}, above the ${pct(SCREEN_RULES.maxTaxBps)} limit.`,
        evidence,
      };
    return {
      code: "SELL",
      status: "pass",
      reason:
        s.taxBps <= SCREEN_RULES.taxToleranceBps
          ? "Sold the whole balance back for what was quoted."
          : `Sold the whole balance with a ${pct(s.taxBps)} shortfall, within the limit.`,
      evidence,
    };
  })();
  const roundTrip: ScreenCheck =
    sim.roundTripBps === null
      ? {
          code: "ROUND_TRIP",
          status: "skipped",
          reason: "Not measured: the round trip did not complete.",
          evidence: {},
        }
      : {
          code: "ROUND_TRIP",
          status: sim.roundTripBps <= SCREEN_RULES.maxRoundTripBps ? "pass" : "fail",
          reason:
            sim.roundTripBps <= SCREEN_RULES.maxRoundTripBps
              ? `A $${SCREEN_RULES.referenceSizeUsd} round trip cost ${pct(sim.roundTripBps)}, within the ${pct(SCREEN_RULES.maxRoundTripBps)} limit.`
              : `A $${SCREEN_RULES.referenceSizeUsd} round trip cost ${pct(sim.roundTripBps)}, above the ${pct(SCREEN_RULES.maxRoundTripBps)} limit.`,
          evidence: {
            amountIn: units(sim.amountIn, baseDecimals),
            base: route.baseSymbol,
            roundTripBps: sim.roundTripBps,
            quotes: sim.quoteSources.join(", "),
          },
        };
  return [buy, transfer, sell, roundTrip];
}

export function marketChecks(
  route: Route | null,
  pools: ScreenInput["pools"],
  nowMs: number,
): ScreenCheck[] {
  const deepest = [...pools].sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0] ?? null;
  const pool = route?.pool ?? deepest;
  const liquidity: ScreenCheck = !pool
    ? { code: "LIQUIDITY", status: "fail", reason: "No pool holds this token.", evidence: {} }
    : {
        code: "LIQUIDITY",
        status: pool.liquidityUsd >= SCREEN_RULES.minLiquidityUsd ? "pass" : "fail",
        reason:
          pool.liquidityUsd >= SCREEN_RULES.minLiquidityUsd
            ? `The route pool holds $${Math.round(pool.liquidityUsd).toLocaleString("en-US")}, at least $${SCREEN_RULES.minLiquidityUsd.toLocaleString("en-US")}.`
            : `The ${route ? "route" : "deepest"} pool holds only $${Math.round(pool.liquidityUsd).toLocaleString("en-US")}, under $${SCREEN_RULES.minLiquidityUsd.toLocaleString("en-US")}.`,
        evidence: { pool: pool.poolId, dex: pool.dex, liquidityUsd: Math.round(pool.liquidityUsd) },
      };
  const age: ScreenCheck = (() => {
    if (!pool)
      return {
        code: "POOL_AGE",
        status: "fail",
        reason: "No pool holds this token.",
        evidence: {},
      };
    if (!pool.createdAt)
      return {
        code: "POOL_AGE",
        status: "fail",
        reason: "The pool's creation time is unknown.",
        evidence: { pool: pool.poolId },
      };
    const hours = (nowMs - Date.parse(pool.createdAt)) / 3_600_000;
    const evidence = { pool: pool.poolId, createdAt: pool.createdAt, ageHours: Math.floor(hours) };
    return hours >= SCREEN_RULES.minPoolAgeHours
      ? {
          code: "POOL_AGE",
          status: "pass",
          reason: `The pool is ${Math.floor(hours / 24)} days old.`,
          evidence,
        }
      : {
          code: "POOL_AGE",
          status: "fail",
          reason: `The pool is ${Math.floor(hours)} hours old, younger than ${SCREEN_RULES.minPoolAgeHours} hours.`,
          evidence,
        };
  })();
  return [liquidity, age];
}

export function lookAlikeCheck(token: ScreenTarget, listings: readonly ListedToken[]): ScreenCheck {
  const hit = lookAlike(token, listings);
  const evidence = { symbol: token.symbol, name: token.name, listingsChecked: listings.length };
  if (listings.length === 0)
    return {
      code: "LOOK_ALIKE",
      status: "skipped",
      reason: "No listings were available to compare against.",
      evidence,
    };
  if (!hit)
    return {
      code: "LOOK_ALIKE",
      status: "pass",
      reason: "Its name and symbol imitate no listed token at another address.",
      evidence,
    };
  return {
    code: "LOOK_ALIKE",
    status: "fail",
    reason: `Its ${hit.field} matches ${hit.listed.symbol} (${hit.listed.name}), listed on ${hit.listed.source} ${hit.listed.monadAddress ? `at ${hit.listed.monadAddress}` : "with no address on Monad"}.`,
    evidence: {
      ...evidence,
      imitates: hit.listed.symbol,
      listedAt: hit.listed.monadAddress,
      source: hit.listed.source,
    },
  };
}

export function goplusCheck(token: string, report: GoPlusReport | null): ScreenCheck {
  if (!report)
    return {
      code: "GOPLUS",
      status: "skipped",
      reason: "GoPlus did not answer; the screen ran without it.",
      evidence: {},
    };
  if (!report.found)
    return {
      code: "GOPLUS",
      status: "skipped",
      reason: "GoPlus has no report for this token.",
      evidence: {},
    };
  const reviewed = reviewedToken(token)?.accepts.includes("owner_powers") ?? false;
  const blocking = report.flags.filter(
    (f) => f !== "is_proxy" && !(reviewed && (GOPLUS_POWER_FLAGS as readonly string[]).includes(f)),
  );
  const evidence = {
    flags: report.flags.join(", ") || null,
    buyTax: report.buyTax,
    sellTax: report.sellTax,
    holderCount: report.holderCount,
    topHolderShare: report.topHolderShare,
    openSource: report.isOpenSource,
  };
  return blocking.length
    ? { code: "GOPLUS", status: "fail", reason: `GoPlus flags ${blocking.join(", ")}.`, evidence }
    : {
        code: "GOPLUS",
        status: "pass",
        reason: report.flags.length
          ? `GoPlus raises only ${report.flags.join(", ")}, which the screen's own checks cover.`
          : "GoPlus raises no flag.",
        evidence,
      };
}

export async function runScreen(input: ScreenInput, deps: ScreenDeps): Promise<ScreenOutcome> {
  const started = deps.now();
  const { token, pools, listings } = input;
  const route = chooseRoute(token.address, pools);
  const routeCheck: ScreenCheck = route
    ? {
        code: "ROUTE",
        status: "pass",
        reason: `Routed through ${route.pool.dex.replace("_", " ")} against ${route.baseSymbol}.`,
        evidence: {
          pool: route.pool.poolId,
          dex: route.pool.dex,
          base: route.baseSymbol,
          fee: route.pool.fee,
        },
      }
    : {
        code: "ROUTE",
        status: "fail",
        reason: "No routable pool pairs this token with USDC, WMON or MON.",
        evidence: { pools: pools.length, routable: pools.filter((p) => p.routable).length },
      };
  const goplus = deps.goplus(token.address).catch(() => null);
  const fork = await deps.onFork(async (sim, block) => {
    const st = await staticChecks(sim.publicClient, token.address, block);
    let simulation: Simulation | null = null;
    if (route) {
      try {
        simulation = await sim.roundTrip(route, await referenceAmount(sim, route, block));
      } catch {
        simulation = null;
      }
    }
    return { st, simulation, block };
  });
  const checks: ScreenCheck[] = [
    routeCheck,
    ...simulationChecks(route, fork.simulation, token),
    ...fork.st.checks,
    ...marketChecks(route, pools, deps.now()),
    lookAlikeCheck(token, listings),
    goplusCheck(token.address, await goplus),
  ];
  const ordered = SCREEN_CHECK_CODES.flatMap((c) => checks.filter((x) => x.code === c));
  return {
    verdict: screenVerdict(ordered),
    checks: ordered,
    route: route ? { ...route, simulation: fork.simulation } : null,
    forkBlock: Number(fork.block),
    durationMs: deps.now() - started,
  };
}
