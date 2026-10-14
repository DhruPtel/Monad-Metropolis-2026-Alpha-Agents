import {
  type Hex,
  createPublicClient,
  formatUnits,
  http,
  isAddressEqual,
  parseAbi,
  parseAbiItem,
  zeroAddress,
} from "viem";

/**
 * 2026-10-13: an agent's deposits and withdrawals, read from the chain's own
 * event logs: its owner's trading account (PersonalAccountV3: Deposited,
 * Withdrawn) and its vault (StrategyVaultV3: Deposited, Redeemed,
 * RedeemedInKind). The indexer does not record these accounts yet, so each
 * contract's logs are scanned from the block its code appeared, in chunks the
 * provider accepts, and kept in memory; a later read scans only the new blocks.
 * Read only: nothing is sent.
 */

export interface MoneyEventJson {
  readonly kind: "deposit" | "withdrawal";
  readonly account: "trading" | "vault";
  /** Who deposited or redeemed (the vault's depositor; the trading account's owner side is implied). */
  readonly who: Hex | null;
  readonly symbol: string;
  /** The amount in the token's units as a decimal string; for an in-kind redemption, the shares. */
  readonly amount: string;
  /** The USDC value when the event states one (deposits, USDC moves, USDC redemptions). */
  readonly valueUsdcE6: string | null;
  /** A vault redemption paid in the vault's tokens rather than USDC. */
  readonly inKind: boolean;
  /** A vault deposit that is the leader's stake. */
  readonly leaderStake: boolean;
  readonly txHash: Hex;
  readonly block: string;
  readonly at: string;
}

export interface MoneyEventsDeps {
  readonly list: (agentId: number) => Promise<readonly MoneyEventJson[]>;
}

const NFT_ABI = parseAbi(["function ownerOf(uint256 agentId) view returns (address)"]);
const FACTORY_ABI = parseAbi([
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
  "function vaultOf(uint256 agentId) view returns (address)",
]);
const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const PERSONAL_EVENTS = [
  parseAbiItem(
    "event Deposited(address indexed token, uint256 amount, uint256 valueUsdc, uint256 principalAfter)",
  ),
  parseAbiItem("event Withdrawn(address indexed token, uint256 amount, address indexed to)"),
] as const;
const VAULT_EVENTS = [
  parseAbiItem(
    "event Deposited(address indexed who, uint256 assets, uint256 shares, uint256 priceE18, bool leaderStake)",
  ),
  parseAbiItem(
    "event Redeemed(address indexed who, address indexed receiver, uint256 shares, uint256 assets, uint256 feeShares)",
  ),
  parseAbiItem(
    "event RedeemedInKind(address indexed who, address indexed receiver, uint256 shares, uint256 supplyBefore)",
  ),
] as const;

/** One decoded log, as the scanner keeps it. */
export interface ScannedLog {
  readonly eventName: string;
  readonly args: Record<string, unknown>;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

/** The parts of a viem public client the scanner uses, so tests can stand in for the chain. */
export interface MoneyEventsChain {
  getBlockNumber(): Promise<bigint>;
  getCode(a: { address: Hex; blockNumber: bigint }): Promise<Hex | undefined>;
  getLogs(a: {
    address: Hex;
    events: readonly unknown[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly ScannedLog[]>;
  getBlockTime(blockNumber: bigint): Promise<bigint>;
  read(a: {
    address: Hex;
    abi: unknown;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

export interface MoneyEventsOptions {
  readonly agentNft: Hex;
  readonly accountFactoryV3: Hex;
  readonly usdc: Hex;
  /** The most blocks one eth_getLogs may span (the testnet provider refuses more than about 1,000). */
  readonly chunk?: number;
  /** How far back the search for a contract's first block starts. */
  readonly lookback?: bigint;
}

/** How many eth_getLogs calls run at once. */
const PARALLEL = 4;

interface Scan {
  from: bigint;
  to: bigint;
  logs: ScannedLog[];
}

export function moneyEvents(chain: MoneyEventsChain, o: MoneyEventsOptions): MoneyEventsDeps {
  const chunk = BigInt(o.chunk ?? 1_000);
  const lookback = o.lookback ?? 3_000_000n;
  const scans = new Map<string, Scan>();
  const running = new Map<string, Promise<Scan>>();
  const times = new Map<bigint, bigint>();
  const tokens = new Map<string, { symbol: string; decimals: number }>();

  /** The first block with the contract's code: a binary search over eth_getCode. */
  async function firstBlock(address: Hex, head: bigint): Promise<bigint> {
    const has = async (b: bigint) =>
      ((await chain.getCode({ address, blockNumber: b }).catch(() => undefined)) ?? "0x") !== "0x";
    let lo = head > lookback ? head - lookback : 0n;
    if (await has(lo)) return lo;
    let hi = head;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (await has(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  async function scan(address: Hex, events: readonly unknown[]): Promise<Scan> {
    const key = address.toLowerCase();
    const open = running.get(key);
    if (open) return open;
    const job = (async () => {
      const head = await chain.getBlockNumber();
      const was = scans.get(key);
      const s: Scan = was ?? { from: await firstBlock(address, head), to: 0n, logs: [] };
      const ranges: [bigint, bigint][] = [];
      for (let at = was ? was.to + 1n : s.from; at <= head; at += chunk)
        ranges.push([at, at + chunk - 1n > head ? head : at + chunk - 1n]);
      // A few chunks at a time, kept in block order.
      for (let i = 0; i < ranges.length; i += PARALLEL) {
        const batch = ranges.slice(i, i + PARALLEL);
        const got = await Promise.all(
          batch.map(([fromBlock, toBlock]) =>
            chain.getLogs({ address, events, fromBlock, toBlock }),
          ),
        );
        for (const logs of got) s.logs.push(...logs);
        s.to = batch.at(-1)?.[1] ?? s.to;
      }
      if (ranges.length === 0 && !was) s.to = head;
      scans.set(key, s);
      return s;
    })().finally(() => running.delete(key));
    running.set(key, job);
    return job;
  }

  async function tokenOf(token: Hex) {
    if (isAddressEqual(token, o.usdc)) return { symbol: "USDC", decimals: 6 };
    const known = tokens.get(token.toLowerCase());
    if (known) return known;
    const [symbol, decimals] = await Promise.all([
      chain.read({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "token"),
      chain.read({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    ]);
    const t = { symbol: String(symbol), decimals: Number(decimals) };
    tokens.set(token.toLowerCase(), t);
    return t;
  }

  async function timeOf(block: bigint) {
    const known = times.get(block);
    if (known !== undefined) return known;
    const t = await chain.getBlockTime(block);
    times.set(block, t);
    return t;
  }

  return {
    async list(agentId) {
      const owner = (await chain.read({
        address: o.agentNft,
        abi: NFT_ABI,
        functionName: "ownerOf",
        args: [BigInt(agentId)],
      })) as Hex;
      const [personal, vault] = (await Promise.all([
        chain.read({
          address: o.accountFactoryV3,
          abi: FACTORY_ABI,
          functionName: "personalAccountOf",
          args: [BigInt(agentId), owner],
        }),
        chain.read({
          address: o.accountFactoryV3,
          abi: FACTORY_ABI,
          functionName: "vaultOf",
          args: [BigInt(agentId)],
        }),
      ])) as [Hex, Hex];
      const out: (MoneyEventJson & { logIndex: number })[] = [];
      const base = async (l: ScannedLog) => ({
        txHash: l.transactionHash,
        block: l.blockNumber.toString(),
        at: new Date(Number(await timeOf(l.blockNumber)) * 1000).toISOString(),
        logIndex: l.logIndex,
      });
      if (!isAddressEqual(personal, zeroAddress)) {
        for (const l of (await scan(personal, PERSONAL_EVENTS)).logs) {
          const a = l.args as { token: Hex; amount: bigint; valueUsdc?: bigint };
          const t = await tokenOf(a.token);
          const usdc = isAddressEqual(a.token, o.usdc);
          out.push({
            kind: l.eventName === "Deposited" ? "deposit" : "withdrawal",
            account: "trading",
            who: l.eventName === "Deposited" ? owner : ((l.args.to as Hex | undefined) ?? null),
            symbol: t.symbol,
            amount: formatUnits(a.amount, t.decimals),
            valueUsdcE6:
              a.valueUsdc !== undefined
                ? a.valueUsdc.toString()
                : usdc
                  ? a.amount.toString()
                  : null,
            inKind: false,
            leaderStake: false,
            ...(await base(l)),
          });
        }
      }
      if (!isAddressEqual(vault, zeroAddress)) {
        for (const l of (await scan(vault, VAULT_EVENTS)).logs) {
          const a = l.args as {
            who: Hex;
            assets?: bigint;
            shares: bigint;
            leaderStake?: boolean;
          };
          const inKind = l.eventName === "RedeemedInKind";
          out.push({
            kind: l.eventName === "Deposited" ? "deposit" : "withdrawal",
            account: "vault",
            who: a.who,
            symbol: inKind ? "shares" : "USDC",
            amount: inKind ? formatUnits(a.shares, 18) : formatUnits(a.assets ?? 0n, 6),
            valueUsdcE6: inKind ? null : (a.assets ?? 0n).toString(),
            inKind,
            leaderStake: a.leaderStake === true,
            ...(await base(l)),
          });
        }
      }
      return out
        .sort((x, y) =>
          x.block === y.block
            ? y.logIndex - x.logIndex
            : BigInt(y.block) > BigInt(x.block)
              ? 1
              : -1,
        )
        .map((e) => {
          const { logIndex, ...rest } = e;
          void logIndex;
          return rest;
        });
    },
  };
}

/** The scanner over an RPC URL (the API's relay), for main.ts. */
export function rpcMoneyEvents(rpcUrl: string, o: MoneyEventsOptions): MoneyEventsDeps {
  const c = createPublicClient({ transport: http(rpcUrl) });
  return moneyEvents(
    {
      getBlockNumber: () => c.getBlockNumber(),
      getCode: (a) => c.getCode(a),
      getLogs: async (a) =>
        (await c.getLogs({
          address: a.address,
          events: a.events as never,
          fromBlock: a.fromBlock,
          toBlock: a.toBlock,
        })) as unknown as ScannedLog[],
      getBlockTime: async (b) => (await c.getBlock({ blockNumber: b })).timestamp,
      read: (a) => c.readContract(a as never),
    },
    o,
  );
}
