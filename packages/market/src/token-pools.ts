import { MONAD_BASE_TOKENS, NATIVE_MON } from "@alpha-agents/domain";
import { type Hex, type PublicClient, getAddress, parseAbi } from "viem";
import { GT_BASE } from "./geckoterminal.ts";
import { type VerifiedPool, V3_FACTORIES, V4_STATE_VIEW, v4PoolId } from "./pool-verify.ts";
import { type UpstreamDeps, getJson } from "./upstream.ts";

/**
 * Pools by token (F-U2 Step 0): a token's pools found from the token itself,
 * not only from volume-sorted pages, so deep but quiet pools and tokens no
 * list has seen are found too.
 *
 * - GeckoTerminal's pools for one token (its top 20 across venues, with
 *   liquidity and age) and its pool search by name or symbol.
 * - Onchain probes that need no list at all: each v3 factory's `getPool`
 *   against USDC and WMON at every fee tier, and each common hookless
 *   Uniswap v4 key against native MON, USDC and WMON, read through StateView.
 *   A v3 pool found this way is real by construction (its factory returned
 *   it); its liquidity is estimated as twice the base asset it holds. A v4
 *   pool keeps no balances of its own, so one GeckoTerminal does not list has
 *   unknown liquidity, counted as none.
 */
export const gtTokenPoolsUrl = (address: string) =>
  `${GT_BASE}/tokens/${address.toLowerCase()}/pools?page=1&include=base_token,quote_token`;
export const gtSearchUrl = (query: string) =>
  `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}&network=monad&include=base_token,quote_token`;

export async function fetchGtTokenPools(address: string, deps: UpstreamDeps): Promise<unknown> {
  return getJson({ provider: "geckoterminal", url: gtTokenPoolsUrl(address) }, deps);
}

export async function fetchGtSearch(query: string, deps: UpstreamDeps): Promise<unknown> {
  return getJson({ provider: "geckoterminal", url: gtSearchUrl(query) }, deps);
}

/** Fee tiers each v3 venue deploys. */
export const V3_FEE_TIERS = {
  uniswap_v3: [100, 500, 3000, 10_000],
  pancakeswap_v3: [100, 500, 2500, 10_000],
} as const;

/** The hookless v4 keys seen on Monad's liquid pools (F-U1): fee and tick spacing. */
export const V4_COMMON_KEYS = [
  [100, 1],
  [500, 10],
  [500, 1],
  [3000, 60],
  [10_000, 200],
  [50, 1],
  [100, 10],
  [2500, 50],
] as const;

const FACTORY_ABI = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const STATE_VIEW_ABI = parseAbi([
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const MON_USD_FEED = "0xBcD78f76005B7515837af6b50c7C52BCf73822fb" as const;
const ZERO = "0x0000000000000000000000000000000000000000";

export interface ProbedPool extends VerifiedPool {
  /** USD liquidity estimated onchain; null when it cannot be (a v4 pool). */
  readonly onchainLiquidityUsd: number | null;
}

async function limited<T, R>(
  items: readonly T[],
  n: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k] as T);
      }
    }),
  );
  return out;
}

/** The token's pools against USDC, WMON and native MON on the three venues, found onchain. */
export async function probeBasePools(
  client: PublicClient,
  token: string,
  concurrency = 2,
): Promise<ProbedPool[]> {
  const t = token.toLowerCase();
  let monUsd: number | null = null;
  const baseUsd = async (base: string, raw: bigint): Promise<number | null> => {
    if (base === MONAD_BASE_TOKENS.USDC) return Number(raw) / 1e6;
    if (monUsd === null) {
      try {
        const [, answer] = await client.readContract({
          address: MON_USD_FEED,
          abi: FEED_ABI,
          functionName: "latestRoundData",
        });
        monUsd = Number(answer) / 1e8;
      } catch {
        return null;
      }
    }
    return (Number(raw) / 1e18) * monUsd;
  };

  const v3Probes = (["uniswap_v3", "pancakeswap_v3"] as const).flatMap((dex) =>
    [MONAD_BASE_TOKENS.USDC, MONAD_BASE_TOKENS.WMON]
      .filter((b) => b !== t)
      .flatMap((base) => V3_FEE_TIERS[dex].map((fee) => ({ dex, base, fee }))),
  );
  const v3 = await limited(v3Probes, concurrency, async (p): Promise<ProbedPool | null> => {
    try {
      const pool = await client.readContract({
        address: V3_FACTORIES[p.dex],
        abi: FACTORY_ABI,
        functionName: "getPool",
        args: [getAddress(t), getAddress(p.base), p.fee],
      });
      if (pool === ZERO) return null;
      const held = await client.readContract({
        address: getAddress(p.base),
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [pool],
      });
      const value = await baseUsd(p.base, held);
      const [token0, token1] = t < p.base ? [t, p.base] : [p.base, t];
      return {
        dex: p.dex,
        poolId: pool.toLowerCase(),
        token0,
        token1,
        fee: p.fee,
        tickSpacing: null,
        hooks: null,
        routable: held > 0n,
        note: `${p.dex === "uniswap_v3" ? "Uniswap" : "PancakeSwap"} v3 pool, fee ${p.fee}, found from its factory`,
        onchainLiquidityUsd: value === null ? null : value * 2,
      };
    } catch {
      return null;
    }
  });

  const v4Probes = [NATIVE_MON, MONAD_BASE_TOKENS.USDC, MONAD_BASE_TOKENS.WMON]
    .filter((b) => b !== t)
    .flatMap((base) => V4_COMMON_KEYS.map(([fee, tickSpacing]) => ({ base, fee, tickSpacing })));
  const v4 = await limited(v4Probes, concurrency, async (p): Promise<ProbedPool | null> => {
    const [currency0, currency1] = t < p.base ? [t, p.base] : [p.base, t];
    const key = { currency0, currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: NATIVE_MON };
    const id = v4PoolId(key);
    try {
      const [sqrtPriceX96] = await client.readContract({
        address: V4_STATE_VIEW,
        abi: STATE_VIEW_ABI,
        functionName: "getSlot0",
        args: [id as Hex],
      });
      if (sqrtPriceX96 === 0n) return null;
      const liquidity = await client.readContract({
        address: V4_STATE_VIEW,
        abi: STATE_VIEW_ABI,
        functionName: "getLiquidity",
        args: [id as Hex],
      });
      return {
        dex: "uniswap_v4",
        poolId: id.toLowerCase(),
        token0: currency0,
        token1: currency1,
        fee: p.fee,
        tickSpacing: p.tickSpacing,
        hooks: NATIVE_MON,
        routable: liquidity > 0n,
        note: `Hookless Uniswap v4 pool, fee ${p.fee}, tick spacing ${p.tickSpacing}, found from its key`,
        onchainLiquidityUsd: null,
      };
    } catch {
      return null;
    }
  });
  return [...v3, ...v4].filter((p): p is ProbedPool => p !== null);
}
