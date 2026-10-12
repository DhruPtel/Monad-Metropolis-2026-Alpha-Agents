import { ComingLater } from "@alpha-agents/ui";

/** The pages that work in the beta, for every page that comes after it (UI-U1). */
export const LIVE_PAGES = [
  {
    href: "/agents",
    label: "My Agents",
    note: "Your agents: their trading account, credits, research and holdings.",
  },
  {
    href: "/mint",
    label: "Mint",
    note: "Mint an agent; its species and tier are drawn at reveal.",
  },
  {
    href: "/configure",
    label: "Configure",
    note: "Your agent in 3D, with its slots and what it is doing.",
  },
] as const;

export function ComingLaterPage({ title, description }: { title: string; description: string }) {
  return <ComingLater title={title} description={description} links={LIVE_PAGES} />;
}
