import { type AccountMode, type AgentState, type DisplayFlag } from "@alpha-agents/domain";
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
    tone: "detail",
    meaning: "Waiting for the owner to approve",
  },
  evaluated: { label: "Evaluated", tone: "neutral", meaning: "Checked and recorded" },
  stale_data: { label: "Stale data", tone: "negative", meaning: "Some data is out of date" },
  partially_settled: {
    label: "Partially settled",
    tone: "detail",
    meaning: "Some legs have not settled yet",
  },
  exit_pending: { label: "Exit pending", tone: "detail", meaning: "A withdrawal is in progress" },
};

type StatusPillProps =
  | { readonly kind: "account_mode"; readonly value: AccountMode }
  | { readonly kind: "agent_state"; readonly value: AgentState }
  | { readonly kind: "display_flag"; readonly value: DisplayFlag };

function renderingFor(props: StatusPillProps): Rendering {
  switch (props.kind) {
    case "account_mode":
      return ACCOUNT_MODE_RENDERING[props.value];
    case "agent_state":
      return AGENT_STATE_RENDERING[props.value];
    case "display_flag":
      return DISPLAY_FLAG_RENDERING[props.value];
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
