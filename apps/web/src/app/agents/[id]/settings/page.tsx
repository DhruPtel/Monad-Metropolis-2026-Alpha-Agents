import { webEnvironment } from "@alpha-agents/config";
import { notFound } from "next/navigation";
import { SettingsPage } from "@/components/settings/settings-page";

export const metadata = { title: "Settings · Alpha Agents" };

/** One agent's settings for its owner (BK-U1): the owner's own keys for paid data sources. */
export default async function AgentSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9]\d{0,4}$/.test(id)) notFound();
  return <SettingsPage environment={webEnvironment(process.env.APP_ENV)} agentId={BigInt(id)} />;
}
