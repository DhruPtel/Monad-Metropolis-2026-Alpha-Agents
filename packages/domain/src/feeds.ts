/**
 * The two Chainlink feeds the oracle adapter reads, as an owner reads about
 * them: the feed's name, how often it updates and how old an answer may be.
 * packages/policy's LAUNCH_LIMITS holds the same bounds, and a policy test
 * keeps the two equal.
 */
export type PriceFeedId = "MON_USD" | "USDC_USD";

export interface PriceFeedFacts {
  readonly label: string;
  /** How often the feed normally updates, measured on Monad mainnet (evidence/p2-ec/REAL_CHAIN.md). */
  readonly heartbeatSeconds: number;
  /** An answer this old or older is refused (D-151, D-317). */
  readonly maxAgeSeconds: number;
  /** What the feed guards, in the owner's words. */
  readonly guards: string;
}

export const PRICE_FEEDS: Readonly<Record<PriceFeedId, PriceFeedFacts>> = Object.freeze({
  MON_USD: Object.freeze({
    label: "MON/USD",
    heartbeatSeconds: 30,
    maxAgeSeconds: 300,
    guards: "the price of WMON",
  }),
  USDC_USD: Object.freeze({
    label: "USDC/USD",
    heartbeatSeconds: 3_600,
    maxAgeSeconds: 7_200,
    guards: "the USDC depeg guard",
  }),
});

/** A duration in the largest whole units that read naturally: "45 seconds", "6 minutes", "2 hours 5 minutes". */
export function readableDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (s < 60) return plural(s, "second");
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? plural(hours, "hour") : `${plural(hours, "hour")} ${plural(rest, "minute")}`;
}

export interface StaleFeedInput {
  readonly feed: PriceFeedId;
  /** The feed's last update, unix seconds; 0 when it has never answered. */
  readonly updatedAt: number;
  /** The chain's time the reading was taken at, unix seconds. */
  readonly now: number;
  /** What was refused: a deposit or a trade. */
  readonly refused: "deposit" | "trade";
}

/**
 * Why a deposit or trade was refused for a stale feed, naming the feed and
 * when it is expected to update (L-145). A stale answer is past its bound, and
 * every bound is longer than the feed's heartbeat, so the next update is
 * always due already: the message says when it was due and that it should
 * arrive soon.
 */
export function staleFeedMessage(input: StaleFeedInput): string {
  const f = PRICE_FEEDS[input.feed];
  const what = input.refused === "deposit" ? "Deposits are" : "Trades are";
  const every = `It normally updates about every ${readableDuration(f.heartbeatSeconds)}`;
  const after =
    input.refused === "deposit" ? "Withdrawals need no price and still work." : "Nothing was sent.";
  if (input.updatedAt <= 0)
    return `${what} refused because the ${f.label} price feed (${f.guards}) has no answer yet. ${every}; try again once it does. ${after}`;
  const age = input.now - input.updatedAt;
  const due = input.updatedAt + f.heartbeatSeconds;
  const late = input.now - due;
  const expected =
    late > 0
      ? `its next update was due ${readableDuration(late)} ago, so expect one shortly`
      : `its next update is expected in about ${readableDuration(-late)}`;
  return `${what} refused because the ${f.label} price feed (${f.guards}) is stale: it last updated ${readableDuration(age)} ago, and answers ${readableDuration(f.maxAgeSeconds)} old or older are not used. ${every}; ${expected}. ${after}`;
}
