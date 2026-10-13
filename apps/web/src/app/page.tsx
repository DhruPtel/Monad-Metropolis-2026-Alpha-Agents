import { webEnvironment } from "@alpha-agents/config";
import { HomePage } from "@/components/home/home-page";

export const metadata = { title: "Vivarium" };

/** The home page (UI-FAST): a quiet hero with live stats and the flow, your agents, and the vaults or agents. */
export default function Page() {
  return <HomePage environment={webEnvironment(process.env.APP_ENV)} />;
}
