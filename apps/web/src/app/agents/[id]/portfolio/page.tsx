import { redirect } from "next/navigation";

/**
 * UI-FAST: the Portfolio page merged into the agent's Overview; an old link
 * lands there. PortfolioPage's code stays in components/portfolio, unlinked.
 */
export default async function AgentPortfolioRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/agents/${id}`);
}
