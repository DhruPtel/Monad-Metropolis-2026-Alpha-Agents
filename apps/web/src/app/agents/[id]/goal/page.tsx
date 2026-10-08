import { notFound } from "next/navigation";
import { GoalPage } from "@/components/goal/goal-page";

export const metadata = { title: "Goal · Alpha Agents" };

/** One agent's goal for its owner (P3-U1, D-295): reached from its card, its portfolio and /configure. */
export default async function AgentGoalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9]\d{0,4}$/.test(id)) notFound();
  return <GoalPage agentId={BigInt(id)} />;
}
