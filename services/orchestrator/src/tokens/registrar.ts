import { MARKET_CHAIN } from "@alpha-agents/market";
import type { ChainReaderV3 } from "@alpha-agents/chain-tools";
import {
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  toBytes,
  zeroAddress,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { PoolRow, ScreenRecord, TokenStore } from "./store.ts";

/**
 * The screened-lane registrar (F-U12, D-342, D-351): when a token passes the
 * platform's safety screen it is registered in the TokenRegistry's screened
 * lane at once by the screener key, with its routable pools whose other side
 * is listed, so opted-in personal accounts may buy it; a later passing screen
 * is recorded; a failed re-screen moves it to sell-only. The screener key
 * tightens instantly and loosens never: restoring a token is the admin's
 * timelocked change. After every action, and on request, the registry's
 * lanes and statuses are mirrored into the platform's token table, so every
 * token list says what the chain says.
 *
 * The local screener is anvil account 3 (scripts/lib/fund.js); testnet's is
 * TESTNET_SCREENER_PRIVATE_KEY.
 */
const REGISTRY_ABI = parseAbi([
  "function addScreened(address token, uint16 maxPositionBps, bytes32 screenHash, uint64 screenedAt)",
  "function recordScreen(address token, bytes32 screenHash, uint64 screenedAt)",
  "function setSellOnly(address token)",
  "function tokenRecord(address token) view returns ((uint8 lane, uint8 status, uint8 priceClass, uint8 decimals, uint16 maxPositionBps, uint64 screenedAt, bytes32 screenHash))",
  "function screener() view returns (address)",
]);
const POOLS_ABI = parseAbi([
  "function addScreenedPool((uint8 venue, address token0, address token1, uint24 fee, int24 tickSpacing, address pool) s) returns (bytes32)",
  "function poolIdOf((uint8 venue, address token0, address token1, uint24 fee, int24 tickSpacing, address pool) s) view returns (bytes32)",
  "function pool(bytes32 poolId) view returns ((uint8 lane, uint8 status, uint8 venue, address token0, address token1, uint24 fee, int24 tickSpacing, address pool, bytes32 codeHash))",
]);

/** The screened lane's cap per token: the class A per-position hard maximum (FINAL_PLAN 0.2). */
export const SCREENED_POSITION_BPS = 1_500;
const VENUE: Readonly<Record<PoolRow["dex"], number>> = {
  uniswap_v3: 1,
  pancakeswap_v3: 2,
  uniswap_v4: 3,
};

/** Anvil's mnemonic, index 3: the local fork's screener (scripts/lib/fund.js FUND_ROLES). */
export const LOCAL_SCREENER_INDEX = 3;
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

export function localScreenerKey(): Hex {
  const key = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: LOCAL_SCREENER_INDEX }).getHdKey()
    .privateKey;
  if (!key) throw new Error("the local screener key could not be derived");
  return `0x${Buffer.from(key).toString("hex")}` as Hex;
}

/** A registrar transaction as mined: its hash and the gas it used (null when the chain did not say). */
export interface SentTx {
  readonly hash: Hex;
  readonly gasUsed: bigint | null;
}

/** The most gas one registrar transaction may use (addScreenedPool reads the pool's state). */
export const MAX_REGISTRAR_GAS = 1_000_000n;
/** The most the registrar pays per gas, 100 gwei: far above Monad's base fee, a bound not a target. */
export const MAX_REGISTRAR_FEE_PER_GAS = 100_000_000_000n;
/** A sweep registers at most this many tokens and tightens at most this many (F-T2, A-85). */
export const REGISTRATIONS_PER_SWEEP = 3;
/** The least liquidity a token needs for the sweep to register it (the screen loop's own floor). */
export const SWEEP_MIN_LIQUIDITY_USD = 50_000;

/** The screener key's chain calls: the registrations and the one tightening. */
export interface ScreenerChain {
  readonly address: Hex;
  addScreened(
    token: Hex,
    maxPositionBps: number,
    screenHash: Hex,
    screenedAt: bigint,
  ): Promise<SentTx>;
  recordScreen(token: Hex, screenHash: Hex, screenedAt: bigint): Promise<SentTx>;
  setSellOnly(token: Hex): Promise<SentTx>;
  addScreenedPool(seed: PoolSeed): Promise<SentTx>;
  poolRegistered(seed: PoolSeed): Promise<boolean>;
  tokenRecord(token: Hex): Promise<{ lane: number; status: number }>;
  /** The chain's clock (its latest block's timestamp): the screen is stamped by it, since the registry's TTL is. */
  now(): Promise<bigint>;
}

export interface PoolSeed {
  readonly venue: number;
  readonly token0: Hex;
  readonly token1: Hex;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly pool: Hex;
}

export function viemScreenerChain(o: {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly privateKey: Hex;
  readonly tokenRegistry: Hex;
  readonly protocolRegistry: Hex;
}): ScreenerChain {
  const transport = http(o.rpcUrl);
  const account = privateKeyToAccount(o.privateKey);
  const chain = {
    id: o.chainId,
    name: MARKET_CHAIN.name,
    nativeCurrency: {
      name: MARKET_CHAIN.native.symbol,
      symbol: MARKET_CHAIN.native.symbol,
      decimals: 18,
    },
    rpcUrls: { default: { http: [] } },
  } as const;
  const wallet = createWalletClient({ account, chain, transport });
  const client = createPublicClient({ chain, transport });
  /** Sends within the gas bounds: the simulation's gas estimate under MAX_REGISTRAR_GAS, the fee under the cap. */
  const send = async (request: Parameters<typeof wallet.writeContract>[0]): Promise<SentTx> => {
    const estimated = (request as { gas?: bigint }).gas ?? null;
    if (estimated !== null && estimated > MAX_REGISTRAR_GAS)
      throw new Error(
        `the registrar's transaction would use ${estimated} gas, over ${MAX_REGISTRAR_GAS}`,
      );
    const fees = await client.estimateFeesPerGas().catch(() => null);
    const maxFeePerGas =
      fees?.maxFeePerGas !== undefined && fees.maxFeePerGas < MAX_REGISTRAR_FEE_PER_GAS
        ? fees.maxFeePerGas
        : MAX_REGISTRAR_FEE_PER_GAS;
    const maxPriorityFeePerGas =
      fees?.maxPriorityFeePerGas !== undefined && fees.maxPriorityFeePerGas < maxFeePerGas
        ? fees.maxPriorityFeePerGas
        : 0n;
    const hash = await wallet.writeContract({
      ...request,
      gas: estimated ?? MAX_REGISTRAR_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas,
    } as never);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success")
      throw new Error(`the registrar's transaction ${hash} reverted`);
    return { hash, gasUsed: receipt.gasUsed };
  };
  const seedTuple = (s: PoolSeed) =>
    ({
      venue: s.venue,
      token0: s.token0,
      token1: s.token1,
      fee: s.fee,
      tickSpacing: s.tickSpacing,
      pool: s.pool,
    }) as const;
  return {
    address: account.address,
    addScreened: async (token, cap, hash, at) => {
      const { request } = await client.simulateContract({
        address: o.tokenRegistry,
        abi: REGISTRY_ABI,
        functionName: "addScreened",
        args: [token, cap, hash, at],
        account,
      });
      return send(request);
    },
    recordScreen: async (token, hash, at) => {
      const { request } = await client.simulateContract({
        address: o.tokenRegistry,
        abi: REGISTRY_ABI,
        functionName: "recordScreen",
        args: [token, hash, at],
        account,
      });
      return send(request);
    },
    setSellOnly: async (token) => {
      const { request } = await client.simulateContract({
        address: o.tokenRegistry,
        abi: REGISTRY_ABI,
        functionName: "setSellOnly",
        args: [token],
        account,
      });
      return send(request);
    },
    addScreenedPool: async (seed) => {
      const { request } = await client.simulateContract({
        address: o.protocolRegistry,
        abi: POOLS_ABI,
        functionName: "addScreenedPool",
        args: [seedTuple(seed)],
        account,
      });
      return send(request);
    },
    now: async () => (await client.getBlock()).timestamp,
    poolRegistered: async (seed) => {
      const id = await client.readContract({
        address: o.protocolRegistry,
        abi: POOLS_ABI,
        functionName: "poolIdOf",
        args: [seedTuple(seed)],
      });
      const r = await client.readContract({
        address: o.protocolRegistry,
        abi: POOLS_ABI,
        functionName: "pool",
        args: [id],
      });
      return r.lane !== 0;
    },
    tokenRecord: async (token) => {
      const r = await client.readContract({
        address: o.tokenRegistry,
        abi: REGISTRY_ABI,
        functionName: "tokenRecord",
        args: [token],
      });
      return { lane: r.lane, status: r.status };
    },
  };
}

/** The hash the registry records for a screen: its id and verdict, so a record is its own receipt. */
export const screenHashOf = (s: Pick<ScreenRecord, "screenId" | "verdict" | "createdAt">): Hex =>
  keccak256(toBytes(`${s.screenId}:${s.verdict}:${s.createdAt}`));

export interface RegistrarAction {
  readonly token: Hex;
  readonly action: "ADD_SCREENED" | "RECORD_SCREEN" | "SELL_ONLY" | "ADD_POOL" | "NOTE";
  readonly detail: string;
  readonly txHash: Hex | null;
  /** The gas the transaction used, as mined; null for a note. */
  readonly gasUsed: bigint | null;
}

export interface RegistrarDeps {
  /** The token table's chain id: Monad mainnet's (the token registry's), not the fork's (L-216). */
  readonly chainId: number;
  readonly store: TokenStore;
  readonly chain: ScreenerChain;
  readonly reader: ChainReaderV3;
  readonly log: (line: string) => void;
}

export class Registrar {
  private readonly d: RegistrarDeps;
  constructor(d: RegistrarDeps) {
    this.d = d;
  }

  get address(): Hex {
    return this.d.chain.address;
  }

  /**
   * After a screen: a passing token not yet registered joins the screened
   * lane with its routable pools; a registered one has the screen recorded;
   * a refused screen moves a buyable token to sell-only. Core tokens are the
   * admin's: a refused core screen is logged and left to the guardian.
   */
  async afterScreen(
    token: Hex,
    screen: ScreenRecord,
    pools: readonly PoolRow[],
  ): Promise<RegistrarAction[]> {
    const out: RegistrarAction[] = [];
    const record = await this.d.chain.tokenRecord(token);
    // The screen just ran: it is stamped by the chain's clock, which a local fork may hold days
    // ahead of the wall clock (the registry's SCREEN_TTL counts from block.timestamp, D-339).
    const screenedAt = await this.d.chain.now();
    const hash = screenHashOf(screen);
    if (screen.verdict === "passed") {
      if (record.lane === 0) {
        const market = await this.d.reader.market();
        const listed = new Set(market.tokens.map((t) => t.token.toLowerCase()));
        listed.add(zeroAddress);
        const seeds = pools
          .filter((p) => p.routable)
          .map((p) => poolSeedOf(p))
          .filter((s) => s !== null)
          .filter((s) => {
            const other = isAddressEqual(s.token0, token) ? s.token1 : s.token0;
            return listed.has(other.toLowerCase()) && !isAddressEqual(other, token);
          });
        if (seeds.length === 0) {
          out.push({
            token,
            action: "NOTE",
            detail: "no routable pool against a listed token; not registered",
            txHash: null,
            gasUsed: null,
          });
          this.d.log(
            `registrar: ${token} passed its screen but has no routable pool against a listed token`,
          );
          return out;
        }
        const tx = await this.d.chain.addScreened(token, SCREENED_POSITION_BPS, hash, screenedAt);
        // The table learns the lane now, from what was just written: a market read may be cached.
        await this.d.store.setRegistry(this.d.chainId, token, "screened", "listed");
        this.noteGas("addScreened", tx.gasUsed);
        out.push({
          token,
          action: "ADD_SCREENED",
          detail: `screened lane, cap ${SCREENED_POSITION_BPS} bps`,
          txHash: tx.hash,
          gasUsed: tx.gasUsed,
        });
        this.d.log(
          `registrar: ${token} registered in the screened lane (${tx.hash}, ${tx.gasUsed ?? "?"} gas)`,
        );
        for (const seed of seeds) {
          if (await this.d.chain.poolRegistered(seed)) continue;
          try {
            const ptx = await this.d.chain.addScreenedPool(seed);
            this.noteGas("addScreenedPool", ptx.gasUsed);
            out.push({
              token,
              action: "ADD_POOL",
              detail: `${seed.venue === 3 ? "uniswap_v4" : seed.venue === 2 ? "pancakeswap_v3" : "uniswap_v3"} ${seed.token0}/${seed.token1} fee ${seed.fee}`,
              txHash: ptx.hash,
              gasUsed: ptx.gasUsed,
            });
          } catch (err) {
            out.push({
              token,
              action: "NOTE",
              detail: `pool not registered: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
              txHash: null,
              gasUsed: null,
            });
          }
        }
      } else {
        const tx = await this.d.chain.recordScreen(token, hash, screenedAt);
        this.noteGas("recordScreen", tx.gasUsed);
        out.push({
          token,
          action: "RECORD_SCREEN",
          detail: "a passing screen recorded",
          txHash: tx.hash,
          gasUsed: tx.gasUsed,
        });
      }
    } else if (record.lane === 2 && record.status === 1) {
      const tx = await this.d.chain.setSellOnly(token);
      await this.d.store.setRegistry(this.d.chainId, token, "screened", "sell_only");
      this.noteGas("setSellOnly", tx.gasUsed);
      out.push({
        token,
        action: "SELL_ONLY",
        detail: `the re-screen was refused`,
        txHash: tx.hash,
        gasUsed: tx.gasUsed,
      });
      this.d.log(
        `registrar: ${token} moved to sell-only after a refused screen (${tx.hash}, ${tx.gasUsed ?? "?"} gas)`,
      );
    } else if (record.lane === 1 && record.status === 1) {
      out.push({
        token,
        action: "NOTE",
        detail: "a core token's screen was refused; the guardian decides",
        txHash: null,
        gasUsed: null,
      });
      this.d.log(`registrar: core token ${token} failed its screen; left to the guardian`);
    }
    await this.sync();
    return out;
  }

  /** The gas each kind of registrar transaction used, as mined (F-T2, A-85). */
  readonly gas: Record<
    "addScreened" | "addScreenedPool" | "recordScreen" | "setSellOnly",
    bigint[]
  > = { addScreened: [], addScreenedPool: [], recordScreen: [], setSellOnly: [] };

  private noteGas(kind: keyof Registrar["gas"], used: bigint | null): void {
    if (used !== null) this.gas[kind].push(used);
  }

  /**
   * F-T2: the background pass. Every token with a fresh passing screen and no
   * lane joins the screened lane (at most `limit` per pass, deepest first,
   * each within the gas bounds), and every listed screened token whose latest
   * screen was refused goes sell-only, without waiting for a sweep to screen
   * it. A failure on one token never stops the others.
   */
  async sweep(limit = REGISTRATIONS_PER_SWEEP): Promise<RegistrarAction[]> {
    const out: RegistrarAction[] = [];
    const one = async (address: string, pools: boolean) => {
      const token = address as Hex;
      const [screen] = await this.d.store.screens(this.d.chainId, address, 1);
      if (!screen) return;
      try {
        out.push(
          ...(await this.afterScreen(
            token,
            screen,
            pools ? await this.d.store.poolsOf(this.d.chainId, address) : [],
          )),
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message.slice(0, 160) : String(err);
        out.push({
          token,
          action: "NOTE",
          detail: `sweep: ${detail}`,
          txHash: null,
          gasUsed: null,
        });
        this.d.log(`registrar: sweep: ${address}: ${detail}`);
      }
    };
    for (const a of await this.d.store.passingUnregistered(
      this.d.chainId,
      SWEEP_MIN_LIQUIDITY_USD,
      limit,
    ))
      await one(a, true);
    for (const a of await this.d.store.refusedListed(this.d.chainId, limit)) await one(a, false);
    return out;
  }

  /** Mirrors the chain's lane and status of every registered token into the platform's token table. */
  async sync(): Promise<number> {
    const market = await this.d.reader.market();
    let n = 0;
    for (const t of market.tokens) {
      const lane = t.lane === "CORE" ? "core" : t.lane === "SCREENED" ? "screened" : null;
      const status =
        t.status === "BUYABLE"
          ? "listed"
          : t.status === "SELL_ONLY"
            ? "sell_only"
            : t.status === "FROZEN"
              ? "delisted"
              : null;
      await this.d.store.setRegistry(this.d.chainId, t.token, lane, status);
      n += 1;
    }
    return n;
  }
}

/** A platform pool row as the registry's seed; null for a pool the registry cannot take. */
export function poolSeedOf(p: PoolRow): PoolSeed | null {
  const venue = VENUE[p.dex];
  if (!venue || p.fee === null || p.tickSpacing === null) return null;
  if (p.dex === "uniswap_v4" && p.hooks && p.hooks !== zeroAddress) return null;
  const [a, b] = [p.token0.toLowerCase(), p.token1.toLowerCase()].sort() as [string, string];
  return {
    venue,
    token0: a as Hex,
    token1: b as Hex,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    pool: p.dex === "uniswap_v4" ? zeroAddress : (p.poolId as Hex),
  };
}
