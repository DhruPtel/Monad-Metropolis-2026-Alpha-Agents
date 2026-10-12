import { type Address, type Hex, decodeFunctionData, getAddress } from "viem";
import { ERC20_ABI, FACTORY_ABI, VAULT_ABI } from "../src/agent/custody";
import type { VaultJson, VaultResponseJson } from "../src/api/client";
import type { FakeChain } from "./fake-chain";
import { FUNDING_ADDRESS } from "./fake-api";
import { FACTORY_V3, NOW, ORACLE_V3, USDC, WMON } from "./fake-trading";

/**
 * The agent's vault as the fake API serves it (P7-U4) and as the fake chain
 * applies the wallet's calls to it: the owner creates it on the v3 factory,
 * a deposit mints shares at the vault's price and locks the wallet's shares
 * for the lockup, a USDC exit pays from the vault's USDC, an in-kind exit pays
 * every token pro rata, a claim empties a credit, and the leader opens or
 * closes deposits. Every test states the vault it starts from.
 */
export const VAULT = getAddress("0x6e3c9a1b3e5f60718293a4b5c6d7e8f90a1b2c40");
export const WBTC_VAULT = "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as const;
const E18 = 10n ** 18n;
const BPS = 10_000n;
const SPREAD_BPS = 50n;
const VIRTUAL_SHARES = 10n ** 12n;
const LOCKUP = 86_400;
const iso = (s: number) => new Date(s * 1000).toISOString();

export interface FakePosition {
  shares: bigint;
  unlockAt: number;
  /** Credits held back for the wallet, by token. */
  claimables?: Partial<Record<"USDC" | "WMON", bigint>>;
}

export interface FakeVaultState {
  /** Null before the owner creates the vault. */
  vault: Address | null;
  owner: Address;
  mode: NonNullable<VaultJson["state"]>["mode"];
  inHandover: boolean;
  windDownAt: number;
  depositsOpen: boolean;
  depositsClosed: boolean;
  /** Each held token's balance, in base units. */
  usdc: bigint;
  wmon: bigint;
  wbtc: bigint;
  /** 1e18 prices: USDC 1, WMON 0.025, WBTC 100,000. */
  principal: bigint;
  totalSupply: bigint;
  leaderShares: bigint;
  positions: Map<string, FakePosition>;
  allowlisted: Set<string>;
  allowlistEnabled: boolean;
  depositsEnabled: boolean;
  usdcWallet: Map<string, bigint>;
}

const PX_WMON = 25n * 10n ** 15n;
const PX_WBTC = 100_000n * E18;
const value = (amount: bigint, priceE18: bigint, decimals: number) =>
  (amount * priceE18) / 10n ** BigInt(12 + decimals);

/** A vault with the leader's 20 USDC stake and two depositors' 30 each, traded into WMON and WBTC, worth 82 USDC. */
export function vaultFixture(owner: Address, over: Partial<FakeVaultState> = {}): FakeVaultState {
  return {
    vault: VAULT,
    owner,
    mode: "NORMAL",
    inHandover: false,
    windDownAt: 0,
    depositsOpen: true,
    depositsClosed: false,
    usdc: 42_000_000n,
    wmon: 1_000n * E18,
    wbtc: 15_000n,
    principal: 80_000_000n,
    totalSupply: 80n * E18,
    leaderShares: 20n * E18,
    positions: new Map([[owner.toLowerCase(), { shares: 20n * E18, unlockAt: NOW - 3_600 }]]),
    allowlisted: new Set([owner.toLowerCase()]),
    allowlistEnabled: true,
    depositsEnabled: false,
    usdcWallet: new Map(),
    ...over,
  };
}

/** Before the owner creates the vault. */
export function noVaultFixture(owner: Address): FakeVaultState {
  return vaultFixture(owner, {
    vault: null,
    usdc: 0n,
    wmon: 0n,
    wbtc: 0n,
    principal: 0n,
    totalSupply: 0n,
    leaderShares: 0n,
    depositsOpen: false,
    positions: new Map(),
  });
}

export class FakeVault {
  state: FakeVaultState;
  readonly calls: string[] = [];
  /** The snapshot readings the performance comes from: value per share at 1e18, oldest first. */
  series: {
    at: string;
    perUnitE18: string;
    valueUsdcE6: string | null;
    reason: "interval" | "trade";
  }[];
  funding: VaultResponseJson["funding"];

  constructor(chain: FakeChain, state: FakeVaultState) {
    this.state = state;
    this.series = state.vault
      ? Array.from({ length: 9 }, (_, i) => ({
          at: iso(NOW - (8 - i) * 3_600),
          perUnitE18: (
            E18 +
            BigInt(i) * 3n * 10n ** 15n -
            (i === 5 ? 12n * 10n ** 15n : 0n)
          ).toString(),
          valueUsdcE6: (80_000_000n + BigInt(i) * 250_000n).toString(),
          reason: i === 3 || i === 6 ? "trade" : "interval",
        }))
      : [];
    this.funding = {
      fundingAddress: FUNDING_ADDRESS,
      creditsUsdcE6: "4994400",
      spendableUsdcE6: "4994400",
      heldUsdcE6: "0",
      creditCapUsdcE6: "50000000",
    };
    chain.onSend = (tx) => this.onSend(chain, tx);
  }

  private nav(): bigint {
    const s = this.state;
    return s.usdc + value(s.wmon, PX_WMON, 18) + value(s.wbtc, PX_WBTC, 8);
  }

  private perUnit(): bigint | null {
    const s = this.state;
    return s.totalSupply === 0n ? null : (this.nav() * 10n ** 30n) / s.totalSupply;
  }

  private sharesFor(assets: bigint): bigint {
    const s = this.state;
    if (s.totalSupply === 0n) return assets * VIRTUAL_SHARES;
    const nav = this.nav();
    const navBuy = nav + (nav * SPREAD_BPS + BPS - 1n) / BPS;
    return (assets * (s.totalSupply + VIRTUAL_SHARES)) / (navBuy + 1n);
  }

  /** The API's answer for a viewer, or for nobody. */
  answer(wallet: string | null): VaultResponseJson {
    const s = this.state;
    const who = wallet ? getAddress(wallet) : null;
    const pos = who ? s.positions.get(who.toLowerCase()) : undefined;
    const shares = pos?.shares ?? 0n;
    const nav = this.nav();
    const navSell = nav - (nav * SPREAD_BPS + BPS - 1n) / BPS;
    const slice = (amount: bigint) =>
      s.totalSupply === 0n ? 0n : (amount * shares) / s.totalSupply;
    const holdings: NonNullable<VaultJson["state"]>["holdings"] = [
      {
        token: USDC,
        symbol: "USDC",
        decimals: 6,
        amountRaw: s.usdc.toString(),
        freeRaw: s.usdc.toString(),
        costBasisUsdcE6: "0",
        priceE18: E18.toString(),
        priceReason: "OK",
        valueUsdcE6: s.usdc.toString(),
      },
      {
        token: WMON,
        symbol: "WMON",
        decimals: 18,
        amountRaw: s.wmon.toString(),
        freeRaw: s.wmon.toString(),
        costBasisUsdcE6: "24000000",
        priceE18: PX_WMON.toString(),
        priceReason: "OK",
        valueUsdcE6: value(s.wmon, PX_WMON, 18).toString(),
      },
      {
        token: WBTC_VAULT,
        symbol: "WBTC",
        decimals: 8,
        amountRaw: s.wbtc.toString(),
        freeRaw: s.wbtc.toString(),
        costBasisUsdcE6: "14000000",
        priceE18: PX_WBTC.toString(),
        priceReason: "OK",
        valueUsdcE6: value(s.wbtc, PX_WBTC, 8).toString(),
      },
    ].filter((h) => BigInt(h.amountRaw) > 0n);
    const allowlisted = who ? s.allowlisted.has(who.toLowerCase()) : false;
    const leaderRoom =
      (s.leaderShares * BPS) / 500n > s.totalSupply
        ? (((s.leaderShares * BPS) / 500n - s.totalSupply) * (navSell + 1n)) /
          (s.totalSupply + VIRTUAL_SHARES)
        : 0n;
    const vault: VaultJson = {
      custody: "v3",
      chainId: 143143,
      block: "109670100",
      timestamp: NOW,
      agentId: "7",
      owner: s.owner,
      contracts: {
        agentNft: FACTORY_V3,
        accountFactory: FACTORY_V3,
        oracle: ORACLE_V3,
        usdc: USDC,
        wmon: WMON,
        executor: FACTORY_V3,
      },
      vault: s.vault,
      predictedVault: VAULT,
      factory: {
        vaultCapUsdcE6: "500000000",
        platformCapUsdcE6: "2000000000",
        platformTotalUsdcE6: (380_000_000n + s.principal).toString(),
        allowlistEnabled: s.allowlistEnabled,
        depositsEnabled: s.depositsEnabled,
      },
      usdcPeg: { priceE18: E18.toString(), updatedAt: NOW - 60, reason: "OK" },
      state: s.vault
        ? {
            leader: s.owner,
            leaderShares: s.leaderShares.toString(),
            leaderStakeBps:
              s.totalSupply === 0n ? 0 : Number((s.leaderShares * BPS) / s.totalSupply),
            incomingLeader: "0x0000000000000000000000000000000000000000",
            incomingShares: "0",
            totalSupply: s.totalSupply.toString(),
            principalUsdcE6: s.principal.toString(),
            navUsdcE6: nav.toString(),
            perUnitE18: this.perUnit()?.toString() ?? null,
            breaker: null,
            mode: s.mode,
            inHandover: s.inHandover,
            depositsOpen: s.depositsOpen,
            depositsClosed: s.depositsClosed,
            lockupSeconds: LOCKUP,
            feeBps: 0,
            windDownAt: s.windDownAt,
            pausedAt: 0,
            holdings,
            constants: {
              minLockupSeconds: 86_400,
              maxLockupSeconds: 604_800,
              leaderMinBps: 500,
              spreadBps: 50,
              handoverPeriodSeconds: 259_200,
            },
          }
        : null,
      viewer: who
        ? {
            address: who,
            isOwner: who.toLowerCase() === s.owner.toLowerCase(),
            isLeader: !!s.vault && who.toLowerCase() === s.owner.toLowerCase(),
            allowlisted,
            mayDeposit: allowlisted || (s.depositsEnabled && !s.allowlistEnabled),
            usdcWalletE6: (s.usdcWallet.get(who.toLowerCase()) ?? 120_000_000n).toString(),
            shares: shares.toString(),
            freeShares: pos && pos.unlockAt <= NOW ? shares.toString() : "0",
            lockedShares: pos && pos.unlockAt > NOW ? shares.toString() : "0",
            unlockAt: pos?.unlockAt ?? 0,
            valueUsdcE6:
              s.totalSupply === 0n ? null : ((shares * navSell) / s.totalSupply).toString(),
            maxDepositUsdcE6: !s.vault
              ? "0"
              : who.toLowerCase() === s.owner.toLowerCase()
                ? "500000000"
                : leaderRoom.toString(),
            inKind:
              shares > 0n
                ? holdings.map((h) => ({
                    token: h.token,
                    symbol: h.symbol,
                    decimals: h.decimals,
                    amountRaw: slice(BigInt(h.amountRaw)).toString(),
                  }))
                : null,
            claimables: Object.entries(pos?.claimables ?? {})
              .filter(([, v]) => (v ?? 0n) > 0n)
              .map(([sym, v]) => ({
                token: sym === "USDC" ? USDC : WMON,
                symbol: sym,
                decimals: sym === "USDC" ? 6 : 18,
                amountRaw: (v ?? 0n).toString(),
              })),
            entryPriceE18: E18.toString(),
          }
        : null,
    };
    const series = [...this.series];
    const live = this.perUnit();
    if (live !== null)
      series.push({
        at: iso(NOW),
        perUnitE18: live.toString(),
        valueUsdcE6: nav.toString(),
        reason: "interval",
      });
    const first = BigInt(series[0]?.perUnitE18 ?? "0");
    const last = BigInt(series[series.length - 1]?.perUnitE18 ?? "0");
    const enough = series.length >= 2 && first > 0n;
    let peak = 0n;
    let worst = 0n;
    for (const p of series) {
      const v = BigInt(p.perUnitE18);
      if (v > peak) peak = v;
      const fall = peak === 0n ? 0n : ((peak - v) * BPS) / peak;
      if (fall > worst) worst = fall;
    }
    return {
      vault,
      performance: {
        series,
        scores: {
          returnSinceStart: enough
            ? {
                ok: true,
                bps: Number(((last - first) * BPS) / first),
                since: series[0]?.at ?? "",
                asOf: series[series.length - 1]?.at ?? "",
              }
            : {
                ok: false,
                reason: "Not enough data yet: the account needs at least two readings.",
              },
          maxDrawdown: enough
            ? {
                ok: true,
                bps: Number(worst),
                peakAt: series[0]?.at ?? "",
                troughAt: series[series.length - 1]?.at ?? "",
              }
            : {
                ok: false,
                reason: "Not enough data yet: the account needs at least two readings.",
              },
        },
        history: {
          points: this.series.length,
          from: this.series[0]?.at ?? null,
          to: this.series[this.series.length - 1]?.at ?? null,
        },
      },
      funding: this.funding,
    };
  }

  /** The mock wallet's transactions, as the contracts would apply them. */
  private onSend(chain: FakeChain, tx: { from: Address; to: Address; data: Hex }) {
    const s = this.state;
    const to = tx.to.toLowerCase();
    const from = tx.from.toLowerCase();
    if (to === FACTORY_V3.toLowerCase()) {
      const call = decodeFunctionData({ abi: FACTORY_ABI, data: tx.data });
      if (call.functionName !== "createVault") return;
      this.calls.push("createVault");
      if (s.vault) throw new Error("VaultExists");
      if (from !== s.owner.toLowerCase()) throw new Error("NotAgentOwner");
      s.vault = VAULT;
      return;
    }
    if (to === USDC.toLowerCase()) {
      const call = decodeFunctionData({ abi: ERC20_ABI, data: tx.data });
      if (call.functionName === "approve") {
        const [spender, amount] = call.args as readonly [Address, bigint];
        this.calls.push(`approve ${spender === VAULT ? "vault" : spender} ${amount.toString()}`);
      }
      return;
    }
    if (!s.vault || to !== s.vault.toLowerCase()) return;
    const call = decodeFunctionData({ abi: VAULT_ABI, data: tx.data });
    const pos = s.positions.get(from) ?? { shares: 0n, unlockAt: 0 };
    switch (call.functionName) {
      case "deposit": {
        const [assets, minShares] = call.args as readonly [bigint, bigint];
        this.calls.push(`deposit ${assets.toString()} min ${minShares.toString()}`);
        const isOwner = from === s.owner.toLowerCase();
        if (!isOwner && !s.depositsOpen) throw new Error("DepositsNotOpen");
        if (s.allowlistEnabled && !s.allowlisted.has(from)) throw new Error("NotAllowlisted");
        const shares = this.sharesFor(assets);
        if (shares < minShares) throw new Error("SharesTooFew");
        s.usdc += assets;
        s.principal += assets;
        s.totalSupply += shares;
        if (isOwner) s.leaderShares += shares;
        s.positions.set(from, { ...pos, shares: pos.shares + shares, unlockAt: NOW + LOCKUP });
        s.usdcWallet.set(from, (s.usdcWallet.get(from) ?? 120_000_000n) - assets);
        chain.setBalance(USDC, tx.from, chain.balanceOf(USDC, tx.from) - assets);
        return;
      }
      case "redeem": {
        const [shares, , minAssets] = call.args as readonly [bigint, Address, bigint, bigint];
        this.calls.push(`redeem ${shares.toString()} min ${minAssets.toString()}`);
        if (pos.unlockAt > NOW) throw new Error("SharesLocked");
        if (shares > pos.shares) throw new Error("InsufficientShares");
        const nav = this.nav();
        const navSell = nav - (nav * SPREAD_BPS + BPS - 1n) / BPS;
        const owed = (shares * navSell) / s.totalSupply;
        const floor = (nav * 1_000n) / BPS;
        if (owed > (s.usdc > floor ? s.usdc - floor : 0n)) throw new Error("UseInKind");
        if (owed < minAssets) throw new Error("AssetsTooFew");
        s.usdc -= owed;
        s.principal -= owed > s.principal ? s.principal : owed;
        s.totalSupply -= shares;
        if (from === s.owner.toLowerCase()) s.leaderShares -= shares;
        s.positions.set(from, { ...pos, shares: pos.shares - shares });
        s.usdcWallet.set(from, (s.usdcWallet.get(from) ?? 120_000_000n) + owed);
        chain.setBalance(USDC, tx.from, chain.balanceOf(USDC, tx.from) + owed);
        return;
      }
      case "redeemInKind": {
        const [shares] = call.args as readonly [bigint, Address];
        this.calls.push(`redeemInKind ${shares.toString()}`);
        if (pos.unlockAt > NOW) throw new Error("SharesLocked");
        if (shares > pos.shares) throw new Error("InsufficientShares");
        const slice = (amount: bigint) => (amount * shares) / s.totalSupply;
        const usdcOut = slice(s.usdc);
        s.wmon -= slice(s.wmon);
        s.wbtc -= slice(s.wbtc);
        s.usdc -= usdcOut;
        s.principal -= usdcOut > s.principal ? s.principal : usdcOut;
        s.totalSupply -= shares;
        if (from === s.owner.toLowerCase()) s.leaderShares -= shares;
        s.positions.set(from, { ...pos, shares: pos.shares - shares });
        s.usdcWallet.set(from, (s.usdcWallet.get(from) ?? 120_000_000n) + usdcOut);
        return;
      }
      case "claim": {
        const [token] = call.args as readonly [Address, Address];
        const sym = token.toLowerCase() === USDC.toLowerCase() ? "USDC" : "WMON";
        this.calls.push(`claim ${sym}`);
        s.positions.set(from, { ...pos, claimables: { ...pos.claimables, [sym]: 0n } });
        return;
      }
      case "setDepositsOpen": {
        const [open] = call.args as readonly [boolean];
        this.calls.push(`setDepositsOpen ${String(open)}`);
        if (from !== s.owner.toLowerCase()) throw new Error("NotManager");
        if (open && s.totalSupply < E18) throw new Error("SeedTooSmall");
        s.depositsOpen = open;
        return;
      }
      default:
        return;
    }
  }
}
