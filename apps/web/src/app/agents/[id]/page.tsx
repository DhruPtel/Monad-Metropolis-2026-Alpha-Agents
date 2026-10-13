import { webEnvironment } from "@alpha-agents/config";
import { OverviewPage } from "@/components/overview/overview-page";

export const metadata = { title: "Agent · Vivarium" };

/** UI-FAST: an agent's Overview, the first of its tabs. */
export default async function AgentOverviewRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OverviewPage environment={webEnvironment(process.env.APP_ENV)} agentId={BigInt(id)} />;
}
