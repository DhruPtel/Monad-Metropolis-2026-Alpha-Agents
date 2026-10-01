import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from "@alpha-agents/ui";
import { Bot } from "lucide-react";
import { PanelHeader } from "@/components/panel-header";
import { PLANNED_AGENT_ACTIONS, agentsSource } from "./extension";

export default function AgentsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        title="Agents"
        description="Every agent on the local stack, with its state, spend and last action, and controls to reset it or trigger a task."
      />
      {agentsSource === null ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="Agents appear here once the indexer and API are built in P1-U4. Mint one from this console after P1-U3."
        />
      ) : null}
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
