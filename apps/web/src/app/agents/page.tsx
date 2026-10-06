import { webEnvironment } from "@alpha-agents/config";
import { MyAgentsPage } from "@/components/my-agents/my-agents-page";

export const metadata = { title: "My Agents · Alpha Agents" };

/** My Agents (P1-U9): the connected wallet's agents, their funding, spend and activity. */
export default function AgentsPage() {
  return <MyAgentsPage environment={webEnvironment(process.env.APP_ENV)} />;
}
