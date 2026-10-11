/**
 * Whether an account may buy a token now, and why not (F-U12): the lane and
 * status the chain records, the safety screen, and the owner's onchain
 * opt-in, in one plain answer every token list and screen result carries.
 */
export type LaneName = "core" | "screened";
export type StatusName = "listed" | "sell_only" | "delisted";

export interface Buyability {
  readonly lane: LaneName | null;
  readonly status: StatusName | null;
  readonly buyable: boolean;
  /** Why the account cannot buy it now, in the owner's words; null when it can. */
  readonly whyNot: string | null;
}

export function buyabilityOf(
  t: {
    readonly registryLane: LaneName | null;
    readonly registryStatus: StatusName | null;
    readonly screen: { readonly verdict: "passed" | "refused"; readonly fresh: boolean } | null;
  },
  /** The account's onchain screened-lane opt-in; null while unknown (no account yet). */
  optedIn: boolean | null,
): Buyability {
  const lane = t.registryLane;
  const status = t.registryStatus;
  const no = (whyNot: string): Buyability => ({ lane, status, buyable: false, whyNot });
  if (lane === null) {
    if (!t.screen) return no("not screened yet; a passing safety screen registers it");
    if (t.screen.verdict === "refused") return no("the safety screen refused it");
    return no("passed the screen but is not registered yet");
  }
  if (status === "sell_only") return no("sell-only in the registry: it may be sold, never bought");
  if (status === "delisted") return no("frozen in the registry");
  if (status !== "listed") return no("not listed in the registry");
  if (lane === "screened") {
    if (optedIn === null)
      return no("in the screened lane; the account's opt-in is unknown until it opens");
    if (!optedIn) return no("in the screened lane; the owner has not opted in on chain");
  }
  if (t.screen && t.screen.verdict === "refused")
    return no("its latest safety screen was refused; the registry has not moved it yet");
  return { lane, status, buyable: true, whyNot: null };
}
