import { lockWords, lockupWords, whenUtc } from "@alpha-agents/ui";
import type { VaultJson } from "@/api/client";
import { ALLOWLIST_WAIT_MESSAGE } from "./custody";

/**
 * The vault page's decisions (P7-U4), pure so tests drive every state: what
 * blocks a deposit or a withdrawal before anything is sent, in the order the
 * contracts check it; the previews (shares for USDC, USDC and the in-kind
 * slices for shares); the minimums the wallet's calls carry; and the words.
 */
const E18 = 10n ** 18n;
const BPS = 10_000n;
/** Shares per USDC base unit into an empty vault (StrategyVaultV3.VIRTUAL_SHARES). */
const VIRTUAL_SHARES = 10n ** 12n;
/** USDC's peg may be this far from $1 before deposits are refused (CustodyCoreV3). */
const MAX_DEPEG_BPS = 100n;
/** The USDC path pays from the vault's USDC above this share of its value (StrategyVaultV3.USDC_FLOOR_BPS). */
const USDC_FLOOR_BPS = 1_000n;
/** How far the value may move between the reading and the transaction before the minimum refuses it. */
const TOLERANCE_BPS = 300n;

export type VaultDepositBlock =
  | "NO_VAULT"
  | "NOT_CONNECTED"
  | "HANDOVER"
  | "WIND_DOWN"
  | "PAUSED"
  | "DEPOSITS_CLOSED"
  | "DEPOSITS_NOT_OPEN"
  | "NOT_ALLOWLISTED"
  | "PUBLIC_DEPOSITS_OFF"
  | "USDC_PRICE_UNAVAILABLE"
  | "USDC_DEPEGGED"
  | "HELD_PRICE_UNAVAILABLE"
  | "NO_ROOM";

export const VAULT_DEPOSIT_BLOCK_MESSAGES: Readonly<Record<VaultDepositBlock, string>> = {
  NO_VAULT: "This agent has no vault yet.",
  NOT_CONNECTED: "Connect your wallet to deposit.",
  HANDOVER:
    "The agent changed hands. The vault takes no deposits until the new owner stakes and accepts management.",
  WIND_DOWN: "The vault is winding down and takes no deposits. Withdrawals still work.",
  PAUSED: "The vault is paused, so it takes no deposits. Withdrawals still work.",
  DEPOSITS_CLOSED: "A tightener closed deposits to this vault. Withdrawals still work.",
  DEPOSITS_NOT_OPEN: "The leader has not opened deposits yet.",
  NOT_ALLOWLISTED: ALLOWLIST_WAIT_MESSAGE,
  PUBLIC_DEPOSITS_OFF:
    "Until the launch decision, only wallets the platform has allowed may deposit into a vault, and yours is not yet one of them. Ask the platform to add it, then try again.",
  USDC_PRICE_UNAVAILABLE: "The USDC price is unusable right now, so the vault takes no deposits.",
  USDC_DEPEGGED: "USDC is away from $1 right now, so the vault takes no deposits.",
  HELD_PRICE_UNAVAILABLE:
    "A token the vault holds has no usable price right now, so the vault takes no deposits.",
  NO_ROOM:
    "The vault can take nothing more from you now: its cap is reached, or the leader's stake would fall under 5%.",
};

/** Why nothing can be deposited now, in the contracts' order, or null. */
export function vaultDepositBlock(v: VaultJson): VaultDepositBlock | null {
  if (!v.vault || !v.state) return "NO_VAULT";
  if (!v.viewer) return "NOT_CONNECTED";
  const s = v.state;
  if (s.inHandover) return "HANDOVER";
  if (s.windDownAt !== 0) return "WIND_DOWN";
  if (s.mode === "PAUSED") return "PAUSED";
  if (s.depositsClosed) return "DEPOSITS_CLOSED";
  if (!s.depositsOpen && !v.viewer.isOwner) return "DEPOSITS_NOT_OPEN";
  if (!v.viewer.allowlisted) {
    if (v.factory.allowlistEnabled) return "NOT_ALLOWLISTED";
    if (!v.factory.depositsEnabled) return "PUBLIC_DEPOSITS_OFF";
  }
  if (v.usdcPeg.reason !== "OK") return "USDC_PRICE_UNAVAILABLE";
  const peg = BigInt(v.usdcPeg.priceE18);
  const off = peg > E18 ? peg - E18 : E18 - peg;
  if (off * BPS > MAX_DEPEG_BPS * E18) return "USDC_DEPEGGED";
  if (s.holdings.some((h) => BigInt(h.amountRaw) > 0n && h.valueUsdcE6 === null))
    return "HELD_PRICE_UNAVAILABLE";
  if (depositRoom(v) === 0n) return "NO_ROOM";
  return null;
}

/** The most this wallet can deposit now: the vault's own answer, bounded by the room under the vault cap. */
export function depositRoom(v: VaultJson): bigint {
  if (!v.viewer || !v.state) return 0n;
  const cap = BigInt(v.factory.vaultCapUsdcE6);
  const principal = BigInt(v.state.principalUsdcE6);
  const capRoom = cap > principal ? cap - principal : 0n;
  const platformRoom =
    BigInt(v.factory.platformCapUsdcE6) > BigInt(v.factory.platformTotalUsdcE6)
      ? BigInt(v.factory.platformCapUsdcE6) - BigInt(v.factory.platformTotalUsdcE6)
      : 0n;
  const own = BigInt(v.viewer.maxDepositUsdcE6);
  return [own, capRoom, platformRoom].reduce((a, b) => (a < b ? a : b));
}

/** The shares `assets` USDC would mint now, as the vault prices them (the value plus the spread; the virtual rate into an empty vault). */
export function previewShares(v: VaultJson, assets: bigint): bigint | null {
  if (!v.state) return null;
  const supply = BigInt(v.state.totalSupply);
  if (supply === 0n) return assets * VIRTUAL_SHARES;
  if (v.state.navUsdcE6 === null) return null;
  const nav = BigInt(v.state.navUsdcE6);
  const spread = BigInt(v.state.constants.spreadBps);
  const navBuy = nav + (nav * spread + BPS - 1n) / BPS;
  return (assets * (supply + VIRTUAL_SHARES)) / (navBuy + 1n);
}

/** The fewest shares the deposit accepts: the preview less the tolerance, exact into an empty vault. */
export function minSharesOut(v: VaultJson, assets: bigint): bigint {
  const shares = previewShares(v, assets);
  if (shares === null) return 0n;
  if (v.state && BigInt(v.state.totalSupply) === 0n) return shares;
  return (shares * (BPS - TOLERANCE_BPS)) / BPS;
}

/** When shares deposited now would unlock, unix seconds. */
export function lockUntil(v: VaultJson, now: number): number {
  return now + (v.state?.lockupSeconds ?? 0);
}

/** The warning before a top-up, or null when the wallet holds no shares. */
export function topUpWarning(v: VaultJson, now: number): string | null {
  if (!v.viewer || !v.state || BigInt(v.viewer.shares) === 0n) return null;
  return `You already hold shares. This deposit locks all of them, old and new, for ${lockupWords(v.state.lockupSeconds)}: until ${whenUtc(lockUntil(v, now))}.`;
}

/** What the viewer's shares would pay on the USDC path, scaled to `shares`; null while unknown. */
export function previewUsdc(v: VaultJson, shares: bigint): bigint | null {
  if (!v.viewer || v.viewer.valueUsdcE6 === null) return null;
  const held = BigInt(v.viewer.shares);
  if (held === 0n) return 0n;
  return (BigInt(v.viewer.valueUsdcE6) * shares) / held;
}

/** The in-kind slices scaled to `shares`; null while unknown. */
export function previewInKind(v: VaultJson, shares: bigint) {
  if (!v.viewer || !v.viewer.inKind) return null;
  const held = BigInt(v.viewer.shares);
  if (held === 0n) return [];
  return v.viewer.inKind.map((a) => ({
    symbol: a.symbol,
    decimals: a.decimals,
    amountRaw: ((BigInt(a.amountRaw) * shares) / held).toString(),
  }));
}

/** The USDC the vault can pay out now above its 10% floor, or null while its value is unknown. */
export function usdcAvailable(v: VaultJson): bigint | null {
  if (!v.state || v.state.navUsdcE6 === null) return null;
  const usdcHeld = v.state.holdings.find(
    (h) => h.token.toLowerCase() === v.contracts.usdc.toLowerCase(),
  );
  const held = BigInt(usdcHeld?.amountRaw ?? "0");
  const floor = (BigInt(v.state.navUsdcE6) * USDC_FLOOR_BPS) / BPS;
  return held > floor ? held - floor : 0n;
}

/** The fewest USDC a USDC exit accepts: the preview less the tolerance. */
export function minAssetsOut(v: VaultJson, shares: bigint): bigint {
  const usdc = previewUsdc(v, shares);
  return usdc === null ? 0n : (usdc * (BPS - TOLERANCE_BPS)) / BPS;
}

/** Why nothing can be withdrawn now, or null. Only the lock and the shares matter: never the mode or a price. */
export function vaultWithdrawBlock(v: VaultJson, now: number): string | null {
  if (!v.vault || !v.state) return "This agent has no vault yet.";
  if (!v.viewer) return "Connect your wallet to withdraw.";
  const held = BigInt(v.viewer.shares);
  if (held === 0n) return "You hold no shares of this vault.";
  if (BigInt(v.viewer.freeShares) === 0n && v.viewer.unlockAt > now)
    return `Your shares are ${lockWords(v.viewer.unlockAt, now).toLowerCase()}.`;
  return null;
}

/** The vault's least supply before deposits may open: 1 USDC of stake (StrategyVaultV3.MIN_SUPPLY_TO_OPEN). */
const MIN_SUPPLY_TO_OPEN = E18;

/**
 * The leader's setup in the order the vault requires it (StrategyVaultV3's
 * setDepositsOpen): a stake of at least 1 USDC that is at least the leader
 * minimum of the vault, then open deposits. `openBlock` is the plain reason
 * opening would revert now, or null when it would go through.
 */
export function leaderSetup(v: VaultJson): { staked: boolean; openBlock: string | null } {
  const s = v.state;
  if (!s) return { staked: false, openBlock: "Create the vault first." };
  const stake = BigInt(s.leaderShares);
  const supply = BigInt(s.totalSupply);
  const staked =
    stake > 0n &&
    supply >= MIN_SUPPLY_TO_OPEN &&
    stake * BPS >= BigInt(s.constants.leaderMinBps) * supply;
  const min = `${s.constants.leaderMinBps / 100}%`;
  const openBlock =
    s.windDownAt !== 0
      ? "The vault is winding down, so deposits cannot open."
      : s.inHandover
        ? "The vault is in a handover: deposits open once the new owner stakes and accepts management."
        : stake === 0n
          ? `Stake first: deposits open only once you have staked at least 1 USDC and your stake is at least ${min} of the vault.`
          : !staked
            ? supply < MIN_SUPPLY_TO_OPEN
              ? "Stake more first: the vault needs at least 1 USDC of stake before deposits open."
              : `Stake more first: your stake must be at least ${min} of the vault before deposits open.`
            : null;
  return { staked, openBlock };
}
