import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
} from "@alpha-agents/ui";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { PanelHeader } from "@/components/panel-header";
import { orchestratorUrl } from "../agents/extension";
import { CycleControls, LiveRefresh } from "./cycle-controls";
import { CycleDetail, CyclesTable, PlanCard } from "./cycle-view";
import { type AgentCyclesJson, type CycleDetailJson, isLive, usdc } from "./cycles";

export const dynamic = "force-dynamic";

/** P3-U4: research cycles, read through the orchestrator; reading starts nothing and charges nothing. */
async function read<T>(path: string): Promise<{ data: T } | { error: string }> {
  try {
    const res = await fetch(`${orchestratorUrl()}${path}`, { cache: "no-store" });
    if (res.status === 404) return { error: "Not found." };
    if (!res.ok) return { error: `The orchestrator answered ${res.status}.` };
    return { data: (await res.json()) as T };
  } catch {
    return { error: "The orchestrator is not running (pnpm dev:all starts it)." };
  }
}

interface Runtimes {
  readonly runtimes: readonly { readonly agentId: string; readonly status: string }[];
}

export default async function CyclesPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string; cycle?: string }>;
}) {
  const params = await searchParams;
  const header = (
    <PanelHeader
      title="Research cycles"
      description="Run a routine cycle (Scan, the Dives it earns, Challenge, Test, Zoom out) or an activation-shaped one for an agent, then read every stage: its model, its caps and cost against the ceiling shown before it ran, its cache reads, its calls, its raw notes and its briefs, refused ones with the validator's reasons. Raw notes are platform-only; owners read only accepted briefs. Nothing here trades."
    />
  );
  const runtimes = await read<Runtimes>("/v1/runtimes");
  if ("error" in runtimes)
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState icon={RefreshCw} title="No research cycles" description={runtimes.error} />
      </div>
    );
  const ready = runtimes.data.runtimes.filter((r) => r.status === "ready");
  const agent =
    params.agent && /^[1-9]\d{0,4}$/.test(params.agent) ? params.agent : ready[0]?.agentId;
  if (!agent)
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={RefreshCw}
          title="No provisioned agent"
          description="Provision an agent first; a cycle runs in its sandbox."
        />
      </div>
    );
  const cycles = await read<AgentCyclesJson>(`/v1/agents/${agent}/cycles`);
  const data = "data" in cycles ? cycles.data : null;
  const selected = params.cycle ?? data?.cycles[0]?.cycleId ?? null;
  const detail = selected ? await read<CycleDetailJson>(`/v1/cycles/${selected}`) : null;
  const live = data?.cycles.some((c) => isLive(c.status)) ?? false;
  return (
    <div className="flex flex-col gap-6">
      {header}
      <LiveRefresh active={live} />
      <nav aria-label="Agents" className="flex flex-wrap gap-2">
        {ready.map((r) => (
          <Button
            key={r.agentId}
            asChild
            size="sm"
            variant={r.agentId === agent ? "primary" : "secondary"}
          >
            <Link
              href={`/cycles?agent=${r.agentId}`}
              aria-current={r.agentId === agent ? "page" : undefined}
            >
              Agent #{r.agentId}
            </Link>
          </Button>
        ))}
      </nav>
      {data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Agent #{agent}</CardTitle>
              {data.goal ? (
                <p className="text-sm text-foreground-muted">
                  Reasoning model <span className="text-foreground">{data.goal.reasoning}</span>,{" "}
                  {data.goal.intensity.toLowerCase()} intensity, up to {data.goal.divesPerDay} Dive
                  {data.goal.divesPerDay === 1 ? "" : "s"} a day. Today{" "}
                  <span className="numeric text-foreground">{usdc(data.today.usedUsdcE6)}</span> of
                  the{" "}
                  <span className="numeric text-foreground">
                    {usdc(data.goal.dailyBudgetUsdcE6)}
                  </span>{" "}
                  daily research budget is used; {usdc(data.goal.creditReserveUsdcE6)} of credits
                  stays in reserve for gas.
                </p>
              ) : (
                <p className="text-sm text-foreground-muted">
                  This agent has no goal. Its owner sets one on the Goal page; a cycle needs its
                  reasoning model and daily budget.
                </p>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <CycleControls agentId={agent} disabled={!data.goal || live} />
              {live ? (
                <Badge tone="detail">A cycle is running; this page refreshes itself</Badge>
              ) : null}
            </CardContent>
          </Card>
          {data.plans ? (
            <div className="grid gap-4 xl:grid-cols-2">
              <PlanCard plan={data.plans.ROUTINE} />
              <PlanCard plan={data.plans.ACTIVATION} />
            </div>
          ) : null}
          {data.cycles.length > 0 ? (
            <CyclesTable data={data} selected={selected} />
          ) : (
            <EmptyState icon={RefreshCw} title="No cycles yet" description="Run one above." />
          )}
          {detail && "data" in detail ? <CycleDetail data={detail.data} /> : null}
          {detail && "error" in detail ? (
            <EmptyState icon={RefreshCw} title="Cycle not shown" description={detail.error} />
          ) : null}
        </>
      ) : (
        <EmptyState
          icon={RefreshCw}
          title="No research cycles"
          description={"error" in cycles ? cycles.error : ""}
        />
      )}
    </div>
  );
}
