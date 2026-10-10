import { loadConfig } from "@alpha-agents/config";
import type { ActivityItem, RuntimeStatus, TaskStatus, ToolCallStatus } from "@alpha-agents/ui";
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
 * controls to fund it with test USDC and refund its credits; P1-U7 adds the
 * Scan, each agent's activity entries (the last one is its last action) and
 * its tool call history. P2-U5 adds the chain check, each agent's latest
 * portfolio reading and its intents.
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
  /** P1-U7: activity entries from the control API, newest first. */
  readonly activity: readonly ActivityItem[];
  /** P1-U7: tool calls from the orchestrator, newest first. */
  readonly toolCalls: readonly ToolCallView[];
  /** P2-U5: what the chain tools recorded; null when the orchestrator did not answer. */
  readonly chain: ChainView | null;
  /** P3-U3: the agent's plan and the runner's decisions; null when the orchestrator did not answer. */
  readonly plan: PlanView | null;
  /** P3-U7: the skills and playbooks its sandbox mounts; null when the orchestrator did not answer. */
  readonly skills: SkillsView | null;
}

/** The skills and playbooks an agent's sandbox mounts, with versions and hashes (P3-U7). */
export interface SkillsView {
  readonly tierPlaybook: string | null;
  readonly setHash: string;
  readonly packages: readonly {
    readonly kind: "skill" | "playbook";
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly contentHash: string;
    readonly description: string;
    readonly tools: readonly string[];
    readonly mountedAt: string;
  }[];
}

/** rebalance_bands@1's parameters as the orchestrator serves them (USDC base units as a string). */
export interface PlanParams {
  readonly targetWmonBps: number;
  readonly bandHalfWidthBps: number;
  readonly minTradeUsdcE6: string;
  readonly volatilityBrakeBps: number;
  readonly costHurdleBps: number;
  readonly maxLegBps: number;
}

/** target_portfolio@1's parameters as the orchestrator serves and takes them (F-U6). */
export interface PortfolioPosition {
  readonly token: string;
  readonly targetWeightBps: number;
  readonly bandBps: number;
  readonly thesisId: string;
  readonly exit: {
    readonly killCriterion: string;
    readonly recheckAt: string;
    readonly trimAboveBps?: number;
  };
}
export interface PortfolioPlanParams {
  readonly template: "target_portfolio@1";
  readonly positions: readonly PortfolioPosition[];
  readonly cashTargetBps: number;
  readonly minTradeUsdcE6: string;
  readonly volatilityBrakeBps: number;
  readonly costHurdleBps: number;
  readonly maxLegBps: number;
}

/** One rule a target portfolio draft failed in the Test stage v2 (F-U6). */
export interface PlanFinding {
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

/** A registered token the console's portfolio form offers (F-U6). */
export interface PortfolioTokenView {
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly class: string;
  readonly lane: string;
  readonly status: string;
  readonly capBps: number;
}

export interface RunnerDecisionView {
  readonly decisionId: number;
  readonly outcome: "hold" | "leg";
  readonly code: string;
  readonly codes: readonly string[];
  readonly message: string;
  readonly leg: {
    readonly sell: string;
    readonly buy: string;
    readonly amountIn: string;
    readonly valueUsdcE6: string;
  } | null;
  readonly intentId: string | null;
  readonly facts: Record<string, unknown>;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly ticks: number;
}

/** The agent's plan, the goal's defaults and limits, and the runner's recent decisions (P3-U3). */
export interface PlanView {
  readonly runner: { readonly on: boolean; readonly canSet: boolean; readonly canRun: boolean };
  readonly strategyEpoch: string;
  readonly goal: {
    readonly presetLabel: string;
    readonly defaults: PlanParams;
    readonly targetRange: { readonly minBps: number; readonly maxBps: number };
    readonly ownerLimits: { readonly maxTradeBps: number; readonly maxSlippageBps: number };
    /** F-U6: the aggressiveness the goal stands for and its envelope (A-60). */
    readonly aggressiveness?: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE" | null;
    readonly envelope?: {
      readonly label: string;
      readonly classAAllowed: boolean;
      readonly maxPositionBps: number;
      readonly maxClassAPositionBps: number;
      readonly maxClassATotalBps: number;
      readonly minStableBps: number;
      readonly maxPositions: number;
    } | null;
  } | null;
  readonly plan: {
    readonly paramId: string;
    /** F-U6: absent on views read before it, which were all two-asset plans. */
    readonly template?: "rebalance_bands@1" | "target_portfolio@1";
    readonly params: PlanParams | Omit<PortfolioPlanParams, "template">;
    readonly strategyEpoch: string;
    readonly setBy: string;
    readonly createdAt: string;
    readonly stale: boolean;
  } | null;
  readonly decisions: readonly RunnerDecisionView[];
  /** F-U6: the fund agent's set when the agent is on it: the tokens the portfolio form offers. */
  readonly portfolio?: {
    readonly custody: string;
    readonly tokens: readonly PortfolioTokenView[];
  } | null;
}

/** Whether a served plan is a target portfolio (F-U6). */
export const isPortfolioPlanView = (
  p: NonNullable<PlanView["plan"]>,
): p is NonNullable<PlanView["plan"]> & { params: Omit<PortfolioPlanParams, "template"> } =>
  p.template === "target_portfolio@1";

/** The agent's latest portfolio reading and its intents (GET /v1/agents/:id/chain). */
export interface ChainView {
  readonly portfolio: {
    readonly block?: string;
    readonly usdc?: string;
    readonly wmon?: string;
    readonly totalValueUsdc?: string;
    readonly mode?: string;
    readonly drawdownBps?: number | null;
    readonly at: string | null;
  } | null;
  readonly intents: readonly IntentView[];
  /** P2-U6: the agent's arming, and whether the trade flow runs (it needs the signer). */
  readonly arming: ArmingView | null;
  readonly tradeFlow: boolean;
}

/** An amount as packages/trading's intentJson gives it. */
export interface TokenAmount {
  readonly asset: "USDC" | "WMON";
  readonly amount: string;
  readonly amountRaw: string;
}

/** One reason a trade was blocked, with when it may clear (chain-tools' Blocker). */
export interface BlockerView {
  readonly code: string;
  readonly message: string;
  readonly clears: string;
  readonly clearsAt: string | null;
  readonly hint: string;
}

/** An intent through its states (P2-U6, packages/trading's intentJson). */
export interface IntentView {
  readonly intentId: string;
  readonly status: string;
  readonly sell: TokenAmount;
  readonly buy: "USDC" | "WMON";
  readonly expectedOut: TokenAmount | null;
  readonly minAmountOut: TokenAmount | null;
  readonly amountOut: TokenAmount | null;
  readonly reason: string;
  readonly reasonCodes: readonly string[];
  readonly blockers: readonly BlockerView[];
  readonly failure: string | null;
  readonly approvedBy: "owner" | "auto" | null;
  readonly txHash: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly settledAt: string | null;
}

/** The agent's arming (P2-U6, packages/trading's armingJson). */
export interface ArmingView {
  readonly state: "unarmed" | "awaiting_first_trade" | "armed";
  readonly validUntilDate: string | null;
  readonly renewalDue: boolean;
  readonly firstIntentId: string | null;
  readonly ended: {
    readonly reason: string;
    readonly message: string;
    readonly at: string | null;
    readonly revokedOnchain: boolean;
  } | null;
}

/** One tool call as the orchestrator reports it (GET /v1/agents/:id/tool-calls). */
export interface ToolCallView {
  readonly callId: string;
  readonly tool: string;
  /** The query, the URL's host, or the stage: never page or note text. */
  readonly target: string | null;
  readonly status: ToolCallStatus;
  readonly errorCode: string | null;
  readonly chargeUsdcE6: string;
  readonly reversed: boolean;
  readonly startedAt: string;
}

export type TaskKind = "noop" | "scan" | "chain_check" | "research_check";

/** The orchestrator's route for each task kind. */
const TASK_ROUTE: Readonly<Record<TaskKind, string>> = {
  noop: "noop",
  scan: "scan",
  chain_check: "chain-check",
  research_check: "research-check",
};

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
  readonly kind?: TaskKind;
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
  /** D-221: the local fork's reveal steering by species slug; null anywhere else. */
  readonly steering: RevealSteeringView | null;
}

/** One steered reveal (D-221), kept in Postgres by the orchestrator. */
export interface RevealSteerView {
  readonly steerId: string;
  readonly target:
    | { readonly kind: "wallet"; readonly wallet: string }
    | { readonly kind: "agent"; readonly agentId: string; readonly owner: string };
  /** Species slug. */
  readonly species: string | null;
  readonly status: "pending" | "applied" | "failed" | "cancelled";
  /** For a pending steer: exactly which agent it will apply to, read from the index. */
  readonly appliesTo: { readonly agentId: string | null; readonly text: string } | null;
  readonly appliedAgentId: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface RevealSteeringView {
  /** Agent #1's species on a fresh fork (LOCAL_FIRST_REVEAL_SPECIES), or null for random. */
  readonly firstReveal: string | null;
  /** Steers waiting for their agent's reveal, oldest first. */
  readonly pending: readonly RevealSteerView[];
  /** The last few resolved steers, newest first. */
  readonly recent: readonly RevealSteerView[];
}

/** Who a new steer is for: a wallet's next reveal, or one pending agent. */
export type RevealSteerTarget = { readonly wallet: string } | { readonly agentId: string };

export interface AgentsSource {
  /** P1-U4: list every agent from the API's projections. */
  listAgents(): Promise<AgentList>;
  /** P1-U5: a new runtime generation with a new key and a fresh config. */
  resetAgent?(agentId: AgentId): Promise<void>;
  /** P1-U5: queues a task for one agent (the no-op task, or P1-U7's Scan); returns its ID. */
  triggerTask?(agentId: AgentId, task: TaskKind): Promise<string>;
  /** P1-U5: one task's status and structured result. */
  task?(taskId: string): Promise<TaskView>;
  /** D-221: steer a wallet's or a pending agent's reveal on the local fork to a species slug. */
  steerReveal?(species: string, target: RevealSteerTarget): Promise<RevealSteeringView>;
  /** D-221: cancel a pending steer. */
  cancelSteer?(steerId: string): Promise<RevealSteeringView>;
  /** P1-U6: asks for a refund of the agent's credits to its current owner. */
  refund?(agentId: AgentId): Promise<string>;
  refundStatus?(refundId: string): Promise<RefundView>;
  /** P2-U6: arm as the owner would on the local fork (the grant, then its record). */
  armAgent?(agentId: AgentId): Promise<ArmingView>;
  /** P2-U6: disarm now, and revoke the grant on the local fork. */
  disarmAgent?(agentId: AgentId): Promise<ArmingView>;
  /** P2-U6: record a proposal over the trade size limit (local only); returns its intent ID. */
  proposeOverLimit?(agentId: AgentId): Promise<string>;
  /** P3-U3: set the agent's plan; resolves to the new strategy epoch. */
  setPlan?(agentId: AgentId, params: PlanParams): Promise<string>;
  /** F-U6: set a target portfolio plan, checked by the Test stage v2; resolves to the new strategy epoch. */
  setPortfolioPlan?(agentId: AgentId, params: PortfolioPlanParams): Promise<string>;
  /** F-U6: check a target portfolio draft without setting it. */
  checkPortfolioPlan?(agentId: AgentId, params: PortfolioPlanParams): Promise<PlanFinding[]>;
  /** P3-U3: run the template runner for the agent once (local only). */
  runRunner?(agentId: AgentId): Promise<RunnerDecisionView>;
  /** P2-U6: approve a waiting intent as the owner; true when it armed the agent. */
  approveIntent?(agentId: AgentId, intentId: string): Promise<boolean>;
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
    async triggerTask(agentId: AgentId, task: TaskKind): Promise<string> {
      const body = await call(`/v1/agents/${agentId.toString()}/tasks/${TASK_ROUTE[task]}`, {
        method: "POST",
      });
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
    async steering(): Promise<RevealSteeringView | null> {
      const body = await call("/v1/keeper");
      return (body.steering as RevealSteeringView | null | undefined) ?? null;
    },
    async steerReveal(species: string, target: RevealSteerTarget): Promise<RevealSteeringView> {
      const body = await call("/v1/keeper/reveal-steers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ species, ...target }),
      });
      return body.steering as RevealSteeringView;
    },
    async cancelSteer(steerId: string): Promise<RevealSteeringView> {
      const body = await call(`/v1/keeper/reveal-steers/${encodeURIComponent(steerId)}/cancel`, {
        method: "POST",
      });
      return body.steering as RevealSteeringView;
    },
    async toolCalls(agentId: string): Promise<ToolCallView[]> {
      const body = await call(`/v1/agents/${agentId}/tool-calls`);
      return (body.calls ?? []) as ToolCallView[];
    },
    async chain(agentId: string): Promise<ChainView> {
      const body = await call(`/v1/agents/${agentId}/chain`);
      return {
        portfolio: (body.portfolio as ChainView["portfolio"] | undefined) ?? null,
        intents: (body.intents ?? []) as IntentView[],
        arming: (body.arming as ArmingView | undefined) ?? null,
        tradeFlow: body.tradeFlow === true,
      };
    },
    async skills(agentId: string): Promise<SkillsView> {
      return (await call(`/v1/agents/${agentId}/skills`)) as unknown as SkillsView;
    },
    async plan(agentId: string): Promise<PlanView> {
      return (await call(`/v1/agents/${agentId}/plan`)) as unknown as PlanView;
    },
    async setPlan(agentId: AgentId, params: PlanParams): Promise<string> {
      const body = await call(`/v1/agents/${agentId.toString()}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      return String((body.plan as { strategyEpoch?: unknown } | undefined)?.strategyEpoch ?? "");
    },
    async setPortfolioPlan(agentId: AgentId, params: PortfolioPlanParams): Promise<string> {
      const body = await call(`/v1/agents/${agentId.toString()}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      return String((body.plan as { strategyEpoch?: unknown } | undefined)?.strategyEpoch ?? "");
    },
    async checkPortfolioPlan(
      agentId: AgentId,
      params: PortfolioPlanParams,
    ): Promise<PlanFinding[]> {
      const body = await call(`/v1/agents/${agentId.toString()}/plan/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      return (body.findings ?? []) as PlanFinding[];
    },
    async runRunner(agentId: AgentId): Promise<RunnerDecisionView> {
      const body = await call(`/v1/agents/${agentId.toString()}/runner/run`, { method: "POST" });
      return body.decision as RunnerDecisionView;
    },
    async armAgent(agentId: AgentId): Promise<ArmingView> {
      const body = await call(`/v1/agents/${agentId.toString()}/arm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return body.arming as ArmingView;
    },
    async disarmAgent(agentId: AgentId): Promise<ArmingView> {
      const body = await call(`/v1/agents/${agentId.toString()}/disarm`, { method: "POST" });
      return body.arming as ArmingView;
    },
    async proposeOverLimit(agentId: AgentId): Promise<string> {
      const body = await call(`/v1/agents/${agentId.toString()}/test-over-limit`, {
        method: "POST",
      });
      return String(body.intentId);
    },
    async approveIntent(agentId: AgentId, intentId: string): Promise<boolean> {
      const body = await call(
        `/v1/agents/${agentId.toString()}/intents/${encodeURIComponent(intentId)}/approve`,
        { method: "POST" },
      );
      return body.armed === true;
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
          steerReveal: orch.steerReveal,
          cancelSteer: orch.cancelSteer,
          armAgent: orch.armAgent,
          disarmAgent: orch.disarmAgent,
          setPlan: orch.setPlan,
          runRunner: orch.runRunner,
          approveIntent: orch.approveIntent,
          proposeOverLimit: orch.proposeOverLimit,
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
      const steering = runtimes && orch ? await orch.steering().catch(() => null) : null;
      // P1-U7: activity from the control API and tool calls from the orchestrator, for each
      // provisioned agent; a failed read shows as none rather than failing the page.
      const activity = new Map<string, ActivityItem[]>();
      const toolCalls = new Map<string, ToolCallView[]>();
      const chain = new Map<string, ChainView | null>();
      const plans = new Map<string, PlanView | null>();
      const skills = new Map<string, SkillsView | null>();
      for (const r of runtimes?.runtimes ?? []) {
        const [a, t, ch, pl, sk] = await Promise.all([
          fetchFn(`${baseUrl}/v1/agents/${r.agentId}/activity`, { cache: "no-store" })
            .then(async (res) =>
              res.ok ? (((await res.json()) as { entries?: ActivityItem[] }).entries ?? []) : [],
            )
            .catch(() => []),
          orch ? orch.toolCalls(r.agentId).catch(() => []) : [],
          orch ? orch.chain(r.agentId).catch(() => null) : null,
          orch ? orch.plan(r.agentId).catch(() => null) : null,
          orch ? orch.skills(r.agentId).catch(() => null) : null,
        ]);
        activity.set(r.agentId, a);
        toolCalls.set(r.agentId, t);
        chain.set(r.agentId, ch);
        plans.set(r.agentId, pl);
        skills.set(r.agentId, sk);
      }
      return {
        orchestrator: runtimes !== null,
        devActions: runtimes?.devActions ?? false,
        steering,
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
            lastAction: activity.get(a.agentId)?.[0]?.text ?? null,
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
            activity: activity.get(a.agentId) ?? [],
            toolCalls: toolCalls.get(a.agentId) ?? [],
            chain: chain.get(a.agentId) ?? null,
            plan: plans.get(a.agentId) ?? null,
            skills: skills.get(a.agentId) ?? null,
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
