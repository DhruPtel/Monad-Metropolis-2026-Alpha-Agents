import { webEnvironment } from "@alpha-agents/config";
import { notFound } from "next/navigation";
import { WindowPage } from "@/components/window/window-page";

export const metadata = { title: "Performance window · Alpha Agents" };

/** One agent's portfolio window for its owner (F-U11): reached from its card on My Agents and its portfolio. */
export default async function AgentWindowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9]\d{0,4}$/.test(id)) notFound();
  return <WindowPage environment={webEnvironment(process.env.APP_ENV)} agentId={BigInt(id)} />;
}
