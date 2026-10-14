"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { ActivityPanel, SectionLabel, Skeleton } from "@alpha-agents/ui";
import Link from "next/link";
import { useActivity } from "@/agent/use-activity";

/** 2026-10-13: the agent's Activity, the same panel on Overview and on the Vault tab. */
export function AgentActivity({
  agentId,
  environment,
}: {
  agentId: bigint;
  environment: EnvironmentId;
}) {
  const a = useActivity(agentId, environment);
  return (
    <section aria-label="Activity" className="flex flex-col gap-3" data-testid="agent-activity">
      <SectionLabel as="h2">Activity</SectionLabel>
      {a.rows === null ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <ActivityPanel
          rows={a.rows}
          linkAs={Link}
          empty="Nothing here yet: deposits, trades and research show as they happen."
          note={a.error ? `Deposits could not be read: ${a.error}` : a.note}
        />
      )}
    </section>
  );
}
