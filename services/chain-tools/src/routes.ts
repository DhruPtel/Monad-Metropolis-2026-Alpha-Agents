import { executorV3 } from "@alpha-agents/policy";
import { type Hex, isAddressEqual } from "viem";
import type { MarketStateV3, PoolInfoV3 } from "./reader-v3.ts";

/**
 * Route selection (F-U5): every route of up to three registered pools that
 * Executor v3 would accept from `tokenIn` to `tokenOut`, in the order the
 * contract checks them (ExecutorV3._checkRoute). A pool serves when its code
 * is intact, its status is ACTIVE (or EXIT_ONLY on a route into USDC) and its
 * lane is CORE (or SCREENED when the account opted in or sells a screened
 * token, D-365). A route never revisits a token, and every token between its
 * ends is USDC, WMON or class F, since the oracle alone prices it there.
 * The venues' quotes then choose among the candidates.
 */

export interface RouteRules {
  readonly optedIn: boolean;
  readonly intoUsdc: boolean;
  readonly sellsScreened: boolean;
}

/** Whether the registry would let this account's route use the pool now. */
export function poolServes(pool: PoolInfoV3, rules: RouteRules): boolean {
  if (!pool.codeIntact) return false;
  const statusOk = pool.status === "ACTIVE" || (pool.status === "EXIT_ONLY" && rules.intoUsdc);
  const laneOk =
    pool.lane === "CORE" || (pool.lane === "SCREENED" && (rules.optedIn || rules.sellsScreened));
  return statusOk && laneOk;
}

const same = (a: Hex, b: Hex) => isAddressEqual(a, b);

export function candidateRoutes(
  m: Pick<MarketStateV3, "pools" | "tokens" | "usdc" | "wmon">,
  tokenIn: Hex,
  tokenOut: Hex,
  rules: RouteRules,
): PoolInfoV3[][] {
  if (same(tokenIn, tokenOut)) return [];
  const usable = m.pools.filter((p) => poolServes(p, rules));
  const base = (t: Hex) => same(t, m.usdc) || same(t, m.wmon);
  const classF = (t: Hex) =>
    base(t) || m.tokens.some((x) => same(x.token, t) && x.priceClass === "F");
  const out: PoolInfoV3[][] = [];
  const walk = (at: Hex, path: Hex[], hops: PoolInfoV3[]) => {
    if (hops.length >= executorV3.CONSTANTS.maxHops) return;
    for (const p of usable) {
      if (hops.includes(p)) continue;
      const next = same(at, p.tokenA) ? p.tokenB : same(at, p.tokenB) ? p.tokenA : null;
      if (!next || path.some((t) => same(t, next))) continue;
      if (same(next, tokenOut)) {
        out.push([...hops, p]);
        continue;
      }
      // A token between the ends must be one the oracle prices on its own.
      if (!classF(next)) continue;
      walk(next, [...path, next], [...hops, p]);
    }
  };
  walk(tokenIn, [tokenIn], []);
  // Shorter routes first, so a tie on the quote keeps the cheaper one.
  return out.sort((a, b) => a.length - b.length);
}

/** The tokens a route crosses, the ends included, as the account holds them. */
export function routeTokens(route: readonly PoolInfoV3[], tokenIn: Hex): Hex[] {
  const path: Hex[] = [tokenIn];
  let at = tokenIn;
  for (const p of route) {
    at = same(at, p.tokenA) ? p.tokenB : p.tokenA;
    path.push(at);
  }
  return path;
}
