import { webEnvironment } from "@alpha-agents/config";
import { HomePage } from "@/components/home/home-page";

export const metadata = { title: "Vivarium" };

/** The home page (UI-FAST): live stats, the money-flow map, your agents and the vaults. */
export default function Page() {
  return <HomePage environment={webEnvironment(process.env.APP_ENV)} />;
}
