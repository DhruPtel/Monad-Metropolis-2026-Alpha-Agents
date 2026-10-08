"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { Card, CardContent, HoldingsPanel, Skeleton } from "@alpha-agents/ui";
import { useHoldings } from "@/agent/use-holdings";

/**
 * D-315: the agent's All holdings, for its owner, with stranded funds movable
 * to the wallet. Nothing at all where the environment has no holdings reader.
 */
export function AgentHoldings({
  agentId,
  environment,
  card = false,
}: {
  readonly agentId: bigint;
  readonly environment: EnvironmentId;
  /** In its own card, as on the portfolio. */
  readonly card?: boolean;
}) {
  const h = useHoldings(agentId, environment);
  if (h.unavailable) return null;
  const body = h.addresses ? (
    <HoldingsPanel addresses={h.addresses} network={h.network} onMove={h.move} />
  ) : h.error ? (
    <p className="text-sm text-foreground-muted">{h.error}</p>
  ) : (
    <Skeleton className="h-40 w-full" aria-label="Loading all holdings" />
  );
  return card ? (
    <Card data-testid="portfolio-holdings">
      <CardContent className="pt-6">{body}</CardContent>
    </Card>
  ) : (
    body
  );
}
