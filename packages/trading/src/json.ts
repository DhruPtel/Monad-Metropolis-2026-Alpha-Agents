import { ASSET_DECIMALS, type ArmingState, ARMING_END_MESSAGES } from "@alpha-agents/domain";
import { formatUnits } from "viem";
import { type ArmingRecord, RENEWAL_REMINDER_SECONDS, armingState, grantDate } from "./arming.ts";
import type { IntentView } from "./store.ts";

/** The trade flow's records as JSON for the control API and the dev console (P2-U6). */

const amount = (asset: "USDC" | "WMON", raw: bigint | null) =>
  raw === null
    ? null
    : { asset, amount: formatUnits(raw, ASSET_DECIMALS[asset]), amountRaw: raw.toString() };

export function intentJson(i: IntentView) {
  return {
    intentId: i.intentId,
    status: i.status,
    sell: amount(i.sell, i.amountIn),
    buy: i.buy,
    expectedOut: amount(i.buy, i.expectedOut),
    minAmountOut: amount(i.buy, i.minAmountOut),
    amountOut: amount(i.buy, i.amountOut),
    reason: i.reason,
    reasonCodes: i.reasonCodes,
    blockers: i.blockers,
    failure: i.failure,
    approvedBy: i.approvedBy,
    txHash: i.txHash,
    deadline: i.deadline?.toString() ?? null,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
    approvedAt: i.approvedAt?.toISOString() ?? null,
    submittedAt: i.submittedAt?.toISOString() ?? null,
    settledAt: i.settledAt?.toISOString() ?? null,
  };
}

export type IntentJson = ReturnType<typeof intentJson>;

/** The agent's arming for its owner: state, the grant's end, and why the last one ended. */
export function armingJson(last: ArmingRecord | null, nowSeconds: number) {
  const state: ArmingState = armingState(last);
  const open = last && last.status !== "ended" ? last : null;
  return {
    state,
    armingId: last?.armingId ?? null,
    validUntil: open ? Number(open.validUntil) : null,
    validUntilDate: open ? grantDate(open.validUntil) : null,
    renewalDue: open ? Number(open.validUntil) - nowSeconds <= RENEWAL_REMINDER_SECONDS : false,
    armedAt: open?.armedAt?.toISOString() ?? null,
    firstIntentId: open?.firstIntentId ?? null,
    ended:
      last && last.status === "ended" && last.endedReason
        ? {
            reason: last.endedReason,
            message: ARMING_END_MESSAGES[last.endedReason],
            at: last.endedAt?.toISOString() ?? null,
            revokedOnchain: last.revokedOnchain,
          }
        : null,
  };
}

export type ArmingJson = ReturnType<typeof armingJson>;
