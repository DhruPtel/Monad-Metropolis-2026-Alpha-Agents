import { staleFeedMessage } from "@alpha-agents/domain";
import type { AssetRow, OlderAccountLine } from "@alpha-agents/ui";
import { type Address, isAddressEqual } from "viem";
import type { DepositTokenJson, HoldingV3Json, PortfolioV3Json } from "@/api/client";
import { type DepositBlock, DEPOSIT_BLOCK_MESSAGES, type DepositCheck } from "./portfolio";

/**
 * The portfolio page's arithmetic and rules on the fund agent's set (A-80,
 * after the F-U11 playtest), pure so every state is tested without a chain:
 * every held token's value and share, the account at a glance, the room
 * under the v3 factory's caps, every reason a deposit of any registered
 * token would be refused (checked before anything is sent), withdrawals of
 * any held token, what is held for a claim, and the older v2 account's lines.
 */
const E18 = 10n ** 18n;
const BPS = 10_000n;
/** CustodyCoreV3.MAX_DEPEG_BPS: USDC more than 1% from $1 refuses deposits. */
const MAX_DEPEG_BPS = 100n;

export const isUsdc = (p: PortfolioV3Json, token: Address) =>
  isAddressEqual(token, p.contracts.usdc);

/** Every held token as the makeup table and the donut show it: value, share of the priced total, cost basis, gain. */
export function assetRows(p: PortfolioV3Json): AssetRow[] {
  const held = p.holdings.filter((h) => BigInt(h.amountRaw) > 0n);
  const total = held.reduce(
    (t, h) => t + (h.valueUsdcE6 === null ? 0n : BigInt(h.valueUsdcE6)),
    0n,
  );
  return held
    .map((h) => {
      const cash = isUsdc(p, h.token);
      const value = h.valueUsdcE6 === null ? null : BigInt(h.valueUsdcE6);
      const basis = cash ? value : BigInt(h.costBasisUsdcE6);
      const gain = !cash && value !== null ? value - BigInt(h.costBasisUsdcE6) : null;
      return {
        symbol: h.symbol,
        decimals: h.decimals,
        amountRaw: h.amountRaw,
        isCash: cash,
        valueUsdcE6: h.valueUsdcE6,
        shareBps: value === null || total === 0n ? null : Number((value * BPS) / total),
        costBasisUsdcE6: basis === null ? null : basis.toString(),
        gainUsdcE6: gain === null ? null : gain.toString(),
        gainBps:
          gain === null || basis === null || basis === 0n ? null : Number((gain * BPS) / basis),
      };
    })
    .sort((a, b) => Number(BigInt(b.valueUsdcE6 ?? "-1") - BigInt(a.valueUsdcE6 ?? "-1")));
}

/** The account at a glance: the rows, the total, the mode, the drawdown and the prices' state. */
export function overviewV3(p: PortfolioV3Json) {
  const held = p.holdings.filter((h) => BigInt(h.amountRaw) > 0n);
  const priced = held.filter((h) => h.valueUsdcE6 !== null);
  const ages = held
    .filter((h) => !isUsdc(p, h.token) && h.valueUsdcE6 !== null)
    .map((h) => {
      const t = p.tokens.find((x) => isAddressEqual(x.address, h.token));
      return t ? Math.max(0, p.timestamp - t.price.updatedAt) : null;
    })
    .filter((a): a is number => a !== null);
  return {
    rows: assetRows(p),
    totalValueUsdcE6: p.navUsdcE6,
    mode: p.mode ?? ("NORMAL" as const),
    drawdownBps: p.breaker?.drawdownBps ?? null,
    prices: {
      priced: priced.length,
      held: held.length,
      oldestAgeSeconds: ages.length === 0 ? null : Math.max(...ages),
    },
  };
}

/** USDC base units still allowed in under each beta cap of the v3 factory. */
export function capRoomV3(p: PortfolioV3Json) {
  const personal = BigInt(p.caps.personalUsdcE6) - BigInt(p.caps.principalUsdcE6);
  const platform = BigInt(p.caps.platformUsdcE6) - BigInt(p.caps.platformTotalUsdcE6);
  const clamp = (v: bigint) => (v > 0n ? v : 0n);
  return {
    personal: clamp(personal),
    platform: clamp(platform),
    room: clamp(personal < platform ? personal : platform),
  };
}

export type DepositBlockV3 = DepositBlock | "TOKEN_NOT_DEPOSITABLE" | "HELD_PRICE_UNAVAILABLE";

export const DEPOSIT_BLOCK_MESSAGES_V3: Readonly<Record<DepositBlockV3, string>> = {
  ...DEPOSIT_BLOCK_MESSAGES,
  WMON_PRICE_UNAVAILABLE:
    "This token's price is unavailable right now, so the account cannot value the deposit. Try again shortly.",
  TOKEN_NOT_DEPOSITABLE:
    "This token cannot be deposited: the account takes USDC and the registry's core tokens with a price feed.",
  HELD_PRICE_UNAVAILABLE:
    "A held token's price is unavailable right now, so the account cannot value a deposit. Try again shortly.",
};

export interface DepositCheckV3 extends Omit<DepositCheck, "block"> {
  readonly block: DepositBlockV3 | null;
}

const refuse = (
  block: DepositBlockV3,
  valueUsdc: bigint | null = null,
  message: string = DEPOSIT_BLOCK_MESSAGES_V3[block],
): DepositCheckV3 => ({ ok: false, block, message, valueUsdc });

/** A token's value in USDC base units at a 1e18 price. */
export const valueOf = (amount: bigint, priceE18: bigint, decimals: number) =>
  (amount * priceE18) / 10n ** BigInt(12 + decimals);

/**
 * Whether a deposit of a token would go through, in the order
 * PersonalAccountV3.deposit checks it, with the allowlist first because it is
 * the one the owner cannot wait out.
 */
export function depositCheckV3(p: PortfolioV3Json, token: Address, amount: bigint): DepositCheckV3 {
  if (p.allowlist.enabled && !p.allowlist.listed) return refuse("NOT_ALLOWLISTED");
  if (!p.account) return refuse("NO_ACCOUNT");
  const t = p.tokens.find((x) => isAddressEqual(x.address, token));
  if (!t) return refuse("TOKEN_NOT_DEPOSITABLE");
  if (amount <= 0n) return refuse("ZERO_AMOUNT");
  if (amount > BigInt(t.walletRaw)) return refuse("OVER_WALLET");
  if (p.mode === "PAUSED") return refuse("PAUSED");
  if (p.depositsClosed) return refuse("DEPOSITS_CLOSED");
  if (p.usdcPeg.reason !== "OK")
    return p.usdcPeg.reason === "STALE"
      ? refuse(
          "USDC_PRICE_UNAVAILABLE",
          null,
          staleFeedMessage({
            feed: "USDC_USD",
            updatedAt: p.usdcPeg.updatedAt,
            now: p.timestamp,
            refused: "deposit",
          }),
        )
      : refuse("USDC_PRICE_UNAVAILABLE");
  const peg = BigInt(p.usdcPeg.priceE18);
  const off = peg > E18 ? peg - E18 : E18 - peg;
  if (off * BPS > MAX_DEPEG_BPS * E18) return refuse("USDC_DEPEGGED");
  const cash = isUsdc(p, token);
  if (!cash && t.price.reason !== "OK")
    return t.price.reason === "STALE"
      ? refuse(
          "WMON_PRICE_UNAVAILABLE",
          null,
          staleFeedMessage({
            feed: t.symbol === "WMON" ? "MON_USD" : "MON_USD",
            updatedAt: t.price.updatedAt,
            now: p.timestamp,
            refused: "deposit",
          }),
        )
      : refuse("WMON_PRICE_UNAVAILABLE");
  // The account values every held token when it takes a deposit; one unusable price refuses it.
  if (p.holdings.some((h) => BigInt(h.amountRaw) > 0n && h.valueUsdcE6 === null))
    return refuse("HELD_PRICE_UNAVAILABLE");
  const value = cash ? amount : valueOf(amount, BigInt(t.price.priceE18), t.decimals);
  const room = capRoomV3(p);
  if (value > room.personal) return refuse("PERSONAL_CAP", value);
  if (value > room.platform) return refuse("PLATFORM_CAP", value);
  return { ok: true, block: null, message: null, valueUsdc: value };
}

/** Whether a withdrawal can be asked for: only the free balance matters, never the mode or a price. */
export function withdrawCheckV3(p: PortfolioV3Json, token: Address, amount: bigint): string | null {
  if (!p.account) return "There is no trading account to withdraw from.";
  if (amount <= 0n) return "Enter an amount greater than zero.";
  const h = p.holdings.find((x) => isAddressEqual(x.token, token));
  const free = h ? BigInt(h.freeRaw) : 0n;
  if (amount > free)
    return h && BigInt(h.amountRaw) > free
      ? "Part of this token is spoken for by a trade in flight; the rest can be withdrawn."
      : "The account does not hold that much.";
  return null;
}

/** The held tokens the owner can withdraw, largest free balance first. */
export const withdrawable = (p: PortfolioV3Json): HoldingV3Json[] =>
  p.holdings
    .filter((h) => BigInt(h.freeRaw) > 0n)
    .sort((a, b) => Number(BigInt(b.valueUsdcE6 ?? "0") - BigInt(a.valueUsdcE6 ?? "0")));

/** The depositable tokens, USDC first, then by the wallet's balance. */
export const depositTokens = (p: PortfolioV3Json): DepositTokenJson[] =>
  [...p.tokens].sort((a, b) =>
    isUsdc(p, a.address)
      ? -1
      : isUsdc(p, b.address)
        ? 1
        : Number(BigInt(b.walletRaw) - BigInt(a.walletRaw)),
  );

/** Tokens with an amount held back from a failed transfer, for the claim action. */
export function claimablesV3(p: PortfolioV3Json) {
  return p.holdings
    .filter((h) => BigInt(h.claimableRaw) > 0n)
    .map((h) => ({
      symbol: h.symbol,
      token: h.token,
      decimals: h.decimals,
      amount: BigInt(h.claimableRaw),
    }));
}

/** The older v2 account's lines for its card, or null without one. */
export function legacyLines(p: PortfolioV3Json): OlderAccountLine[] | null {
  const l = p.legacy;
  if (!l) return null;
  return [
    {
      symbol: "USDC",
      decimals: 6,
      raw: BigInt(l.usdcE6),
      claimableRaw: BigInt(l.claimable.usdcE6),
    },
    {
      symbol: "WMON",
      decimals: 18,
      raw: BigInt(l.wmonWei),
      claimableRaw: BigInt(l.claimable.wmonWei),
    },
  ];
}
