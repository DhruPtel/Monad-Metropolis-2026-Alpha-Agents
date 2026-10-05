import { loadConfig } from "@alpha-agents/config";
import {
  type AgentId,
  type AgentState,
  type Tier,
  type UsdcE6,
  speciesByIndex,
  usdcE6,
} from "@alpha-agents/domain";

/**
 * Extension points for the agents panel. P1-U4 lists agents from the control
 * API's index; later units add their state, spend and last action, and the
 * controls to reset an agent or trigger a task.
 */
export interface AgentRow {
  readonly agentId: AgentId;
  readonly name: string;
  readonly owner: string;
  /** Null until revealed. */
  readonly tier: Tier | null;
  readonly speciesName: string | null;
  readonly state: AgentState;
  /** Credits spent in the last 24 hours. */
  readonly spendUsdcE6: UsdcE6;
  /** Plain-English last action, from the activity feed. */
  readonly lastAction: string | null;
}

export interface AgentList {
  readonly agents: readonly AgentRow[];
  /** The block the index had reached, or null before its first range. */
  readonly watermark: { readonly block: number; readonly updatedAt: string } | null;
}

export interface AgentsSource {
  /** P1-U4: list every agent from the API's projections. */
  listAgents(): Promise<AgentList>;
  /** Later unit: reset one agent's runtime state on the local stack. */
  resetAgent?(agentId: AgentId): Promise<void>;
  /** Later unit: enqueue a task for one agent, for example a no-op cycle. */
  triggerTask?(agentId: AgentId, task: string): Promise<void>;
}

/** The planned agent actions, shown disabled until their unit lands. */
export const PLANNED_AGENT_ACTIONS = [
  { label: "Reset an agent", unit: "P1-U5" },
  { label: "Trigger a task", unit: "P1-U8" },
  { label: "Kill switch: pause all Executors", unit: "PB-U1" },
] as const;

interface ApiAgent {
  agentId: string;
  owner: string;
  species: number;
}

/** Agents from the control API (pnpm dev:api). */
export function apiAgentsSource(baseUrl: string, fetchFn: typeof fetch = fetch): AgentsSource {
  return {
    async listAgents() {
      const res = await fetchFn(`${baseUrl}/v1/agents`, { cache: "no-store" });
      if (!res.ok) throw new Error(`the control API answered ${res.status}`);
      const body = (await res.json()) as {
        agents: ApiAgent[];
        watermark: { block: number; updatedAt: string } | null;
      };
      return {
        watermark: body.watermark
          ? { block: body.watermark.block, updatedAt: body.watermark.updatedAt }
          : null,
        agents: body.agents.map((a) => {
          const species = a.species === 0 ? null : speciesByIndex(a.species);
          return {
            agentId: BigInt(a.agentId) as AgentId,
            name: `Alpha Agent #${a.agentId}`,
            owner: a.owner,
            tier: species?.tier ?? null,
            speciesName: species?.name ?? null,
            // No build or runtime exists yet (P1-U5, P6): every agent is unconfigured.
            state: "UNCONFIGURED",
            // Credits arrive with funding addresses (P1-U6).
            spendUsdcE6: usdcE6(0n),
            lastAction: null,
          };
        }),
      };
    },
  };
}

/** The control API's URL from configuration (CONTROL_API_URL, local default). */
export function controlApiUrl(): string {
  const config = loadConfig({ name: "dev console", usesChain: false });
  return String(config.values.CONTROL_API_URL ?? "http://127.0.0.1:4100");
}

export const agentsSource: AgentsSource = {
  listAgents: () => apiAgentsSource(controlApiUrl()).listAgents(),
};
