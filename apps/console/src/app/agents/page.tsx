import { SCAN_MIN_CREDITS_USDC_E6 } from "@alpha-agents/accounting";
import {
  ACCOUNT_MODES,
  ARMING_STATE_MEANINGS,
  type AccountMode,
  INTENT_STATES,
  INTENT_STATE_MEANINGS,
  type IntentState,
  REJECTION_CODES,
  type RejectionCode,
  TRADE_FLOW_CODES,
  type TradeFlowCode,
} from "@alpha-agents/domain";
import {
  ActivityFeed,
  AddressDisplay,
  AmountDisplay,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ReasonMessage,
  RuntimeStatusBadge,
  SectionLabel,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  ToolCallStatusBadge,
} from "@alpha-agents/ui";
import { Bot, PlugZap } from "lucide-react";
import { PanelHeader } from "@/components/panel-header";
import { AgentActions, AgentTasks, CreditActions } from "./agent-tasks";
import { RevealControl } from "./reveal-control";
import { PlanControls } from "./plan-controls";
import { portfolioSummary } from "./portfolio-plan";
import { ApproveIntentButton, ArmingControls, RefreshWhileMoving } from "./trade-controls";
import {
  type AgentList,
  type AgentRow,
  type ChainView,
  type PlanView,
  type SkillsView,
  PLANNED_AGENT_ACTIONS,
  agentsSource,
  isPortfolioPlanView,
  type PlanParams,
} from "./extension";

// Read from the control API on every visit, never at build time.
export const dynamic = "force-dynamic";

const TIER_TONE = { base: "neutral", medium: "rare", pro: "legendary" } as const;

const isMode = (v: unknown): v is AccountMode =>
  typeof v === "string" && (ACCOUNT_MODES as readonly string[]).includes(v);
const isIntentState = (v: string): v is IntentState =>
  (INTENT_STATES as readonly string[]).includes(v);
const DECIMALS = { USDC: 6, WMON: 18 } as const;
/** A decimal from the chain tools ("12.5") as base units, for AmountDisplay. */
const units = (text: string | undefined, decimals: number): bigint => {
  if (!text || !/^\d+(\.\d+)?$/.test(text)) return 0n;
  const [w = "0", f = ""] = text.split(".");
  return (
    BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.slice(0, decimals).padEnd(decimals, "0") || "0")
  );
};

/** P2-U6: the reason codes a blocker may carry (the Executor's and the trade flow's own). */
const isReason = (v: string): v is RejectionCode | TradeFlowCode =>
  (REJECTION_CODES as readonly string[]).includes(v) ||
  (TRADE_FLOW_CODES as readonly string[]).includes(v);
const CLEARS_TEXT: Record<string, string> = {
  by_waiting: "clears by waiting",
  by_changing_the_trade: "clears with another trade",
  by_the_owner: "the owner clears it",
  by_the_platform: "the platform clears it",
};
/** Intents still moving through the trade flow: the page refreshes while any is. */
const MOVING = new Set(["approved", "submitted", "confirmed"]);

/** P2-U6: the agent's arming, with the console's arm and disarm. */
function AgentArming({
  agentId,
  name,
  chain,
  enabled,
}: {
  agentId: string;
  name: string;
  chain: ChainView;
  enabled: boolean;
}) {
  const a = chain.arming;
  const state = a?.state ?? "unarmed";
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-surface px-4 py-3"
      data-testid="agent-arming"
      data-state={state}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <StatusPill kind="arming" value={state} />
          {a?.validUntilDate ? (
            <span className="text-xs text-foreground-muted">
              Permission until <span className="numeric">{a.validUntilDate}</span>
            </span>
          ) : null}
          {a?.renewalDue ? <Badge tone="warning">Renew soon</Badge> : null}
        </span>
        <span className="text-xs break-words text-foreground-muted">
          {state === "unarmed"
            ? a?.ended
              ? `${a.ended.message}${a.ended.reason === "disarmed" && !a.ended.revokedOnchain ? " The permission is still on chain until it is revoked." : ""}`
              : "Every proposal waits for the owner's approval."
            : ARMING_STATE_MEANINGS[state]}
        </span>
        {chain.tradeFlow ? null : (
          <span className="text-xs text-foreground-muted">
            The trade flow is off: start the orchestrator with the signer to send trades.
          </span>
        )}
      </div>
      <ArmingControls agentId={agentId} name={name} state={state} enabled={enabled} />
    </div>
  );
}

/** P3-U7: the skills and playbooks the agent's sandbox mounts, read-only, with versions and hashes. */
function AgentSkills({ name, skills }: { name: string; skills: SkillsView | null }) {
  if (!skills)
    return <p className="text-sm text-foreground-muted">The mounted skills could not be read.</p>;
  return (
    <div className="flex flex-col gap-4" data-testid="agent-skills">
      <SectionLabel as="h3">Skills and playbooks</SectionLabel>
      <p className="text-sm text-foreground-muted">
        Mounted read-only in every sandbox; the same set for every agent until builds exist. Set{" "}
        <span className="numeric text-foreground">{skills.setHash.slice(0, 12)}</span>
        {skills.tierPlaybook ? (
          <>
            , tier config <span className="numeric text-foreground">{skills.tierPlaybook}</span>
          </>
        ) : null}
        .
      </p>
      <Table stack label={`Skills and playbooks of ${name}`}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Kind</TableHead>
            <TableHead scope="col">Version</TableHead>
            <TableHead scope="col">Content hash</TableHead>
            <TableHead scope="col">Tools</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {skills.packages.map((p) => (
            <TableRow key={p.name}>
              <TableCell className="numeric whitespace-nowrap">{p.name}</TableCell>
              <TableCell label="Kind">
                <Badge tone={p.kind === "playbook" ? "detail" : "neutral"}>
                  {p.kind === "playbook" ? "Playbook" : "Skill"}
                </Badge>
              </TableCell>
              <TableCell label="Version" className="numeric">
                {p.version}
              </TableCell>
              <TableCell label="Content hash" className="numeric">
                {p.contentHash.slice(0, 12)}
              </TableCell>
              <TableCell label="Tools" className="numeric">
                {p.tools.length}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** F-U6: the position a portfolio decision is about, with its share and target, from the rule's facts. */
function positionShare(facts: Record<string, unknown>): string {
  const positions = facts.positions;
  const about = facts.position;
  if (!Array.isArray(positions) || typeof about !== "string") return "";
  const p = (
    positions as { token: string; symbol: string; shareBps: number | null; targetBps: number }[]
  ).find((x) => x.token.toLowerCase() === about.toLowerCase());
  if (!p) return "";
  return `${p.symbol} ${p.shareBps === null ? "?" : p.shareBps / 100}% of ${p.targetBps / 100}%`;
}

/** P3-U3: the agent's plan, the goal's limits, the runner's recent decisions, and the plan form. */
function AgentPlan({
  agentId,
  name,
  plan,
  enabled,
}: {
  agentId: string;
  name: string;
  plan: PlanView | null;
  enabled: boolean;
}) {
  if (!plan) return <p className="text-sm text-foreground-muted">The plan could not be read.</p>;
  const g = plan.goal;
  const p = plan.plan;
  const bands = p && !isPortfolioPlanView(p) ? (p.params as PlanParams) : null;
  const pct = (bps: number) => `${bps / 100}%`;
  return (
    <div className="flex flex-col gap-4" data-testid="agent-plan">
      <SectionLabel as="h3">Plan and runner</SectionLabel>
      {!g ? (
        <p className="text-sm text-foreground-muted">
          No goal yet: the owner saves one on the Goal page before a plan can be set.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="plan-summary">
            <Badge tone={plan.runner.on ? "positive" : "neutral"}>
              {plan.runner.on ? "Runner on" : "Runner off"}
            </Badge>
            <span className="text-foreground-muted">
              {g.presetLabel} goal: target {pct(g.targetRange.minBps)} to{" "}
              {pct(g.targetRange.maxBps)} WMON, largest trade {pct(g.ownerLimits.maxTradeBps)}
            </span>
            {g.envelope ? (
              <span className="text-foreground-muted" data-testid="plan-envelope">
                {g.envelope.label} envelope: at most {g.envelope.maxPositions} positions,{" "}
                {pct(g.envelope.maxPositionBps)} each, {pct(g.envelope.minStableBps)} in stablecoins
                {g.envelope.classAAllowed
                  ? `, class A up to ${pct(g.envelope.maxClassATotalBps)}`
                  : ", class F only"}
              </span>
            ) : null}
            {p ? (
              <>
                {isPortfolioPlanView(p) ? (
                  <span>
                    Plan: {portfolioSummary(p.params, plan.portfolio?.tokens ?? [])}, legs up to{" "}
                    <span className="numeric">{pct(p.params.maxLegBps)}</span>, set by {p.setBy} at
                    strategy epoch <span className="numeric">{p.strategyEpoch}</span>
                  </span>
                ) : bands ? (
                  <span>
                    Plan: <span className="numeric">{pct(bands.targetWmonBps)}</span> WMON ±{" "}
                    <span className="numeric">{bands.bandHalfWidthBps / 100}</span> points, legs up
                    to <span className="numeric">{pct(bands.maxLegBps)}</span>, set by {p.setBy} at
                    strategy epoch <span className="numeric">{p.strategyEpoch}</span>
                  </span>
                ) : null}
                {p.stale ? <Badge tone="warning">Goal changed: set a new plan</Badge> : null}
              </>
            ) : (
              <span>No plan yet: the runner makes no trades.</span>
            )}
          </div>
          <PlanControls
            agentId={agentId}
            name={name}
            plan={p}
            defaults={g.defaults}
            portfolio={plan.portfolio ?? null}
            canSet={enabled && plan.runner.canSet}
            canRun={enabled && plan.runner.canRun && p !== null}
          />
        </>
      )}
      {plan.decisions.length === 0 ? (
        <p className="text-sm text-foreground-muted">The runner has made no decision yet.</p>
      ) : (
        <Table stack label={`Runner decisions of ${name}`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Last seen</TableHead>
              <TableHead scope="col">Decision</TableHead>
              <TableHead scope="col">Why</TableHead>
              <TableHead scope="col">Share and leg</TableHead>
              <TableHead scope="col">Minutes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.decisions.slice(0, 6).map((d) => (
              <TableRow key={d.decisionId}>
                <TableCell className="numeric whitespace-nowrap">
                  {d.lastAt.replace("T", " ").slice(0, 16)} UTC
                </TableCell>
                <TableCell label="Decision">
                  <Badge
                    tone={
                      d.outcome === "leg" ? "detail" : d.code === "IN_BAND" ? "positive" : "warning"
                    }
                  >
                    {d.outcome === "leg" ? "Leg" : d.code}
                  </Badge>
                </TableCell>
                <TableCell label="Why" className="text-sm">
                  {d.message}
                </TableCell>
                <TableCell label="Share and leg" className="numeric text-sm">
                  {typeof d.facts.wmonShareBps === "number"
                    ? `${d.facts.wmonShareBps / 100}% WMON`
                    : positionShare(d.facts)}
                  {d.leg ? (
                    <>
                      {" · "}
                      <AmountDisplay
                        value={BigInt(d.leg.amountIn)}
                        decimals={
                          d.leg.sell === "USDC"
                            ? 6
                            : typeof d.facts.sellDecimals === "number"
                              ? d.facts.sellDecimals
                              : 18
                        }
                        maxFractionDigits={4}
                        symbol={d.leg.sell}
                      />
                      {d.leg.buy ? ` for ${d.leg.buy}` : ""}
                    </>
                  ) : null}
                </TableCell>
                <TableCell label="Minutes" className="numeric">
                  {d.ticks}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** P2-U5, P2-U6: the latest portfolio reading, the arming, and intents through their states. */
function AgentChain({
  agentId,
  name,
  chain,
  enabled,
}: {
  agentId: string;
  name: string;
  chain: ChainView | null;
  enabled: boolean;
}) {
  if (!chain)
    return <p className="text-sm text-foreground-muted">The chain tools could not be read.</p>;
  const p = chain.portfolio;
  const armingState = chain.arming?.state ?? "unarmed";
  return (
    <div className="flex flex-col gap-4" data-testid="agent-chain">
      <SectionLabel as="h3">Chain tools</SectionLabel>
      {p ? (
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm"
          data-testid="portfolio-reading"
        >
          <span className="text-foreground-muted">Latest portfolio reading</span>
          <AmountDisplay
            value={units(p.totalValueUsdc, 6)}
            decimals={6}
            minFractionDigits={2}
            symbol="USDC"
          />
          <span className="flex items-center gap-1 text-xs text-foreground-muted">
            <AmountDisplay
              value={units(p.usdc, 6)}
              decimals={6}
              minFractionDigits={2}
              symbol="USDC"
            />
            <span aria-hidden>and</span>
            <AmountDisplay
              value={units(p.wmon, 18)}
              decimals={18}
              maxFractionDigits={4}
              symbol="WMON"
            />
          </span>
          {isMode(p.mode) ? <StatusPill kind="account_mode" value={p.mode} /> : null}
          <span className="text-xs text-foreground-muted">
            Drawdown{" "}
            <span className="numeric">
              {p.drawdownBps === null || p.drawdownBps === undefined
                ? "unknown"
                : `${(p.drawdownBps / 100).toFixed(2)}%`}
            </span>
            {p.block ? (
              <>
                {" "}
                at block <span className="numeric">{p.block}</span>
              </>
            ) : null}
          </span>
        </div>
      ) : (
        <p className="text-sm text-foreground-muted">
          No portfolio reading yet: run a chain check.
        </p>
      )}
      <RefreshWhileMoving active={chain.intents.some((i) => MOVING.has(i.status))} />
      <AgentArming agentId={agentId} name={name} chain={chain} enabled={enabled} />
      {chain.intents.length === 0 ? (
        <p className="text-sm text-foreground-muted">No intents yet.</p>
      ) : (
        <Table stack label={`Intents of ${name}`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Proposal</TableHead>
              <TableHead scope="col">Why or result</TableHead>
              <TableHead scope="col">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {chain.intents.slice(0, 8).map((i) => (
              <TableRow key={i.intentId} data-status={i.status}>
                <TableCell label="State" className="align-top">
                  <span className="flex flex-col items-start gap-1">
                    {isIntentState(i.status) ? (
                      <StatusPill kind="intent" value={i.status} />
                    ) : (
                      <Badge>{i.status}</Badge>
                    )}
                    {i.approvedBy ? (
                      <span className="text-xs text-foreground-muted">
                        {i.approvedBy === "auto" ? "Approved while armed" : "Approved by the owner"}
                      </span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell label="Proposal" className="align-top">
                  <div className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-1">
                      Sell
                      <AmountDisplay
                        value={BigInt(i.sell.amountRaw)}
                        decimals={DECIMALS[i.sell.asset]}
                        maxFractionDigits={6}
                        symbol={i.sell.asset}
                      />
                      for {i.buy}
                    </span>
                    <span className="text-xs break-words text-foreground-muted">{i.reason}</span>
                  </div>
                </TableCell>
                <TableCell label="Why or result" className="align-top">
                  {i.amountOut ? (
                    <span className="flex flex-col gap-1" data-testid="intent-result">
                      <span className="flex flex-wrap items-center gap-1">
                        Got
                        <AmountDisplay
                          value={BigInt(i.amountOut.amountRaw)}
                          decimals={DECIMALS[i.amountOut.asset]}
                          maxFractionDigits={6}
                          symbol={i.amountOut.asset}
                        />
                      </span>
                      {i.txHash ? (
                        <span className="numeric text-xs break-all text-foreground-muted">
                          {i.txHash}
                        </span>
                      ) : null}
                    </span>
                  ) : i.blockers.length > 0 &&
                    (i.status === "rejected" || i.status === "failed") ? (
                    <div className="flex flex-col gap-2">
                      {i.blockers.map((b) =>
                        isReason(b.code) ? (
                          <ReasonMessage
                            key={b.code}
                            code={b.code}
                            detail={`${CLEARS_TEXT[b.clears] ?? b.clears}${b.clearsAt ? ` at ${b.clearsAt.slice(11, 16)} UTC` : ""}`}
                          />
                        ) : (
                          <span key={b.code}>{b.code}</span>
                        ),
                      )}
                    </div>
                  ) : (
                    <span className="text-sm text-foreground-muted">
                      {i.status === "awaiting_approval"
                        ? `Passed every check; waits until ${i.expiresAt.slice(11, 19)} UTC`
                        : i.status === "expired"
                          ? "Expired before approval"
                          : isIntentState(i.status)
                            ? INTENT_STATE_MEANINGS[i.status]
                            : i.status}
                    </span>
                  )}
                </TableCell>
                <TableCell label="Action" className="align-top">
                  {i.status === "awaiting_approval" && armingState !== "unarmed" && enabled ? (
                    <ApproveIntentButton
                      agentId={agentId}
                      intentId={i.intentId}
                      first={armingState === "awaiting_first_trade"}
                    />
                  ) : (
                    <span className="text-xs text-foreground-muted">
                      {i.status === "awaiting_approval" ? "Arm the agent to approve" : "None"}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** P1-U7: each provisioned agent's activity entries and its last tool calls. */
function AgentActivity({ agents, enabled }: { agents: readonly AgentRow[]; enabled: boolean }) {
  if (agents.length === 0) return null;
  return (
    <section
      aria-labelledby="activity-heading"
      className="flex flex-col gap-4"
      data-testid="agent-activity"
    >
      <SectionLabel as="h2" id="activity-heading">
        Activity and tool calls
      </SectionLabel>
      {agents.map((a) => (
        <Card key={a.agentId.toString()}>
          <CardHeader>
            <CardTitle>{a.name}</CardTitle>
            <CardDescription>
              Entries the narrator wrote from the agent's records, newest first, its last tool calls
              with what each was charged, and what the chain tools recorded.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <ActivityFeed
              label={`Activity of ${a.name}`}
              entries={a.activity.slice(0, 5)}
              empty="No activity yet: run a Scan."
            />
            {a.toolCalls.length === 0 ? (
              <p className="text-sm text-foreground-muted">No tool calls yet.</p>
            ) : (
              <Table label={`Tool calls of ${a.name}`}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Tool</TableHead>
                    <TableHead scope="col">Query or host</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">Charge</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {a.toolCalls.slice(0, 12).map((c) => (
                    <TableRow key={c.callId}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {c.tool}
                      </TableCell>
                      <TableCell className="max-w-64 text-xs break-words text-foreground-muted">
                        {c.target ?? "None"}
                      </TableCell>
                      <TableCell>
                        <ToolCallStatusBadge status={c.status} code={c.errorCode} />
                      </TableCell>
                      <TableCell>
                        <AmountDisplay
                          value={c.status === "succeeded" ? BigInt(c.chargeUsdcE6) : 0n}
                          decimals={6}
                          maxFractionDigits={4}
                          symbol="USDC"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="xl:col-span-2">
              <AgentChain
                agentId={a.agentId.toString()}
                name={a.name}
                chain={a.chain}
                enabled={enabled}
              />
            </div>
            <div className="xl:col-span-2">
              <AgentPlan
                agentId={a.agentId.toString()}
                name={a.name}
                plan={a.plan}
                enabled={enabled}
              />
            </div>
            <div className="xl:col-span-2">
              <AgentSkills name={a.name} skills={a.skills} />
            </div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
const TIER_NAME = { base: "Base", medium: "Medium", pro: "Pro" } as const;

async function load(): Promise<AgentList | null> {
  try {
    return await agentsSource().listAgents();
  } catch {
    return null;
  }
}

export default async function AgentsPage() {
  const list = await load();
  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        title="Agents"
        description="Every agent on the local stack from the control API's index, with its funding address and credits, its runtime from the orchestrator, its state, spend and last action, and controls to fund it, run the no-op task, a Scan, a chain check or a research check, refund its credits or reset it. Below the table: each provisioned agent's activity entries, tool calls, latest portfolio reading and intents."
      />
      {list === null ? (
        <EmptyState
          icon={PlugZap}
          title="Control API unreachable"
          description="Start it with pnpm dev:api, and the indexer with pnpm dev:indexer."
        />
      ) : list.agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="Mint one from the web app's mint page; it appears here once the indexer sees it."
        />
      ) : (
        <AgentTasks>
          <div className="flex flex-col gap-3" data-testid="agents-list">
            <p className="text-sm text-foreground-muted">
              <span className="numeric text-foreground">{list.agents.length}</span> agents, indexed
              to block{" "}
              <span className="numeric text-foreground">{list.watermark?.block ?? "none"}</span>.{" "}
              {list.orchestrator
                ? list.devActions
                  ? null
                  : "The orchestrator offers no actions outside the local stack."
                : "The orchestrator is not running: start it with pnpm dev:orchestrator to see runtimes and run tasks."}
            </p>
            <Table label="Agents">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Agent</TableHead>
                  <TableHead scope="col">Tier</TableHead>
                  <TableHead scope="col">Owner and funding address</TableHead>
                  <TableHead scope="col">Credits</TableHead>
                  <TableHead scope="col">Runtime and state</TableHead>
                  <TableHead scope="col">Spend, 24h</TableHead>
                  <TableHead scope="col">Last action</TableHead>
                  <TableHead scope="col">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.agents.map((a) => (
                  <TableRow key={a.agentId.toString()}>
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="font-medium whitespace-nowrap">{a.name}</span>
                        <span className="text-xs whitespace-nowrap text-foreground-muted">
                          {a.speciesName ?? "Waiting for reveal"}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {a.tier ? (
                        <Tag tone={TIER_TONE[a.tier]}>{TIER_NAME[a.tier]}</Tag>
                      ) : (
                        <span className="text-xs text-foreground-muted">Unrevealed</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-1">
                        <AddressDisplay address={a.owner} label={`Owner of ${a.name}`} />
                        {a.credits ? (
                          <AddressDisplay
                            address={a.credits.fundingAddress}
                            label={`Funding address of ${a.name}`}
                          />
                        ) : (
                          <span className="text-xs text-foreground-muted">
                            No funding address yet
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      {a.credits ? (
                        <span className="flex flex-col gap-1">
                          <AmountDisplay
                            value={a.credits.spendable}
                            decimals={6}
                            maxFractionDigits={4}
                            symbol="USDC"
                          />
                          {a.credits.held > 0n ? (
                            <Badge
                              tone="warning"
                              title="Deposited above the 50 USDC beta cap; returned by a refund"
                            >
                              <AmountDisplay value={a.credits.held} decimals={6} symbol="USDC" />{" "}
                              held
                            </Badge>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-xs text-foreground-muted">Unknown</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col items-start gap-1">
                        {list.orchestrator ? (
                          <RuntimeStatusBadge status={a.runtime} />
                        ) : (
                          <span className="text-xs text-foreground-muted">Runtime unknown</span>
                        )}
                        <StatusPill kind="agent_state" value={a.state} />
                      </span>
                    </TableCell>
                    <TableCell>
                      {/* Model calls cost fractions of a cent: four decimals, truncated, never overstated. */}
                      <AmountDisplay
                        value={a.spendUsdcE6}
                        decimals={6}
                        maxFractionDigits={4}
                        symbol="USDC"
                      />
                    </TableCell>
                    <TableCell className="text-xs text-foreground-muted">
                      {/* The latest activity entry; the whole entry is below the table. */}
                      <span className="line-clamp-3 max-w-56" title={a.lastAction ?? undefined}>
                        {a.lastAction ?? "None yet"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-2">
                        <AgentActions
                          agentId={a.agentId.toString()}
                          name={a.name}
                          runtime={a.runtime}
                          enabled={list.orchestrator && list.devActions}
                          restricted={a.credits?.restricted ?? false}
                          canScan={(a.credits?.spendable ?? 0n) >= SCAN_MIN_CREDITS_USDC_E6}
                        />
                        <CreditActions
                          agentId={a.agentId.toString()}
                          name={a.name}
                          enabled={list.orchestrator && list.devActions && a.credits !== null}
                          hasCredits={
                            (a.credits?.spendable ?? 0n) > 0n || (a.credits?.held ?? 0n) > 0n
                          }
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <AgentActivity
              agents={list.agents.filter((a) => a.runtime === "ready")}
              enabled={list.orchestrator && list.devActions}
            />
          </div>
        </AgentTasks>
      )}
      {list?.devActions && list.steering ? <RevealControl steering={list.steering} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>Planned controls</CardTitle>
          <CardDescription>Each one is wired by the unit named beside it.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-3">
            {PLANNED_AGENT_ACTIONS.map((a) => (
              <li key={a.label} className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm">
                  {a.label}
                  <Badge>{a.unit}</Badge>
                </span>
                <Button size="sm" variant={a.unit === "PB-U1" ? "danger" : "secondary"} disabled>
                  {a.unit === "PB-U1" ? "Pause all" : "Not available yet"}
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
