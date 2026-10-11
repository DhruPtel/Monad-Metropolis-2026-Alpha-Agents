"use client";

import { AgentTerminal } from "@alpha-agents/ui";
import Link from "next/link";
import { useTerminal } from "@/agent/use-research";

/**
 * The agent terminal inside the activation step panel (P3-U10): while the
 * sweep runs, the owner watches the cycle's lines as they happen; after it,
 * the Research page keeps the history.
 */
export function ActivationTerminal({ agentId, live }: { agentId: bigint; live: boolean }) {
  const t = useTerminal(agentId, null, true);
  // Nothing to follow yet (no cycle, or no orchestrator on this stack): the panel stays as it was.
  if (t.state === "idle") return null;
  return (
    <div className="flex flex-col gap-2" data-testid="activation-terminal">
      <AgentTerminal
        lines={t.lines}
        state={live && t.state === "ended" ? "connecting" : t.state}
        cycle={t.cycle}
        maxHeightClass="max-h-64"
      />
      <Link
        href={`/agents/${agentId.toString()}/research`}
        className="w-fit text-sm text-primary underline-offset-4 hover:underline"
        data-testid="research-link-panel"
      >
        Open the Research page
      </Link>
    </div>
  );
}
