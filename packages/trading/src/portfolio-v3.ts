import { ACCOUNT_MODES, AGENT_NFT_ABI, type AccountMode } from "@alpha-agents/domain";
import { custodyV3 } from "@alpha-agents/policy";
import { type Hex, createPublicClient, http, isAddressEqual, parseAbi, zeroAddress } from "viem";

/**
 * The owner's portfolio on the fund agent's set (after the F-U11 playtest,
 * A-80): the PersonalAccountV3 or where it will be, every held token with
 * its price and value as the account values it, the cost basis, what is
 * held back for a claim, the mode and the breaker, the v3 factory's allowlist
 * and caps, the registered tokens the owner may deposit with the wallet's
 * balance of each and the oracle's price, and the agent's v2 PersonalAccount
 * as an older account, when one exists, so its funds can be moved. Read
 * fresh from the chain, like the v2 reading.
 */
export interface PortfolioContractsV3 {
  readonly agentNft: Hex;
  /** AccountFactoryV3. */
  readonly accountFactory: Hex;
  /** The v2 AccountFactory, for the older account; null where v2 custody is not deployed. */
  readonly accountFactoryV2: Hex | null;
  /** OracleAdapterV3. */
  readonly oracle: Hex;
  readonly usdc: Hex;
  readonly wmon: Hex;
  /** Executor v3. */
  readonly executor: Hex;
}

/** A price as OracleAdapterV3 reads it; the reason is PRICE_REASONS_V3's word. */
export interface PriceReadingV3 {
  readonly priceE18: bigint;
  readonly updatedAt: bigint;
  readonly reason: string;
}

/** A registered token the owner may deposit (core lane, class F, buyable), as the registry lists it. */
export interface DepositTokenV3 {
  readonly symbol: string;
  readonly address: Hex;
  readonly decimals: number;
  readonly priceClass: "F" | "A";
}

export interface HoldingReadingV3 {
  readonly token: Hex;
  readonly symbol: string;
  readonly decimals: number;
  readonly balance: bigint;
  /** What a swap or withdrawal may use now. */
  readonly free: bigint;
  /** What the held amount cost in USDC; 0 for USDC. */
  readonly costBasis: bigint;
  /** The price the account values it at (USDC exactly 1), or null while unusable. */
  readonly priceE18: bigint | null;
  readonly priceReason: string;
  readonly valueUsdc: bigint | null;
  /** Held back for the owner after a transfer that failed. */
  readonly claimable: bigint;
}

export interface LegacyAccountReading {
  readonly account: Hex;
  readonly usdc: bigint;
  readonly wmon: bigint;
  readonly claimableUsdc: bigint;
  readonly claimableWmon: bigint;
  readonly mode: AccountMode | null;
}

export interface PortfolioReadingV3 {
  readonly custody: "v3";
  readonly chainId: number;
  readonly block: bigint;
  readonly timestamp: bigint;
  readonly agentId: number;
  readonly owner: Hex;
  readonly contracts: PortfolioContractsV3;
  readonly account: Hex | null;
  readonly predictedAccount: Hex;
  readonly allowlist: { readonly enabled: boolean; readonly listed: boolean };
  readonly caps: {
    readonly personal: bigint;
    readonly platform: bigint;
    readonly platformTotal: bigint;
    readonly principal: bigint;
  };
  readonly mode: AccountMode | null;
  readonly depositsClosed: boolean;
  /** The account's own value, null while a held token's price is unusable. */
  readonly navUsdc: bigint | null;
  readonly breaker: {
    readonly navUsdc: bigint;
    readonly perUnit: bigint;
    readonly peak: bigint;
    readonly drawdownBps: bigint;
  } | null;
  readonly peak7d: bigint | null;
  readonly holdings: readonly HoldingReadingV3[];
  /** The depositable tokens with the wallet's balance of each and the oracle's price. */
  readonly tokens: readonly (DepositTokenV3 & {
    readonly wallet: bigint;
    readonly price: PriceReadingV3;
  })[];
  /** The USDC peg the account checks before a deposit. */
  readonly usdcPeg: PriceReadingV3;
  readonly wallet: { readonly mon: bigint };
  readonly legacy: LegacyAccountReading | null;
}

export interface PortfolioReaderV3 {
  /** Null when the agent does not exist. */
  portfolio(agentId: number): Promise<PortfolioReadingV3 | null>;
}

/** The reads the reader makes; a test gives a fake, the app a viem client. */
export interface PortfolioClientV3 {
  readContract(args: {
    address: Hex;
    abi: unknown;
    functionName: string;
    args?: unknown[];
  }): Promise<unknown>;
  getBlock(): Promise<{ number: bigint; timestamp: bigint }>;
  getBalance(args: { address: Hex }): Promise<bigint>;
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
  "function mode() view returns (uint8)",
  "function depositsClosed() view returns (bool)",
  "function holdings() view returns ((address token, uint8 decimals, uint256 balance, uint256 free, uint256 costBasis, uint256 lastPriceE18, uint64 lastPricedAt)[])",
  "function navUsdc() view returns (uint256)",
  "function breakerState() view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps)",
  "function peakPerUnit7d() view returns (uint256)",
  "function claimable(address token, address who) view returns (uint256)",
]);
const LEGACY_ACCOUNT_ABI = parseAbi([
  "function freeBalance(address token) view returns (uint256)",
  "function claimable(address token) view returns (uint256)",
  "function mode() view returns (uint8)",
]);
const ORACLE_ABI = parseAbi([
  "function price(address token) view returns (uint256 priceE18, uint256 updatedAt, uint8 reason)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address who) view returns (uint256)"]);

/** OracleAdapterV3's PriceReason, in the contract's order (packages/policy's PRICE_REASONS). */
export const PRICE_REASONS_V3 = [
  "OK",
  "UNKNOWN_ASSET",
  "ATTESTATION_REQUIRED",
  "FEED_REVERTED",
  "DECIMALS_MISMATCH",
  "ANSWER_NOT_POSITIVE",
  "ANSWER_OUT_OF_RANGE",
  "ROUND_INCOMPLETE",
  "FUTURE_TIMESTAMP",
  "STALE",
  "POOL_UNREADABLE",
  "POOL_DEVIATION",
] as const;
const reasonOf = (i: number) => PRICE_REASONS_V3[i] ?? "FEED_REVERTED";
/** A class A token's attested price serves for a day (CustodyCoreV3._valuation). */
const ATTESTATION_TTL = 86_400n;

interface HoldingTuple {
  token: Hex;
  decimals: number;
  balance: bigint;
  free: bigint;
  costBasis: bigint;
  lastPriceE18: bigint;
  lastPricedAt: bigint;
}

export function rpcPortfolioReaderV3(
  rpcUrl: string,
  chainId: number,
  c: PortfolioContractsV3,
  deps: {
    /** The registered tokens the owner may deposit, from the platform's registry. */
    readonly tokens: () => Promise<readonly DepositTokenV3[]>;
    readonly client?: PortfolioClientV3;
  },
): PortfolioReaderV3 {
  const client: PortfolioClientV3 =
    deps.client ??
    (createPublicClient({ transport: http(rpcUrl) }) as unknown as PortfolioClientV3);
  const read = <T>(address: Hex, abi: unknown, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args }) as Promise<T>;
  const priceOf = async (token: Hex): Promise<PriceReadingV3> => {
    if (isAddressEqual(token, c.usdc)) {
      const [p, at, r] = await read<readonly [bigint, bigint, number]>(
        c.oracle,
        ORACLE_ABI,
        "price",
        [token],
      );
      return { priceE18: p, updatedAt: at, reason: reasonOf(r) };
    }
    return read<readonly [bigint, bigint, number]>(c.oracle, ORACLE_ABI, "price", [token])
      .then(([p, at, r]) => ({ priceE18: p, updatedAt: at, reason: reasonOf(r) }))
      .catch(() => ({ priceE18: 0n, updatedAt: 0n, reason: "FEED_REVERTED" }));
  };
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
      const [
        block,
        existing,
        predicted,
        enabled,
        listed,
        personal,
        platform,
        platformTotal,
        tokens,
      ] = await Promise.all([
        client.getBlock(),
        read<Hex>(f, FACTORY_ABI, "personalAccountOf", [id, owner]),
        read<Hex>(f, FACTORY_ABI, "predictPersonalAccount", [id, owner]),
        read<boolean>(f, FACTORY_ABI, "allowlistEnabled"),
        read<boolean>(f, FACTORY_ABI, "isAllowlisted", [owner]),
        read<bigint>(f, FACTORY_ABI, "personalCap"),
        read<bigint>(f, FACTORY_ABI, "platformCap"),
        read<bigint>(f, FACTORY_ABI, "platformTotal"),
        deps.tokens(),
      ]);
      // USDC is always depositable, whatever the registry lists.
      const depositable: DepositTokenV3[] = [
        { symbol: "USDC", address: c.usdc, decimals: 6, priceClass: "F" },
        ...tokens.filter((t) => !isAddressEqual(t.address, c.usdc)),
      ];
      const [usdcPeg, walletMon, legacyAccount, ...tokenReads] = await Promise.all([
        priceOf(c.usdc),
        client.getBalance({ address: owner }),
        c.accountFactoryV2
          ? read<Hex>(c.accountFactoryV2, FACTORY_ABI, "personalAccountOf", [id, owner])
          : Promise.resolve(zeroAddress as Hex),
        ...depositable.map(async (t) => ({
          ...t,
          wallet: await read<bigint>(t.address, ERC20_ABI, "balanceOf", [owner]),
          price: await priceOf(t.address),
        })),
      ]);
      const legacy = await readLegacy(legacyAccount);
      const account = existing === zeroAddress ? null : existing;
      const base = {
        custody: "v3" as const,
        chainId,
        block: block.number,
        timestamp: block.timestamp,
        agentId,
        owner,
        contracts: c,
        account,
        predictedAccount: predicted,
        allowlist: { enabled, listed },
        tokens: tokenReads,
        usdcPeg,
        wallet: { mon: walletMon },
        legacy,
      };
      if (!account)
        return {
          ...base,
          caps: { personal, platform, platformTotal, principal: 0n },
          mode: null,
          depositsClosed: false,
          navUsdc: null,
          breaker: null,
          peak7d: null,
          holdings: [],
        };
      const [principal, mode, closed, held, nav, breaker, peak7d] = await Promise.all([
        read<bigint>(account, ACCOUNT_ABI, "principal"),
        read<number>(account, ACCOUNT_ABI, "mode"),
        read<boolean>(account, ACCOUNT_ABI, "depositsClosed"),
        read<readonly HoldingTuple[]>(account, ACCOUNT_ABI, "holdings"),
        // The views that value the account revert while a held token's price is unusable.
        read<bigint>(account, ACCOUNT_ABI, "navUsdc").catch(() => null),
        read<readonly [bigint, bigint, bigint, bigint]>(account, ACCOUNT_ABI, "breakerState")
          .then(([navUsdc, perUnit, peak, drawdownBps]) => ({
            navUsdc,
            perUnit,
            peak,
            drawdownBps,
          }))
          .catch(() => null),
        read<bigint>(account, ACCOUNT_ABI, "peakPerUnit7d").catch(() => null),
      ]);
      const holdings = await Promise.all(
        held.map(async (h): Promise<HoldingReadingV3> => {
          const known = depositable.find((t) => isAddressEqual(t.address, h.token));
          const symbol =
            known?.symbol ??
            (isAddressEqual(h.token, c.wmon)
              ? "WMON"
              : `${h.token.slice(0, 6)}…${h.token.slice(-4)}`);
          const claimable = await read<bigint>(account, ACCOUNT_ABI, "claimable", [h.token, owner]);
          if (isAddressEqual(h.token, c.usdc))
            return {
              token: h.token,
              symbol,
              decimals: h.decimals,
              balance: h.balance,
              free: h.free,
              costBasis: 0n,
              priceE18: 10n ** 18n,
              priceReason: "OK",
              valueUsdc: h.balance,
              claimable,
            };
          const attested =
            h.lastPricedAt !== 0n && h.lastPricedAt + ATTESTATION_TTL > block.timestamp;
          const classA = known?.priceClass === "A";
          const feed = classA ? null : await priceOf(h.token);
          const priceE18 = classA
            ? attested
              ? h.lastPriceE18
              : null
            : feed && feed.reason === "OK" && feed.priceE18 > 0n
              ? feed.priceE18
              : null;
          return {
            token: h.token,
            symbol,
            decimals: h.decimals,
            balance: h.balance,
            free: h.free,
            costBasis: h.costBasis,
            priceE18,
            priceReason: classA
              ? attested
                ? "OK"
                : "ATTESTATION_REQUIRED"
              : (feed?.reason ?? "FEED_REVERTED"),
            valueUsdc:
              priceE18 === null ? null : custodyV3.valueE6(h.balance, priceE18, h.decimals),
            claimable,
          };
        }),
      );
      return {
        ...base,
        caps: { personal, platform, platformTotal, principal },
        mode: ACCOUNT_MODES[mode] ?? null,
        depositsClosed: closed,
        navUsdc: nav,
        breaker,
        peak7d,
        holdings,
      };
    },
  };

  /** The agent's v2 PersonalAccount, when one exists: its two balances, its claimables and its mode. */
  async function readLegacy(account: Hex): Promise<LegacyAccountReading | null> {
    if (account === zeroAddress) return null;
    const [usdc, wmon, claimableUsdc, claimableWmon, mode] = await Promise.all([
      read<bigint>(account, LEGACY_ACCOUNT_ABI, "freeBalance", [c.usdc]),
      read<bigint>(account, LEGACY_ACCOUNT_ABI, "freeBalance", [c.wmon]),
      read<bigint>(account, LEGACY_ACCOUNT_ABI, "claimable", [c.usdc]),
      read<bigint>(account, LEGACY_ACCOUNT_ABI, "claimable", [c.wmon]),
      read<number>(account, LEGACY_ACCOUNT_ABI, "mode").catch(() => -1),
    ]);
    return { account, usdc, wmon, claimableUsdc, claimableWmon, mode: ACCOUNT_MODES[mode] ?? null };
  }
}

const s = (v: bigint) => v.toString();
const price = (p: PriceReadingV3) => ({
  priceE18: s(p.priceE18),
  updatedAt: Number(p.updatedAt),
  reason: p.reason,
});

/** The reading as JSON: every amount a base-unit string. */
export function portfolioV3Json(r: PortfolioReadingV3) {
  return {
    custody: "v3" as const,
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
    mode: r.mode,
    depositsClosed: r.depositsClosed,
    navUsdcE6: r.navUsdc === null ? null : s(r.navUsdc),
    breaker: r.breaker
      ? {
          navUsdcE6: s(r.breaker.navUsdc),
          perUnitE18: s(r.breaker.perUnit),
          peakE18: s(r.breaker.peak),
          drawdownBps: Number(r.breaker.drawdownBps),
        }
      : null,
    peak7dE18: r.peak7d === null ? null : s(r.peak7d),
    holdings: r.holdings.map((h) => ({
      token: h.token,
      symbol: h.symbol,
      decimals: h.decimals,
      amountRaw: s(h.balance),
      freeRaw: s(h.free),
      costBasisUsdcE6: s(h.costBasis),
      priceE18: h.priceE18 === null ? null : s(h.priceE18),
      priceReason: h.priceReason,
      valueUsdcE6: h.valueUsdc === null ? null : s(h.valueUsdc),
      claimableRaw: s(h.claimable),
    })),
    tokens: r.tokens.map((t) => ({
      symbol: t.symbol,
      address: t.address,
      decimals: t.decimals,
      priceClass: t.priceClass,
      walletRaw: s(t.wallet),
      price: price(t.price),
    })),
    usdcPeg: price(r.usdcPeg),
    wallet: { monWei: s(r.wallet.mon) },
    legacy: r.legacy
      ? {
          account: r.legacy.account,
          usdcE6: s(r.legacy.usdc),
          wmonWei: s(r.legacy.wmon),
          claimable: { usdcE6: s(r.legacy.claimableUsdc), wmonWei: s(r.legacy.claimableWmon) },
          mode: r.legacy.mode,
        }
      : null,
  };
}

export type PortfolioV3Json = ReturnType<typeof portfolioV3Json>;
