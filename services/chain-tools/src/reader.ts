import type { EnvironmentId } from "@alpha-agents/config";
import {
  ACCOUNT_MODES,
  type AccountMode,
  type AddressBookId,
  type AssetId,
  addressEntry,
} from "@alpha-agents/domain";
import { ORACLE_REASONS, type OracleReason } from "@alpha-agents/policy";
import {
  type Hex,
  type PublicClient,
  createPublicClient,
  http,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from "viem";

/**
 * What the chain tools read (P2-U5). Environment-neutral: every contract
 * address comes from the environment's address book (packages/domain), and
 * the venue's pool, fee and quote currency are read from the venue adapter on
 * chain, so the same code reads the local fork, testnet and mainnet. Nothing
 * here writes: reads only, at the latest block.
 *
 * Market data (prices, the venue, the policy) and quotes are cached for a few
 * seconds, so the calls of one run do not each go to the RPC; an agent's own
 * account is read fresh every time.
 */

export const CONTRACT_IDS = [
  "agent_nft",
  "account_factory",
  "executor",
  "oracle_adapter",
  "protocol_registry",
  "venue_uniswap_v4_mon_usdc",
  "uniswap_v4_quoter",
  "usdc",
  "wmon",
] as const satisfies readonly AddressBookId[];
export type ContractId = (typeof CONTRACT_IDS)[number];
export type Contracts = Readonly<Record<ContractId, Hex>>;

/** The environment's contracts, or the IDs the address book has not verified there. */
export function contractsFor(
  environment: EnvironmentId,
):
  | { readonly ok: true; readonly contracts: Contracts }
  | { readonly ok: false; readonly missing: ContractId[] } {
  const missing: ContractId[] = [];
  const out: Partial<Record<ContractId, Hex>> = {};
  for (const id of CONTRACT_IDS) {
    const e = addressEntry(environment, id);
    if (e.status !== "verified" || !e.address) missing.push(id);
    else out[id] = e.address as Hex;
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, contracts: out as Contracts };
}

export interface Policy {
  readonly maxTradeBps: number;
  readonly maxAssetBps: number;
  readonly minUsdcBps: number;
  readonly maxSlippageBps: number;
  readonly maxTurnoverBps: number;
  readonly maxTradesPerWindow: number;
  readonly windowSeconds: number;
  readonly deadlineSeconds: number;
}

export interface FeedRead {
  readonly priceE18: bigint;
  readonly updatedAt: bigint;
  readonly reason: OracleReason;
}

export interface MarketState {
  readonly chainId: number;
  readonly block: bigint;
  readonly timestamp: bigint;
  readonly policy: Policy;
  readonly policyHash: Hex;
  /** The Executor's global pause. */
  readonly paused: boolean;
  readonly wmonBuyable: boolean;
  readonly monUsd: FeedRead;
  readonly usdcUsd: FeedRead;
  readonly pool: { readonly priceE18: bigint; readonly reason: OracleReason };
  readonly deviationBps: bigint;
  /** The adapter's `tradable(WMON)`: what the Executor checks. */
  readonly tradableReason: OracleReason;
  readonly venue: {
    readonly adapterId: Hex;
    readonly adapter: Hex;
    readonly feeBps: number;
    readonly poolKey: {
      readonly currency0: Hex;
      readonly currency1: Hex;
      readonly fee: number;
      readonly tickSpacing: number;
      readonly hooks: Hex;
    };
  } | null;
}

export interface Grant {
  readonly key: Hex;
  readonly ownerEpoch: bigint;
  readonly configEpoch: bigint;
  readonly validUntil: bigint;
}

export interface AgentState {
  readonly block: bigint;
  readonly timestamp: bigint;
  readonly owner: Hex;
  readonly ownerEpoch: bigint;
  readonly configEpoch: bigint;
  /** The PersonalAccount of the agent and its current owner, or null before the first deposit. */
  readonly account: Hex | null;
  readonly usdc: bigint;
  readonly wmon: bigint;
  readonly mode: AccountMode;
  /**
   * The breaker's view now, or null while the price it needs is unusable
   * (`breakerState` reverts then, as the Executor's trade would).
   */
  readonly breaker: {
    readonly nav: bigint;
    readonly perUnit: bigint;
    readonly peak: bigint;
    readonly drawdownBps: bigint;
  } | null;
  /** The recorded 7-day peak value per unit; reads no oracle, so it is always there. */
  readonly peak7d: bigint;
  readonly grant: Grant | null;
  readonly trades: readonly { readonly at: bigint; readonly valueUsdcE6: bigint }[];
  readonly tradesLeft: number;
  readonly nextSlotFreesAt: bigint;
  readonly turnoverUsed: bigint;
  /** Whether the registry gives the venue adapter for a buy (USDC in) and for a sale (WMON in). */
  readonly venueAllowed: { readonly buy: boolean; readonly sell: boolean };
}

export interface Quote {
  readonly block: bigint;
  readonly amountOut: bigint;
}

export interface ChainReader {
  readonly chainId: number;
  market(): Promise<MarketState>;
  /** The agent's state; null when the agent does not exist on chain. */
  agent(agentId: number): Promise<AgentState | null>;
  /** The venue's expected output for selling `amountIn` of `sell`. */
  quote(sell: AssetId, amountIn: bigint): Promise<Quote>;
  tokenOf(asset: AssetId): Hex;
}

const ORACLE_ABI = parseAbi([
  "function price(address asset) view returns (uint256 priceE18, uint256 updatedAt, uint8 reason)",
  "function usdcPeg() view returns (uint256 usdcUsdE18, uint256 updatedAt, uint8 reason)",
  "function poolPrice(address asset) view returns (uint256 priceE18, uint8 reason)",
  "function poolDeviationBps(address asset) view returns (uint256 bps, uint8 reason)",
  "function tradable(address asset) view returns (bool ok, uint8 reason)",
]);
const EXECUTOR_ABI = parseAbi([
  "function policy() view returns ((uint16 maxTradeBps, uint16 maxAssetBps, uint16 minUsdcBps, uint16 maxSlippageBps, uint16 maxTurnoverBps, uint8 maxTradesPerWindow, uint32 windowSeconds, uint32 deadlineSeconds))",
  "function policyHash() view returns (bytes32)",
  "function paused() view returns (bool)",
  "function configEpochOf(uint256 agentId) view returns (uint64)",
  "function sessionOf(uint256 agentId) view returns ((address key, uint64 ownerEpoch, uint64 configEpoch, uint64 validUntil))",
  "function pastTrades(address account) view returns ((uint64 at, uint192 valueUsdc)[20])",
  "function limits(address account) view returns ((uint16 maxTradeBps, uint16 maxAssetBps, uint16 minUsdcBps, uint16 maxSlippageBps, uint16 maxTurnoverBps, uint8 maxTradesPerWindow, uint32 windowSeconds, uint32 deadlineSeconds) p, uint256 tradesLeft, uint256 nextSlotFreesAt, uint256 turnoverUsed)",
]);
const NFT_ABI = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function ownerEpoch(uint256 agentId) view returns (uint64)",
]);
const FACTORY_ABI = parseAbi([
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
  "function isBuyable(address token) view returns (bool)",
]);
const ACCOUNT_ABI = parseAbi([
  "function mode() view returns (uint8)",
  "function freeBalance(address token) view returns (uint256)",
  "function breakerState() view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps)",
  "function peakPerUnit7d() view returns (uint256)",
]);
const REGISTRY_ABI = parseAbi([
  "function adapterCount() view returns (uint256)",
  "function adapterIds(uint256) view returns (bytes32)",
  "function entry(bytes32 adapterId) view returns ((address adapter, uint8 status, bytes32 adapterCodeHash, bytes32 venueCodeHash))",
  "function adapterFor(bytes32 adapterId, address tokenIn, address tokenOut) view returns (address)",
]);
const ADAPTER_ABI = parseAbi([
  "function USDC() view returns (address)",
  "function FEE() view returns (uint24)",
  "function TICK_SPACING() view returns (int24)",
  "function feeBps() view returns (uint256)",
]);
/** Uniswap v4's Quoter: not a view, so it is called with eth_call (simulateContract). */
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

const reasonOf = (i: number): OracleReason => ORACLE_REASONS[i] ?? "FEED_REVERTED";

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
    // A failed read is not cached.
    value.catch(() => this.entries.delete(key));
    if (this.entries.size > 500)
      for (const k of [...this.entries.keys()].slice(0, 250)) this.entries.delete(k);
    return value;
  }
}

export interface ViemChainReaderOptions {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly contracts: Contracts;
  /** How long market data and quotes are reused (3 s by default, A-44). */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

export class ViemChainReader implements ChainReader {
  readonly chainId: number;
  private readonly c: Contracts;
  private readonly client: PublicClient;
  private readonly cache: TtlCache;

  constructor(o: ViemChainReaderOptions) {
    this.chainId = o.chainId;
    this.c = o.contracts;
    this.client = createPublicClient({ transport: http(o.rpcUrl) });
    this.cache = new TtlCache(o.cacheMs ?? 3_000, o.now ?? Date.now);
  }

  tokenOf(asset: AssetId): Hex {
    return asset === "USDC" ? this.c.usdc : this.c.wmon;
  }

  market(): Promise<MarketState> {
    return this.cache.get("market", () => this.readMarket());
  }

  private async venue(): Promise<MarketState["venue"]> {
    return this.cache.get("venue", async () => {
      const r = this.c.protocol_registry;
      const n = await this.client.readContract({
        address: r,
        abi: REGISTRY_ABI,
        functionName: "adapterCount",
      });
      for (let i = 0n; i < n; i++) {
        const id = await this.client.readContract({
          address: r,
          abi: REGISTRY_ABI,
          functionName: "adapterIds",
          args: [i],
        });
        const e = await this.client.readContract({
          address: r,
          abi: REGISTRY_ABI,
          functionName: "entry",
          args: [id],
        });
        if (!isAddressEqual(e.adapter, this.c.venue_uniswap_v4_mon_usdc)) continue;
        const a = this.c.venue_uniswap_v4_mon_usdc;
        const [usdc, fee, tickSpacing, feeBps] = await Promise.all([
          this.client.readContract({ address: a, abi: ADAPTER_ABI, functionName: "USDC" }),
          this.client.readContract({ address: a, abi: ADAPTER_ABI, functionName: "FEE" }),
          this.client.readContract({ address: a, abi: ADAPTER_ABI, functionName: "TICK_SPACING" }),
          this.client.readContract({ address: a, abi: ADAPTER_ABI, functionName: "feeBps" }),
        ]);
        return {
          adapterId: id,
          adapter: a,
          feeBps: Number(feeBps),
          // Native MON is currency0 (address zero sorts first in v4), USDC currency1.
          poolKey: {
            currency0: zeroAddress,
            currency1: usdc,
            fee,
            tickSpacing,
            hooks: zeroAddress,
          },
        };
      }
      return null;
    });
  }

  private async readMarket(): Promise<MarketState> {
    const o = this.c.oracle_adapter;
    const e = this.c.executor;
    const wmon = this.c.wmon;
    const [block, policy, policyHash, paused, buyable, mon, peg, pool, dev, trad, venue] =
      await Promise.all([
        this.client.getBlock(),
        this.client.readContract({ address: e, abi: EXECUTOR_ABI, functionName: "policy" }),
        this.client.readContract({ address: e, abi: EXECUTOR_ABI, functionName: "policyHash" }),
        this.client.readContract({ address: e, abi: EXECUTOR_ABI, functionName: "paused" }),
        this.client.readContract({
          address: this.c.account_factory,
          abi: FACTORY_ABI,
          functionName: "isBuyable",
          args: [wmon],
        }),
        this.client.readContract({
          address: o,
          abi: ORACLE_ABI,
          functionName: "price",
          args: [wmon],
        }),
        this.client.readContract({ address: o, abi: ORACLE_ABI, functionName: "usdcPeg" }),
        this.client.readContract({
          address: o,
          abi: ORACLE_ABI,
          functionName: "poolPrice",
          args: [wmon],
        }),
        this.client.readContract({
          address: o,
          abi: ORACLE_ABI,
          functionName: "poolDeviationBps",
          args: [wmon],
        }),
        this.client.readContract({
          address: o,
          abi: ORACLE_ABI,
          functionName: "tradable",
          args: [wmon],
        }),
        this.venue(),
      ]);
    return {
      chainId: this.chainId,
      block: block.number,
      timestamp: block.timestamp,
      policy: { ...policy },
      policyHash,
      paused,
      wmonBuyable: buyable,
      monUsd: { priceE18: mon[0], updatedAt: mon[1], reason: reasonOf(mon[2]) },
      usdcUsd: { priceE18: peg[0], updatedAt: peg[1], reason: reasonOf(peg[2]) },
      pool: { priceE18: pool[0], reason: reasonOf(pool[1]) },
      deviationBps: dev[0],
      tradableReason: trad[0] ? "OK" : reasonOf(trad[1]),
      venue,
    };
  }

  async agent(agentId: number): Promise<AgentState | null> {
    const id = BigInt(agentId);
    const nft = this.c.agent_nft;
    const e = this.c.executor;
    let owner: Hex;
    try {
      owner = await this.client.readContract({
        address: nft,
        abi: NFT_ABI,
        functionName: "ownerOf",
        args: [id],
      });
    } catch (err) {
      if (err instanceof Error && /revert/i.test(err.message)) return null;
      throw err;
    }
    const [block, ownerEpoch, configEpoch, account, session, venue] = await Promise.all([
      this.client.getBlock(),
      this.client.readContract({
        address: nft,
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
      this.client.readContract({
        address: this.c.account_factory,
        abi: FACTORY_ABI,
        functionName: "personalAccountOf",
        args: [id, owner],
      }),
      this.client.readContract({
        address: e,
        abi: EXECUTOR_ABI,
        functionName: "sessionOf",
        args: [id],
      }),
      this.venue(),
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
      grant,
    };
    if (account === zeroAddress)
      return {
        ...base,
        account: null,
        usdc: 0n,
        wmon: 0n,
        mode: "NORMAL",
        breaker: { nav: 0n, perUnit: 0n, peak: 0n, drawdownBps: 0n },
        peak7d: 0n,
        trades: [],
        tradesLeft: 0,
        nextSlotFreesAt: 0n,
        turnoverUsed: 0n,
        venueAllowed: { buy: false, sell: false },
      };
    const r = this.c.protocol_registry;
    const allowed = async (tokenIn: Hex, tokenOut: Hex) =>
      venue === null
        ? false
        : (await this.client.readContract({
            address: r,
            abi: REGISTRY_ABI,
            functionName: "adapterFor",
            args: [venue.adapterId, tokenIn, tokenOut],
          })) !== zeroAddress;
    const breakerOrNull = this.client
      .readContract({ address: account, abi: ACCOUNT_ABI, functionName: "breakerState" })
      .catch((err: unknown) => {
        if (err instanceof Error && /revert/i.test(err.message)) return null;
        throw err;
      });
    const [mode, usdc, wmon, breaker, peak7d, past, limits, buy, sell] = await Promise.all([
      this.client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "mode" }),
      this.client.readContract({
        address: account,
        abi: ACCOUNT_ABI,
        functionName: "freeBalance",
        args: [this.c.usdc],
      }),
      this.client.readContract({
        address: account,
        abi: ACCOUNT_ABI,
        functionName: "freeBalance",
        args: [this.c.wmon],
      }),
      breakerOrNull,
      this.client.readContract({
        address: account,
        abi: ACCOUNT_ABI,
        functionName: "peakPerUnit7d",
      }),
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
      allowed(this.c.usdc, this.c.wmon),
      allowed(this.c.wmon, this.c.usdc),
    ]);
    return {
      ...base,
      account,
      usdc,
      wmon,
      mode: ACCOUNT_MODES[mode] ?? "PAUSED",
      breaker:
        breaker === null
          ? null
          : { nav: breaker[0], perUnit: breaker[1], peak: breaker[2], drawdownBps: breaker[3] },
      peak7d,
      trades: past.map((t) => ({ at: t.at, valueUsdcE6: t.valueUsdc })),
      tradesLeft: Number(limits[1]),
      nextSlotFreesAt: limits[2],
      turnoverUsed: limits[3],
      venueAllowed: { buy, sell },
    };
  }

  quote(sell: AssetId, amountIn: bigint): Promise<Quote> {
    return this.cache.get(`quote:${sell}:${amountIn}`, async () => {
      const venue = await this.venue();
      if (!venue) throw new Error("no venue adapter is registered");
      const [block, sim] = await Promise.all([
        this.client.getBlockNumber(),
        this.client.simulateContract({
          address: this.c.uniswap_v4_quoter,
          abi: QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          // Selling WMON sells native MON (currency0) into USDC: zeroForOne.
          args: [
            {
              poolKey: venue.poolKey,
              zeroForOne: sell === "WMON",
              exactAmount: amountIn,
              hookData: "0x",
            },
          ],
        }),
      ]);
      return { block, amountOut: sim.result[0] };
    });
  }
}
