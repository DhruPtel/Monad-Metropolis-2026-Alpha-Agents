/**
 * The signer's transaction states and its own reason codes (P2-U4). The
 * signer, the outbox table and the screens share these lists, so a state or a
 * code shown anywhere has one meaning. The Executor's refusals stay in
 * REJECTION_CODES; these are the signer's, before or after the Executor.
 */
export const TRANSACTION_STATES = [
  "accepted",
  "signed",
  "submitted",
  "unknown",
  "confirmed",
  "reconciled",
  "failed",
] as const;
export type TransactionState = (typeof TRANSACTION_STATES)[number];

export const SIGNER_REASON_CODES = [
  // Refused before signing (the allowlist, the chain pin, the caps).
  "CHAIN_NOT_PINNED",
  "CONTRACT_CREATION",
  "TARGET_NOT_ALLOWED",
  "FUNCTION_NOT_ALLOWED",
  "VALUE_NOT_ALLOWED",
  "INTENT_MALFORMED",
  "AGENT_MISMATCH",
  "RECIPIENT_NOT_ALLOWED",
  "GAS_LIMIT_EXCEEDED",
  "FEE_CAP_EXCEEDED",
  // Outcomes after signing.
  "NO_SESSION_KEY",
  "BROADCAST_REJECTED",
  "NONCE_CONSUMED",
  "DROPPED",
  "TRANSFER_REVERTED",
  "RECONCILE_MISMATCH",
] as const;
export type SignerReasonCode = (typeof SIGNER_REASON_CODES)[number];

export const SIGNER_REASON_MESSAGES: Readonly<Record<SignerReasonCode, string>> = {
  CHAIN_NOT_PINNED: "The transaction is for another chain than this environment's.",
  CONTRACT_CREATION: "The signer never deploys contracts.",
  TARGET_NOT_ALLOWED:
    "The signer signs calls to the Executor, and USDC transfers for credits, only.",
  FUNCTION_NOT_ALLOWED: "The signer signs the Executor's swap and a USDC transfer only.",
  VALUE_NOT_ALLOWED: "The signer never sends native value.",
  INTENT_MALFORMED: "The call's arguments do not decode or are empty.",
  AGENT_MISMATCH: "The intent is for another agent or chain than the key's.",
  RECIPIENT_NOT_ALLOWED:
    "A credit transfer pays only the agent's current owner (a refund) or the platform treasury (a settlement).",
  GAS_LIMIT_EXCEEDED: "The gas limit is above the limit for this kind of transaction.",
  FEE_CAP_EXCEEDED: "The network fee is above the signer's cap.",
  NO_SESSION_KEY: "The agent has no session key in the signer.",
  BROADCAST_REJECTED: "The network refused the transaction; its nonce was given back.",
  NONCE_CONSUMED: "Another transaction used this one's nonce; it never landed.",
  DROPPED: "No node holds the transaction and its nonce is unused; it was not sent again.",
  TRANSFER_REVERTED:
    "The USDC transfer would revert or reverted; nothing left the funding address.",
  RECONCILE_MISMATCH:
    "The transaction landed, but the balances and its event disagree; a person must check it.",
};

export const TRANSACTION_STATE_MEANINGS: Readonly<Record<TransactionState, string>> = {
  accepted: "Passed the signer's allowlist; waiting to be signed",
  signed: "Signed and stored with its nonce; not yet sent",
  submitted: "Sent; waiting for its receipt",
  unknown: "Sent, but the answer was lost; resolving by hash and nonce, never resent",
  confirmed: "Mined; waiting for reconciliation",
  reconciled: "Balances match the transaction's event; in the ledger",
  failed: "Did not happen; the reason says why",
};
