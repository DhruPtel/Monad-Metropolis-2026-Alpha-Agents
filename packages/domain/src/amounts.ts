import { z } from "zod";

/**
 * Amounts and prices are bigints whose scale is part of the type name, and never
 * pass through floating point (Alpha Markets lesson 10). On the wire they are
 * decimal integer strings. Ratios are integer basis points.
 */
declare const scale: unique symbol;
type Scaled<S extends string> = bigint & { readonly [scale]: S };

/** USDC base units: 1 USDC = 1_000_000n. Every value and NAV is denominated in this. */
export type UsdcE6 = Scaled<"usdc-e6">;
/** A token amount in the token's own base units (its own decimals). */
export type AmountRaw = Scaled<"token-raw">;
/** The USDC value of one whole token, scaled by 1e18. */
export type PriceE18 = Scaled<"usdc-per-token-e18">;

declare const bpsBrand: unique symbol;
/** An integer number of basis points: 10_000 = 100%. */
export type Bps = number & { readonly [bpsBrand]: true };

export const BPS_DENOMINATOR = 10_000;
export const USDC_DECIMALS = 6;
export const PRICE_SCALE = 10n ** 18n;
/** One USDC as a price: USDC is treated as exactly 1 (FINAL_PLAN 4.1.9). */
export const USDC_PRICE_E18 = PRICE_SCALE as PriceE18;

function nonNegative(value: bigint, what: string): bigint {
  if (value < 0n) throw new RangeError(`${what} must not be negative`);
  return value;
}

export const usdcE6 = (value: bigint): UsdcE6 => nonNegative(value, "USDC amount") as UsdcE6;
export const amountRaw = (value: bigint): AmountRaw =>
  nonNegative(value, "token amount") as AmountRaw;
export const priceE18 = (value: bigint): PriceE18 => nonNegative(value, "price") as PriceE18;

export function bps(value: number): Bps {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("basis points must be a non-negative integer");
  }
  return value as Bps;
}

/**
 * The one conversion site from a token amount to its USDC value. Rounds down.
 * value = amount × price / 10^decimals, with the price's 1e18 scale removed
 * down to USDC's 1e6.
 */
export function valueUsdcE6(amount: AmountRaw, decimals: number, price: PriceE18): UsdcE6 {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError("decimals must be an integer from 0 to 36");
  }
  const scaleDown = 10n ** BigInt(decimals) * 10n ** BigInt(18 - USDC_DECIMALS);
  return ((amount * price) / scaleDown) as UsdcE6;
}

/** `part / whole` in basis points, rounded down. A zero whole gives 0. */
export function ratioBps(part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  return (part * BigInt(BPS_DENOMINATOR)) / whole;
}

/** True when `part / whole <= limitBps / 10_000`, exactly, without division. */
export function withinBps(part: bigint, whole: bigint, limitBps: number): boolean {
  return part * BigInt(BPS_DENOMINATOR) <= whole * BigInt(limitBps);
}

/** True when `part / whole >= limitBps / 10_000`, exactly, without division. */
export function atLeastBps(part: bigint, whole: bigint, limitBps: number): boolean {
  return part * BigInt(BPS_DENOMINATOR) >= whole * BigInt(limitBps);
}

const decimalInteger = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be a non-negative decimal integer string")
  .transform((s) => BigInt(s));

/** Wire schemas: decimal integer strings in, scaled bigints out. A JSON number is rejected. */
export const UsdcE6Schema = decimalInteger.transform((v) => v as UsdcE6);
export const AmountRawSchema = decimalInteger.transform((v) => v as AmountRaw);
export const PriceE18Schema = decimalInteger.transform((v) => v as PriceE18);
export const BpsSchema = z
  .number()
  .int()
  .min(0)
  .max(BPS_DENOMINATOR)
  .transform((v) => v as Bps);

export interface FormatAmountOptions {
  /** Digits kept after the point; extra digits are cut, never rounded up. Default 2. */
  readonly maxFractionDigits?: number;
  /** Digits always shown after the point, padding with zeros. Default 0. */
  readonly minFractionDigits?: number;
  /** Prefix positive values with "+". Default false. */
  readonly signed?: boolean;
}

/**
 * Formats a base-unit amount as a decimal string with thousands separators,
 * entirely in bigint arithmetic. `formatAmount(1234567890n, 6)` is "1,234.56".
 * Truncates toward zero so a display never overstates a balance.
 */
export function formatAmount(
  amount: bigint,
  decimals: number,
  options: FormatAmountOptions = {},
): string {
  const { maxFractionDigits = 2, minFractionDigits = 0, signed = false } = options;
  if (!Number.isSafeInteger(decimals) || decimals < 0)
    throw new RangeError("decimals must be a non-negative integer");
  if (minFractionDigits > maxFractionDigits)
    throw new RangeError("minFractionDigits exceeds maxFractionDigits");
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let fraction = (abs % scale).toString().padStart(decimals, "0").slice(0, maxFractionDigits);
  while (fraction.length > minFractionDigits && fraction.endsWith("0"))
    fraction = fraction.slice(0, -1);
  fraction = fraction.padEnd(minFractionDigits, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const isZero = whole === 0n && /^0*$/.test(fraction);
  const sign = negative && !isZero ? "-" : signed && !negative && !isZero ? "+" : "";
  return `${sign}${grouped}${fraction ? `.${fraction}` : ""}`;
}
