/**
 * P2-U0 venue and oracle spike. Read-only against Monad mainnet; every quote runs on a local
 * anvil fork pinned at a recent block, and every log comes from Monad's public RPC.
 *
 *   pnpm spike:venues            writes evidence/p2-u0/data.json
 *
 * 1. Pins block B (the keyed RPC's head minus 10) and starts anvil on 127.0.0.1:8547 at B.
 * 2. Checks every address has code on that fork, and discovers the USDC/MON pools: Uniswap v3
 *    through the factory, Uniswap v4 through the PoolManager's Initialize events, Kuru through
 *    its Router's verifiedMarket.
 * 3. Quotes $10, $100, $1,000 and $5,000 (plus $200, the beta platform burst) both ways on every
 *    pool: v3 QuoterV2, v4 Quoter, and Kuru's Router simulated with eth_call from a funded test
 *    account. Each quote is compared with the Chainlink-implied output and the pool's mid price.
 * 4. Reads 7 days of AnswerUpdated events for MON/USD, USDC/USD and ETH/USD, and 7 days of
 *    swaps or trades on each pool, and samples pool against oracle every minute.
 * 5. Reads the USDC token's identity and proxy layout for Q-03.
 *
 * Nothing is signed or sent anywhere but the local fork. The keyed RPC URL never appears in
 * output: anvil reads it through the `monad` alias in chains/monad/foundry.toml, and every error
 * is redacted before it is printed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createPublicClient,
  decodeFunctionResult,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  maxUint256,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { mintTestUsdc, redact, rpc, setMonBalance } from "@alpha-agents/devenv";
import { ADDR, FEED_SOURCE, LOGS_RPC, SOURCES } from "./sources.ts";
import {
  feedStats,
  priceFromSqrtX96,
  sampleDeviation,
  shortfallBps,
  summarizeDeviation,
  type DeviationSample,
  type Point,
} from "./stats.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const FORK_PORT = 8547;
const FORK_URL = `http://127.0.0.1:${FORK_PORT}`;
const WINDOW_SECONDS = 7 * 86_400;
const SAMPLE_STEP = 60;
const SIZES_USD = [10, 100, 1_000, 5_000] as const;
/** 10% of the $2,000 platform cap: every beta account trading the same way at once. */
const BURST_USD = 200;
const MAX_SLIPPAGE_BPS = 50;
const MAX_DEVIATION_BPS = 200;
const STALE_THRESHOLDS = [60, 120, 300, 600, 900, 1_800, 3_600, 3_900];
/** A fresh address that exists only on the fork, used as the Kuru taker in simulations. */
const TAKER: Address = "0x00000000000000000000000000000000000b0b05";

process.loadEnvFile(join(ROOT, ".env"));
const KEYED_RPC = process.env.MONAD_RPC_URL;
if (!KEYED_RPC) throw new Error("MONAD_RPC_URL is not set in .env");
const SECRETS = [KEYED_RPC, process.env.MONAD_API_KEY].filter((s): s is string => !!s);
const safe = (err: unknown) =>
  redact(err instanceof Error ? err.message : String(err), SECRETS).slice(0, 300);

const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [LOGS_RPC] } },
});
const client = (url: string): PublicClient =>
  createPublicClient({ chain: monad, transport: http(url, { retryCount: 4, timeout: 60_000 }) });
const keyed = client(KEYED_RPC);
const logsRpc = client(LOGS_RPC);
const fork = client(FORK_URL);

// ---------- ABIs (interfaces only, written from the venues' documented signatures) ----------
const feedAbi = parseAbi([
  "function aggregator() view returns (address)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
]);
const answerUpdated = parseAbiItem(
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
);
const v3FactoryAbi = parseAbi([
  "function getPool(address, address, uint24) view returns (address)",
]);
const v3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function fee() view returns (uint24)",
]);
const v3Swap = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);
const v3QuoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const v4Initialize = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
const v4Swap = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);
const v4QuoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const kuruRouterAbi = parseAbi([
  "function verifiedMarket(address) view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAssetAddress, uint256 baseAssetDecimals, address quoteAssetAddress, uint256 quoteAssetDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)",
  "function anyToAnySwap(address[] _marketAddresses, bool[] _isBuy, bool[] _nativeSend, address _debitToken, address _creditToken, uint256 _amount, uint256 _minAmountOut) payable returns (uint256 _amountOut)",
]);
const kuruBookAbi = parseAbi([
  "function bestBidAsk() view returns (uint256, uint256)",
  "function getVaultParams() view returns (address, uint256, uint96, uint256, uint96, uint96, uint96, uint96)",
]);
const kuruTrade = parseAbiItem(
  "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
);
const usdcAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function version() view returns (string)",
  "function owner() view returns (address)",
  "function masterMinter() view returns (address)",
  "function pauser() view returns (address)",
  "function blacklister() view returns (address)",
  "function rescuer() view returns (address)",
  "function paused() view returns (bool)",
  "function isBlacklisted(address) view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);

// ---------- helpers ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (x: number, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

/** Runs tasks with bounded concurrency, keeping order. */
async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

/** eth_getLogs over [from, to] on the public RPC in 100k-block chunks, halving a chunk on error. */
async function getLogsChunked<E extends AbiEvent>(
  params: { address: Address; event: E; args?: Record<string, unknown> },
  from: bigint,
  to: bigint,
  concurrency = 2,
): Promise<Log[]> {
  const ranges: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += 100_000n) ranges.push([s, s + 99_999n > to ? to : s + 99_999n]);
  const fetchRange = async ([a, b]: [bigint, bigint], depth = 0): Promise<Log[]> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await logsRpc.getLogs({
          address: params.address,
          event: params.event,
          ...(params.args ? { args: params.args } : {}),
          fromBlock: a,
          toBlock: b,
        } as Parameters<PublicClient["getLogs"]>[0])) as Log[];
      } catch (err) {
        const message = safe(err);
        // A rate limit is not a range problem: wait and retry the same range.
        if (/429|rate|too many/i.test(message) && attempt < 10) {
          await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
          continue;
        }
        // Anything else may be a response-size limit: split the range.
        if (b - a > 1_000n && depth < 8) {
          const mid = a + (b - a) / 2n;
          return [
            ...(await fetchRange([a, mid], depth + 1)),
            ...(await fetchRange([mid + 1n, b], depth + 1)),
          ];
        }
        // The cause is left off on purpose: viem's error text can carry an RPC URL.
        // eslint-disable-next-line preserve-caught-error
        if (attempt >= 3) throw new Error(`getLogs ${a}-${b}: ${message}`);
        await sleep(1_000 * (attempt + 1));
      }
    }
  };
  return (await pool(ranges, concurrency, (r) => fetchRange(r))).flat();
}

/** Block timestamps by linear interpolation between anchors fetched every 50k blocks. */
async function blockClock(from: bigint, to: bigint) {
  const anchors: { n: bigint; t: number }[] = [];
  const points: bigint[] = [];
  for (let n = from; n < to; n += 50_000n) points.push(n);
  points.push(to);
  const blocks = await pool(points, 3, (n) => keyed.getBlock({ blockNumber: n }));
  for (const b of blocks) anchors.push({ n: b.number, t: Number(b.timestamp) });
  return (n: bigint): number => {
    let i = 0;
    while (i + 1 < anchors.length && (anchors[i + 1] as { n: bigint }).n < n) i += 1;
    const a = anchors[i] as { n: bigint; t: number };
    const b = anchors[Math.min(i + 1, anchors.length - 1)] as { n: bigint; t: number };
    if (b.n === a.n) return a.t;
    return a.t + ((b.t - a.t) * Number(n - a.n)) / Number(b.n - a.n);
  };
}

/** First block whose timestamp is at or after t, by binary search on the public RPC. */
async function blockAtTime(t: number, hi: bigint): Promise<bigint> {
  let lo = hi - 4_000_000n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const b = await keyed.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) < t) lo = mid;
    else hi = mid;
  }
  return hi;
}

async function startAnvil(block: bigint): Promise<ChildProcess> {
  const child = spawn(
    "anvil",
    [
      "--fork-url",
      "monad",
      "--fork-block-number",
      String(block),
      "--host",
      "127.0.0.1",
      "--port",
      String(FORK_PORT),
      "--silent",
    ],
    { cwd: join(ROOT, "chains/monad"), env: process.env, stdio: ["ignore", "ignore", "ignore"] },
  );
  // A signal ends node without its exit event, so anvil is stopped on signals too.
  process.once("exit", () => child.kill("SIGTERM"));
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      child.kill("SIGTERM");
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  for (let i = 0; i < 120; i += 1) {
    try {
      const v = await rpc(FORK_URL, "web3_clientVersion", [], 2_000);
      if (typeof v === "string" && v.startsWith("anvil/")) return child;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  child.kill("SIGTERM");
  throw new Error("anvil did not start on the spike port within 60 seconds");
}

async function sendOnFork(from: Address, to: Address, data: Hex): Promise<void> {
  await rpc(FORK_URL, "anvil_impersonateAccount", [from]);
  try {
    const hash = await rpc(FORK_URL, "eth_sendTransaction", [{ from, to, data }]);
    for (let i = 0; i < 300; i += 1) {
      const r = (await rpc(FORK_URL, "eth_getTransactionReceipt", [hash])) as {
        status?: string;
      } | null;
      if (r) {
        if (r.status !== "0x1") throw new Error("fork transaction reverted");
        return;
      }
      await sleep(50);
    }
    throw new Error("no fork receipt within 15 seconds");
  } finally {
    await rpc(FORK_URL, "anvil_stopImpersonatingAccount", [from]);
  }
}

// ---------- venues ----------
type Direction = "USDC->MON" | "MON->USDC";

interface Venue {
  readonly id: string;
  readonly venue: "uniswap-v3" | "uniswap-v4" | "kuru";
  readonly label: string;
  readonly hookless: boolean;
  readonly feeBps: number;
  /** USDC per MON at the pool's mid price, at block B. */
  readonly midPrice: number;
  readonly detail: Record<string, unknown>;
  /** Raw output for a raw input, or throws. */
  quote(direction: Direction, amountIn: bigint): Promise<bigint>;
  /** Pool price series (USDC per MON) over the window. */
  history(from: bigint, to: bigint, clock: (n: bigint) => number): Promise<Point[]>;
}

/**
 * Uniswap quoter calls go to the keyed RPC as eth_call at the pinned block: the same result as
 * on the fork, in one request, where the fork would fetch every crossed tick slot by slot.
 */
async function v3Venues(at: bigint): Promise<Venue[]> {
  const out: Venue[] = [];
  for (const fee of [100, 500, 3000, 10000]) {
    const addr = await fork.readContract({
      address: ADDR.v3Factory,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [ADDR.usdc, ADDR.wmon, fee],
    });
    if (addr === zeroAddress) continue;
    const [slot0, liquidity, token0, usdcBal, wmonBal] = await Promise.all([
      fork.readContract({ address: addr, abi: v3PoolAbi, functionName: "slot0" }),
      fork.readContract({ address: addr, abi: v3PoolAbi, functionName: "liquidity" }),
      fork.readContract({ address: addr, abi: v3PoolAbi, functionName: "token0" }),
      fork.readContract({
        address: ADDR.usdc,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [addr],
      }),
      fork.readContract({
        address: ADDR.wmon,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [addr],
      }),
    ]);
    const wmonIs0 = token0.toLowerCase() === ADDR.wmon.toLowerCase();
    const toUsdcPerMon = (sqrt: bigint) =>
      wmonIs0 ? priceFromSqrtX96(sqrt, 18, 6) : 1 / priceFromSqrtX96(sqrt, 6, 18);
    const mid = toUsdcPerMon(slot0[0]);
    out.push({
      id: `uniswap-v3-${fee}`,
      venue: "uniswap-v3",
      label: `Uniswap v3 USDC/WMON ${fee / 10_000}%`,
      hookless: true,
      feeBps: fee / 100,
      midPrice: mid,
      detail: {
        pool: addr,
        token0,
        liquidity: liquidity.toString(),
        tvl: { usdc: Number(usdcBal) / 1e6, wmon: Number(wmonBal) / 1e18 },
        tvlUsd: Number(usdcBal) / 1e6 + (Number(wmonBal) / 1e18) * mid,
      },
      quote: async (dir, amountIn) => {
        const [tokenIn, tokenOut] =
          dir === "USDC->MON" ? [ADDR.usdc, ADDR.wmon] : [ADDR.wmon, ADDR.usdc];
        const r = await keyed.readContract({
          blockNumber: at,
          address: ADDR.v3QuoterV2,
          abi: v3QuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        });
        return r[0];
      },
      history: async (from, to, clock) => {
        const logs = await getLogsChunked({ address: addr, event: v3Swap }, from, to);
        return logs.map((l) => {
          const args = (l as unknown as { args: { sqrtPriceX96: bigint } }).args;
          return { t: clock(l.blockNumber as bigint), price: toUsdcPerMon(args.sqrtPriceX96) };
        });
      },
    });
  }
  return out;
}

interface V4Init {
  id: Hex;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  block: number;
}

/**
 * Every Initialize of a MON/USDC or WMON/USDC pool since genesis. The scan is about 1,100
 * requests, so its result is cached in .dev/ (gitignored) and a rerun scans only newer blocks.
 */
async function v4Initializations(head: bigint): Promise<V4Init[]> {
  const cachePath = join(ROOT, ".dev/p2-u0-v4-initialize.json");
  let cached: { scannedTo: number; inits: V4Init[] } = { scannedTo: -1, inits: [] };
  if (existsSync(cachePath)) cached = JSON.parse(readFileSync(cachePath, "utf8")) as typeof cached;
  if (BigInt(cached.scannedTo) < head) {
    const logs = await getLogsChunked(
      {
        address: ADDR.v4PoolManager,
        event: v4Initialize,
        args: { currency0: [zeroAddress, ADDR.wmon], currency1: ADDR.usdc },
      },
      BigInt(cached.scannedTo + 1),
      head,
      2,
    );
    for (const l of logs) {
      const a = (l as unknown as { args: Omit<V4Init, "block"> }).args;
      cached.inits.push({
        id: a.id,
        currency0: a.currency0,
        currency1: a.currency1,
        fee: Number(a.fee),
        tickSpacing: Number(a.tickSpacing),
        hooks: a.hooks,
        block: Number(l.blockNumber),
      });
    }
    cached.scannedTo = Number(head);
    mkdirSync(join(ROOT, ".dev"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cached));
  }
  return cached.inits.filter((i) => BigInt(i.block) <= head);
}

async function v4Venues(head: bigint): Promise<{ venues: Venue[]; allPools: unknown[] }> {
  const venues: Venue[] = [];
  const allPools: unknown[] = [];
  for (const a of await v4Initializations(head)) {
    const [slot0, liquidity] = await Promise.all([
      fork.readContract({
        address: ADDR.v4StateView,
        abi: v4StateViewAbi,
        functionName: "getSlot0",
        args: [a.id],
      }),
      fork.readContract({
        address: ADDR.v4StateView,
        abi: v4StateViewAbi,
        functionName: "getLiquidity",
        args: [a.id],
      }),
    ]);
    const key = {
      currency0: a.currency0,
      currency1: a.currency1,
      fee: a.fee,
      tickSpacing: a.tickSpacing,
      hooks: a.hooks,
    };
    const computedId = keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "uint24" },
          { type: "int24" },
          { type: "address" },
        ],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      ),
    );
    const native = a.currency0 === zeroAddress;
    const mid = priceFromSqrtX96(slot0[0], 18, 6);
    const dynamicFee = a.fee === 0x800000;
    const info = {
      poolId: a.id,
      idMatchesKey: computedId === a.id,
      currency0: native ? "native MON" : "WMON",
      fee: a.fee,
      dynamicFee,
      lpFee: slot0[3],
      tickSpacing: a.tickSpacing,
      hooks: a.hooks,
      hookless: a.hooks === zeroAddress,
      liquidity: liquidity.toString(),
      midPrice: mid,
      initializedAtBlock: a.block,
    };
    allPools.push(info);
    if (liquidity === 0n) continue;
    venues.push({
      id: `uniswap-v4-${native ? "mon" : "wmon"}-${a.fee}-${a.tickSpacing}${a.hooks === zeroAddress ? "" : `-hooked-${a.hooks.slice(2, 8).toLowerCase()}`}`,
      venue: "uniswap-v4",
      label: `Uniswap v4 ${native ? "MON" : "WMON"}/USDC fee ${dynamicFee ? "dynamic" : `${a.fee / 10_000}%`} spacing ${a.tickSpacing}${a.hooks === zeroAddress ? "" : " (hooked)"}`,
      hookless: a.hooks === zeroAddress,
      feeBps: slot0[3] / 100,
      midPrice: mid,
      detail: info,
      quote: async (dir, amountIn) => {
        const r = await keyed.readContract({
          blockNumber: head,
          address: ADDR.v4Quoter,
          abi: v4QuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [
            {
              poolKey: key,
              zeroForOne: dir === "MON->USDC",
              exactAmount: amountIn,
              hookData: "0x",
            },
          ],
        });
        return r[0];
      },
      history: async (from, to, clock) => {
        const logs = await getLogsChunked(
          { address: ADDR.v4PoolManager, event: v4Swap, args: { id: a.id } },
          from,
          to,
        );
        return logs.map((x) => {
          const args = (x as unknown as { args: { sqrtPriceX96: bigint } }).args;
          return {
            t: clock(x.blockNumber as bigint),
            price: priceFromSqrtX96(args.sqrtPriceX96, 18, 6),
          };
        });
      },
    });
  }
  return { venues, allPools };
}

async function kuruVenue(oraclePrice: number): Promise<Venue> {
  const p = await fork.readContract({
    address: ADDR.kuruRouter,
    abi: kuruRouterAbi,
    functionName: "verifiedMarket",
    args: [ADDR.kuruMonUsdc],
  });
  const [
    pricePrecision,
    sizePrecision,
    base,
    baseDecimals,
    quoteAsset,
    quoteDecimals,
    tickSize,
    minSize,
    maxSize,
    takerFeeBps,
    makerFeeBps,
  ] = p;
  if (quoteAsset.toLowerCase() !== ADDR.usdc.toLowerCase())
    throw new Error(`Kuru MON-USDC quote asset is ${quoteAsset}, not USDC`);
  const [bid, ask] = await fork.readContract({
    address: ADDR.kuruMonUsdc,
    abi: kuruBookAbi,
    functionName: "bestBidAsk",
  });
  // Price scale: the ABI says uint256 while the docs say uint32. Pick the scale that lands near the oracle.
  const scales = [10 ** 18, Number(pricePrecision)];
  const scale = scales.reduce((best, s) =>
    Math.abs(Number(bid) / s / oraclePrice - 1) < Math.abs(Number(bid) / best / oraclePrice - 1)
      ? s
      : best,
  );
  const mid = (Number(bid) + Number(ask)) / 2 / scale;
  let vault: unknown;
  try {
    const v = await fork.readContract({
      address: ADDR.kuruMonUsdc,
      abi: kuruBookAbi,
      functionName: "getVaultParams",
    });
    vault = { vault: v[0], raw: v.slice(1).map(String) };
  } catch (err) {
    vault = { error: safe(err) };
  }
  const nativeBase = base === zeroAddress;
  return {
    id: "kuru-mon-usdc",
    venue: "kuru",
    label: "Kuru MON-USDC orderbook (with AMM vault)",
    hookless: true,
    feeBps: Number(takerFeeBps),
    midPrice: mid,
    detail: {
      market: ADDR.kuruMonUsdc,
      base: nativeBase ? "native MON" : base,
      baseDecimals: Number(baseDecimals),
      quoteDecimals: Number(quoteDecimals),
      pricePrecision: Number(pricePrecision),
      sizePrecision: sizePrecision.toString(),
      tickSize: Number(tickSize),
      minSize: minSize.toString(),
      maxSize: maxSize.toString(),
      takerFeeBps: Number(takerFeeBps),
      makerFeeBps: Number(makerFeeBps),
      bestBid: Number(bid) / scale,
      bestAsk: Number(ask) / scale,
      spreadBps: ((Number(ask) - Number(bid)) / ((Number(ask) + Number(bid)) / 2)) * 10_000,
      priceScale: scale === 10 ** 18 ? "1e18" : `pricePrecision ${pricePrecision}`,
      vault,
    },
    quote: async (dir, amountIn) => {
      const buy = dir === "USDC->MON";
      const baseToken = nativeBase ? zeroAddress : base;
      const data = encodeFunctionData({
        abi: kuruRouterAbi,
        functionName: "anyToAnySwap",
        args: [
          [ADDR.kuruMonUsdc],
          [buy],
          [!buy && nativeBase],
          buy ? ADDR.usdc : baseToken,
          buy ? baseToken : ADDR.usdc,
          amountIn,
          0n,
        ],
      });
      const r = await fork.call({
        account: TAKER,
        to: ADDR.kuruRouter,
        data,
        ...(!buy && nativeBase ? { value: amountIn } : {}),
      });
      return decodeFunctionResult({
        abi: kuruRouterAbi,
        functionName: "anyToAnySwap",
        data: r.data as Hex,
      });
    },
    history: async (from, to, clock) => {
      const logs = await getLogsChunked({ address: ADDR.kuruMonUsdc, event: kuruTrade }, from, to);
      return logs.map((l) => {
        const args = (l as unknown as { args: { price: bigint } }).args;
        return { t: clock(l.blockNumber as bigint), price: Number(args.price) / 1e18 };
      });
    },
  };
}

// ---------- main ----------
async function main(): Promise<void> {
  const report: Record<string, unknown> = { unit: "P2-U0", generatedAt: new Date().toISOString() };
  // Stage 3 (quotes and size search) is cached per pinned block in .dev/, so a run that fails
  // later resumes at the same block without quoting again. Delete the file to start fresh.
  const stageCachePath = join(ROOT, ".dev/p2-u0-quotes.json");
  const stageCache = existsSync(stageCachePath)
    ? (JSON.parse(readFileSync(stageCachePath, "utf8")) as {
        block: string;
        quotes: unknown[];
        maxSize: Record<string, Record<string, number>>;
      })
    : null;
  const B = stageCache ? BigInt(stageCache.block) : (await keyed.getBlockNumber()) - 10n;
  const blockB = await keyed.getBlock({ blockNumber: B });
  const tB = Number(blockB.timestamp);
  report.block = { number: Number(B), timestamp: tB, iso: new Date(tB * 1000).toISOString() };
  console.log(`pinned block ${B} (${new Date(tB * 1000).toISOString()})`);

  const anvil = await startAnvil(B);
  try {
    // 1. Code at every address on the fork.
    console.log("1/6 code checks");
    const code = await pool(SOURCES, 4, async (s) => {
      const bytes = (await fork.getCode({ address: s.address })) ?? "0x";
      return {
        ...s,
        codeSize: (bytes.length - 2) / 2,
        codeHash: bytes === "0x" ? null : keccak256(bytes),
      };
    });
    report.addresses = code;
    const missing = code.filter((c) => c.codeSize === 0);
    if (missing.length)
      throw new Error(`no code on the fork at: ${missing.map((m) => m.id).join(", ")}`);

    // 2. Feeds at B.
    console.log("2/6 feeds at the pinned block");
    const feeds = [
      { id: "MON/USD", proxy: ADDR.monUsd, publishedHeartbeat: 3600, publishedDeviationPct: 0.02 },
      {
        id: "USDC/USD",
        proxy: ADDR.usdcUsd,
        publishedHeartbeat: 3600,
        publishedDeviationPct: 0.05,
      },
      { id: "ETH/USD", proxy: ADDR.ethUsd, publishedHeartbeat: 3600, publishedDeviationPct: 0.05 },
    ];
    const feedNow = await pool(feeds, 3, async (f) => {
      const [aggregator, decimals, description, latest] = await Promise.all([
        fork.readContract({ address: f.proxy, abi: feedAbi, functionName: "aggregator" }),
        fork.readContract({ address: f.proxy, abi: feedAbi, functionName: "decimals" }),
        fork.readContract({ address: f.proxy, abi: feedAbi, functionName: "description" }),
        fork.readContract({ address: f.proxy, abi: feedAbi, functionName: "latestRoundData" }),
      ]);
      const aggCode = (await fork.getCode({ address: aggregator })) ?? "0x";
      return {
        ...f,
        aggregator,
        aggregatorCodeSize: (aggCode.length - 2) / 2,
        decimals,
        description,
        answer: Number(latest[1]) / 10 ** decimals,
        updatedAt: Number(latest[3]),
        ageAtBlock: tB - Number(latest[3]),
      };
    });
    const monPrice = (feedNow[0] as { answer: number }).answer;
    const usdcPrice = (feedNow[1] as { answer: number }).answer;
    report.feedsAtBlock = { source: FEED_SOURCE, feeds: feedNow };

    // 3. Venues and quotes.
    console.log("3/6 venues and quotes");
    await setMonBalance(TAKER, 10n ** 30n, FORK_URL);
    await mintTestUsdc(TAKER, 1_000_000n * 10n ** 6n, FORK_URL);
    await sendOnFork(
      TAKER,
      ADDR.usdc,
      encodeFunctionData({
        abi: usdcAbi,
        functionName: "approve",
        args: [ADDR.kuruRouter, maxUint256],
      }),
    );
    const v3 = await v3Venues(B);
    const v4 = await v4Venues(B);
    const kuru = await kuruVenue(monPrice);
    const venues = [...v3, ...v4.venues, kuru];
    // Quotes, sizes and deviation are keyed by venue id; a duplicate would merge two pools.
    const ids = venues.map((v) => v.id);
    if (new Set(ids).size !== ids.length) throw new Error(`duplicate venue ids: ${ids.join(", ")}`);
    report.v4PoolsFound = v4.allPools;

    const amountFor = (dir: Direction, usd: number): bigint =>
      dir === "USDC->MON"
        ? BigInt(Math.round(usd * 1e6))
        : BigInt(Math.round((usd / monPrice) * 1e9)) * 10n ** 9n;
    const outFloat = (dir: Direction, raw: bigint) =>
      dir === "USDC->MON" ? Number(raw) / 1e18 : Number(raw) / 1e6;
    const quoteRow = async (v: Venue, dir: Direction, usd: number) => {
      const amountIn = amountFor(dir, usd);
      const inFloat = dir === "USDC->MON" ? Number(amountIn) / 1e6 : Number(amountIn) / 1e18;
      const oracleOut = dir === "USDC->MON" ? inFloat / monPrice : inFloat * monPrice;
      const midOut = dir === "USDC->MON" ? inFloat / v.midPrice : inFloat * v.midPrice;
      try {
        const raw = await v.quote(dir, amountIn);
        const out = outFloat(dir, raw);
        return {
          venue: v.id,
          direction: dir,
          sizeUsd: usd,
          amountIn: amountIn.toString(),
          amountOut: raw.toString(),
          out,
          oracleImpliedOut: oracleOut,
          slippageVsOracleBps: round(shortfallBps(out, oracleOut)),
          impactVsMidBps: round(shortfallBps(out, midOut)),
          impactExFeeBps: round(shortfallBps(out, midOut) - v.feeBps),
          withinLimit: shortfallBps(out, oracleOut) <= MAX_SLIPPAGE_BPS,
        };
      } catch (err) {
        return {
          venue: v.id,
          direction: dir,
          sizeUsd: usd,
          amountIn: amountIn.toString(),
          error: safe(err),
        };
      }
    };
    const directions: Direction[] = ["USDC->MON", "MON->USDC"];
    type QuoteRow = Awaited<ReturnType<typeof quoteRow>>;
    const quotes: QuoteRow[] = stageCache ? (stageCache.quotes as QuoteRow[]) : [];
    console.log(`   ${venues.length} venues: ${venues.map((v) => v.id).join(", ")}`);
    if (stageCache) console.log("   quotes and max sizes reused from .dev/p2-u0-quotes.json");
    for (const v of stageCache ? [] : venues) {
      for (const dir of directions)
        for (const usd of [...SIZES_USD, BURST_USD]) quotes.push(await quoteRow(v, dir, usd));
      console.log(`   quoted ${v.id}`);
    }

    // Largest size inside 0.5% against the oracle, by bisection on a log scale.
    const maxSize = (stageCache?.maxSize ?? {}) as Record<string, Record<Direction, number>>;
    for (const v of stageCache ? [] : venues) {
      console.log(`   max size search ${v.id}`);
      maxSize[v.id] = { "USDC->MON": 0, "MON->USDC": 0 };
      for (const dir of directions) {
        const ok = async (usd: number) => {
          const r = await quoteRow(v, dir, usd);
          return "withinLimit" in r && r.withinLimit;
        };
        if (!(await ok(1))) continue;
        let lo = 1;
        let hi = 50_000;
        if (await ok(hi)) {
          (maxSize[v.id] as Record<Direction, number>)[dir] = hi;
          continue;
        }
        for (let i = 0; i < 18; i += 1) {
          const mid = Math.sqrt(lo * hi);
          if (await ok(mid)) lo = mid;
          else hi = mid;
        }
        (maxSize[v.id] as Record<Direction, number>)[dir] = round(lo, 0) ?? 0;
      }
    }
    console.log("   max sizes found");
    if (!stageCache)
      writeFileSync(stageCachePath, JSON.stringify({ block: B.toString(), quotes, maxSize }));
    report.venues = venues.map((v) => ({
      id: v.id,
      venue: v.venue,
      label: v.label,
      hookless: v.hookless,
      feeBps: v.feeBps,
      midPrice: v.midPrice,
      midVsOracleBps: round(((v.midPrice - monPrice) / monPrice) * 10_000),
      maxSizeUsdWithin50Bps: maxSize[v.id],
      detail: v.detail,
    }));
    report.quotes = quotes;

    // 4. Feed history.
    console.log("4/6 feed history (7 days of AnswerUpdated)");
    const startT = tB - WINDOW_SECONDS;
    const startBlock = await blockAtTime(startT, B);
    // Two hours before the window, so the answer current at the window start is known.
    const preBlock = startBlock - 24_000n;
    const clock = await blockClock(preBlock, B);
    report.window = {
      startBlock: Number(startBlock),
      endBlock: Number(B),
      startIso: new Date(startT * 1000).toISOString(),
      endIso: new Date(tB * 1000).toISOString(),
      logsRpc: LOGS_RPC,
      timestamps:
        "AnswerUpdated carries updatedAt; pool events use block times interpolated from headers every 50,000 blocks",
    };
    const feedHistory: Record<string, unknown> = {};
    const series: Record<string, Point[]> = {};
    for (const f of feedNow) {
      const logs = await getLogsChunked(
        { address: f.aggregator, event: answerUpdated },
        preBlock,
        B,
      );
      const updates = logs
        .map((l) => {
          const a = (
            l as unknown as { args: { current: bigint; roundId: bigint; updatedAt: bigint } }
          ).args;
          return {
            t: Number(a.updatedAt),
            price: Number(a.current) / 10 ** f.decimals,
            roundId: a.roundId,
            block: Number(l.blockNumber),
          };
        })
        .sort((a, b) => a.t - b.t);
      const before = updates.filter((u) => u.t <= startT);
      const inWindow = updates.filter((u) => u.t > startT);
      const used = [...before.slice(-1), ...inWindow];
      const begin = used.length ? (used[0] as Point).t : startT;
      series[f.id] = used;
      // Cross-check the last 20 events against the aggregator's stored rounds at B.
      const tail = inWindow.slice(-20);
      const mismatches = (
        await pool(tail, 4, async (u) => {
          const r = await fork.readContract({
            address: f.aggregator,
            abi: feedAbi,
            functionName: "getRoundData",
            args: [u.roundId],
          });
          return Number(r[3]) === u.t && Number(r[1]) / 10 ** f.decimals === u.price ? 0 : 1;
        })
      ).reduce((s: number, x) => s + x, 0);
      feedHistory[f.id] = {
        aggregator: f.aggregator,
        publishedHeartbeatSeconds: f.publishedHeartbeat,
        publishedDeviationPct: f.publishedDeviationPct,
        stats: feedStats(used, begin, tB, f.publishedHeartbeat, STALE_THRESHOLDS),
        crossCheck: { roundsChecked: tail.length, mismatches },
        updates: used.map((u) => [u.t, u.price]),
      };
    }
    report.feedHistory = feedHistory;

    // 5. Pool versus oracle.
    console.log("5/6 pool history and deviation sampling");
    const oracle = series["MON/USD"] as Point[];
    const deviation: Record<string, unknown> = {};
    for (const v of venues) {
      let hist: Point[];
      try {
        hist = (await v.history(preBlock, B, clock)).sort((a, b) => a.t - b.t);
      } catch (err) {
        deviation[v.id] = { error: safe(err) };
        continue;
      }
      const samples: DeviationSample[] = sampleDeviation(oracle, hist, startT, tB, SAMPLE_STEP);
      // Share of minutes when a small trade would pass both the 2% deviation rule and 0.5% slippage,
      // using each size's impact at B and the minute's deviation (buying MON suffers when the pool is
      // above the oracle, selling when it is below).
      const passShare = (usd: number) => {
        const res: Record<string, number | null> = {};
        for (const dir of directions) {
          const q = quotes.find(
            (x) => x.venue === v.id && x.direction === dir && x.sizeUsd === usd,
          );
          if (!q || !("impactVsMidBps" in q) || q.impactVsMidBps === null) {
            res[dir] = null;
            continue;
          }
          const impact = q.impactVsMidBps;
          const pass = samples.filter((s) => {
            const slip = dir === "USDC->MON" ? impact + s.bps : impact - s.bps;
            return Math.abs(s.bps) <= MAX_DEVIATION_BPS && slip <= MAX_SLIPPAGE_BPS;
          }).length;
          res[dir] = samples.length ? pass / samples.length : null;
        }
        return res;
      };
      deviation[v.id] = {
        events: hist.length,
        priceSource:
          v.venue === "kuru" ? "Trade event price (taker fills)" : "post-swap sqrtPriceX96",
        summary: summarizeDeviation(samples, SAMPLE_STEP),
        shareOfMinutesTradable: { usd10: passShare(10), usd200: passShare(BURST_USD) },
      };
    }
    report.deviation = deviation;

    // 6. Q-03.
    console.log("6/6 USDC identity");
    const read = async (fn: string) => {
      try {
        const r = await fork.readContract({
          address: ADDR.usdc,
          abi: usdcAbi,
          functionName: fn as "name",
          ...(fn === "isBlacklisted" ? { args: [zeroAddress] } : {}),
        } as Parameters<PublicClient["readContract"]>[0]);
        return typeof r === "bigint" ? r.toString() : r;
      } catch (err) {
        return { error: safe(err) };
      }
    };
    const slot = async (s: Hex) => {
      const v = (await fork.getStorageAt({ address: ADDR.usdc, slot: s })) ?? "0x";
      return BigInt(v) === 0n ? null : (`0x${v.slice(-40)}` as Address);
    };
    const impl =
      (await slot("0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3")) ??
      (await slot("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"));
    const implCode = impl ? ((await fork.getCode({ address: impl })) ?? "0x") : "0x";
    const usdcFields: Record<string, unknown> = {};
    for (const fn of [
      "name",
      "symbol",
      "decimals",
      "version",
      "owner",
      "masterMinter",
      "pauser",
      "blacklister",
      "rescuer",
      "paused",
      "isBlacklisted",
      "totalSupply",
    ])
      usdcFields[fn] = await read(fn);
    report.usdc = {
      address: ADDR.usdc,
      fields: usdcFields,
      proxy: {
        implementationSlotZeppelinOs: await slot(
          "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
        ),
        adminSlotZeppelinOs: await slot(
          "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
        ),
        implementationSlotEip1967: await slot(
          "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
        ),
        adminSlotEip1967: await slot(
          "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
        ),
        implementation: impl,
        implementationCodeSize: (implCode.length - 2) / 2,
        implementationCodeHash: implCode === "0x" ? null : keccak256(implCode),
      },
      usdcUsdAtBlock: usdcPrice,
      circleListing:
        "https://developers.circle.com/stablecoins/usdc-contract-addresses lists Monad mainnet USDC as 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 (checked 2026-10-03)",
    };
  } finally {
    anvil.kill("SIGTERM");
  }

  const dir = join(ROOT, "evidence/p2-u0");
  mkdirSync(dir, { recursive: true });
  const text = redact(JSON.stringify(report, null, 1), SECRETS);
  writeFileSync(join(dir, "data.json"), `${text}\n`);
  console.log(`wrote evidence/p2-u0/data.json (${text.length} bytes)`);
}

main().catch((err: unknown) => {
  console.error(`spike failed: ${safe(err)}`);
  process.exit(1);
});
