import { webEnvironment } from "@alpha-agents/config";
import { TradingPage } from "@/components/trading/trading-page";

export const metadata = { title: "Trading · Vivarium" };

/** UI-FAST: an agent's Trading tab. */
export default async function AgentTradingRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TradingPage environment={webEnvironment(process.env.APP_ENV)} agentId={BigInt(id)} />;
}
