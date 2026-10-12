import { ACCOUNT_MODES, type AccountMode } from "@alpha-agents/domain";
import { custodyV3 } from "@alpha-agents/policy";
import { type Hex, createPublicClient, http, isAddressEqual, parseAbi, zeroAddress } from "viem";
import {
  type DepositTokenV3,
  PRICE_REASONS_V3,
  type PortfolioClientV3,
  type PriceReadingV3,
} from "./portfolio-v3.ts";
import type { SnapshotRow } from "./snapshots.ts";
import {
  type PerUnitPoint,
  type Score,
  maxDrawdown,
  perUnitSeries,
  returnSinceStart,
} from "./window.ts";

/**
 * The agent's StrategyVaultV3 as the app shows it (P7-U4): where it is or will
 * be, the factory's caps and flags, its state (the leader and the stake, the
 * supply and the value, the mode, the handover, the lockup, the fee, every held
 * token valued as the vault values it), and a viewer's own position (shares,
 * the lock, the value, the in-kind slices, the claimable credits, the room to
 * deposit). Every number is on chain, so the reading is public; the viewer's
 * part is whatever wallet the caller names. Performance comes from the value
 * snapshots the orchestrator records (F-U11), filtered to the vault's rows.
 */

export interface VaultContractsV3 {
  readonly agentNft: Hex;
  /** AccountFactoryV3. */
  readonly accountFactory: Hex;
  /** OracleAdapterV3. */
  readonly oracle: Hex;
  readonly usdc: Hex;
  readonly wmon: Hex;
  /** Executor v3. */
  readonly executor: Hex;
}

export interface VaultHoldingV3 {
  readonly token: Hex;
  readonly symbol: string;
  readonly decimals: number;
  readonly balance: bigint;
  readonly free: bigint;
  readonly costBasis: bigint;
  readonly priceE18: bigint | null;
  readonly priceReason: string;
  readonly valueUsdc: bigint | null;
}

export interface TokenAmountV3 {
  readonly token: Hex;
  readonly symbol: string;
  readonly decimals: number;
  readonly amount: bigint;
}

export interface VaultStateV3 {
  readonly leader: Hex;
  readonly leaderShares: bigint;
  /** The leader's stake as a share of the supply, in basis points (the minimum is 500). */
  readonly leaderStakeBps: bigint;
  readonly incomingLeader: Hex;
  readonly incomingShares: bigint;
  readonly totalSupply: bigint;
  /** USDC put in, net of USDC taken out: what the vault cap counts. */
  readonly principal: bigint;
  /** The vault's value in USDC, or null while a held token's price is unusable. */
  readonly navUsdc: bigint | null;
  /** The value of one share scaled by 1e18, as the snapshots record it; null while unreadable. */
  readonly perUnitE18: bigint | null;
  readonly breaker: {
    readonly navUsdc: bigint;
    readonly perUnit: bigint;
    readonly peak: bigint;
    readonly drawdownBps: bigint;
  } | null;
  /** The effective mode: PAUSED first, else HANDOVER while the agent changed hands, else the core's. */
  readonly mode: AccountMode | null;
  readonly inHandover: boolean;
  /** The manager's switch. */
  readonly depositsOpen: boolean;
  /** The tighteners' switch. */
  readonly depositsClosed: boolean;
  /** The lockup every deposit starts, in seconds. */
  readonly lockup: bigint;
  readonly feeBps: number;
  readonly windDownAt: bigint;
  readonly pausedAt: bigint;
  readonly holdings: readonly VaultHoldingV3[];
  readonly constants: {
    readonly minLockup: bigint;
    readonly maxLockup: bigint;
    readonly leaderMinBps: bigint;
    readonly spreadBps: bigint;
    readonly handoverPeriod: bigint;
  };
}

export interface VaultViewerV3 {
  readonly address: Hex;
  /** The agent's current owner: the manager, and the leader once management is accepted. */
  readonly isOwner: boolean;
  readonly isLeader: boolean;
  readonly allowlisted: boolean;
  /** Whether the factory would take this wallet's deposit: allowlisted, or public deposits on and the allowlist off. */
  readonly mayDeposit: boolean;
  readonly usdcWallet: bigint;
  readonly shares: bigint;
  readonly freeShares: bigint;
  readonly lockedShares: bigint;
  readonly unlockAt: bigint;
  /** What the shares would pay on the USDC path now (less the spread), or null while unreadable. */
  readonly valueUsdc: bigint | null;
  /** The most USDC the vault would take from this wallet now, 0 when none. */
  readonly maxDeposit: bigint;
  /** What the shares would pay in kind now, token by token; null without shares. */
  readonly inKind: readonly TokenAmountV3[] | null;
  /** Credits held back for this wallet after a transfer that failed. */
  readonly claimables: readonly TokenAmountV3[];
  readonly entryPriceE18: bigint;
}

export interface VaultReadingV3 {
  readonly custody: "v3";
  readonly chainId: number;
  readonly block: bigint;
  readonly timestamp: bigint;
  readonly agentId: number;
  readonly owner: Hex;
  readonly contracts: VaultContractsV3;
  /** The vault, or null before the owner creates it. */
  readonly vault: Hex | null;
  readonly predictedVault: Hex;
  readonly factory: {
    readonly vaultCap: bigint;
    readonly platformCap: bigint;
    readonly platformTotal: bigint;
    readonly allowlistEnabled: boolean;
    readonly depositsEnabled: boolean;
  };
  readonly usdcPeg: PriceReadingV3;
  readonly state: VaultStateV3 | null;
  readonly viewer: VaultViewerV3 | null;
}

export interface VaultReaderV3 {
  /** Null when the agent does not exist. The viewer's position is read when a wallet is named. */
  vault(agentId: number, viewer?: Hex): Promise<VaultReadingV3 | null>;
}

const AGENT_NFT_ABI = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);
const FACTORY_ABI = parseAbi([
  "function vaultOf(uint256 agentId) view returns (address)",
  "function predictVault(uint256 agentId) view returns (address)",
  "function vaultCap() view returns (uint256)",
  "function platformCap() view returns (uint256)",
  "function platformTotal() view returns (uint256)",
  "function allowlistEnabled() view returns (bool)",
  "function depositsEnabled() view returns (bool)",
  "function isAllowlisted(address depositor) view returns (bool)",
]);
const VAULT_ABI = parseAbi([
  "function leader() view returns (address)",
  "function leaderShares() view returns (uint256)",
  "function leaderStakeBps() view returns (uint256)",
  "function incomingLeader() view returns (address)",
  "function incomingShares() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function principal() view returns (uint256)",
  "function navUsdc() view returns (uint256)",
  "function breakerState() view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps)",
  "function effectiveMode() view returns (uint8)",
  "function inHandover() view returns (bool)",
  "function depositsOpen() view returns (bool)",
  "function depositsClosed() view returns (bool)",
  "function lockup() view returns (uint64)",
  "function feeBps() view returns (uint16)",
  "function windDownAt() view returns (uint64)",
  "function pausedAt() view returns (uint64)",
  "function holdings() view returns ((address token, uint8 decimals, uint256 balance, uint256 free, uint256 costBasis, uint256 lastPriceE18, uint64 lastPricedAt)[])",
  "function MIN_LOCKUP() view returns (uint64)",
  "function MAX_LOCKUP() view returns (uint64)",
  "function LEADER_STAKE_BPS() view returns (uint256)",
  "function SPREAD_BPS() view returns (uint256)",
  "function HANDOVER_PERIOD() view returns (uint64)",
  "function sharesOf(address who) view returns (uint256)",
  "function freeShares(address who) view returns (uint256)",
  "function lockOf(address who) view returns (uint256 lockedShares, uint64 unlockAt)",
  "function entryPriceE18(address who) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxDeposit(address who) view returns (uint256)",
  "function inKindAmounts(uint256 shares) view returns (address[] tokens, uint256[] amounts)",
  "function claimable(address token, address who) view returns (uint256)",
]);
const ORACLE_ABI = parseAbi([
  "function price(address token) view returns (uint256 priceE18, uint256 updatedAt, uint8 reason)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address who) view returns (uint256)"]);
const reasonOf = (i: number) => PRICE_REASONS_V3[i] ?? "FEED_REVERTED";

interface HoldingTuple {
  token: Hex;
  decimals: number;
  balance: bigint;
  free: bigint;
  costBasis: bigint;
  lastPriceE18: bigint;
  lastPricedAt: bigint;
}

export function rpcVaultReaderV3(
  rpcUrl: string,
  chainId: number,
  c: VaultContractsV3,
  deps: {
    /** The registered tokens, for their symbols and decimals. */
    readonly tokens: () => Promise<readonly DepositTokenV3[]>;
    readonly client?: PortfolioClientV3;
  },
): VaultReaderV3 {
  const client: PortfolioClientV3 =
    deps.client ??
    (createPublicClient({ transport: http(rpcUrl) }) as unknown as PortfolioClientV3);
  const read = <T>(address: Hex, abi: unknown, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args }) as Promise<T>;
  const priceOf = (token: Hex): Promise<PriceReadingV3> =>
    read<readonly [bigint, bigint, number]>(c.oracle, ORACLE_ABI, "price", [token])
      .then(([p, at, r]) => ({ priceE18: p, updatedAt: at, reason: reasonOf(r) }))
      .catch(() => ({ priceE18: 0n, updatedAt: 0n, reason: "FEED_REVERTED" }));
  return {
    async vault(agentId, viewer) {
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
        vaultCap,
        platformCap,
        platformTotal,
        enabled,
        open,
        tokens,
        usdcPeg,
      ] = await Promise.all([
        client.getBlock(),
        read<Hex>(f, FACTORY_ABI, "vaultOf", [id]),
        read<Hex>(f, FACTORY_ABI, "predictVault", [id]),
        read<bigint>(f, FACTORY_ABI, "vaultCap"),
        read<bigint>(f, FACTORY_ABI, "platformCap"),
        read<bigint>(f, FACTORY_ABI, "platformTotal"),
        read<boolean>(f, FACTORY_ABI, "allowlistEnabled"),
        read<boolean>(f, FACTORY_ABI, "depositsEnabled"),
        deps.tokens(),
        priceOf(c.usdc),
      ]);
      const vault = existing === zeroAddress ? null : existing;
      const symbolOf = (token: Hex) => {
        const known = tokens.find((t) => isAddressEqual(t.address, token));
        if (known) return { symbol: known.symbol, decimals: known.decimals };
        if (isAddressEqual(token, c.usdc)) return { symbol: "USDC", decimals: 6 };
        if (isAddressEqual(token, c.wmon)) return { symbol: "WMON", decimals: 18 };
        return { symbol: `${token.slice(0, 6)}…${token.slice(-4)}`, decimals: 18 };
      };
      const base = {
        custody: "v3" as const,
        chainId,
        block: block.number,
        timestamp: block.timestamp,
        agentId,
        owner,
        contracts: c,
        vault,
        predictedVault: predicted,
        factory: {
          vaultCap,
          platformCap,
          platformTotal,
          allowlistEnabled: enabled,
          depositsEnabled: open,
        },
        usdcPeg,
      };
      const viewerBase = async (): Promise<Omit<
        VaultViewerV3,
        | "shares"
        | "freeShares"
        | "lockedShares"
        | "unlockAt"
        | "valueUsdc"
        | "maxDeposit"
        | "inKind"
        | "claimables"
        | "entryPriceE18"
        | "isLeader"
      > | null> => {
        if (!viewer) return null;
        const [allowlisted, usdcWallet] = await Promise.all([
          read<boolean>(f, FACTORY_ABI, "isAllowlisted", [viewer]),
          read<bigint>(c.usdc, ERC20_ABI, "balanceOf", [viewer]),
        ]);
        return {
          address: viewer,
          isOwner: isAddressEqual(viewer, owner),
          allowlisted,
          mayDeposit: allowlisted || (open && !enabled),
          usdcWallet,
        };
      };
      if (!vault) {
        const v = await viewerBase();
        return {
          ...base,
          state: null,
          viewer: v
            ? {
                ...v,
                isLeader: false,
                shares: 0n,
                freeShares: 0n,
                lockedShares: 0n,
                unlockAt: 0n,
                valueUsdc: null,
                maxDeposit: 0n,
                inKind: null,
                claimables: [],
                entryPriceE18: 0n,
              }
            : null,
        };
      }
      const v = (fn: string, args: unknown[] = []) => read<unknown>(vault, VAULT_ABI, fn, args);
      const [
        leader,
        leaderShares,
        leaderStakeBps,
        incomingLeader,
        incomingShares,
        totalSupply,
        principal,
        nav,
        breaker,
        mode,
        inHandover,
        depositsOpen,
        depositsClosed,
        lockup,
        feeBps,
        windDownAt,
        pausedAt,
        held,
        minLockup,
        maxLockup,
        leaderMinBps,
        spreadBps,
        handoverPeriod,
      ] = await Promise.all([
        v("leader") as Promise<Hex>,
        v("leaderShares") as Promise<bigint>,
        v("leaderStakeBps") as Promise<bigint>,
        v("incomingLeader") as Promise<Hex>,
        v("incomingShares") as Promise<bigint>,
        v("totalSupply") as Promise<bigint>,
        v("principal") as Promise<bigint>,
        // The views that value the vault revert while a held token's price is unusable.
        (v("navUsdc") as Promise<bigint>).catch(() => null),
        (v("breakerState") as Promise<readonly [bigint, bigint, bigint, bigint]>)
          .then(([navUsdc, perUnit, peak, drawdownBps]) => ({
            navUsdc,
            perUnit,
            peak,
            drawdownBps,
          }))
          .catch(() => null),
        v("effectiveMode") as Promise<number>,
        v("inHandover") as Promise<boolean>,
        v("depositsOpen") as Promise<boolean>,
        v("depositsClosed") as Promise<boolean>,
        v("lockup") as Promise<bigint>,
        v("feeBps") as Promise<number>,
        v("windDownAt") as Promise<bigint>,
        v("pausedAt") as Promise<bigint>,
        v("holdings") as Promise<readonly HoldingTuple[]>,
        v("MIN_LOCKUP") as Promise<bigint>,
        v("MAX_LOCKUP") as Promise<bigint>,
        v("LEADER_STAKE_BPS") as Promise<bigint>,
        v("SPREAD_BPS") as Promise<bigint>,
        v("HANDOVER_PERIOD") as Promise<bigint>,
      ]);
      const holdings = await Promise.all(
        held.map(async (h): Promise<VaultHoldingV3> => {
          const { symbol } = symbolOf(h.token);
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
            };
          const feed = await priceOf(h.token);
          const priceE18 = feed.reason === "OK" && feed.priceE18 > 0n ? feed.priceE18 : null;
          return {
            token: h.token,
            symbol,
            decimals: h.decimals,
            balance: h.balance,
            free: h.free,
            costBasis: h.costBasis,
            priceE18,
            priceReason: feed.reason,
            valueUsdc:
              priceE18 === null ? null : custodyV3.valueE6(h.balance, priceE18, h.decimals),
          };
        }),
      );
      const state: VaultStateV3 = {
        leader,
        leaderShares,
        leaderStakeBps,
        incomingLeader,
        incomingShares,
        totalSupply,
        principal,
        navUsdc: nav,
        perUnitE18: breaker ? breaker.perUnit : null,
        breaker,
        mode: ACCOUNT_MODES[mode] ?? null,
        inHandover,
        depositsOpen,
        depositsClosed,
        lockup: BigInt(lockup),
        feeBps: Number(feeBps),
        windDownAt: BigInt(windDownAt),
        pausedAt: BigInt(pausedAt),
        holdings,
        constants: {
          minLockup: BigInt(minLockup),
          maxLockup: BigInt(maxLockup),
          leaderMinBps,
          spreadBps,
          handoverPeriod: BigInt(handoverPeriod),
        },
      };
      const vb = await viewerBase();
      if (!vb || !viewer) return { ...base, state, viewer: null };
      const [shares, freeShares, lock, entryPriceE18, maxDeposit] = await Promise.all([
        v("sharesOf", [viewer]) as Promise<bigint>,
        v("freeShares", [viewer]) as Promise<bigint>,
        v("lockOf", [viewer]) as Promise<readonly [bigint, bigint]>,
        v("entryPriceE18", [viewer]) as Promise<bigint>,
        (v("maxDeposit", [viewer]) as Promise<bigint>).catch(() => 0n),
      ]);
      const [valueUsdc, inKind] =
        shares > 0n
          ? await Promise.all([
              (v("convertToAssets", [shares]) as Promise<bigint>).catch(() => null),
              (
                v("inKindAmounts", [shares]) as Promise<
                  readonly [readonly Hex[], readonly bigint[]]
                >
              )
                .then(([ts, amounts]) =>
                  ts.map((t, i) => ({ token: t, ...symbolOf(t), amount: amounts[i] ?? 0n })),
                )
                .catch(() => null),
            ])
          : [null, null];
      const claimTokens = [c.usdc, c.wmon, ...holdings.map((h) => h.token)].filter(
        (t, i, all) => all.findIndex((x) => isAddressEqual(x, t)) === i,
      );
      const claimables = (
        await Promise.all(
          claimTokens.map(async (t) => ({
            token: t,
            ...symbolOf(t),
            amount: await (v("claimable", [t, viewer]) as Promise<bigint>).catch(() => 0n),
          })),
        )
      ).filter((x) => x.amount > 0n);
      return {
        ...base,
        state,
        viewer: {
          ...vb,
          isLeader: isAddressEqual(viewer, leader),
          shares,
          freeShares,
          lockedShares: lock[0],
          unlockAt: BigInt(lock[1]),
          valueUsdc,
          maxDeposit,
          inKind,
          claimables,
          entryPriceE18,
        },
      };
    },
  };
}

const s = (v: bigint) => v.toString();
const amount = (a: TokenAmountV3) => ({
  token: a.token,
  symbol: a.symbol,
  decimals: a.decimals,
  amountRaw: s(a.amount),
});

/** The reading as JSON: every amount a base-unit string. */
export function vaultV3Json(r: VaultReadingV3) {
  return {
    custody: "v3" as const,
    chainId: r.chainId,
    block: s(r.block),
    timestamp: Number(r.timestamp),
    agentId: String(r.agentId),
    owner: r.owner,
    contracts: r.contracts,
    vault: r.vault,
    predictedVault: r.predictedVault,
    factory: {
      vaultCapUsdcE6: s(r.factory.vaultCap),
      platformCapUsdcE6: s(r.factory.platformCap),
      platformTotalUsdcE6: s(r.factory.platformTotal),
      allowlistEnabled: r.factory.allowlistEnabled,
      depositsEnabled: r.factory.depositsEnabled,
    },
    usdcPeg: {
      priceE18: s(r.usdcPeg.priceE18),
      updatedAt: Number(r.usdcPeg.updatedAt),
      reason: r.usdcPeg.reason,
    },
    state: r.state
      ? {
          leader: r.state.leader,
          leaderShares: s(r.state.leaderShares),
          leaderStakeBps: Number(r.state.leaderStakeBps),
          incomingLeader: r.state.incomingLeader,
          incomingShares: s(r.state.incomingShares),
          totalSupply: s(r.state.totalSupply),
          principalUsdcE6: s(r.state.principal),
          navUsdcE6: r.state.navUsdc === null ? null : s(r.state.navUsdc),
          perUnitE18: r.state.perUnitE18 === null ? null : s(r.state.perUnitE18),
          breaker: r.state.breaker
            ? {
                navUsdcE6: s(r.state.breaker.navUsdc),
                perUnitE18: s(r.state.breaker.perUnit),
                peakE18: s(r.state.breaker.peak),
                drawdownBps: Number(r.state.breaker.drawdownBps),
              }
            : null,
          mode: r.state.mode,
          inHandover: r.state.inHandover,
          depositsOpen: r.state.depositsOpen,
          depositsClosed: r.state.depositsClosed,
          lockupSeconds: Number(r.state.lockup),
          feeBps: r.state.feeBps,
          windDownAt: Number(r.state.windDownAt),
          pausedAt: Number(r.state.pausedAt),
          holdings: r.state.holdings.map((h) => ({
            token: h.token,
            symbol: h.symbol,
            decimals: h.decimals,
            amountRaw: s(h.balance),
            freeRaw: s(h.free),
            costBasisUsdcE6: s(h.costBasis),
            priceE18: h.priceE18 === null ? null : s(h.priceE18),
            priceReason: h.priceReason,
            valueUsdcE6: h.valueUsdc === null ? null : s(h.valueUsdc),
          })),
          constants: {
            minLockupSeconds: Number(r.state.constants.minLockup),
            maxLockupSeconds: Number(r.state.constants.maxLockup),
            leaderMinBps: Number(r.state.constants.leaderMinBps),
            spreadBps: Number(r.state.constants.spreadBps),
            handoverPeriodSeconds: Number(r.state.constants.handoverPeriod),
          },
        }
      : null,
    viewer: r.viewer
      ? {
          address: r.viewer.address,
          isOwner: r.viewer.isOwner,
          isLeader: r.viewer.isLeader,
          allowlisted: r.viewer.allowlisted,
          mayDeposit: r.viewer.mayDeposit,
          usdcWalletE6: s(r.viewer.usdcWallet),
          shares: s(r.viewer.shares),
          freeShares: s(r.viewer.freeShares),
          lockedShares: s(r.viewer.lockedShares),
          unlockAt: Number(r.viewer.unlockAt),
          valueUsdcE6: r.viewer.valueUsdc === null ? null : s(r.viewer.valueUsdc),
          maxDepositUsdcE6: s(r.viewer.maxDeposit),
          inKind: r.viewer.inKind === null ? null : r.viewer.inKind.map(amount),
          claimables: r.viewer.claimables.map(amount),
          entryPriceE18: s(r.viewer.entryPriceE18),
        }
      : null,
  };
}

export type VaultV3Json = ReturnType<typeof vaultV3Json>;

/** The vault's performance as the window computes it, from the vault's own snapshot rows. */
export interface VaultPerformanceJson {
  readonly series: readonly PerUnitPoint[];
  readonly scores: {
    readonly returnSinceStart: ReturnType<typeof returnSinceStart>;
    readonly maxDrawdown: ReturnType<typeof maxDrawdown>;
  };
  readonly history: {
    readonly points: number;
    readonly from: string | null;
    readonly to: string | null;
  };
}

/**
 * The vault's value per share over time from the value snapshots recorded for
 * the vault's address (a personal account's rows for the same agent are left
 * out), with the live reading as the last point when it is readable, and the
 * window's two scores over the series.
 */
export function vaultPerformance(
  rows: readonly SnapshotRow[],
  reading: Pick<VaultReadingV3, "vault" | "state">,
  now: Date,
): VaultPerformanceJson {
  const vault = reading.vault;
  const own = vault ? rows.filter((r) => isAddressEqual(r.account, vault)) : [];
  const live =
    reading.state && reading.state.perUnitE18 !== null
      ? [
          {
            perUnit: reading.state.perUnitE18,
            createdAt: now,
            valueUsdc: reading.state.navUsdc,
            reason: "interval" as const,
          },
        ]
      : [];
  const series = perUnitSeries([...own, ...live]);
  const scores: VaultPerformanceJson["scores"] = {
    returnSinceStart: returnSinceStart(series),
    maxDrawdown: maxDrawdown(series),
  };
  return {
    series,
    scores,
    history: {
      points: own.length,
      from: own[0]?.createdAt.toISOString() ?? null,
      to: own[own.length - 1]?.createdAt.toISOString() ?? null,
    },
  };
}

export type { Score as VaultScore };
