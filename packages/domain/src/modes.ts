import { z } from "zod";

/**
 * The canonical mode model of FINAL_PLAN 4.12 (D-137): two orthogonal state
 * machines and a set of derived display flags. Every other vocabulary maps here.
 */

/** Onchain, one per custody account, held by the custody core. */
export const ACCOUNT_MODES = ["NORMAL", "REDUCE_ONLY", "PAUSED", "HANDOVER", "WIND_DOWN"] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];
export const AccountModeSchema = z.enum(ACCOUNT_MODES);

/** HANDOVER and WIND_DOWN exist only on a StrategyVault. */
export const VAULT_ONLY_MODES: readonly AccountMode[] = ["HANDOVER", "WIND_DOWN"];

/** Offchain, one per agent, held by the orchestrator. */
export const AGENT_STATES = ["UNCONFIGURED", "READY", "RUNNING", "RESTRICTED", "INCIDENT"] as const;
export type AgentState = (typeof AGENT_STATES)[number];
export const AgentStateSchema = z.enum(AGENT_STATES);

/** Derived for display, never stored as a state. */
export const DISPLAY_FLAGS = [
  "awaiting_approval",
  "evaluated",
  "stale_data",
  "partially_settled",
  "exit_pending",
] as const;
export type DisplayFlag = (typeof DISPLAY_FLAGS)[number];

/** The wire form of the account mode, as `chain.get_limits.mode` returns it. */
export const ACCOUNT_MODE_WIRE = {
  NORMAL: "normal",
  REDUCE_ONLY: "reduce_only",
  PAUSED: "paused",
  HANDOVER: "handover",
  WIND_DOWN: "wind_down",
} as const satisfies Record<AccountMode, string>;
export type AccountModeWire = (typeof ACCOUNT_MODE_WIRE)[AccountMode];

export function accountModeToWire(mode: AccountMode): AccountModeWire {
  return ACCOUNT_MODE_WIRE[mode];
}

export function accountModeFromWire(wire: string): AccountMode | undefined {
  return ACCOUNT_MODES.find((m) => ACCOUNT_MODE_WIRE[m] === wire);
}

export type CanonicalName =
  | { readonly machine: "account_mode"; readonly value: AccountMode }
  | { readonly machine: "agent_state"; readonly value: AgentState }
  | { readonly machine: "display_flag"; readonly value: DisplayFlag };

export interface LegacyMapping {
  readonly where: string;
  readonly name: string;
  readonly canonical: CanonicalName;
}

const mode = (value: AccountMode): CanonicalName => ({ machine: "account_mode", value });
const state = (value: AgentState): CanonicalName => ({ machine: "agent_state", value });
const flag = (value: DisplayFlag): CanonicalName => ({ machine: "display_flag", value });

/** FINAL_PLAN 4.12 "Mapping from every earlier vocabulary", one row per name. */
export const LEGACY_MAPPINGS: readonly LegacyMapping[] = [
  { where: "Custody core mode() in revision 1", name: "NONE", canonical: mode("NORMAL") },
  { where: "Custody core mode()", name: "REDUCE_ONLY", canonical: mode("REDUCE_ONLY") },
  { where: "Custody core mode()", name: "PAUSED", canonical: mode("PAUSED") },
  { where: "Custody core mode()", name: "HANDOVER", canonical: mode("HANDOVER") },
  { where: "Custody core mode()", name: "WIND_DOWN", canonical: mode("WIND_DOWN") },
  {
    where: "Risk Sentinel state machine in revision 1",
    name: "RESTRICTED",
    canonical: state("RESTRICTED"),
  },
  { where: "Risk Sentinel state machine", name: "REDUCE_ONLY", canonical: mode("REDUCE_ONLY") },
  { where: "Risk Sentinel state machine", name: "PAUSED", canonical: mode("PAUSED") },
  { where: "Risk Sentinel state machine", name: "EXIT_PENDING", canonical: flag("exit_pending") },
  { where: "Risk Sentinel state machine", name: "INCIDENT", canonical: state("INCIDENT") },
  {
    where: "P9-U1 lifecycle modes in revision 1",
    name: "UNCONFIGURED",
    canonical: state("UNCONFIGURED"),
  },
  { where: "P9-U1 lifecycle modes in revision 1", name: "READY", canonical: state("READY") },
  { where: "P9-U1 lifecycle modes in revision 1", name: "RUNNING", canonical: state("RUNNING") },
  {
    where: "P9-U1 lifecycle modes in revision 1",
    name: "RESTRICTED",
    canonical: state("RESTRICTED"),
  },
  { where: "P9-U1 lifecycle modes in revision 1", name: "INCIDENT", canonical: state("INCIDENT") },
  { where: "P9-U1 lifecycle modes", name: "REDUCE_ONLY", canonical: mode("REDUCE_ONLY") },
  { where: "P9-U1 lifecycle modes", name: "PAUSED", canonical: mode("PAUSED") },
  { where: "P9-U1 lifecycle modes", name: "EXIT_PENDING", canonical: flag("exit_pending") },
  { where: "Chain tools get_limits.mode", name: "none", canonical: mode("NORMAL") },
  { where: "Chain tools get_limits.mode", name: "reduce_only", canonical: mode("REDUCE_ONLY") },
  { where: "Chain tools get_limits.mode", name: "paused", canonical: mode("PAUSED") },
  { where: "UI states in revision 1", name: "restricted", canonical: state("RESTRICTED") },
  { where: "UI states in revision 1", name: "reduce-only", canonical: mode("REDUCE_ONLY") },
  { where: "UI states in revision 1", name: "paused", canonical: mode("PAUSED") },
  { where: "UI states in revision 1", name: "handover", canonical: mode("HANDOVER") },
  { where: "UI states in revision 1", name: "incident", canonical: state("INCIDENT") },
  {
    where: "UI states in revision 1",
    name: "awaiting approval",
    canonical: flag("awaiting_approval"),
  },
  { where: "UI states in revision 1", name: "evaluated", canonical: flag("evaluated") },
  { where: "UI states in revision 1", name: "stale data", canonical: flag("stale_data") },
  {
    where: "UI states in revision 1",
    name: "partially settled",
    canonical: flag("partially_settled"),
  },
  { where: "UI states in revision 1", name: "exit pending", canonical: flag("exit_pending") },
];

/** The canonical name for a name from an earlier vocabulary, or undefined if it has none. */
export function canonicalFor(where: string, name: string): CanonicalName | undefined {
  return LEGACY_MAPPINGS.find((m) => m.where === where && m.name === name)?.canonical;
}
