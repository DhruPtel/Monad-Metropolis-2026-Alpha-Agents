import type { ArmingEndReason, ArmingState, CustodyPath } from "@alpha-agents/domain";
import { type Hex, isAddressEqual } from "viem";

/**
 * Arming (P2-U6). The owner registers a session grant in the Executor from
 * their own wallet, naming the agent's funding address as its key, and then
 * approves the agent's first proposed trade once. From then on trades within
 * the hard limits go through without the owner, until the grant expires, the
 * agent is sold, its configuration changes, the grant is revoked on chain, or
 * the owner disarms it. These are the pure rules; the store keeps the record.
 */

/** The Executor's MAX_SESSION: a grant lasts at most 30 days. */
export const MAX_GRANT_SECONDS = 30 * 86_400;
/** A-45: the owner is reminded to renew this long before the grant expires. */
export const RENEWAL_REMINDER_SECONDS = 3 * 86_400;

export interface GrantView {
  readonly key: Hex;
  readonly ownerEpoch: bigint;
  readonly configEpoch: bigint;
  /** Unix seconds. */
  readonly validUntil: bigint;
}

/** What the chain says about an agent now: chain-tools' AgentState has this shape. */
export interface AgentChainView {
  readonly owner: Hex;
  readonly ownerEpoch: bigint;
  readonly configEpoch: bigint;
  readonly grant: GrantView | null;
  /** The block's time, unix seconds. */
  readonly timestamp: bigint;
}

export type ArmingStatus = "awaiting_first_trade" | "armed" | "ended";

export interface ArmingRecord {
  readonly armingId: string;
  readonly chainId: number;
  readonly agentId: number;
  /** F-U5 (D-367): the custody set the grant belongs to, and the Executor it is registered on. */
  readonly custody: CustodyPath;
  readonly executor: Hex | null;
  readonly owner: Hex;
  readonly ownerEpoch: bigint;
  readonly configEpoch: bigint;
  readonly sessionKey: Hex;
  readonly validUntil: bigint;
  readonly status: ArmingStatus;
  readonly endedReason: ArmingEndReason | null;
  readonly firstIntentId: string | null;
  readonly revokedOnchain: boolean;
  readonly remindedAt: Date | null;
  readonly armedAt: Date | null;
  readonly endedAt: Date | null;
  readonly createdAt: Date;
}

/** The owner-facing state of an agent's arming. */
export function armingState(r: ArmingRecord | null): ArmingState {
  if (!r || r.status === "ended") return "unarmed";
  return r.status;
}

/**
 * Why an open arming must end now, from a fresh chain read, or null if it
 * holds. A sale comes first (it also ends the grant), then a configuration
 * change, then expiry, then a grant that is gone or no longer the one armed.
 */
export function armingEnd(r: ArmingRecord, chain: AgentChainView): ArmingEndReason | null {
  if (!isAddressEqual(chain.owner, r.owner) || chain.ownerEpoch !== r.ownerEpoch) return "sold";
  if (chain.configEpoch !== r.configEpoch) return "config_changed";
  const g = chain.grant;
  if (g && isAddressEqual(g.key, r.sessionKey) && g.validUntil <= chain.timestamp) return "expired";
  if (!g || !isAddressEqual(g.key, r.sessionKey)) return "revoked";
  if (g.ownerEpoch !== r.ownerEpoch || g.configEpoch !== r.configEpoch) return "revoked";
  return null;
}

/** Why a grant cannot arm the agent, in the owner's words, or null when it can. */
export function grantProblem(
  chain: AgentChainView,
  owner: Hex,
  fundingAddress: Hex,
): string | null {
  const g = chain.grant;
  if (!isAddressEqual(chain.owner, owner)) return "Only the agent's owner can arm it.";
  if (!g) return "No trading permission is registered for this agent yet.";
  if (!isAddressEqual(g.key, fundingAddress))
    return "The trading permission names a different key than the agent's funding address.";
  if (g.ownerEpoch !== chain.ownerEpoch || g.configEpoch !== chain.configEpoch)
    return "The trading permission is from before the agent's last sale or change.";
  if (g.validUntil <= chain.timestamp) return "The trading permission has already expired.";
  if (g.validUntil > chain.timestamp + BigInt(MAX_GRANT_SECONDS))
    return "A trading permission can last at most 30 days.";
  return null;
}

/** Whether the owner should be reminded to renew: within the reminder window and not yet told. */
export function renewalDue(r: ArmingRecord, nowSeconds: bigint): boolean {
  return (
    r.status !== "ended" &&
    r.remindedAt === null &&
    r.validUntil - nowSeconds <= BigInt(RENEWAL_REMINDER_SECONDS)
  );
}

/** A grant's last moment as a UTC date, YYYY-MM-DD, for owner-facing text. */
export const grantDate = (validUntil: bigint): string =>
  new Date(Number(validUntil) * 1000).toISOString().slice(0, 10);
