import type { AgentId, AgentState, Tier, UsdcE6 } from "@alpha-agents/domain";

/**
 * Extension points for the agents panel. Agents come from the indexer and the
 * control API (P1-U4); until then the panel shows an empty state. Later units
 * implement these and the panel renders them without changing its layout.
 */
export interface AgentRow {
  readonly agentId: AgentId;
  readonly name: string;
  readonly tier: Tier;
  readonly state: AgentState;
  /** Credits spent in the last 24 hours. */
  readonly spendUsdcE6: UsdcE6;
  /** Plain-English last action, from the activity feed. */
  readonly lastAction: string | null;
}

export interface AgentsSource {
  /** P1-U4: list every agent from the API's projections. */
  listAgents(): Promise<readonly AgentRow[]>;
  /** Later unit: reset one agent's runtime state on the local stack. */
  resetAgent?(agentId: AgentId): Promise<void>;
  /** Later unit: enqueue a task for one agent, for example a no-op cycle. */
  triggerTask?(agentId: AgentId, task: string): Promise<void>;
}

/** The planned agent actions, shown disabled until their unit lands. */
export const PLANNED_AGENT_ACTIONS = [
  { label: "List agents", unit: "P1-U4" },
  { label: "Reset an agent", unit: "P1-U5" },
  { label: "Trigger a task", unit: "P1-U8" },
  { label: "Kill switch: pause all Executors", unit: "PB-U1" },
] as const;

/** No source exists until P1-U4. */
export const agentsSource: AgentsSource | null = null;
