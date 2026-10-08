import {
  type AccountMode,
  type AgentState,
  ARMING_STATE_MEANINGS,
  type ArmingState,
  type DisplayFlag,
  INTENT_STATE_MEANINGS,
  type IntentState,
  TRANSACTION_STATE_MEANINGS,
  type TransactionState,
} from "@alpha-agents/domain";
import { Badge, type BadgeTone } from "./ui/badge";

/**
 * Renders the canonical mode model of FINAL_PLAN 4.12 straight from
 * packages/domain. Each map is typed `Record<Mode, ...>`, so adding a mode to
 * the domain without a rendering here fails the typecheck, and a test renders
 * every value of ACCOUNT_MODES, AGENT_STATES and DISPLAY_FLAGS.
 */
interface Rendering {
  readonly label: string;
  readonly tone: BadgeTone;
  /** Owner-facing meaning, used as the pill's accessible description. */
  readonly meaning: string;
}

export const ACCOUNT_MODE_RENDERING: Readonly<Record<AccountMode, Rendering>> = {
  NORMAL: { label: "Normal", tone: "positive", meaning: "Trading within limits" },
  REDUCE_ONLY: {
    label: "Reduce only",
    tone: "detail",
    meaning: "Only sales into USDC are allowed",
  },
  PAUSED: { label: "Paused", tone: "negative", meaning: "No new trades; exits stay open" },
  HANDOVER: { label: "Handover", tone: "detail", meaning: "The vault is changing hands" },
  WIND_DOWN: { label: "Winding down", tone: "detail", meaning: "The vault is closing" },
};

export const AGENT_STATE_RENDERING: Readonly<Record<AgentState, Rendering>> = {
  UNCONFIGURED: {
    label: "Not configured",
    tone: "neutral",
    meaning: "No goal or build is active yet",
  },
  READY: { label: "Ready", tone: "neutral", meaning: "Configured, not running" },
  RUNNING: { label: "Running", tone: "positive", meaning: "Cycles are scheduled" },
  RESTRICTED: {
    label: "Restricted",
    tone: "detail",
    meaning: "Research and proposals are stopped",
  },
  INCIDENT: {
    label: "Incident",
    tone: "negative",
    meaning: "A fault needs a person to look at it",
  },
};

export const DISPLAY_FLAG_RENDERING: Readonly<Record<DisplayFlag, Rendering>> = {
  awaiting_approval: {
    label: "Awaiting approval",
    tone: "warning",
    meaning: "Waiting for the owner to approve",
  },
  evaluated: { label: "Evaluated", tone: "neutral", meaning: "Checked and recorded" },
  stale_data: { label: "Stale data", tone: "warning", meaning: "Some data is out of date" },
  partially_settled: {
    label: "Partially settled",
    tone: "detail",
    meaning: "Some legs have not settled yet",
  },
  exit_pending: { label: "Exit pending", tone: "detail", meaning: "A withdrawal is in progress" },
};

/** The signer's transaction states (P2-U4): failed is the only red; unknown waits on the chain. */
export const TRANSACTION_STATE_RENDERING: Readonly<Record<TransactionState, Rendering>> = {
  accepted: { label: "Accepted", tone: "neutral", meaning: TRANSACTION_STATE_MEANINGS.accepted },
  signed: { label: "Signed", tone: "neutral", meaning: TRANSACTION_STATE_MEANINGS.signed },
  submitted: { label: "Submitted", tone: "detail", meaning: TRANSACTION_STATE_MEANINGS.submitted },
  unknown: { label: "Unknown", tone: "warning", meaning: TRANSACTION_STATE_MEANINGS.unknown },
  confirmed: { label: "Confirmed", tone: "detail", meaning: TRANSACTION_STATE_MEANINGS.confirmed },
  reconciled: {
    label: "Reconciled",
    tone: "positive",
    meaning: TRANSACTION_STATE_MEANINGS.reconciled,
  },
  failed: { label: "Failed", tone: "negative", meaning: TRANSACTION_STATE_MEANINGS.failed },
};

/** An intent's states (P2-U5, P2-U6): rejected and failed are red; waiting for approval is amber. */
export const INTENT_STATE_RENDERING: Readonly<Record<IntentState, Rendering>> = {
  awaiting_approval: {
    label: "Awaiting approval",
    tone: "warning",
    meaning: INTENT_STATE_MEANINGS.awaiting_approval,
  },
  approved: { label: "Approved", tone: "detail", meaning: INTENT_STATE_MEANINGS.approved },
  submitted: { label: "Submitted", tone: "detail", meaning: INTENT_STATE_MEANINGS.submitted },
  confirmed: { label: "Confirmed", tone: "detail", meaning: INTENT_STATE_MEANINGS.confirmed },
  reconciled: { label: "Settled", tone: "positive", meaning: INTENT_STATE_MEANINGS.reconciled },
  rejected: { label: "Rejected", tone: "negative", meaning: INTENT_STATE_MEANINGS.rejected },
  expired: { label: "Expired", tone: "neutral", meaning: INTENT_STATE_MEANINGS.expired },
  failed: { label: "Failed", tone: "negative", meaning: INTENT_STATE_MEANINGS.failed },
  cancelled: { label: "Cancelled", tone: "neutral", meaning: INTENT_STATE_MEANINGS.cancelled },
};

/** An agent's arming (P2-U6): armed is the lime state; waiting for the first trade is amber. */
export const ARMING_STATE_RENDERING: Readonly<Record<ArmingState, Rendering>> = {
  unarmed: { label: "Not armed", tone: "neutral", meaning: ARMING_STATE_MEANINGS.unarmed },
  awaiting_first_trade: {
    label: "Approve first trade",
    tone: "warning",
    meaning: ARMING_STATE_MEANINGS.awaiting_first_trade,
  },
  armed: { label: "Armed", tone: "positive", meaning: ARMING_STATE_MEANINGS.armed },
};

type StatusPillProps =
  | { readonly kind: "account_mode"; readonly value: AccountMode }
  | { readonly kind: "agent_state"; readonly value: AgentState }
  | { readonly kind: "display_flag"; readonly value: DisplayFlag }
  | { readonly kind: "transaction"; readonly value: TransactionState }
  | { readonly kind: "intent"; readonly value: IntentState }
  | { readonly kind: "arming"; readonly value: ArmingState };

function renderingFor(props: StatusPillProps): Rendering {
  switch (props.kind) {
    case "account_mode":
      return ACCOUNT_MODE_RENDERING[props.value];
    case "agent_state":
      return AGENT_STATE_RENDERING[props.value];
    case "display_flag":
      return DISPLAY_FLAG_RENDERING[props.value];
    case "transaction":
      return TRANSACTION_STATE_RENDERING[props.value];
    case "intent":
      return INTENT_STATE_RENDERING[props.value];
    case "arming":
      return ARMING_STATE_RENDERING[props.value];
  }
}

function StatusPill(props: StatusPillProps) {
  const { label, tone, meaning } = renderingFor(props);
  return (
    <Badge tone={tone} title={meaning} data-kind={props.kind} data-value={props.value}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}

export { StatusPill };
