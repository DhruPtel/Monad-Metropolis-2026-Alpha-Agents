import { UNISWAP_V4_MON_USDC_POOL, addressEntry } from "@alpha-agents/domain";
import { type PublicClient, createPublicClient, parseAbi } from "viem";
import { type Figure, iso } from "./figures.ts";
import { type GuardContext, guard } from "./guards.ts";
import { readOnlyTransport } from "./readonly.ts";
import { MarketError } from "./upstream.ts";

/**
 * Mainnet reads for research (D-289: research reads live mainnet data in
 * every environment; trades use the environment's own chain). Chainlink's
 * MON/USD, the launch venue's pool price and active liquidity through
 * StateView, and the price impact of buys and sells at reference sizes through
 * the v4 Quoter, all at one block of chain 143.
 */
export const MAINNET_CHAIN_ID = 143;
/** Reference trade sizes in USD for depth (A-56): from a small leg to far past the beta caps. */
export const DEPTH_SIZES_USD = [10, 100, 1_000, 10_000] as const;
/** Chainlink's own bound for MON/USD (D-151): older than this is stale. */
export const CHAINLINK_MAX_AGE_SECONDS = 300;
const POOL_FEE_BPS = UNISWAP_V4_MON_USDC_POOL.fee / 100;

const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

const book = (id: Parameters<typeof addressEntry>[1]) =>
  addressEntry("beta", id).address as `0x${string}`;

export interface DepthRow {
  readonly sizeUsd: number;
  readonly side: "buy_mon" | "sell_mon";
  /** Price impact against the pool's mid price, the 0.05% fee included. */
  readonly impactBps: Figure;
  /** The same less the fee: what the pool's depth alone costs. */
  readonly impactExFeeBps: Figure;
}

export interface PoolDepth {
  readonly block: string;
  readonly asOf: string;
  readonly midPriceUsd: Figure;
  readonly activeLiquidity: Figure;
  readonly feeBps: number;
  readonly rows: readonly DepthRow[];
}

export interface OracleVsPool {
  readonly chainlinkMonUsd: Figure;
  readonly poolMonUsdc: Figure;
  /** How far the pool is from Chainlink, in bps of Chainlink's price; positive when the pool is higher. */
  readonly deviationBps: Figure;
  readonly block: string;
}

export interface MainnetMarketReader {
  oracleVsPool(ctx: GuardContext): Promise<OracleVsPool>;
  poolDepth(ctx: GuardContext): Promise<PoolDepth>;
}

/** USDC per MON from the pool's sqrtPriceX96 (MON has 18 decimals, USDC 6). */
export function midPriceFromSqrt(sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 1e12;
}

/** Impact in bps of what the mid price would give, never negative. */
export function impactBps(midOut: number, out: number): number {
  return midOut <= 0 ? 10_000 : Math.max(0, ((midOut - out) / midOut) * 10_000);
}

export function viemMainnetReader(
  rpcUrls: readonly string[],
  /** Tests point the reader at a local fork of mainnet, which answers its own chain ID. */
  expectChainId: number = MAINNET_CHAIN_ID,
): MainnetMarketReader {
  if (rpcUrls.length === 0) throw new Error("the mainnet market reader needs an RPC URL");
  const client = createPublicClient({ transport: readOnlyTransport(rpcUrls) }) as PublicClient;
  const unavailable = (what: string) =>
    new MarketError("UPSTREAM_UNAVAILABLE", "monad", `Could not read ${what} from Monad mainnet.`, {
      retryable: true,
    });
  const key = {
    currency0: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    currency1: book("usdc"),
    fee: UNISWAP_V4_MON_USDC_POOL.fee,
    tickSpacing: UNISWAP_V4_MON_USDC_POOL.tickSpacing,
    hooks: UNISWAP_V4_MON_USDC_POOL.hooks,
  };

  async function head() {
    const chainId = await client.getChainId();
    if (chainId !== expectChainId)
      throw new MarketError(
        "UPSTREAM_UNAVAILABLE",
        "monad",
        `The mainnet RPC serves chain ${chainId}, not 143.`,
        {
          retryable: false,
        },
      );
    return client.getBlock();
  }

  async function slot0(blockNumber: bigint) {
    return client.readContract({
      address: book("uniswap_v4_state_view"),
      abi: STATE_VIEW_ABI,
      functionName: "getSlot0",
      args: [UNISWAP_V4_MON_USDC_POOL.id],
      blockNumber,
    });
  }

  return {
    async oracleVsPool(ctx) {
      try {
        const b = await head();
        const feed = book("chainlink_mon_usd");
        const [round, decimals, s0] = await Promise.all([
          client.readContract({
            address: feed,
            abi: FEED_ABI,
            functionName: "latestRoundData",
            blockNumber: b.number,
          }),
          client.readContract({
            address: feed,
            abi: FEED_ABI,
            functionName: "decimals",
            blockNumber: b.number,
          }),
          slot0(b.number),
        ]);
        const ts = Number(b.timestamp);
        const chainlink = guard(
          "monPriceUsd",
          Number(round[1]) / 10 ** decimals,
          "chainlink",
          Number(round[3]),
          CHAINLINK_MAX_AGE_SECONDS,
          ctx,
        );
        const pool = guard("monPriceUsd", midPriceFromSqrt(s0[0]), "uniswap_v4", ts, 120, ctx);
        const dev =
          chainlink.value !== null && pool.value !== null
            ? ((pool.value - chainlink.value) / chainlink.value) * 10_000
            : null;
        return {
          chainlinkMonUsd: chainlink,
          poolMonUsdc: pool,
          deviationBps: { value: dev, source: "computed", asOf: iso(ts), warnings: [] },
          block: b.number.toString(),
        };
      } catch (err) {
        throw err instanceof MarketError ? err : unavailable("the oracle and the pool");
      }
    },

    async poolDepth(ctx) {
      try {
        const b = await head();
        const ts = Number(b.timestamp);
        const [s0, liquidity] = await Promise.all([
          slot0(b.number),
          client.readContract({
            address: book("uniswap_v4_state_view"),
            abi: STATE_VIEW_ABI,
            functionName: "getLiquidity",
            args: [UNISWAP_V4_MON_USDC_POOL.id],
            blockNumber: b.number,
          }),
        ]);
        const mid = midPriceFromSqrt(s0[0]);
        const quote = async (zeroForOne: boolean, exactAmount: bigint) =>
          (
            await client.simulateContract({
              address: book("uniswap_v4_quoter"),
              abi: QUOTER_ABI,
              functionName: "quoteExactInputSingle",
              args: [{ poolKey: key, zeroForOne, exactAmount, hookData: "0x" }],
              blockNumber: b.number,
            })
          ).result[0];
        const rows: DepthRow[] = [];
        for (const sizeUsd of DEPTH_SIZES_USD) {
          // A buy pays USDC (currency1) for MON; a sale pays MON (currency0) worth the size at mid.
          const usdcIn = BigInt(Math.round(sizeUsd * 1e6));
          const monIn = BigInt(Math.round((sizeUsd / mid) * 1e18));
          const [buyOut, sellOut] = await Promise.all([quote(false, usdcIn), quote(true, monIn)]);
          const buy = impactBps(sizeUsd / mid, Number(buyOut) / 1e18);
          const sell = impactBps(sizeUsd, Number(sellOut) / 1e6);
          for (const [side, bps] of [
            ["buy_mon", buy],
            ["sell_mon", sell],
          ] as const)
            rows.push({
              sizeUsd,
              side,
              impactBps: guard("priceImpactBps", bps, "uniswap_v4", ts, 120, ctx),
              impactExFeeBps: guard(
                "priceImpactBps",
                Math.max(0, bps - POOL_FEE_BPS),
                "uniswap_v4",
                ts,
                120,
                ctx,
              ),
            });
        }
        return {
          block: b.number.toString(),
          asOf: iso(ts),
          midPriceUsd: guard("monPriceUsd", mid, "uniswap_v4", ts, 120, ctx),
          activeLiquidity: guard("poolLiquidity", Number(liquidity), "uniswap_v4", ts, 120, ctx),
          feeBps: POOL_FEE_BPS,
          rows,
        };
      } catch (err) {
        throw err instanceof MarketError ? err : unavailable("the pool's depth");
      }
    },
  };
}
