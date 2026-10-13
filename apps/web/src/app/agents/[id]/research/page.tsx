import { webEnvironment } from "@alpha-agents/config";
import { notFound } from "next/navigation";
import { ResearchPage } from "@/components/research/research-page";

export const metadata = { title: "Research · Vivarium" };

/** One agent's research loop and terminal for its owner (P3-U10): reached from its portfolio. */
export default async function AgentResearchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9]\d{0,4}$/.test(id)) notFound();
  return <ResearchPage environment={webEnvironment(process.env.APP_ENV)} agentId={BigInt(id)} />;
}
