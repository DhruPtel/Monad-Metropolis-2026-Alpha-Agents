/**
 * The console's token registry (F-U1): the shapes the orchestrator's token
 * routes serve, and the small rules the page shows them with.
 */
export type CheckStatus = "pass" | "fail" | "skipped";

export interface CheckJson {
  readonly code: string;
  readonly status: CheckStatus;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ScreenJson {
  readonly screenId: string;
  readonly address: string;
  readonly verdict: "passed" | "refused";
  readonly checks: readonly CheckJson[];
  readonly route: {
    readonly pool?: string;
    readonly dex?: string;
    readonly base?: string;
    readonly fee?: number | null;
  } | null;
  readonly forkBlock: number | null;
  readonly requestedBy: string;
  readonly durationMs: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface TokenRowJson {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly priceClass: "F" | "A";
  readonly feed: {
    readonly ok?: boolean;
    readonly kind?: string;
    readonly legs?: readonly {
      readonly description: string;
      readonly ok: boolean;
      readonly reason: string;
      readonly ageSeconds: number | null;
      readonly heartbeatSeconds: number;
    }[];
  } | null;
  readonly listings: {
    readonly coingecko?: { readonly id: string } | null;
    readonly coinmarketcap?: {
      readonly id: number;
      readonly rank: number | null;
      readonly match: string;
    } | null;
  };
  readonly liquidityUsd: number;
  readonly volume24hUsd: number;
  readonly deepestPool: string | null;
  readonly oldestPoolAt: string | null;
  readonly screen: {
    readonly screenId: string;
    readonly verdict: "passed" | "refused";
    readonly screenedAt: string;
    readonly expiresAt: string;
    readonly fresh: boolean;
  } | null;
  /** When discovery last saw the token: ages on the page are measured from here. */
  readonly lastSeenAt: string;
}

export interface PoolJson {
  readonly pool: string;
  readonly dex: "uniswap_v3" | "uniswap_v4" | "pancakeswap_v3";
  readonly pair: string;
  readonly fee: number | null;
  readonly routable: boolean;
  readonly routeNote: string;
  readonly liquidityUsd: number;
  readonly volume24hUsd: number;
  readonly createdAt: string | null;
  readonly ageHours: number | null;
}

export interface RunJson {
  readonly runId: string;
  readonly status: "running" | "completed" | "failed";
  readonly poolsSeen: number;
  readonly tokensSeen: number;
  readonly newPools: number;
  readonly sources: Readonly<Record<string, { readonly ok: boolean; readonly detail: string }>>;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface TokensJson {
  readonly configured: { readonly discovery: boolean; readonly screen: boolean };
  readonly counts: {
    readonly tokens: number;
    readonly classF: number;
    readonly classA: number;
    readonly passing: number;
    readonly refused: number;
    readonly pools: number;
    readonly routable: number;
  };
  readonly runs: readonly RunJson[];
  readonly tokens: readonly TokenRowJson[];
  readonly labels: Readonly<Record<string, string>>;
  readonly canAct: boolean;
}

export interface TokenDetailJson {
  readonly token: TokenRowJson;
  readonly pools: readonly PoolJson[];
  readonly screens: readonly ScreenJson[];
  readonly labels: Readonly<Record<string, string>>;
  readonly canAct: boolean;
}

/** Dollars, whole, with thousands separators; millions shortened. */
export function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** A pool's age from its creation time, against a fixed `now` so pages render the same. */
export function age(createdAt: string | null, nowMs: number): string {
  if (!createdAt) return "Unknown";
  const hours = (nowMs - Date.parse(createdAt)) / 3_600_000;
  if (hours < 0) return "Unknown";
  if (hours < 72) return `${Math.floor(hours)} hours`;
  return `${Math.floor(hours / 24)} days`;
}

export type ScreenState = "passed" | "refused" | "expired" | "unscreened";

export function screenState(s: TokenRowJson["screen"]): ScreenState {
  if (!s) return "unscreened";
  return s.fresh ? s.verdict : "expired";
}

export const SCREEN_STATE_LABEL: Readonly<Record<ScreenState, string>> = {
  passed: "Passed",
  refused: "Refused",
  expired: "Expired",
  unscreened: "Not screened",
};

export function screenTone(
  s: ScreenState | CheckStatus,
): "positive" | "negative" | "warning" | "neutral" {
  switch (s) {
    case "passed":
    case "pass":
      return "positive";
    case "refused":
    case "fail":
      return "negative";
    case "expired":
      return "warning";
    default:
      return "neutral";
  }
}

export const DEX_LABEL: Readonly<Record<PoolJson["dex"], string>> = {
  uniswap_v3: "Uniswap v3",
  uniswap_v4: "Uniswap v4",
  pancakeswap_v3: "PancakeSwap v3",
};

/** A pool fee in hundredths of a basis point as a percentage; Uniswap v4's dynamic fee flag as "dynamic". */
export function feePct(fee: number | null): string {
  if (fee === null) return "Unknown";
  if (fee === 0x800000) return "Dynamic";
  return `${(fee / 10_000)
    .toFixed(fee % 100 === 0 ? 2 : 4)
    .replace(/0+$/, "")
    .replace(/\.$/, "")}%`;
}

/** One evidence entry as text. */
export function evidenceText(v: string | number | boolean | null): string {
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return v;
}

export const isAddress = (s: string | undefined): s is string =>
  s !== undefined && /^0x[0-9a-fA-F]{40}$/.test(s);
