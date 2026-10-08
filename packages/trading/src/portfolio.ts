import { ACCOUNT_MODES, AGENT_NFT_ABI, type AccountMode } from "@alpha-agents/domain";
import { ORACLE_REASONS, type OracleReason } from "@alpha-agents/policy";
import { type Hex, createPublicClient, http, parseAbi, zeroAddress } from "viem";

/**
 * The owner's portfolio view of one agent (P2-U7), from one fresh read of the
 * chain: the PersonalAccount (or where it will be created), its balances,
 * credits held back from a failed transfer, mode and circuit breaker, the
 * deposit allowlist and caps, the oracle's prices with their age, and the
 * owner wallet's own balances for the deposit form. Every address comes from
 * the environment's address book, so the same code reads the fork, testnet
 * and mainnet (D-255).
 */

export interface PortfolioContracts {
  readonly agentNft: Hex;
  readonly accountFactory: Hex;
  readonly oracle: Hex;
  readonly usdc: Hex;
  readonly wmon: Hex;
  readonly executor: Hex;
}

export interface PriceReading {
  readonly priceE18: bigint;
  /** Unix seconds; 0 when the feed gave none. */
  readonly updatedAt: bigint;
  readonly reason: OracleReason;
}

export interface PortfolioReading {
  readonly chainId: number;
  readonly block: bigint;
  /** The block's time, unix seconds. */
  readonly timestamp: bigint;
  readonly agentId: number;
  readonly owner: Hex;
  readonly contracts: PortfolioContracts;
  /** The account, or null before the owner opens one. */
  readonly account: Hex | null;
  /** Where the account is (or will be) created for this owner. */
  readonly predictedAccount: Hex;
  readonly allowlist: { readonly enabled: boolean; readonly listed: boolean };
  /** USDC, 6 decimals: the per-account cap, the platform cap, deposits so far. */
  readonly caps: {
    readonly personal: bigint;
    readonly platform: bigint;
    readonly platformTotal: bigint;
    readonly principal: bigint;
  };
  /** What the account holds and can use (claimable credits excluded). */
  readonly balances: { readonly usdc: bigint; readonly wmon: bigint };
  /** Tokens whose transfer out failed, held for the owner to claim. */
  readonly claimable: { readonly usdc: bigint; readonly wmon: bigint };
  readonly mode: AccountMode | null;
  readonly depositsClosed: boolean;
  /** Null when the price is unusable (the breaker reads it) or there is no account. */
  readonly breaker: {
    readonly navUsdc: bigint;
    readonly perUnit: bigint;
    readonly peak: bigint;
    readonly drawdownBps: bigint;
  } | null;
  /** The 7-day peak of the value per unit, read without the oracle. */
  readonly peak7d: bigint | null;
  readonly prices: { readonly monUsd: PriceReading; readonly usdcUsd: PriceReading };
  /** The owner wallet's balances, for the deposit form and gas. */
  readonly wallet: {
    readonly usdc: bigint;
    readonly wmon: bigint;
    readonly mon: bigint;
  };
}

const FACTORY_ABI = parseAbi([
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
  "function predictPersonalAccount(uint256 agentId, address owner) view returns (address)",
  "function allowlistEnabled() view returns (bool)",
  "function isAllowlisted(address depositor) view returns (bool)",
  "function personalCap() view returns (uint256)",
  "function platformCap() view returns (uint256)",
  "function platformTotal() view returns (uint256)",
]);
const ACCOUNT_ABI = parseAbi([
  "function principal() view returns (uint256)",
  "function freeBalance(address token) view returns (uint256)",
  "function claimable(address token) view returns (uint256)",
  "function mode() view returns (uint8)",
  "function depositsClosed() view returns (bool)",
  "function breakerState() view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps)",
  "function peakPerUnit7d() view returns (uint256)",
]);
const ORACLE_ABI = parseAbi([
  "function price(address asset) view returns (uint256 priceE18, uint256 updatedAt, uint8 reason)",
  "function usdcPeg() view returns (uint256 usdcUsdE18, uint256 updatedAt, uint8 reason)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address who) view returns (uint256)"]);

const reasonOf = (n: number): OracleReason => ORACLE_REASONS[n] ?? "UNKNOWN_ASSET";

export interface PortfolioReader {
  /** Null when the agent does not exist. */
  portfolio(agentId: number): Promise<PortfolioReading | null>;
}

export function rpcPortfolioReader(
  rpcUrl: string,
  chainId: number,
  c: PortfolioContracts,
): PortfolioReader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const read = <T>(address: Hex, abi: unknown, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  return {
    async portfolio(agentId) {
      const id = BigInt(agentId);
      let owner: Hex;
      try {
        owner = await read<Hex>(c.agentNft, AGENT_NFT_ABI, "ownerOf", [id]);
      } catch (err) {
        if (err instanceof Error && /revert/i.test(err.message)) return null;
        throw err;
      }
      const f = c.accountFactory;
      const [block, existing, predicted, enabled, listed, personal, platform, platformTotal] =
        await Promise.all([
          client.getBlock(),
          read<Hex>(f, FACTORY_ABI, "personalAccountOf", [id, owner]),
          read<Hex>(f, FACTORY_ABI, "predictPersonalAccount", [id, owner]),
          read<boolean>(f, FACTORY_ABI, "allowlistEnabled"),
          read<boolean>(f, FACTORY_ABI, "isAllowlisted", [owner]),
          read<bigint>(f, FACTORY_ABI, "personalCap"),
          read<bigint>(f, FACTORY_ABI, "platformCap"),
          read<bigint>(f, FACTORY_ABI, "platformTotal"),
        ]);
      const [mon, peg, walletUsdc, walletWmon, walletMon] = await Promise.all([
        read<readonly [bigint, bigint, number]>(c.oracle, ORACLE_ABI, "price", [c.wmon]),
        read<readonly [bigint, bigint, number]>(c.oracle, ORACLE_ABI, "usdcPeg"),
        read<bigint>(c.usdc, ERC20_ABI, "balanceOf", [owner]),
        read<bigint>(c.wmon, ERC20_ABI, "balanceOf", [owner]),
        client.getBalance({ address: owner }),
      ]);
      const account = existing === zeroAddress ? null : existing;
      const base = {
        chainId,
        block: block.number,
        timestamp: block.timestamp,
        agentId,
        owner,
        contracts: c,
        account,
        predictedAccount: predicted,
        allowlist: { enabled, listed },
        prices: {
          monUsd: { priceE18: mon[0], updatedAt: mon[1], reason: reasonOf(mon[2]) },
          usdcUsd: { priceE18: peg[0], updatedAt: peg[1], reason: reasonOf(peg[2]) },
        },
        wallet: { usdc: walletUsdc, wmon: walletWmon, mon: walletMon },
      };
      if (!account)
        return {
          ...base,
          caps: { personal, platform, platformTotal, principal: 0n },
          balances: { usdc: 0n, wmon: 0n },
          claimable: { usdc: 0n, wmon: 0n },
          mode: null,
          depositsClosed: false,
          breaker: null,
          peak7d: null,
        };
      const [principal, usdc, wmon, claimUsdc, claimWmon, mode, closed, peak7d] = await Promise.all(
        [
          read<bigint>(account, ACCOUNT_ABI, "principal"),
          read<bigint>(account, ACCOUNT_ABI, "freeBalance", [c.usdc]),
          read<bigint>(account, ACCOUNT_ABI, "freeBalance", [c.wmon]),
          read<bigint>(account, ACCOUNT_ABI, "claimable", [c.usdc]),
          read<bigint>(account, ACCOUNT_ABI, "claimable", [c.wmon]),
          read<number>(account, ACCOUNT_ABI, "mode"),
          read<boolean>(account, ACCOUNT_ABI, "depositsClosed"),
          read<bigint>(account, ACCOUNT_ABI, "peakPerUnit7d"),
        ],
      );
      // The breaker reads the price, so it reverts while the price is unusable and WMON is held.
      const breaker = await read<readonly [bigint, bigint, bigint, bigint]>(
        account,
        ACCOUNT_ABI,
        "breakerState",
      )
        .then(([navUsdc, perUnit, peak, drawdownBps]) => ({ navUsdc, perUnit, peak, drawdownBps }))
        .catch(() => null);
      return {
        ...base,
        caps: { personal, platform, platformTotal, principal },
        balances: { usdc, wmon },
        claimable: { usdc: claimUsdc, wmon: claimWmon },
        mode: ACCOUNT_MODES[mode] ?? null,
        depositsClosed: closed,
        breaker,
        peak7d,
      };
    },
  };
}

const s = (v: bigint) => v.toString();
const price = (p: PriceReading) => ({
  priceE18: s(p.priceE18),
  updatedAt: Number(p.updatedAt),
  reason: p.reason,
});

/** The reading as JSON: every amount a base-unit string (USDC 6 decimals, WMON and MON 18). */
export function portfolioJson(r: PortfolioReading) {
  return {
    chainId: r.chainId,
    block: s(r.block),
    timestamp: Number(r.timestamp),
    agentId: String(r.agentId),
    owner: r.owner,
    contracts: r.contracts,
    account: r.account,
    predictedAccount: r.predictedAccount,
    allowlist: r.allowlist,
    caps: {
      personalUsdcE6: s(r.caps.personal),
      platformUsdcE6: s(r.caps.platform),
      platformTotalUsdcE6: s(r.caps.platformTotal),
      principalUsdcE6: s(r.caps.principal),
    },
    balances: { usdcE6: s(r.balances.usdc), wmonWei: s(r.balances.wmon) },
    claimable: { usdcE6: s(r.claimable.usdc), wmonWei: s(r.claimable.wmon) },
    mode: r.mode,
    depositsClosed: r.depositsClosed,
    breaker: r.breaker
      ? {
          navUsdcE6: s(r.breaker.navUsdc),
          perUnitE18: s(r.breaker.perUnit),
          peakE18: s(r.breaker.peak),
          drawdownBps: Number(r.breaker.drawdownBps),
        }
      : null,
    peak7dE18: r.peak7d === null ? null : s(r.peak7d),
    prices: { monUsd: price(r.prices.monUsd), usdcUsd: price(r.prices.usdcUsd) },
    wallet: { usdcE6: s(r.wallet.usdc), wmonWei: s(r.wallet.wmon), monWei: s(r.wallet.mon) },
  };
}

export type PortfolioJson = ReturnType<typeof portfolioJson>;
