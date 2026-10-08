import { webEnvironment } from "@alpha-agents/config";
import { notFound } from "next/navigation";
import { PortfolioPage } from "@/components/portfolio/portfolio-page";

export const metadata = { title: "Portfolio · Alpha Agents" };

/** One agent's portfolio for its owner (P2-U7): reached from its card on My Agents. */
export default async function AgentPortfolioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9]\d{0,4}$/.test(id)) notFound();
  return <PortfolioPage environment={webEnvironment(process.env.APP_ENV)} agentId={BigInt(id)} />;
}
