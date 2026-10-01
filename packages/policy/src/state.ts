import type {
  AccountMode,
  AmountRaw,
  AssetId,
  ConfigEpoch,
  OwnerEpoch,
  PriceE18,
  RejectionCode,
  UnixSeconds,
  UsdcE6,
} from "@alpha-agents/domain";

/** One oracle reading for a non-USDC asset. USDC is always priced at exactly 1. */
export interface OracleReading {
  /** Oracle price: USDC value of one whole token, scaled by 1e18. */
  readonly priceE18: PriceE18;
  readonly updatedAt: UnixSeconds;
  /** Spot price of the pool the trade would use, same scale. */
  readonly poolPriceE18: PriceE18;
}

/** A trade already counted in the rolling window, as the Executor's ring buffer holds it. */
export interface PastTrade {
  readonly at: UnixSeconds;
  readonly valueUsdcE6: UsdcE6;
}

/** A snapshot of one capital account, as the chain tools read it before a pre-check. */
export interface AccountState {
  readonly mode: AccountMode;
  readonly holdings: Readonly<Record<AssetId, AmountRaw>>;
  /** Readings for the non-USDC assets; a missing reading fails closed. */
  readonly oracle: Readonly<Partial<Record<AssetId, OracleReading>>>;
  /** Assets the account may buy. Selling a held asset never needs the allowlist. */
  readonly buyAllowlist: readonly AssetId[];
  /** Trades in the Executor's ring buffer, any order; older ones are ignored. */
  readonly recentTrades: readonly PastTrade[];
  /** Current epochs onchain and the epochs the session was issued under. */
  readonly epochs?: {
    readonly current: { readonly owner: OwnerEpoch; readonly config: ConfigEpoch };
    readonly session: { readonly owner: OwnerEpoch; readonly config: ConfigEpoch };
  };
}

export interface Rejection {
  readonly code: RejectionCode;
  /** The owner-facing explanation for the code. */
  readonly message: string;
  /** Deterministic facts behind the rejection, for logs and the activity feed. */
  readonly detail: string;
}
