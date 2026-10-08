"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { HoldingsPanel, Skeleton } from "@alpha-agents/ui";
import { useHoldings } from "@/agent/use-holdings";

/** D-315: the agent's All holdings, for its owner, with stranded funds movable to the wallet. */
export function AgentHoldings({
  agentId,
  environment,
}: {
  readonly agentId: bigint;
  readonly environment: EnvironmentId;
}) {
  const h = useHoldings(agentId, environment);
  if (h.addresses)
    return <HoldingsPanel addresses={h.addresses} network={h.network} onMove={h.move} />;
  if (h.error) return <p className="text-sm text-foreground-muted">{h.error}</p>;
  return <Skeleton className="h-40 w-full" aria-label="Loading all holdings" />;
}
