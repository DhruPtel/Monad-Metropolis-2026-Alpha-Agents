import { EmptyState } from "@alpha-agents/ui";
import { Repeat } from "lucide-react";
import { PanelHeader } from "@/components/panel-header";
import { orchestratorUrl } from "../../agents/extension";
import { LiveRefresh } from "../cycle-controls";
import { type CycleDetailJson, isLive } from "../cycles";
import type { ReplayViewJson } from "../replay";
import { ReplayPanel } from "../replay-panel";

export const dynamic = "force-dynamic";

/**
 * UI-U2: the replay tool. Pick any stored research stage from a cycle, edit
 * its playbook or an owner skill in place, run the stage again on the exact
 * stored inputs it saw, and read the old and new output side by side with
 * the cost. Operators only: the console is local (D-205).
 */
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

export default async function ReplayPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; replay?: string }>;
}) {
  const params = await searchParams;
  const header = (
    <PanelHeader
      title="Replay a stage"
      description="Run a stored research stage again on the exact inputs it saw, with its playbook or one of the owner's skills edited in place, and read the old and new output side by side. Every tool call answers from the stored results; only the model call is paid. An edit is saved as a new version only when you choose."
    />
  );
  const stageId =
    params.stage && /^stage-run-[0-9a-f-]{36}$/.test(params.stage) ? params.stage : null;
  if (!stageId)
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={Repeat}
          title="Pick a stage to replay"
          description="Open a cycle on the Cycles page and choose Replay on any of its model stages."
        />
      </div>
    );
  const view = await read<ReplayViewJson>(`/v1/stages/${stageId}/replay`);
  if ("error" in view)
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState icon={Repeat} title="No stage to replay" description={view.error} />
      </div>
    );
  const detail = await read<CycleDetailJson>(`/v1/cycles/${view.data.cycle.cycleId}`);
  const original =
    "data" in detail ? (detail.data.stages.find((s) => s.stageRunId === stageId) ?? null) : null;
  if (!original)
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={Repeat}
          title="No stage to replay"
          description={"error" in detail ? detail.error : "The stage is not in its cycle."}
        />
      </div>
    );
  const wanted =
    params.replay && /^cycle-[0-9a-f-]{36}$/.test(params.replay) ? params.replay : null;
  const selected =
    view.data.replays.find((r) => r.cycle.cycleId === wanted) ?? view.data.replays[0] ?? null;
  const replayDetail = selected
    ? await read<CycleDetailJson>(`/v1/cycles/${selected.cycle.cycleId}`)
    : null;
  const replayStage =
    replayDetail && "data" in replayDetail ? (replayDetail.data.stages[0] ?? null) : null;
  const live = view.data.replays.some((r) => isLive(r.cycle.status));
  return (
    <div className="flex flex-col gap-6">
      {header}
      <LiveRefresh active={live} />
      <ReplayPanel
        view={view.data}
        original={original}
        replay={replayStage}
        selectedReplay={selected ? { cycle: selected.cycle, overrides: selected.overrides } : null}
      />
    </div>
  );
}
