import { webEnvironment } from "@alpha-agents/config";
import { notFound } from "next/navigation";
import { SkillsPage } from "@/components/skills/skills-page";

export const metadata = { title: "Skills · Vivarium" };

/** One agent's skills for its owner (SK-U1): the built-in set and the owner's own uploads; reached from the portfolio and My Agents. */
export default async function AgentSkillsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9]\d{0,4}$/.test(id)) notFound();
  return <SkillsPage environment={webEnvironment(process.env.APP_ENV)} agentId={BigInt(id)} />;
}
