import { type Hex, type PublicClient, type WalletClient, encodeFunctionData, parseAbi } from "viem";
import type { DeployerQueue } from "./deployer-queue.ts";

/**
 * 2026-10-18 (owner): the pool recycler on Monad testnet. Every testnet buy
 * crosses MON/USDC and nothing sells MON back (L-285), so each agent's buys
 * lift the price above the oracle and drain the buy side, while the MON piles
 * up in the stand-in pools (TALPHA and TBETA against MON). When MON/USDC sits
 * above the oracle or holds too little MON above its price, the recycler sells
 * the deployer's stand-ins into their MON pools at par (TestnetToken has no
 * mint; the deployer holds most of each supply), sells that MON into MON/USDC
 * down to the oracle, and adds the rest just above the price. The deployer
 * pays gas only: it never puts its own MON in a pool, so a run that recovers
 * too little stops before it sends anything into MON/USDC.
 */

/** MON/USDC as StateView reads it: currency0 is native MON (18 decimals), currency1 USDC (6). */
export interface PoolState {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly spacing: number;
  /** liquidityNet of each initialized tick near the price. */
  readonly nets: ReadonlyMap<number, bigint>;
}

/** The pool's fee (500 = 0.05%), which a sale into it pays on what it sends in. */
export const POOL_FEE_PPM = 500;
/** Above the oracle by more than this many ticks (0.3%), the pool is re-centred. */
export const HIGH_TICKS = 30;
/** The buy side is the MON within this many ticks (1.5%) above the price. */
export const BUY_BAND_TICKS = 150;
/** Below this much MON on the buy side, the recycler refills it... */
export const MIN_BUY_SIDE_WEI = 3n * 10n ** 18n;
/** ...up to this much. */
export const BUY_SIDE_TARGET_WEI = 6n * 10n ** 18n;
/** A stand-in sale gets at least this share of par back (99.5%): only MON that agents' buys left there. */
export const PAR_SHARE_PPM = 995_000n;
/** Recovering less than this is not worth a run's gas (about 0.1 MON). */
export const MIN_RECOVERY_WEI = 3n * 10n ** 17n;
/** The deployer's MON a run needs for its gas, about seven transactions at Monad's billed limit. */
export const RUN_GAS_ROOM_WEI = 3n * 10n ** 17n;

const sqrtAt = (tick: number) => Math.sqrt(1.0001 ** tick);
const sqrtOf = (s: PoolState) => Number(s.sqrtPriceX96) / 2 ** 96;
const wei = (x: number) => (x > 0 ? BigInt(Math.floor(x)) : 0n);

/** The tick of a MON price in USDC: the raw price is USDC units per MON wei. */
export function tickOfPrice(usdcPerMon: number): number {
  return Math.floor(Math.log(usdcPerMon * 1e-12) / Math.log(1.0001));
}

/** The MON a sale into the pool must send in (fee included) to bring its price down to `toTick`. */
export function monToLower(s: PoolState, toTick: number): bigint {
  const end = sqrtAt(toTick);
  let p = sqrtOf(s);
  if (p <= end) return 0n;
  let l = Number(s.liquidity);
  let x = 0;
  const crossed = [...s.nets.keys()].filter((k) => k <= s.tick && k > toTick).sort((a, b) => b - a);
  for (const k of crossed) {
    const b = sqrtAt(k);
    x += l * (1 / b - 1 / p);
    p = b;
    l -= Number(s.nets.get(k) ?? 0n);
  }
  x += l * (1 / end - 1 / p);
  return wei(x / (1 - POOL_FEE_PPM / 1e6));
}

/** The MON buys can take out of the pool before its price reaches `toTick`. */
export function monAbove(s: PoolState, toTick: number): bigint {
  const end = sqrtAt(toTick);
  let p = sqrtOf(s);
  if (p >= end) return 0n;
  let l = Number(s.liquidity);
  let x = 0;
  const crossed = [...s.nets.keys()].filter((k) => k > s.tick && k < toTick).sort((a, b) => a - b);
  for (const k of crossed) {
    const b = sqrtAt(k);
    x += l * (1 / p - 1 / b);
    p = b;
    l += Number(s.nets.get(k) ?? 0n);
  }
  x += l * (1 / p - 1 / end);
  return wei(x);
}

/** The liquidity that puts `mon` wei into [lo, hi], a range wholly above the price. */
export function liquidityForMon(mon: bigint, lo: number, hi: number): bigint {
  return wei(Number(mon) / (1 / sqrtAt(lo) - 1 / sqrtAt(hi)));
}

export type RecyclePlan =
  | { readonly act: false; readonly why: string }
  | {
      readonly act: true;
      readonly why: string;
      /** The tick the pool is brought down to: the oracle's, on the spacing. */
      readonly targetTick: number;
      /** The MON to sell into MON/USDC to get there. */
      readonly sellWei: bigint;
      /** The MON to add above the price afterwards. */
      readonly addWei: bigint;
    };

/** What the pool needs, from its state and the oracle's tick. */
export function planRecycle(s: PoolState, oracleTick: number): RecyclePlan {
  const targetTick = Math.floor(oracleTick / s.spacing) * s.spacing;
  const high = s.tick > oracleTick + HIGH_TICKS;
  const buySide = monAbove(s, s.tick + BUY_BAND_TICKS);
  const low = buySide < MIN_BUY_SIDE_WEI;
  const fmt = (w: bigint) => (Number(w) / 1e18).toFixed(3);
  if (!high && !low)
    return {
      act: false,
      why: `centred (tick ${s.tick}, oracle ${oracleTick}) with ${fmt(buySide)} MON on the buy side`,
    };
  const sellWei = high ? monToLower(s, targetTick) : 0n;
  // Selling down turns the USDC between the target and the price back into MON above it.
  const after = buySide + sellWei;
  const addWei = after < BUY_SIDE_TARGET_WEI ? BUY_SIDE_TARGET_WEI - after : 0n;
  return {
    act: true,
    why: [
      high ? `tick ${s.tick} is above the oracle's ${oracleTick}` : null,
      low ? `${fmt(buySide)} MON on the buy side` : null,
    ]
      .filter(Boolean)
      .join(" and "),
    targetTick,
    sellWei,
    addWei,
  };
}

export interface StandIn {
  readonly symbol: string;
  readonly address: Hex;
  /** Its pool against native MON. */
  readonly poolId: Hex;
}

/** The chain as the recycler uses it: reads, quotes and the deployer's sends. */
export interface RecycleChain {
  pool(): Promise<PoolState>;
  oracleTick(): Promise<number>;
  deployerMon(): Promise<bigint>;
  tokenBalance(token: Hex): Promise<bigint>;
  /** MON out for selling `amount` of the stand-in into its pool; null when the pool cannot fill it. */
  quoteSale(s: StandIn, amount: bigint): Promise<bigint | null>;
  /** Sells the stand-in for WMON, at least `minOut`; returns the WMON received. */
  sell(s: StandIn, amount: bigint, minOut: bigint): Promise<{ hash: Hex; out: bigint }>;
  /** Sells WMON into MON/USDC for at least `minUsdc`. */
  sellMon(amount: bigint, minUsdc: bigint): Promise<Hex>;
  unwrap(amount: bigint): Promise<Hex>;
  /** Adds `mon` wei of native MON to MON/USDC in [lo, hi] above the price. */
  addAbove(lo: number, hi: number, mon: bigint): Promise<Hex>;
}

export interface RecycleRun {
  readonly plan: RecyclePlan;
  readonly recoveredWei: bigint;
  readonly txs: readonly { readonly what: string; readonly hash: Hex }[];
  readonly stopped?: string;
}

/** The largest sale of `s` the pool fills at par (within PAR_SHARE_PPM), up to `most`. */
export async function parSale(chain: RecycleChain, s: StandIn, most: bigint): Promise<bigint> {
  const fills = async (a: bigint) => {
    const out = await chain.quoteSale(s, a);
    return out !== null && out * 1_000_000n >= a * PAR_SHARE_PPM;
  };
  if (most <= 0n) return 0n;
  if (await fills(most)) return most;
  let lo = 0n;
  let hi = most;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2n;
    if (await fills(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** One pass: read, plan, recover MON from the stand-in pools, re-centre and deepen MON/USDC. */
export async function recyclePass(o: {
  readonly chain: RecycleChain;
  readonly standIns: readonly StandIn[];
  /** USDC per MON at the oracle, for the sale's minimum out. */
  readonly oraclePrice: () => Promise<number>;
  readonly log: (line: string) => void;
}): Promise<RecycleRun> {
  const { chain } = o;
  const s = await chain.pool();
  const plan = planRecycle(s, await chain.oracleTick());
  const txs: { what: string; hash: Hex }[] = [];
  if (!plan.act) return { plan, recoveredWei: 0n, txs };
  if ((await chain.deployerMon()) < RUN_GAS_ROOM_WEI)
    return {
      plan,
      recoveredWei: 0n,
      txs,
      stopped: "the deployer holds too little MON for the gas",
    };
  const need = plan.sellWei + plan.addWei;
  let recovered = 0n;
  for (const standIn of o.standIns) {
    const left = need - recovered;
    if (left <= 0n) break;
    const held = await chain.tokenBalance(standIn.address);
    // At par one stand-in is one MON; ask a little over what is left for the pool's fee.
    const amount = await parSale(
      chain,
      standIn,
      held < (left * 101n) / 100n ? held : (left * 101n) / 100n,
    );
    if (amount < MIN_RECOVERY_WEI / 4n) continue;
    const sold = await chain.sell(standIn, amount, (amount * 99n) / 100n);
    txs.push({ what: `sell ${amount} ${standIn.symbol} for WMON`, hash: sold.hash });
    recovered += sold.out;
  }
  if (recovered < MIN_RECOVERY_WEI) {
    // Whatever was recovered waits as WMON for the next run; nothing goes into MON/USDC.
    return {
      plan,
      recoveredWei: recovered,
      txs,
      stopped: "the stand-in pools hold too little MON above par to recover",
    };
  }
  let left = recovered;
  if (plan.sellWei > 0n) {
    const sell = plan.sellWei < left ? plan.sellWei : left;
    const price = await o.oraclePrice();
    // USDC (6 decimals) for `sell` wei at the oracle, less 1%: the pool sits above the oracle.
    const minUsdc = BigInt(Math.floor((Number(sell) / 1e12) * price * 0.99));
    txs.push({ what: `sell ${sell} WMON into MON/USDC`, hash: await chain.sellMon(sell, minUsdc) });
    left -= sell;
  }
  if (left > 0n) {
    txs.push({ what: `unwrap ${left} WMON`, hash: await chain.unwrap(left) });
    const now = await chain.pool();
    const lo = Math.ceil((now.tick + 1) / now.spacing) * now.spacing;
    const hi = lo + BUY_BAND_TICKS;
    txs.push({
      what: `add ${left} MON to MON/USDC [${lo}, ${hi}]`,
      hash: await chain.addAbove(lo, hi, left),
    });
  }
  o.log(
    `pool recycler: ${plan.why}; recovered ${recovered} wei of MON from the stand-in pools: ${txs.map((t) => `${t.what} (${t.hash})`).join(", ")}`,
  );
  return { plan, recoveredWei: recovered, txs };
}

// ---- Monad testnet ----

/** The Monad testnet stand-in market (evidence/co-u1-monad/testnet-deployment.json, CO-U1). */
export const MONAD_TESTNET_MARKET = {
  poolId: "0x40ab892dad820a1b57392a8a6e7c783e108a2285e83d3a6dbf1dd44902a19972",
  seeder: "0xA4adD8Adbb6C04De71dC313322913b7084a9424A",
  routeAdapter: "0x2B601bBab005d83fDa58dAFae2cD9C57AB35bBC6",
  stateView: "0xB639209539c61BaF67AC04876315786F8D0b153c",
  quoter: "0x869834d127b230283fe63E0d0A9bEB67216a94C7",
  wmon: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
  usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  monUsdFeed: "0x4F257aD5E3AE49E0934813c23F5940448d20965E",
  usdcUsdFeed: "0x94f797988a94c86dF85bC457027eDF7b4673fD9D",
  fee: 500,
  spacing: 10,
  standIns: [
    {
      symbol: "TALPHA",
      address: "0xD4EB3FeF2A9eBE27D59D4188B6D20Bb21220c03c",
      poolId: "0x1ef9a330198d0abfd0a655ef79354c60e17391f53fd1ec00ccc3dbddbdbc1704",
    },
    {
      symbol: "TBETA",
      address: "0x57ca16ca75E968Bd3FF712C729e6e5F6940Cc010",
      poolId: "0x40ce0801823100e952681aa05f5816ec8cde1ed39f27b85dbec46a30d2397b1c",
    },
  ],
} as const;

const NATIVE = "0x0000000000000000000000000000000000000000" as Hex;
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)",
  "function getLiquidity(bytes32) view returns (uint128)",
  "function getTickBitmap(bytes32, int16) view returns (uint256)",
  "function getTickLiquidity(bytes32, int24) view returns (uint128, int128)",
]);
const QUOTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Params { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(Params params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const SEEDER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function addLiquidity(PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity) payable",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
]);
const WMON_ABI = parseAbi(["function withdraw(uint256)"]);
const ADAPTER_ABI = parseAbi([
  "function swapRoute(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient, bytes32[] route, bool allowScreened) returns (uint256)",
]);
const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);

/** USDC per MON at the stand-in feeds. */
export async function monadOraclePrice(reader: PublicClient): Promise<number> {
  const m = MONAD_TESTNET_MARKET;
  const read = async (feed: Hex) => {
    const [round, decimals] = await Promise.all([
      reader.readContract({ address: feed, abi: FEED_ABI, functionName: "latestRoundData" }),
      reader.readContract({ address: feed, abi: FEED_ABI, functionName: "decimals" }),
    ]);
    return Number(round[1]) / 10 ** decimals;
  };
  return (await read(m.monUsdFeed)) / (await read(m.usdcUsdFeed));
}

/**
 * The recycler's chain on Monad testnet, from the deployer's key. Each send is
 * one transaction through the deployer's queue (deployer-queue.ts: one at a
 * time, spaced for Monad's reserve rule), with its gas from the plain
 * eth_estimateGas plus 30% (L-270).
 */
export function monadRecycleChain(o: {
  readonly reader: PublicClient;
  readonly wallet: WalletClient;
  readonly deployer: Hex;
  readonly queue: DeployerQueue;
}): RecycleChain {
  const m = MONAD_TESTNET_MARKET;
  const { reader, deployer } = o;
  const keyOf = (currency1: Hex) => ({
    currency0: NATIVE,
    currency1,
    fee: m.fee,
    tickSpacing: m.spacing,
    hooks: NATIVE,
  });
  const send = (to: Hex, data: Hex, value = 0n) =>
    o.queue.run(async () => {
      const estimate = BigInt(
        await reader.request({
          method: "eth_estimateGas",
          params: [{ from: deployer, to, data, value: `0x${value.toString(16)}` }],
        } as never),
      );
      const hash = await o.wallet.sendTransaction({
        account: deployer,
        chain: null,
        to,
        data,
        value,
        gas: (estimate * 13n) / 10n,
      } as never);
      const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success")
        throw new Error(`the recycler's transaction ${hash} reverted`);
      return hash;
    });
  const balanceOf = (token: Hex) =>
    reader.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [deployer],
    });
  const transfer = (token: Hex, to: Hex, amount: bigint) =>
    send(
      token,
      encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] }),
    );
  return {
    async pool() {
      const id = m.poolId as Hex;
      const [slot, liquidity] = await Promise.all([
        reader.readContract({
          address: m.stateView,
          abi: STATE_VIEW_ABI,
          functionName: "getSlot0",
          args: [id],
        }),
        reader.readContract({
          address: m.stateView,
          abi: STATE_VIEW_ABI,
          functionName: "getLiquidity",
          args: [id],
        }),
      ]);
      const tick = slot[1];
      // Every initialized tick within a bitmap word or two of the price (a word spans 2,560 ticks).
      const word = (t: number) => Math.floor(Math.floor(t / m.spacing) / 256);
      const nets = new Map<number, bigint>();
      for (let w = word(tick) - 1; w <= word(tick) + 1; w++) {
        const bits = await reader.readContract({
          address: m.stateView,
          abi: STATE_VIEW_ABI,
          functionName: "getTickBitmap",
          args: [id, w],
        });
        for (let b = 0; b < 256; b++) {
          if (((bits >> BigInt(b)) & 1n) === 0n) continue;
          const t = (w * 256 + b) * m.spacing;
          const [, net] = await reader.readContract({
            address: m.stateView,
            abi: STATE_VIEW_ABI,
            functionName: "getTickLiquidity",
            args: [id, t],
          });
          nets.set(t, net);
        }
      }
      return { sqrtPriceX96: slot[0], tick, liquidity, spacing: m.spacing, nets };
    },
    oracleTick: async () => tickOfPrice(await monadOraclePrice(reader)),
    deployerMon: () => reader.getBalance({ address: deployer }),
    tokenBalance: balanceOf,
    async quoteSale(s, amount) {
      try {
        const { result } = await reader.simulateContract({
          address: m.quoter,
          abi: QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            { poolKey: keyOf(s.address), zeroForOne: false, exactAmount: amount, hookData: "0x" },
          ],
        });
        return result[0];
      } catch {
        return null;
      }
    },
    async sell(s, amount, minOut) {
      const before = await balanceOf(m.wmon);
      await transfer(s.address, m.routeAdapter, amount);
      const hash = await send(
        m.routeAdapter,
        encodeFunctionData({
          abi: ADAPTER_ABI,
          functionName: "swapRoute",
          args: [s.address, m.wmon, amount, minOut, deployer, [s.poolId], false],
        }),
      );
      return { hash, out: (await balanceOf(m.wmon)) - before };
    },
    async sellMon(amount, minUsdc) {
      await transfer(m.wmon, m.routeAdapter, amount);
      return send(
        m.routeAdapter,
        encodeFunctionData({
          abi: ADAPTER_ABI,
          functionName: "swapRoute",
          args: [m.wmon, m.usdc, amount, minUsdc, deployer, [m.poolId], false],
        }),
      );
    },
    unwrap: (amount) =>
      send(m.wmon, encodeFunctionData({ abi: WMON_ABI, functionName: "withdraw", args: [amount] })),
    addAbove: (lo, hi, mon) =>
      send(
        m.seeder,
        encodeFunctionData({
          abi: SEEDER_ABI,
          functionName: "addLiquidity",
          args: [keyOf(m.usdc), lo, hi, (liquidityForMon(mon, lo, hi) * 99n) / 100n],
        }),
        mon,
      ),
  };
}
