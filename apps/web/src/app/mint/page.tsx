import { webEnvironment } from "@alpha-agents/config";
import { MintPage } from "@/components/mint/mint-page";

export const metadata = { title: "Mint · Alpha Agents" };

/** The mint page (P1-U10): tiers, supply and odds from AgentNFT, and the mint. */
export default function Mint() {
  return <MintPage environment={webEnvironment(process.env.APP_ENV)} />;
}
