import type { EnvironmentId } from "@alpha-agents/config";
import {
  ACCOUNT_MODES,
  type AccountMode,
  type AddressBookId,
  type CustodyPath,
  type ExecutorPolicyV3,
  ROUTE_ADAPTER_ID,
  addressEntry,
} from "@alpha-agents/domain";
import {
  LANES,
  POOL_STATUSES,
  PRICE_REASONS,
  type PriceReason,
  TOKEN_STATUSES,
  executorV3,
} from "@alpha-agents/policy";
import {
  type Hex,
  type PublicClient,
  createPublicClient,
  getAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from "viem";
import type { Grant } from "./reader.ts";
import { candidateRoutes } from "./routes.ts";
import { rpcTransport } from "./transport.ts";

/**
 * What the chain tools read for the fund agent's v3 set (F-U5): the
 * TokenRegistry's tokens, the ProtocolRegistryV3's pools, each class F
 * token's price from OracleAdapterV3, the account's held list with its cost
 * basis, Executor v3's policy, grants and trade ring, and quotes along
 * routes of up to three registered pools through each venue's own quoter.
 * Environment-neutral like the v2 reader: every address comes from the
 * environment's address book. Reads only, at the latest block.
 */

export const CONTRACT_IDS_V3 = [
  "agent_nft",
  "account_factory",
  "account_factory_v3",
  "executor_v3",
  "oracle_adapter_v3",
  "protocol_registry_v3",
  "token_registry_v3",
  "executor_route_adapter_v3",
  "usdc",
  "wmon",
  "uniswap_v3_quoter_v2",
  "pancakeswap_v3_quoter_v2",
  "uniswap_v4_quoter",
] as const satisfies readonly AddressBookId[];
export type ContractIdV3 = (typeof CONTRACT_IDS_V3)[number];
export type ContractsV3 = Readonly<Record<ContractIdV3, Hex>>;

/** The environment's v3 contracts, or the IDs the address book has not verified there. */
export function contractsForV3(
  environment: EnvironmentId,
):
  | { readonly ok: true; readonly contracts: ContractsV3 }
  | { readonly ok: false; readonly missing: ContractIdV3[] } {
  const missing: ContractIdV3[] = [];
  const out: Partial<Record<ContractIdV3, Hex>> = {};
  for (const id of CONTRACT_IDS_V3) {
    const e = addressEntry(environment, id);
    if (e.status !== "verified" || !e.address) missing.push(id);
    else out[id] = e.address as Hex;
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, contracts: out as ContractsV3 };
}

export type VenueV3 = "UNISWAP_V3" | "PANCAKESWAP_V3" | "UNISWAP_V4";
export type PoolStatusV3 = (typeof POOL_STATUSES)[number];
const VENUES = ["NONE", "UNISWAP_V3", "PANCAKESWAP_V3", "UNISWAP_V4"] as const;

/** A registered token, as the TokenRegistry records it, with its symbol. */
export interface TokenInfoV3 {
  readonly token: Hex;
  readonly symbol: string;
  readonly decimals: number;
  readonly lane: executorV3.LaneV3;
  readonly status: executorV3.TokenStatusV3;
  readonly priceClass: executorV3.PriceClassV3;
  readonly maxPositionBps: number;
}

/** A class F token's oracle reading now; a class A token reads ATTESTATION_REQUIRED with no price. */
export interface PriceV3 {
  readonly priceE18: bigint;
  readonly updatedAt: bigint;
  readonly reason: PriceReason;
}

/** A registered pool, with the oracle's view of its spot against the token it prices. */
export interface PoolInfoV3 {
  readonly poolId: Hex;
  readonly venue: VenueV3;
  /** The pair as the account holds it: a native MON side reads as WMON (the adapter wraps). */
  readonly tokenA: Hex;
  readonly tokenB: Hex;
  /** The v4 key's currency0, zero for native MON; the v3 pool's token0 otherwise. */
  readonly currency0: Hex;
  readonly currency1: Hex;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly pool: Hex;
  readonly lane: executorV3.LaneV3;
  readonly status: PoolStatusV3;
  /** False when the pool's or its venue's code changed: the registry refuses it. */
  readonly codeIntact: boolean;
  /** The token the pool prices (its non-base side, else WMON) against the oracle. */
  readonly pricedToken: Hex;
  readonly deviationBps: bigint;
  readonly priceReason: PriceReason;
}

export interface MarketStateV3 {
  readonly chainId: number;
  readonly block: bigint;
  readonly timestamp: bigint;
  readonly policy: ExecutorPolicyV3;
  readonly policyHash: Hex;
  /** Executor v3's global pause. */
  readonly paused: boolean;
  /** The Executor's RouteAdapter is registered, active and unchanged. */
  readonly adapterAllowed: boolean;
  /** The registry names a class A price attestor (F-U12); none yet. */
  readonly attestorSet: boolean;
  readonly usdc: Hex;
  readonly wmon: Hex;
  readonly tokens: readonly TokenInfoV3[];
  /** Keyed by the token's lowercase address. */
  readonly prices: Readonly<Record<string, PriceV3>>;
  readonly pools: readonly PoolInfoV3[];
}

/** One held token as the account's `holdings()` view reports it. */
export interface HoldingReadV3 {
  readonly token: Hex;
  readonly decimals: number;
  readonly balance: bigint;
  readonly free: bigint;
  readonly costBasis: bigint;
  readonly lastPriceE18: bigint;
  readonly lastPricedAt: bigint;
}

export interface AgentStateV3 {
  readonly block: bigint;
  readonly timestamp: bigint;
  readonly owner: Hex;
  readonly ownerEpoch: bigint;
  /** Executor v3's configuration epoch for the agent. */
  readonly configEpoch: bigint;
  /** The PersonalAccountV3 of the agent and its current owner, or null before one is opened. */
  readonly account: Hex | null;
  /** The v2 PersonalAccount, if the agent has one, so the path can be told (D-367). */
  readonly v2Account: Hex | null;
  readonly mode: AccountMode;
  readonly screenedOptIn: boolean;
  readonly holdings: readonly HoldingReadV3[];
  /** `navUsdc` and `capValues`, or null while a held class F feed is unusable (the views revert). */
  readonly values: executorV3.AccountValuesV3 | null;
  readonly breaker: {
    readonly nav: bigint;
    readonly perUnit: bigint;
    readonly peak: bigint;
    readonly drawdownBps: bigint;
  } | null;
  readonly grant: Grant | null;
  readonly trades: readonly { readonly at: bigint; readonly valueUsdcE6: bigint }[];
  readonly tradesLeft: number;
  readonly nextSlotFreesAt: bigint;
  readonly turnoverUsed: bigint;
}

/** One hop's quote along a route. */
export interface HopQuoteV3 {
  readonly poolId: Hex;
  readonly tokenIn: Hex;
  readonly tokenOut: Hex;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export interface RouteQuoteV3 {
  readonly block: bigint;
  readonly route: readonly PoolInfoV3[];
  readonly hops: readonly HopQuoteV3[];
  readonly amountOut: bigint;
  /** How many candidate routes were quoted; the best is this one. */
  readonly candidates: number;
}

export interface ChainReaderV3 {
  readonly chainId: number;
  /** Executor v3's address: the grant's target on this set. */
  readonly executorAddress: Hex;
  market(): Promise<MarketStateV3>;
  /** The agent's state; null when the agent does not exist on chain. */
  agent(agentId: number): Promise<AgentStateV3 | null>;
  /**
   * Which custody set serves the agent (D-367): v3 once its owner opened a
   * PersonalAccountV3; v2 while it has only a v2 account; v3 for an agent
   * with no account at all. Null when the agent does not exist.
   */
  custodyPath(agentId: number): Promise<CustodyPath | null>;
  /**
   * The best route of up to three registered pools from `tokenIn` to
   * `tokenOut` for `amountIn`, by the venues' own quotes, among the routes
   * the registry would let this account use; null when none connects them.
   */
  bestRoute(
    tokenIn: Hex,
    tokenOut: Hex,
    amountIn: bigint,
    o: { readonly optedIn: boolean; readonly intoUsdc: boolean; readonly sellsScreened: boolean },
  ): Promise<RouteQuoteV3 | null>;
  /** The quote along one given route (the one an intent stored), or null when a hop cannot be quoted. */
  quoteRoute(route: readonly Hex[], tokenIn: Hex, amountIn: bigint): Promise<RouteQuoteV3 | null>;
}

const NFT_ABI = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function ownerEpoch(uint256 agentId) view returns (uint64)",
]);
const FACTORY_ABI = parseAbi([
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
]);
const POLICY_TUPLE =
  "(uint16 maxTradeBps, uint16 maxAssetBps, uint16 minUsdcBps, uint16 maxSlippageBps, uint16 maxSlippageClassABps, uint16 maxClassAPositionBps, uint16 maxClassATotalBps, uint16 maxTurnoverBps, uint8 maxTradesPerWindow, uint32 windowSeconds, uint32 deadlineSeconds)";
const EXECUTOR_ABI = parseAbi([
  `function policy() view returns (${POLICY_TUPLE})`,
  "function policyHash() view returns (bytes32)",
  "function paused() view returns (bool)",
  "function configEpochOf(uint256 agentId) view returns (uint64)",
  "function sessionOf(uint256 agentId) view returns ((address key, uint64 ownerEpoch, uint64 configEpoch, uint64 validUntil))",
  "function pastTrades(address account) view returns ((uint64 tradedAt, uint192 valueUsdc)[20])",
  `function limits(address account) view returns (${POLICY_TUPLE} p, uint256 tradesLeft, uint256 nextSlotFreesAt, uint256 turnoverUsed)`,
]);
const TOKENS_ABI = parseAbi([
  "function tokenCount() view returns (uint256)",
  "function tokens(uint256) view returns (address)",
  "function tokenRecord(address token) view returns ((uint8 lane, uint8 status, uint8 priceClass, uint8 decimals, uint16 maxPositionBps, uint64 screenedAt, bytes32 screenHash))",
  "function verifier() view returns (address)",
]);
const POOLS_ABI = parseAbi([
  "function poolCount() view returns (uint256)",
  "function poolIds(uint256) view returns (bytes32)",
  "function pool(bytes32 poolId) view returns ((uint8 lane, uint8 status, uint8 venue, address token0, address token1, uint24 fee, int24 tickSpacing, address pool, bytes32 codeHash))",
  "function usablePool(bytes32 poolId, bool allowScreened, bool toUsdc) view returns ((uint8 lane, uint8 status, uint8 venue, address token0, address token1, uint24 fee, int24 tickSpacing, address pool, bytes32 codeHash))",
  "function adapterFor(bytes32 adapterId) view returns (address)",
]);
const ORACLE_ABI = parseAbi([
  "function price(address token) view returns (uint256 priceE18, uint256 updatedAt, uint8 reason)",
  "function poolDeviationBps(address token, bytes32 poolId) view returns (uint256 bps, uint8 reason)",
]);
const ACCOUNT_ABI = parseAbi([
  "function mode() view returns (uint8)",
  "function screenedOptIn() view returns (bool)",
  "function holdings() view returns ((address token, uint8 decimals, uint256 balance, uint256 free, uint256 costBasis, uint256 lastPriceE18, uint64 lastPricedAt)[])",
  "function navUsdc() view returns (uint256)",
  "function capValues() view returns (uint256 capped, uint256 totalBasis, uint256 classABasis)",
  "function breakerState() view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps)",
]);
const ERC20_ABI = parseAbi(["function symbol() view returns (string)"]);
/** Uniswap v3's and PancakeSwap v3's QuoterV2 (the same ABI): not a view, so called with eth_call. */
const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const QUOTER_V4_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

const reasonOf = (i: number): PriceReason => PRICE_REASONS[i] ?? "FEED_REVERTED";
const laneOf = (i: number): executorV3.LaneV3 => LANES[i] ?? "NONE";
const statusOf = (i: number): executorV3.TokenStatusV3 => TOKEN_STATUSES[i] ?? "NONE";
const poolStatusOf = (i: number): PoolStatusV3 => POOL_STATUSES[i] ?? "NONE";
const classOf = (i: number): executorV3.PriceClassV3 => (["NONE", "F", "A"] as const)[i] ?? "NONE";
const venueOf = (i: number): VenueV3 | "NONE" => VENUES[i] ?? "NONE";
const lower = (a: Hex) => a.toLowerCase();

/** A small time-limited cache, so repeated reads within seconds share one RPC answer. */
class TtlCache {
  private readonly entries = new Map<string, { until: number; value: Promise<unknown> }>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs: number, now: () => number) {
    this.ttlMs = ttlMs;
    this.now = now;
  }
  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.until > this.now()) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { until: this.now() + this.ttlMs, value });
    value.catch(() => this.entries.delete(key));
    if (this.entries.size > 500)
      for (const k of [...this.entries.keys()].slice(0, 250)) this.entries.delete(k);
    return value;
  }
}

export interface ViemChainReaderV3Options {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly fallbackRpcUrl?: string | null;
  readonly contracts: ContractsV3;
  /** How long market data and quotes are reused (3 s by default, A-44). */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

export class ViemChainReaderV3 implements ChainReaderV3 {
  readonly chainId: number;
  readonly executorAddress: Hex;
  private readonly c: ContractsV3;
  private readonly client: PublicClient;
  private readonly cache: TtlCache;
  /** Symbols never change: read once per token per process. */
  private readonly symbols = new Map<string, Promise<string>>();

  constructor(o: ViemChainReaderV3Options) {
    this.chainId = o.chainId;
    this.c = o.contracts;
    this.executorAddress = o.contracts.executor_v3;
    this.client = createPublicClient({ transport: rpcTransport(o.rpcUrl, o.fallbackRpcUrl) });
    this.cache = new TtlCache(o.cacheMs ?? 3_000, o.now ?? Date.now);
  }

  market(): Promise<MarketStateV3> {
    return this.cache.get("market", () => this.readMarket());
  }

  private symbolOf(token: Hex): Promise<string> {
    const k = lower(token);
    let p = this.symbols.get(k);
    if (!p) {
      p = this.client
        .readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" })
        .then((s) => s.slice(0, 32))
        .catch(() => `${token.slice(0, 6)}…${token.slice(-4)}`);
      this.symbols.set(k, p);
      p.catch(() => this.symbols.delete(k));
    }
    return p;
  }

  private async readTokens(): Promise<TokenInfoV3[]> {
    const r = this.c.token_registry_v3;
    const n = await this.client.readContract({
      address: r,
      abi: TOKENS_ABI,
      functionName: "tokenCount",
    });
    const addresses = await Promise.all(
      Array.from({ length: Number(n) }, (_, i) =>
        this.client.readContract({
          address: r,
          abi: TOKENS_ABI,
          functionName: "tokens",
          args: [BigInt(i)],
        }),
      ),
    );
    return Promise.all(
      addresses.map(async (token) => {
        const [rec, symbol] = await Promise.all([
          this.client.readContract({
            address: r,
            abi: TOKENS_ABI,
            functionName: "tokenRecord",
            args: [token],
          }),
          this.symbolOf(token),
        ]);
        return {
          token: getAddress(token),
          symbol,
          decimals: rec.decimals,
          lane: laneOf(rec.lane),
          status: statusOf(rec.status),
          priceClass: classOf(rec.priceClass),
          maxPositionBps: rec.maxPositionBps,
        };
      }),
    );
  }

  private async readPools(): Promise<PoolInfoV3[]> {
    const r = this.c.protocol_registry_v3;
    const o = this.c.oracle_adapter_v3;
    const n = await this.client.readContract({
      address: r,
      abi: POOLS_ABI,
      functionName: "poolCount",
    });
    const ids = await Promise.all(
      Array.from({ length: Number(n) }, (_, i) =>
        this.client.readContract({
          address: r,
          abi: POOLS_ABI,
          functionName: "poolIds",
          args: [BigInt(i)],
        }),
      ),
    );
    const base = (t: Hex) => isAddressEqual(t, this.c.usdc) || isAddressEqual(t, this.c.wmon);
    return Promise.all(
      ids.map(async (poolId) => {
        const rec = await this.client.readContract({
          address: r,
          abi: POOLS_ABI,
          functionName: "pool",
          args: [poolId],
        });
        // The registry's own verdict on the pool's code and venue (status and lane aside).
        const intact = await this.client
          .readContract({
            address: r,
            abi: POOLS_ABI,
            functionName: "usablePool",
            args: [poolId, true, true],
          })
          .then(() => true)
          .catch(() => false);
        const held = (t: Hex): Hex => (t === zeroAddress ? this.c.wmon : getAddress(t));
        const tokenA = held(rec.token0);
        const tokenB = held(rec.token1);
        const pricedToken = base(tokenA) ? (base(tokenB) ? this.c.wmon : tokenB) : tokenA;
        const dev = await this.client
          .readContract({
            address: o,
            abi: ORACLE_ABI,
            functionName: "poolDeviationBps",
            args: [pricedToken, poolId],
          })
          .catch(() => [0n, PRICE_REASONS.indexOf("FEED_REVERTED")] as const);
        return {
          poolId,
          venue: (venueOf(rec.venue) === "NONE" ? "UNISWAP_V3" : venueOf(rec.venue)) as VenueV3,
          tokenA,
          tokenB,
          currency0: rec.token0,
          currency1: rec.token1,
          fee: rec.fee,
          tickSpacing: rec.tickSpacing,
          pool: rec.pool,
          lane: laneOf(rec.lane),
          status: poolStatusOf(rec.status),
          codeIntact: intact,
          pricedToken,
          deviationBps: dev[0],
          priceReason: reasonOf(Number(dev[1])),
        };
      }),
    );
  }

  private async readMarket(): Promise<MarketStateV3> {
    const e = this.c.executor_v3;
    const [block, policy, policyHash, paused, adapter, verifier, tokens, pools] = await Promise.all(
      [
        this.client.getBlock(),
        this.client.readContract({ address: e, abi: EXECUTOR_ABI, functionName: "policy" }),
        this.client.readContract({ address: e, abi: EXECUTOR_ABI, functionName: "policyHash" }),
        this.client.readContract({ address: e, abi: EXECUTOR_ABI, functionName: "paused" }),
        this.client.readContract({
          address: this.c.protocol_registry_v3,
          abi: POOLS_ABI,
          functionName: "adapterFor",
          args: [ROUTE_ADAPTER_ID],
        }),
        this.client.readContract({
          address: this.c.token_registry_v3,
          abi: TOKENS_ABI,
          functionName: "verifier",
        }),
        this.readTokens(),
        this.readPools(),
      ],
    );
    const o = this.c.oracle_adapter_v3;
    const prices: Record<string, PriceV3> = {};
    await Promise.all(
      tokens.map(async (t) => {
        const p = await this.client
          .readContract({ address: o, abi: ORACLE_ABI, functionName: "price", args: [t.token] })
          .catch(() => [0n, 0n, PRICE_REASONS.indexOf("FEED_REVERTED")] as const);
        prices[lower(t.token)] = {
          priceE18: p[0],
          updatedAt: p[1],
          reason: reasonOf(Number(p[2])),
        };
      }),
    );
    return {
      chainId: this.chainId,
      block: block.number,
      timestamp: block.timestamp,
      policy: { ...policy },
      policyHash,
      paused,
      adapterAllowed: isAddressEqual(adapter, this.c.executor_route_adapter_v3),
      attestorSet: verifier !== zeroAddress,
      usdc: this.c.usdc,
      wmon: this.c.wmon,
      tokens,
      prices,
      pools,
    };
  }

  private async ownerOf(agentId: bigint): Promise<Hex | null> {
    try {
      return await this.client.readContract({
        address: this.c.agent_nft,
        abi: NFT_ABI,
        functionName: "ownerOf",
        args: [agentId],
      });
    } catch (err) {
      if (err instanceof Error && /revert/i.test(err.message)) return null;
      throw err;
    }
  }

  private accountOf(factory: Hex, agentId: bigint, owner: Hex): Promise<Hex> {
    return this.client.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "personalAccountOf",
      args: [agentId, owner],
    });
  }

  custodyPath(agentId: number): Promise<CustodyPath | null> {
    return this.cache.get(`path:${agentId}`, async () => {
      const id = BigInt(agentId);
      const owner = await this.ownerOf(id);
      if (!owner) return null;
      const [v3, v2] = await Promise.all([
        this.accountOf(this.c.account_factory_v3, id, owner),
        this.accountOf(this.c.account_factory, id, owner),
      ]);
      if (v3 !== zeroAddress) return "v3";
      return v2 !== zeroAddress ? "v2" : "v3";
    });
  }

  async agent(agentId: number): Promise<AgentStateV3 | null> {
    const id = BigInt(agentId);
    const owner = await this.ownerOf(id);
    if (!owner) return null;
    const e = this.c.executor_v3;
    const [block, ownerEpoch, configEpoch, account, v2Account, session] = await Promise.all([
      this.client.getBlock(),
      this.client.readContract({
        address: this.c.agent_nft,
        abi: NFT_ABI,
        functionName: "ownerEpoch",
        args: [id],
      }),
      this.client.readContract({
        address: e,
        abi: EXECUTOR_ABI,
        functionName: "configEpochOf",
        args: [id],
      }),
      this.accountOf(this.c.account_factory_v3, id, owner),
      this.accountOf(this.c.account_factory, id, owner),
      this.client.readContract({
        address: e,
        abi: EXECUTOR_ABI,
        functionName: "sessionOf",
        args: [id],
      }),
    ]);
    const grant: Grant | null =
      session.key === zeroAddress
        ? null
        : {
            key: session.key,
            ownerEpoch: session.ownerEpoch,
            configEpoch: session.configEpoch,
            validUntil: session.validUntil,
          };
    const base = {
      block: block.number,
      timestamp: block.timestamp,
      owner,
      ownerEpoch,
      configEpoch,
      v2Account: v2Account === zeroAddress ? null : v2Account,
      grant,
    };
    if (account === zeroAddress)
      return {
        ...base,
        account: null,
        mode: "NORMAL",
        screenedOptIn: false,
        holdings: [],
        values: null,
        breaker: null,
        trades: [],
        tradesLeft: 0,
        nextSlotFreesAt: 0n,
        turnoverUsed: 0n,
      };
    const revertsToNull = <T>(p: Promise<T>): Promise<T | null> =>
      p.catch((err: unknown) => {
        if (err instanceof Error && /revert/i.test(err.message)) return null;
        throw err;
      });
    const [mode, optedIn, holdings, nav, caps, breaker, past, limits] = await Promise.all([
      this.client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "mode" }),
      this.client.readContract({
        address: account,
        abi: ACCOUNT_ABI,
        functionName: "screenedOptIn",
      }),
      this.client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "holdings" }),
      revertsToNull(
        this.client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "navUsdc" }),
      ),
      revertsToNull(
        this.client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "capValues" }),
      ),
      revertsToNull(
        this.client.readContract({
          address: account,
          abi: ACCOUNT_ABI,
          functionName: "breakerState",
        }),
      ),
      this.client.readContract({
        address: e,
        abi: EXECUTOR_ABI,
        functionName: "pastTrades",
        args: [account],
      }),
      this.client.readContract({
        address: e,
        abi: EXECUTOR_ABI,
        functionName: "limits",
        args: [account],
      }),
    ]);
    return {
      ...base,
      account,
      mode: ACCOUNT_MODES[mode] ?? "PAUSED",
      screenedOptIn: optedIn,
      holdings: holdings.map((h) => ({
        token: getAddress(h.token),
        decimals: h.decimals,
        balance: h.balance,
        free: h.free,
        costBasis: h.costBasis,
        lastPriceE18: h.lastPriceE18,
        lastPricedAt: h.lastPricedAt,
      })),
      values:
        nav === null || caps === null
          ? null
          : { nav, capped: caps[0], totalBasis: caps[1], classABasis: caps[2] },
      breaker:
        breaker === null
          ? null
          : { nav: breaker[0], perUnit: breaker[1], peak: breaker[2], drawdownBps: breaker[3] },
      trades: past.map((t) => ({ at: t.tradedAt, valueUsdcE6: t.valueUsdc })),
      tradesLeft: Number(limits[1]),
      nextSlotFreesAt: limits[2],
      turnoverUsed: limits[3],
    };
  }

  /** One hop's output through the pool's own venue quoter. */
  private quoteHop(pool: PoolInfoV3, tokenIn: Hex, amountIn: bigint): Promise<bigint> {
    return this.cache.get(`hop:${pool.poolId}:${lower(tokenIn)}:${amountIn}`, async () => {
      const inIsA = isAddressEqual(tokenIn, pool.tokenA);
      const tokenOut = inIsA ? pool.tokenB : pool.tokenA;
      if (pool.venue === "UNISWAP_V4") {
        // Native MON is currency0 when the key names the zero address; WMON trades as MON there.
        const currencyIn = inIsA ? pool.currency0 : pool.currency1;
        const sim = await this.client.simulateContract({
          address: this.c.uniswap_v4_quoter,
          abi: QUOTER_V4_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              poolKey: {
                currency0: pool.currency0,
                currency1: pool.currency1,
                fee: pool.fee,
                tickSpacing: pool.tickSpacing,
                hooks: zeroAddress,
              },
              zeroForOne: isAddressEqual(currencyIn, pool.currency0),
              exactAmount: amountIn,
              hookData: "0x",
            },
          ],
        });
        return sim.result[0];
      }
      const quoter =
        pool.venue === "PANCAKESWAP_V3"
          ? this.c.pancakeswap_v3_quoter_v2
          : this.c.uniswap_v3_quoter_v2;
      const sim = await this.client.simulateContract({
        address: quoter,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n }],
      });
      return sim.result[0];
    });
  }

  private async quoteAlong(
    route: readonly PoolInfoV3[],
    tokenIn: Hex,
    amountIn: bigint,
    block: bigint,
    candidates: number,
  ): Promise<RouteQuoteV3 | null> {
    const hops: HopQuoteV3[] = [];
    let at = tokenIn;
    let amount = amountIn;
    for (const pool of route) {
      if (!isAddressEqual(at, pool.tokenA) && !isAddressEqual(at, pool.tokenB)) return null;
      const out = isAddressEqual(at, pool.tokenA) ? pool.tokenB : pool.tokenA;
      let got: bigint;
      try {
        got = await this.quoteHop(pool, at, amount);
      } catch {
        return null;
      }
      if (got === 0n) return null;
      hops.push({
        poolId: pool.poolId,
        tokenIn: at,
        tokenOut: out,
        amountIn: amount,
        amountOut: got,
      });
      at = out;
      amount = got;
    }
    return { block, route, hops, amountOut: amount, candidates };
  }

  async bestRoute(
    tokenIn: Hex,
    tokenOut: Hex,
    amountIn: bigint,
    o: { readonly optedIn: boolean; readonly intoUsdc: boolean; readonly sellsScreened: boolean },
  ): Promise<RouteQuoteV3 | null> {
    const m = await this.market();
    const routes = candidateRoutes(m, tokenIn, tokenOut, o);
    if (routes.length === 0) return null;
    const quoted = await Promise.all(
      routes.map((r) => this.quoteAlong(r, tokenIn, amountIn, m.block, routes.length)),
    );
    let best: RouteQuoteV3 | null = null;
    for (const q of quoted) {
      if (!q) continue;
      if (
        !best ||
        q.amountOut > best.amountOut ||
        (q.amountOut === best.amountOut && q.route.length < best.route.length)
      )
        best = q;
    }
    return best;
  }

  async quoteRoute(
    route: readonly Hex[],
    tokenIn: Hex,
    amountIn: bigint,
  ): Promise<RouteQuoteV3 | null> {
    const m = await this.market();
    const pools: PoolInfoV3[] = [];
    for (const id of route) {
      const p = m.pools.find((x) => x.poolId.toLowerCase() === id.toLowerCase());
      if (!p) return null;
      pools.push(p);
    }
    return this.quoteAlong(pools, tokenIn, amountIn, m.block, 1);
  }
}
