import { EmptyState } from "@alpha-agents/ui";
import { Telescope } from "lucide-react";
import { PanelHeader } from "@/components/panel-header";
import { orchestratorUrl } from "../agents/extension";
import { type ResearchJson, ResearchView } from "./research-view";

export const dynamic = "force-dynamic";

/** P3-U9: the research sources the agents use, read through the orchestrator; nothing is charged or fetched. */
async function readResearch(): Promise<{ data: ResearchJson } | { error: string }> {
  try {
    const res = await fetch(`${orchestratorUrl()}/v1/research`, { cache: "no-store" });
    if (res.status === 503)
      return { error: "Research sources are not configured in the orchestrator." };
    if (!res.ok) return { error: `The orchestrator answered ${res.status}.` };
    return { data: (await res.json()) as ResearchJson };
  } catch {
    return { error: "The orchestrator is not running (pnpm dev:all starts it)." };
  }
}

export default async function ResearchPage() {
  const r = await readResearch();
  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        title="Research sources"
        description="What the agents read beyond market data: X searches over curated topics, the platform's saved Dune queries, and contract reads on Monad mainnet, with each call's charge and whether the shared cache answered it. Post text is shown only while it is cached and is never stored. Reloading reads nothing upstream."
      />
      {"data" in r ? (
        <ResearchView data={r.data} />
      ) : (
        <EmptyState icon={Telescope} title="No research sources" description={r.error} />
      )}
    </div>
  );
}
