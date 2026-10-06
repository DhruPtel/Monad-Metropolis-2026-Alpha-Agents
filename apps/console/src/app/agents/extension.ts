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
 * controls to reset an agent and run the no-op task; P1-U6 adds each agent's
 * funding address, credits, 24-hour spend and RESTRICTED state, and the
 * controls to fund it with test USDC and refund its credits; later units add
 * the last action.
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
  /** P1-U6: null when the orchestrator does not answer or has no funding address yet. */
  readonly credits: CreditsView | null;
}

/** An agent's credits as the orchestrator reports them (GET /v1/credits), in USDC base units. */
export interface CreditsView {
  readonly fundingAddress: string;
  readonly credits: bigint;
  readonly spendable: bigint;
  readonly held: bigint;
  readonly restricted: boolean;
}

/** A refund as the orchestrator reports it. */
export interface RefundView {
  readonly refundId: string;
  readonly status: "requested" | "signed" | "sent" | "refused" | "failed";
  readonly creditsUsdcE6: string | null;
  readonly heldUsdcE6: string | null;
  readonly txHash: string | null;
  readonly reason: string | null;
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
  /** P1-U6: asks for a refund of the agent's credits to its current owner. */
  refund?(agentId: AgentId): Promise<string>;
  refundStatus?(refundId: string): Promise<RefundView>;
}

interface ApiCredits {
  agentId: string;
  fundingAddress: string | null;
  creditsUsdcE6: string;
  spendableUsdcE6: string;
  heldUsdcE6: string;
  restricted: boolean;
  spent24hUsdcE6: string;
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
    async credits(): Promise<ApiCredits[]> {
      const body = await call("/v1/credits");
      return (body.agents ?? []) as ApiCredits[];
    },
    async refund(agentId: AgentId): Promise<string> {
      const body = await call(`/v1/agents/${agentId.toString()}/refund`, { method: "POST" });
      return String(body.refundId);
    },
    async refundStatus(refundId: string): Promise<RefundView> {
      return (await call(`/v1/refunds/${encodeURIComponent(refundId)}`)) as unknown as RefundView;
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
          refund: orch.refund,
          refundStatus: orch.refundStatus,
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
      const credits = runtimes && orch ? await orch.credits().catch(() => []) : [];
      return {
        orchestrator: runtimes !== null,
        devActions: runtimes?.devActions ?? false,
        watermark: body.watermark
          ? { block: body.watermark.block, updatedAt: body.watermark.updatedAt }
          : null,
        agents: body.agents.map((a) => {
          const species = a.species === 0 ? null : speciesByIndex(a.species);
          const c = credits.find((x) => x.agentId === a.agentId);
          const runtime =
            runtimes?.runtimes.find((r) => r.agentId === a.agentId)?.status ?? "not_provisioned";
          return {
            agentId: BigInt(a.agentId) as AgentId,
            name: `Alpha Agent #${a.agentId}`,
            owner: a.owner,
            tier: species?.tier ?? null,
            speciesName: species?.name ?? null,
            // D-129: a provisioned agent with no credits is RESTRICTED; goals and builds come later.
            state: runtime === "ready" && c?.restricted ? "RESTRICTED" : "UNCONFIGURED",
            spendUsdcE6: usdcE6(BigInt(c?.spent24hUsdcE6 ?? "0")),
            lastAction: null,
            runtime,
            latestTask: runtimes?.runtimes.find((r) => r.agentId === a.agentId)?.latestTask ?? null,
            credits:
              c && c.fundingAddress
                ? {
                    fundingAddress: c.fundingAddress,
                    credits: BigInt(c.creditsUsdcE6),
                    spendable: BigInt(c.spendableUsdcE6),
                    held: BigInt(c.heldUsdcE6),
                    restricted: c.restricted,
                  }
                : null,
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
