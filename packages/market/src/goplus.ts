import { MarketError, type UpstreamDeps, getJson } from "./upstream.ts";

/**
 * GoPlus token security (F-U1, D-339): a second opinion, never the only
 * source. Keyless for Monad (chain 143); an API key only raises the limit,
 * and none is configured, so the platform runs without one. GoPlus's flags
 * can refuse a token the platform's own checks passed; its silence never
 * passes a token on its own.
 */
export const goplusUrl = (chainId: number, address: string) =>
  `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`;

/** Flags that mean the token can trap or tax a holder. */
export const GOPLUS_TRAP_FLAGS = [
  "is_honeypot",
  "cannot_sell_all",
  "cannot_buy",
  "selfdestruct",
] as const;
/** Flags that mean someone can change what a holder has. */
export const GOPLUS_POWER_FLAGS = [
  "is_blacklisted",
  "transfer_pausable",
  "owner_change_balance",
  "slippage_modifiable",
  "personal_slippage_modifiable",
  "hidden_owner",
  "can_take_back_ownership",
] as const;
export type GoPlusFlag =
  | (typeof GOPLUS_TRAP_FLAGS)[number]
  | (typeof GOPLUS_POWER_FLAGS)[number]
  | "is_proxy"
  | "tax_over_limit";

export interface GoPlusReport {
  readonly found: boolean;
  readonly flags: readonly GoPlusFlag[];
  /** Fractions of one, as GoPlus reports them; null when absent. */
  readonly buyTax: number | null;
  readonly sellTax: number | null;
  readonly transferTax: number | null;
  readonly holderCount: number | null;
  /** The largest holder's share, as a fraction of one, excluding contracts GoPlus marks locked. */
  readonly topHolderShare: number | null;
  readonly isOpenSource: boolean | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseGoPlus(body: unknown, address: string, maxTax: number): GoPlusReport {
  const b = body as { code?: unknown; result?: Record<string, Record<string, unknown>> } | null;
  const r = b?.result?.[address.toLowerCase()];
  if (!r)
    return {
      found: false,
      flags: [],
      buyTax: null,
      sellTax: null,
      transferTax: null,
      holderCount: null,
      topHolderShare: null,
      isOpenSource: null,
    };
  const flags: GoPlusFlag[] = [];
  for (const f of [...GOPLUS_TRAP_FLAGS, ...GOPLUS_POWER_FLAGS]) if (r[f] === "1") flags.push(f);
  if (r.is_proxy === "1") flags.push("is_proxy");
  const buyTax = num(r.buy_tax);
  const sellTax = num(r.sell_tax);
  const transferTax = num(r.transfer_tax);
  if ([buyTax, sellTax, transferTax].some((t) => t !== null && t > maxTax))
    flags.push("tax_over_limit");
  const holders = Array.isArray(r.holders) ? (r.holders as Record<string, unknown>[]) : [];
  const shares = holders
    .filter((h) => h.is_locked !== 1 && h.is_locked !== "1")
    .map((h) => num(h.percent))
    .filter((p): p is number => p !== null);
  return {
    found: true,
    flags,
    buyTax,
    sellTax,
    transferTax,
    holderCount: num(r.holder_count),
    topHolderShare: shares.length ? Math.max(...shares) : null,
    isOpenSource: r.is_open_source === "1" ? true : r.is_open_source === "0" ? false : null,
  };
}

export async function fetchGoPlus(
  chainId: number,
  address: string,
  maxTax: number,
  deps: UpstreamDeps,
): Promise<GoPlusReport> {
  const body = await getJson({ provider: "goplus", url: goplusUrl(chainId, address) }, deps);
  const code = (body as { code?: unknown } | null)?.code;
  if (code !== 1)
    throw new MarketError(
      "UPSTREAM_UNAVAILABLE",
      "goplus",
      "GoPlus did not answer for this token.",
      {
        retryable: true,
      },
    );
  return parseGoPlus(body, address, maxTax);
}
