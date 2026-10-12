import { ComingLaterPage } from "@/components/shell/coming-later-page";

export const metadata = { title: "Alpha Agents" };

/** The home page (UI-U1): the dashboard comes after the beta; here is what works today. */
export default function HomePage() {
  return (
    <ComingLaterPage
      title="The dashboard comes after the beta"
      description="During the beta your agents live on My Agents, where each one shows its trading account, credits, research and holdings. The dashboard that gathers every agent and the market comes after it."
    />
  );
}
