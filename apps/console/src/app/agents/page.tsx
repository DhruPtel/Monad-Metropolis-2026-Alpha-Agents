import {
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from "@alpha-agents/ui";
import { Bot, PlugZap } from "lucide-react";
import { PanelHeader } from "@/components/panel-header";
import { type AgentList, PLANNED_AGENT_ACTIONS, agentsSource } from "./extension";

// Read from the control API on every visit, never at build time.
export const dynamic = "force-dynamic";

const TIER_TONE = { base: "neutral", medium: "rare", pro: "legendary" } as const;
const TIER_NAME = { base: "Base", medium: "Medium", pro: "Pro" } as const;

async function load(): Promise<AgentList | null> {
  try {
    return await agentsSource.listAgents();
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
        description="Every agent on the local stack from the control API's index, with its state, spend and last action, and controls to reset it or trigger a task."
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
        <div className="flex flex-col gap-3" data-testid="agents-list">
          <p className="text-sm text-foreground-muted">
            <span className="numeric text-foreground">{list.agents.length}</span> agents, indexed to
            block <span className="numeric text-foreground">{list.watermark?.block ?? "none"}</span>
            .
          </p>
          <Table label="Agents">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Agent</TableHead>
                <TableHead scope="col">Tier</TableHead>
                <TableHead scope="col">Owner</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">Spend, 24h</TableHead>
                <TableHead scope="col">Last action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.agents.map((a) => (
                <TableRow key={a.agentId.toString()}>
                  <TableCell>
                    <span className="flex flex-col">
                      <span className="font-medium">{a.name}</span>
                      <span className="text-xs text-foreground-muted">
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
                    <AddressDisplay address={a.owner} label={`Owner of ${a.name}`} />
                  </TableCell>
                  <TableCell>
                    <Badge>{a.state}</Badge>
                  </TableCell>
                  <TableCell>
                    <AmountDisplay value={a.spendUsdcE6} decimals={6} symbol="USDC" />
                  </TableCell>
                  <TableCell className="text-xs text-foreground-muted">
                    {a.lastAction ?? "None yet"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
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
