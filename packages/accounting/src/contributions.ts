/**
 * Contributions to an agent's credits (D-242). Anyone may send USDC to an
 * agent's funding address; each sender's share of the credits is its share of
 * all contributions. A settled refund to a contributor "consumes" that
 * contributor's contributions up to then (its basis), so later shares are
 * computed on what is left and every other contributor's share is unchanged.
 *
 * Amounts are USDC base units (6 decimals), as bigints. Rounding is down, so
 * the sum of the shares paid never exceeds what is refundable.
 */
export interface ContributionWeights {
  /** Everything this contributor sent to the funding address. */
  readonly contributed: bigint;
  /** The basis of this contributor's settled refunds. */
  readonly consumed: bigint;
  /** Everything every contributor sent. */
  readonly totalContributed: bigint;
  /** The basis of every settled refund. */
  readonly totalConsumed: bigint;
}

export interface OwnShare {
  /** What this contributor is paid now. */
  readonly amount: bigint;
  /** The contributions this refund consumes: the contributor's weight. */
  readonly basis: bigint;
}

/**
 * One contributor's share of `refundable` (D-242 rule 5): the contributor's
 * remaining contributions over everyone's, rounded down. Zero when the
 * contributor has nothing left or nothing is refundable.
 */
export function ownShare(w: ContributionWeights, refundable: bigint): OwnShare {
  if (w.consumed > w.contributed || w.totalConsumed > w.totalContributed)
    throw new RangeError("consumed contributions exceed contributions");
  const mine = w.contributed - w.consumed;
  const all = w.totalContributed - w.totalConsumed;
  if (mine > all) throw new RangeError("one contributor's weight exceeds the total");
  if (mine === 0n || all === 0n || refundable <= 0n) return { amount: 0n, basis: 0n };
  return { amount: (refundable * mine) / all, basis: mine };
}

/** The share of each part of the refundable pool, rounded down per part. */
export function shareOf(part: bigint, share: OwnShare, w: ContributionWeights): bigint {
  const all = w.totalContributed - w.totalConsumed;
  if (share.basis === 0n || all === 0n || part <= 0n) return 0n;
  return (part * share.basis) / all;
}
