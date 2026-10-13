"use client";

import { speciesAsset, speciesByIndex } from "@alpha-agents/domain";
import { AgentPageHeader, Button, PageTabs, RunStatusBadge, Skeleton } from "@alpha-agents/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { type ApiAgent, api } from "@/api/client";
import { activeAgentTab, agentTabs } from "@/agent/agent-tabs";
import { type MyAgent, useMyAgent } from "@/agent/use-my-agent";

const GOAL_WORD: Readonly<Record<string, string>> = {
  CONSERVATIVE: "Conservative",
  BALANCED: "Balanced",
  AGGRESSIVE: "Aggressive",
};

/**
 * UI-FAST: the agent's owner-side summary (credits, refund, spend, status), read once by the
 * shell for the header's status and shared with the tab that shows it, so it is never read twice.
 */
const AgentSummaryContext = createContext<MyAgent | null>(null);

/** The shell's read of the agent's summary; null outside an agent page. */
export function useAgentSummary(): MyAgent | null {
  return useContext(AgentSummaryContext);
}

/**
 * UI-FAST: every agent page shares one header (the agent, its tier, species
 * and goal, with Change goal) and one tab bar. Both read public data only:
 * the agent from the index and its goal summary.
 */
export function AgentShell({ agentId, children }: { agentId: bigint; children: ReactNode }) {
  const path = usePathname();
  const me = useMyAgent(agentId, { trading: false, performance: false });
  const [agent, setAgent] = useState<ApiAgent | null | undefined>(undefined);
  const [goal, setGoal] = useState<{ configured: boolean; aggressiveness: string | null } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    void api.agent(agentId).then(
      (a) => live && setAgent(a),
      () => live && setAgent(null),
    );
    void api.goalSummary(agentId).then(
      (g) => live && setGoal(g),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [agentId, path]);
  const species = agent && agent.species > 0 ? speciesByIndex(agent.species) : null;
  const goalHref = `/agents/${agentId.toString()}/goal`;
  return (
    <div className="flex flex-col gap-6" data-testid="agent-shell">
      <div className="flex flex-col gap-4">
        {agent === undefined ? (
          <Skeleton className="h-28 w-80 sm:h-40" />
        ) : (
          <AgentPageHeader
            name={`Agent #${agentId.toString()}`}
            image={species && agent ? speciesAsset(agent.species).image : null}
            tier={species?.tier ?? null}
            speciesName={species?.name ?? null}
            status={me.summary ? <RunStatusBadge status={me.summary.runStatus} /> : null}
          />
        )}
        <PageTabs
          label="Agent sections"
          tabs={agentTabs(agentId)}
          active={activeAgentTab(path, agentId)}
          linkAs={Link}
          end={
            <>
              <span className="text-foreground-muted">Goal</span>
              <span className="font-medium" data-testid="agent-goal">
                {goal === null
                  ? "–"
                  : goal.configured
                    ? (GOAL_WORD[goal.aggressiveness ?? ""] ?? "Goal set")
                    : "No goal"}
              </span>
              <Button asChild variant="secondary" size="sm" data-testid="change-goal">
                <Link href={goalHref}>{goal?.configured ? "Change goal" : "Set goal"}</Link>
              </Button>
            </>
          }
        />
      </div>
      <AgentSummaryContext.Provider value={me}>{children}</AgentSummaryContext.Provider>
    </div>
  );
}
