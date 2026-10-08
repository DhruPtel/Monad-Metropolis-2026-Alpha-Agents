import { EmptyState } from "@alpha-agents/ui";
import { LineChart } from "lucide-react";
import { PanelHeader } from "@/components/panel-header";
import { orchestratorUrl } from "../agents/extension";
import { type MarketJson, MarketView } from "./market-view";

export const dynamic = "force-dynamic";

/** P3-U2: the market snapshot the agents read, read through the orchestrator; nothing is charged. */
async function readMarket(): Promise<{ data: MarketJson } | { error: string }> {
  try {
    const res = await fetch(`${orchestratorUrl()}/v1/market`, { cache: "no-store" });
    if (res.status === 503) return { error: "Market data is not configured in the orchestrator." };
    if (!res.ok) return { error: `The orchestrator answered ${res.status}.` };
    return { data: (await res.json()) as MarketJson };
  } catch {
    return { error: "The orchestrator is not running (pnpm dev:all starts it)." };
  }
}

export default async function MarketPage() {
  const r = await readMarket();
  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        title="Market data"
        description="The market snapshot the agents read: CoinMarketCap prices, Chainlink against the Uniswap v4 pool and the pool's depth on Monad mainnet, volatility, and DefiLlama's TVL, DEX volume and yields. Every figure names its source and age; a refused value is never shown as a number. Reloading the page reads it again; nothing is charged."
      />
      {"data" in r ? (
        <MarketView data={r.data} />
      ) : (
        <EmptyState icon={LineChart} title="No market snapshot" description={r.error} />
      )}
    </div>
  );
}
