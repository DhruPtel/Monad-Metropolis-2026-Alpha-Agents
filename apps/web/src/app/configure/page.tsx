import { webEnvironment } from "@alpha-agents/config";
import { Suspense } from "react";
import { AgentPortal } from "@/components/portal/agent-portal";

export const metadata = { title: "Configure · Alpha Agents" };

/** The configure page (P1-U11): the connected wallet's agent in the portal. */
export default function ConfigurePage() {
  const environment = webEnvironment(process.env.APP_ENV);
  return (
    <Suspense>
      <AgentPortal environment={environment} />
    </Suspense>
  );
}
