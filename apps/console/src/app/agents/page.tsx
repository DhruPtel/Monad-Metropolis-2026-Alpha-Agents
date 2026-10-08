import { SCAN_MIN_CREDITS_USDC_E6 } from "@alpha-agents/accounting";
import {
  ACCOUNT_MODES,
  type AccountMode,
  INTENT_STATES,
  type IntentState,
  REJECTION_CODES,
  type RejectionCode,
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
import {
  type AgentList,
  type AgentRow,
  type ChainView,
  PLANNED_AGENT_ACTIONS,
  agentsSource,
} from "./extension";

// Read from the control API on every visit, never at build time.
export const dynamic = "force-dynamic";

const TIER_TONE = { base: "neutral", medium: "rare", pro: "legendary" } as const;

const isMode = (v: unknown): v is AccountMode =>
  typeof v === "string" && (ACCOUNT_MODES as readonly string[]).includes(v);
const isIntentState = (v: string): v is IntentState =>
  (INTENT_STATES as readonly string[]).includes(v);
const isReason = (v: string): v is RejectionCode =>
  (REJECTION_CODES as readonly string[]).includes(v);
const DECIMALS = { USDC: 6, WMON: 18 } as const;
/** A decimal from the chain tools ("12.5") as base units, for AmountDisplay. */
const units = (text: string | undefined, decimals: number): bigint => {
  if (!text || !/^\d+(\.\d+)?$/.test(text)) return 0n;
  const [w = "0", f = ""] = text.split(".");
  return (
    BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.slice(0, decimals).padEnd(decimals, "0") || "0")
  );
};

/** P2-U5: the agent's latest portfolio reading and its intents with their states and reasons. */
function AgentChain({ name, chain }: { name: string; chain: ChainView | null }) {
  if (!chain)
    return <p className="text-sm text-foreground-muted">The chain tools could not be read.</p>;
  const p = chain.portfolio;
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
      {chain.intents.length === 0 ? (
        <p className="text-sm text-foreground-muted">No intents yet.</p>
      ) : (
        <Table stack label={`Intents of ${name}`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Proposal</TableHead>
              <TableHead scope="col">Why</TableHead>
              <TableHead scope="col">Expires</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {chain.intents.slice(0, 8).map((i) => (
              <TableRow key={i.intentId} data-status={i.status}>
                <TableCell label="State" className="align-top">
                  {isIntentState(i.status) ? (
                    <StatusPill kind="intent" value={i.status} />
                  ) : (
                    <Badge>{i.status}</Badge>
                  )}
                </TableCell>
                <TableCell label="Proposal" className="align-top">
                  <div className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-1">
                      Sell
                      <AmountDisplay
                        value={BigInt(i.amountIn)}
                        decimals={DECIMALS[i.sell]}
                        maxFractionDigits={6}
                        symbol={i.sell}
                      />
                      for {i.buy}
                    </span>
                    <span className="text-xs break-words text-foreground-muted">{i.reason}</span>
                  </div>
                </TableCell>
                <TableCell label="Why" className="align-top">
                  {i.reasonCodes.length === 0 ? (
                    <span className="text-sm text-foreground-muted">Passed every check</span>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {i.reasonCodes.map((c) =>
                        isReason(c) ? <ReasonMessage key={c} code={c} /> : <span key={c}>{c}</span>,
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell label="Expires" className="numeric align-top text-xs">
                  {i.status === "awaiting_approval" ? i.expiresAt.slice(11, 19) : "None"}
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
function AgentActivity({ agents }: { agents: readonly AgentRow[] }) {
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
              <AgentChain name={a.name} chain={a.chain} />
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
        description="Every agent on the local stack from the control API's index, with its funding address and credits, its runtime from the orchestrator, its state, spend and last action, and controls to fund it, run the no-op task, a Scan or a chain check, refund its credits or reset it. Below the table: each provisioned agent's activity entries, tool calls, latest portfolio reading and intents."
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
            <AgentActivity agents={list.agents.filter((a) => a.runtime === "ready")} />
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
