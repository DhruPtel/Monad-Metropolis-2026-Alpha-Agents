"use client";

import { Button, toast } from "@alpha-agents/ui";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { startCycleAction } from "./actions";

/** Starts a routine or an activation-shaped cycle for the agent, and opens it. */
export function CycleControls({ agentId, disabled }: { agentId: string; disabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (kind: "ROUTINE" | "ACTIVATION") =>
    start(async () => {
      const r = await startCycleAction(agentId, kind);
      if (!r.ok) {
        toast.error("The cycle did not start", { description: r.error });
        return;
      }
      toast.success(kind === "ROUTINE" ? "Routine cycle started" : "Activation cycle started");
      router.push(`/cycles?agent=${agentId}&cycle=${r.value.cycleId}`);
    });
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => run("ROUTINE")} disabled={disabled || pending} loading={pending}>
        Run routine cycle
      </Button>
      <Button variant="secondary" onClick={() => run("ACTIVATION")} disabled={disabled || pending}>
        Run activation cycle
      </Button>
    </div>
  );
}

/** Refreshes the page every few seconds while a cycle may still change. */
export function LiveRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
