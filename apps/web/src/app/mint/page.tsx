import { TESTNET_CHAIN, webEnvironment } from "@alpha-agents/config";
import { Button, EmptyState } from "@alpha-agents/ui";
import { Sprout } from "lucide-react";
import { MintPage } from "@/components/mint/mint-page";
import { NETWORK_SITES } from "@/network-sites";

export const metadata = { title: "Mint · Vivarium" };

/** The mint page (P1-U10): tiers, supply and odds from AgentNFT, and the mint. */
export default function Mint() {
  const environment = webEnvironment(process.env.APP_ENV);
  // CO-U1: agents are minted on Monad; Base and Arbitrum hold the platform's copy of each.
  if (environment === "testnet" && TESTNET_CHAIN.key !== "monad")
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-12">
        <EmptyState
          icon={Sprout}
          title={`Agents are minted on Monad`}
          description={`Mint your agent on Monad Testnet. Vivarium then gives you its copy on ${TESTNET_CHAIN.name}, with the same species and tier, to fund and trade here.`}
          action={
            <Button asChild size="sm">
              <a href={`${NETWORK_SITES.monad}/mint`}>Mint on Monad</a>
            </Button>
          }
        />
      </div>
    );
  return <MintPage environment={environment} />;
}
