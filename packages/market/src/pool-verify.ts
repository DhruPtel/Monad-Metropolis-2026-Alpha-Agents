import { type ClassFFeed, NATIVE_MON, addressEntry } from "@alpha-agents/domain";
import {
  type Address,
  type Hex,
  type PublicClient,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
} from "viem";
import type { Dex } from "./geckoterminal.ts";

/**
 * Onchain checks for discovery (F-U1). Nothing GeckoTerminal says about a
 * pool is trusted until the chain agrees:
 *
 * - a v3 pool (Uniswap or PancakeSwap) is real only when its own factory's
 *   `getPool(token0, token1, fee)` returns it, so a lookalike contract posing
 *   as a pool is never listed;
 * - a Uniswap v4 pool ID is the hash of its key. The platform routes only
 *   through hookless pools (Q-35), so it recovers the key by hashing the
 *   pool's two currencies with each fee and tick spacing in use; a pool whose
 *   ID matches no hookless key has a hook, or an unusual key, and is recorded
 *   as not routable. StateView must report liquidity for it.
 * - a token's symbol, name and decimals are read from the token, not taken
 *   from GeckoTerminal.
 *
 * Every read goes through the client it is given: the read-only mainnet
 * transport in the service, a fork in tests.
 */
const book = (id: Parameters<typeof addressEntry>[1]) => {
  const e = addressEntry("beta", id);
  if (!e.address) throw new Error(`${id} has no mainnet address`);
  return getAddress(e.address);
};

export const V3_FACTORIES: Readonly<Record<Exclude<Dex, "uniswap_v4">, Address>> = {
  uniswap_v3: book("uniswap_v3_factory"),
  pancakeswap_v3: book("pancakeswap_v3_factory"),
};
export const V4_STATE_VIEW = book("uniswap_v4_state_view");

const V3_POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
]);
const V3_FACTORY_ABI = parseAbi([
  "function getPool(address, address, uint24) view returns (address)",
]);
const STATE_VIEW_ABI = parseAbi([
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const FEED_ABI = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** Fees and tick spacings seen on Monad's v4 pools, the standard ones first. */
export const V4_FEES = [
  100, 500, 3000, 10_000, 50, 250, 1000, 2500, 5000, 30, 10, 1, 400, 200, 300, 750, 1500, 2000,
  3500, 6000, 7000, 15_000, 20_000, 30_000, 0x800000,
] as const;
export const V4_TICK_SPACINGS = [1, 10, 60, 200, 50, 100, 2, 5, 20, 25, 30, 40, 120] as const;

export interface PoolKey {
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: string;
}

export function v4PoolId(k: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [getAddress(k.currency0), getAddress(k.currency1), k.fee, k.tickSpacing, getAddress(k.hooks)],
    ),
  );
}

/** The hookless key whose hash is this pool ID, or null when none in use matches. */
export function recoverHooklessKey(poolId: string, a: string, b: string): PoolKey | null {
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  const id = poolId.toLowerCase();
  for (const fee of V4_FEES)
    for (const tickSpacing of V4_TICK_SPACINGS) {
      const k = { currency0, currency1, fee, tickSpacing, hooks: NATIVE_MON };
      if (v4PoolId(k) === id) return k;
    }
  return null;
}

export interface VerifiedPool {
  readonly dex: Dex;
  readonly poolId: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: number | null;
  readonly tickSpacing: number | null;
  readonly hooks: string | null;
  /** Whether the platform can route through it. */
  readonly routable: boolean;
  readonly note: string;
}

/**
 * Verifies one pool GeckoTerminal named. Null when the chain does not agree
 * that it is a pool of these two tokens on that venue.
 */
export async function verifyPool(
  client: PublicClient,
  p: { dex: Dex; poolId: string; base: string; quote: string },
): Promise<VerifiedPool | null> {
  if (p.dex === "uniswap_v4") {
    const key = recoverHooklessKey(p.poolId, p.base, p.quote);
    const liquidity = await client.readContract({
      address: V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: "getLiquidity",
      args: [p.poolId as Hex],
    });
    const [sqrtPriceX96] = await client.readContract({
      address: V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: "getSlot0",
      args: [p.poolId as Hex],
    });
    // An uninitialized ID has no price: it is not a pool at all.
    if (sqrtPriceX96 === 0n) return null;
    const [token0, token1] =
      p.base.toLowerCase() < p.quote.toLowerCase() ? [p.base, p.quote] : [p.quote, p.base];
    if (!key)
      return {
        dex: p.dex,
        poolId: p.poolId,
        token0,
        token1,
        fee: null,
        tickSpacing: null,
        hooks: null,
        routable: false,
        note: "Its ID matches no hookless key in use: a pool with a hook (or an unusual key), which the platform does not route through",
      };
    return {
      dex: p.dex,
      poolId: p.poolId,
      token0,
      token1,
      fee: key.fee,
      tickSpacing: key.tickSpacing,
      hooks: key.hooks,
      routable: liquidity > 0n,
      note:
        liquidity > 0n
          ? `Hookless Uniswap v4 pool, fee ${key.fee}, tick spacing ${key.tickSpacing}`
          : "Hookless Uniswap v4 pool with no liquidity in range",
    };
  }
  const pool = getAddress(p.poolId);
  const read = <F extends "token0" | "token1" | "fee" | "tickSpacing" | "liquidity">(fn: F) =>
    client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: fn });
  let token0: string, token1: string, fee: number, tickSpacing: number, liquidity: bigint;
  try {
    [token0, token1, fee, tickSpacing, liquidity] = (await Promise.all([
      read("token0"),
      read("token1"),
      read("fee"),
      read("tickSpacing"),
      read("liquidity"),
    ])) as [string, string, number, number, bigint];
  } catch {
    return null;
  }
  const real = await client.readContract({
    address: V3_FACTORIES[p.dex],
    abi: V3_FACTORY_ABI,
    functionName: "getPool",
    args: [getAddress(token0), getAddress(token1), fee],
  });
  if (real.toLowerCase() !== pool.toLowerCase()) return null;
  const pair = [token0.toLowerCase(), token1.toLowerCase()].sort().join();
  if (pair !== [p.base.toLowerCase(), p.quote.toLowerCase()].sort().join()) return null;
  return {
    dex: p.dex,
    poolId: p.poolId,
    token0: token0.toLowerCase(),
    token1: token1.toLowerCase(),
    fee,
    tickSpacing,
    hooks: null,
    routable: liquidity > 0n,
    note:
      liquidity > 0n
        ? `${p.dex === "uniswap_v3" ? "Uniswap" : "PancakeSwap"} v3 pool, fee ${fee}, confirmed by its factory`
        : "v3 pool with no liquidity in range",
  };
}

export interface TokenMeta {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

/** A token's own symbol, name and decimals; null when it does not answer as an ERC-20. */
export async function readTokenMeta(
  client: PublicClient,
  address: string,
): Promise<TokenMeta | null> {
  const a = getAddress(address);
  try {
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address: a, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address: a, abi: ERC20_ABI, functionName: "name" }),
      client.readContract({ address: a, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    // Names are shown in the console and given to agents: control characters are dropped.
    const clean = (s: string, n: number) =>
      [...s]
        .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
        .join("")
        .slice(0, n);
    return { symbol: clean(symbol, 32), name: clean(name, 80), decimals };
  } catch {
    return null;
  }
}

export interface FeedCheck {
  readonly proxy: string;
  readonly description: string;
  readonly ok: boolean;
  readonly reason: string;
  readonly answer: string | null;
  readonly updatedAt: string | null;
  readonly ageSeconds: number | null;
  readonly heartbeatSeconds: number;
}

export interface ClassFCheck {
  readonly ok: boolean;
  readonly kind: ClassFFeed["kind"];
  readonly legs: readonly FeedCheck[];
  /** The USD price the feeds give now, for the record; null when a leg failed. */
  readonly priceUsd: number | null;
}

/**
 * Verifies a reviewed feed onchain: the proxy has code, answers the expected
 * description and decimals, a positive answer, and a round inside its
 * heartbeat. A composite multiplies its legs. `nowSeconds` is the chain's time.
 */
export async function checkClassFFeed(
  client: PublicClient,
  feed: ClassFFeed,
  nowSeconds: number,
): Promise<ClassFCheck> {
  const legs: FeedCheck[] = [];
  let price = 1;
  for (const leg of feed.legs) {
    const proxy = getAddress(leg.proxy);
    const base = {
      proxy: leg.proxy,
      description: leg.description,
      heartbeatSeconds: leg.heartbeatSeconds,
    };
    try {
      const [description, decimals, round] = await Promise.all([
        client.readContract({ address: proxy, abi: FEED_ABI, functionName: "description" }),
        client.readContract({ address: proxy, abi: FEED_ABI, functionName: "decimals" }),
        client.readContract({ address: proxy, abi: FEED_ABI, functionName: "latestRoundData" }),
      ]);
      const [, answer, , updatedAt] = round;
      const age = nowSeconds - Number(updatedAt);
      const problem =
        description !== leg.description
          ? `answers "${description.slice(0, 60)}", not "${leg.description}"`
          : decimals !== leg.decimals
            ? `has ${decimals} decimals, not ${leg.decimals}`
            : answer <= 0n
              ? "answers a price of zero or less"
              : age > leg.heartbeatSeconds
                ? `last updated ${age} seconds ago, past its ${leg.heartbeatSeconds}-second heartbeat`
                : null;
      legs.push({
        ...base,
        ok: problem === null,
        reason: problem ?? `fresh: updated ${Math.max(0, age)} seconds ago`,
        answer: answer.toString(),
        updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
        ageSeconds: age,
      });
      price *= Number(answer) / 10 ** decimals;
    } catch {
      legs.push({
        ...base,
        ok: false,
        reason: "did not answer as a Chainlink feed",
        answer: null,
        updatedAt: null,
        ageSeconds: null,
      });
    }
  }
  const ok = legs.every((l) => l.ok);
  return { ok, kind: feed.kind, legs, priceUsd: ok ? price : null };
}
