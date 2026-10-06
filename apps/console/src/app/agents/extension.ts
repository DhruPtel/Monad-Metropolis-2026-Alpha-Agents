import { loadConfig } from "@alpha-agents/config";
import type { RuntimeStatus, TaskStatus } from "@alpha-agents/ui";
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
 * API's index; P1-U5 adds each agent's runtime from the orchestrator and the
 * controls to reset an agent and run the no-op task; later units add state,
 * spend and last action.
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
  /** P1-U5: whether the orchestrator has provisioned it. */
  readonly runtime: RuntimeStatus;
  readonly latestTask: TaskView | null;
}

/** A task as the orchestrator reports it (GET /v1/tasks/:id). */
export interface TaskView {
  readonly taskId: string;
  readonly agentId: string;
  readonly status: TaskStatus;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface AgentList {
  readonly agents: readonly AgentRow[];
  /** False when the orchestrator did not answer: runtimes are unknown and actions are off. */
  readonly orchestrator: boolean;
  /** True when the orchestrator offers the dev actions (APP_ENV=local, D-205). */
  readonly devActions: boolean;
  /** The block the index had reached, or null before its first range. */
  readonly watermark: { readonly block: number; readonly updatedAt: string } | null;
}

export interface AgentsSource {
  /** P1-U4: list every agent from the API's projections. */
  listAgents(): Promise<AgentList>;
  /** P1-U5: a new runtime generation with a new key and a fresh config. */
  resetAgent?(agentId: AgentId): Promise<void>;
  /** P1-U5: queues a task for one agent (the no-op task); returns its ID. */
  triggerTask?(agentId: AgentId, task: "noop"): Promise<string>;
  /** P1-U5: one task's status and structured result. */
  task?(taskId: string): Promise<TaskView>;
}

/** The planned agent actions, shown disabled until their unit lands. */
export const PLANNED_AGENT_ACTIONS = [
  { label: "Kill switch: pause all Executors", unit: "PB-U1" },
] as const;

interface ApiRuntime {
  agentId: string;
  status: Exclude<RuntimeStatus, "not_provisioned">;
  latestTask: TaskView | null;
}

/** The orchestrator's internal API (pnpm dev:orchestrator, D-205). */
export function orchestratorSource(baseUrl: string, fetchFn: typeof fetch = fetch) {
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetchFn(`${baseUrl}${path}`, { cache: "no-store", ...init });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new Error(
        typeof body.message === "string" ? body.message : `the orchestrator answered ${res.status}`,
      );
    return body;
  };
  return {
    async runtimes(): Promise<{ devActions: boolean; runtimes: ApiRuntime[] }> {
      const body = await call("/v1/runtimes");
      return { devActions: body.devActions === true, runtimes: body.runtimes as ApiRuntime[] };
    },
    async triggerTask(agentId: AgentId, task: "noop"): Promise<string> {
      const body = await call(`/v1/agents/${agentId.toString()}/tasks/${task}`, { method: "POST" });
      return String(body.taskId);
    },
    async task(taskId: string): Promise<TaskView> {
      return (await call(`/v1/tasks/${encodeURIComponent(taskId)}`)) as unknown as TaskView;
    },
    async resetAgent(agentId: AgentId): Promise<void> {
      await call(`/v1/agents/${agentId.toString()}/reset`, { method: "POST" });
    },
  };
}

interface ApiAgent {
  agentId: string;
  owner: string;
  species: number;
}

/**
 * Agents from the control API (pnpm dev:api), with their runtimes from the
 * orchestrator when one is given and answers.
 */
export function apiAgentsSource(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  orchestratorUrl: string | null = null,
): AgentsSource {
  const orch = orchestratorUrl ? orchestratorSource(orchestratorUrl, fetchFn) : null;
  return {
    ...(orch
      ? {
          triggerTask: orch.triggerTask,
          task: orch.task,
          resetAgent: orch.resetAgent,
        }
      : {}),
    async listAgents() {
      const res = await fetchFn(`${baseUrl}/v1/agents`, { cache: "no-store" });
      if (!res.ok) throw new Error(`the control API answered ${res.status}`);
      const body = (await res.json()) as {
        agents: ApiAgent[];
        watermark: { block: number; updatedAt: string } | null;
      };
      const runtimes = orch ? await orch.runtimes().catch(() => null) : null;
      return {
        orchestrator: runtimes !== null,
        devActions: runtimes?.devActions ?? false,
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
            runtime:
              runtimes?.runtimes.find((r) => r.agentId === a.agentId)?.status ?? "not_provisioned",
            latestTask: runtimes?.runtimes.find((r) => r.agentId === a.agentId)?.latestTask ?? null,
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

/** The orchestrator's URL from configuration (ORCHESTRATOR_URL, local default). */
export function orchestratorUrl(): string {
  const config = loadConfig({ name: "dev console", usesChain: false });
  return String(config.values.ORCHESTRATOR_URL ?? "http://127.0.0.1:4200");
}

export const agentsSource = (): AgentsSource =>
  apiAgentsSource(controlApiUrl(), fetch, orchestratorUrl());
