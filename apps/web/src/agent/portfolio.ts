import type { Address } from "viem";
import type { PortfolioJson } from "@/api/client";

/**
 * The portfolio page's arithmetic and rules (P2-U7), pure so every state is
 * tested without a chain: positions with each asset's value and share, the
 * price's age, the room left under the beta caps, and every reason a deposit
 * would be refused, checked before anything is sent so the owner reads it
 * first, not as a revert. Withdrawals have no such checks: they need no price
 * and no platform, and work in every mode.
 */

export type Asset = "USDC" | "WMON";
export const DECIMALS: Readonly<Record<Asset, number>> = { USDC: 6, WMON: 18 };

/**
 * A-50: below this much MON the wallet is warned it cannot pay gas to arm,
 * deposit or withdraw: 0.05 MON covers a few owner transactions at Monad's
 * fees (each is one or two calls of at most a few hundred thousand gas).
 */
export const LOW_GAS_WEI = 50_000_000_000_000_000n;

/** A price older than this reads as stale here; the oracle's own reason is the real rule. */
export const PRICE_FRESH_SECONDS = 300;

export interface Positions {
  readonly usdc: bigint;
  readonly wmon: bigint;
  /** WMON's value in USDC base units at the oracle price; null when the price is unusable. */
  readonly wmonValueUsdc: bigint | null;
  /** Null when WMON is held and its price is unusable. */
  readonly totalUsdc: bigint | null;
  /** Each asset's share of the account in basis points; null without a usable total. */
  readonly usdcShareBps: number | null;
  readonly wmonShareBps: number | null;
}

export const priceUsable = (p: PortfolioJson) => p.prices.monUsd.reason === "OK";

/** USDC base units for a WMON amount at a 1e18 USD price. */
export const wmonToUsdc = (wmonWei: bigint, priceE18: bigint) => (wmonWei * priceE18) / 10n ** 30n;

export function positions(p: PortfolioJson): Positions {
  const usdc = BigInt(p.balances.usdcE6);
  const wmon = BigInt(p.balances.wmonWei);
  const wmonValueUsdc = priceUsable(p) ? wmonToUsdc(wmon, BigInt(p.prices.monUsd.priceE18)) : null;
  const totalUsdc = wmon === 0n ? usdc : wmonValueUsdc === null ? null : usdc + wmonValueUsdc;
  const share = (part: bigint | null) =>
    totalUsdc === null || part === null
      ? null
      : totalUsdc === 0n
        ? 0
        : Number((part * 10_000n) / totalUsdc);
  return {
    usdc,
    wmon,
    wmonValueUsdc,
    totalUsdc,
    usdcShareBps: share(usdc),
    wmonShareBps: share(wmon === 0n ? 0n : wmonValueUsdc),
  };
}

/** How old the oracle's price is, in seconds at the block's time. */
export const priceAgeSeconds = (p: PortfolioJson, which: "monUsd" | "usdcUsd" = "monUsd") =>
  Math.max(0, p.timestamp - p.prices[which].updatedAt);

/** USDC base units still allowed in under each beta cap. */
export function capRoom(p: PortfolioJson) {
  const personal = BigInt(p.caps.personalUsdcE6) - BigInt(p.caps.principalUsdcE6);
  const platform = BigInt(p.caps.platformUsdcE6) - BigInt(p.caps.platformTotalUsdcE6);
  const clamp = (v: bigint) => (v > 0n ? v : 0n);
  return {
    personal: clamp(personal),
    platform: clamp(platform),
    room: clamp(personal < platform ? personal : platform),
  };
}

export type DepositBlock =
  | "NO_ACCOUNT"
  | "NOT_ALLOWLISTED"
  | "ZERO_AMOUNT"
  | "OVER_WALLET"
  | "PAUSED"
  | "DEPOSITS_CLOSED"
  | "USDC_DEPEGGED"
  | "USDC_PRICE_UNAVAILABLE"
  | "WMON_PRICE_UNAVAILABLE"
  | "PERSONAL_CAP"
  | "PLATFORM_CAP";

export const DEPOSIT_BLOCK_MESSAGES: Readonly<Record<DepositBlock, string>> = {
  NO_ACCOUNT: "Open the trading account first.",
  NOT_ALLOWLISTED:
    "This wallet is not on the beta deposit allowlist yet, so the account would refuse the deposit.",
  ZERO_AMOUNT: "Enter an amount greater than zero.",
  OVER_WALLET: "Your wallet does not hold that much.",
  PAUSED: "The account is paused, so it takes no deposits. Withdrawals still work.",
  DEPOSITS_CLOSED: "Deposits to this account are closed. Withdrawals still work.",
  USDC_DEPEGGED:
    "USDC is more than 1% away from $1, so deposits are refused until it recovers (the depeg guard). Withdrawals still work.",
  USDC_PRICE_UNAVAILABLE:
    "The USDC price check is unavailable right now, so deposits are refused until it answers. Withdrawals still work.",
  WMON_PRICE_UNAVAILABLE:
    "The WMON price is unavailable right now, so the account cannot value this deposit. Try again shortly.",
  PERSONAL_CAP: "This deposit would take the account past its beta cap.",
  PLATFORM_CAP: "This deposit would take the platform past its beta cap.",
};

export interface DepositCheck {
  readonly ok: boolean;
  readonly block: DepositBlock | null;
  readonly message: string | null;
  /** The deposit's value in USDC base units, when it can be priced. */
  readonly valueUsdc: bigint | null;
}

const refuse = (block: DepositBlock, valueUsdc: bigint | null = null): DepositCheck => ({
  ok: false,
  block,
  message: DEPOSIT_BLOCK_MESSAGES[block],
  valueUsdc,
});

/**
 * Whether a deposit would go through, in the order the account checks it,
 * with the allowlist first because it is the one the owner cannot wait out.
 */
export function depositCheck(p: PortfolioJson, asset: Asset, amount: bigint): DepositCheck {
  if (p.allowlist.enabled && !p.allowlist.listed) return refuse("NOT_ALLOWLISTED");
  if (!p.account) return refuse("NO_ACCOUNT");
  if (amount <= 0n) return refuse("ZERO_AMOUNT");
  const held = asset === "USDC" ? BigInt(p.wallet.usdcE6) : BigInt(p.wallet.wmonWei);
  if (amount > held) return refuse("OVER_WALLET");
  if (p.mode === "PAUSED") return refuse("PAUSED");
  if (p.depositsClosed) return refuse("DEPOSITS_CLOSED");
  const peg = p.prices.usdcUsd.reason;
  if (peg === "USDC_DEPEGGED") return refuse("USDC_DEPEGGED");
  if (peg !== "OK") return refuse("USDC_PRICE_UNAVAILABLE");
  const holdsWmon = BigInt(p.balances.wmonWei) > 0n;
  if ((asset === "WMON" || holdsWmon) && !priceUsable(p)) return refuse("WMON_PRICE_UNAVAILABLE");
  const value = asset === "USDC" ? amount : wmonToUsdc(amount, BigInt(p.prices.monUsd.priceE18));
  const room = capRoom(p);
  if (value > room.personal) return refuse("PERSONAL_CAP", value);
  if (value > room.platform) return refuse("PLATFORM_CAP", value);
  return { ok: true, block: null, message: null, valueUsdc: value };
}

/** Whether a withdrawal can be asked for: only the amount matters, never the mode or a price. */
export function withdrawCheck(p: PortfolioJson, asset: Asset, amount: bigint): string | null {
  if (!p.account) return "There is no trading account to withdraw from.";
  if (amount <= 0n) return "Enter an amount greater than zero.";
  const held = asset === "USDC" ? BigInt(p.balances.usdcE6) : BigInt(p.balances.wmonWei);
  if (amount > held) return "The account does not hold that much.";
  return null;
}

/** Parses a decimal amount in token units; null if it is not a number with at most `decimals` places. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Assets with credits held back from a failed transfer, for the claim action. */
export function claimables(p: PortfolioJson): { asset: Asset; token: Address; amount: bigint }[] {
  const out: { asset: Asset; token: Address; amount: bigint }[] = [];
  const usdc = BigInt(p.claimable.usdcE6);
  const wmon = BigInt(p.claimable.wmonWei);
  if (usdc > 0n) out.push({ asset: "USDC", token: p.contracts.usdc, amount: usdc });
  if (wmon > 0n) out.push({ asset: "WMON", token: p.contracts.wmon, amount: wmon });
  return out;
}
