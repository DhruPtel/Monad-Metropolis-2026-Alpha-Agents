import { forkClock, readForkConfig } from "@alpha-agents/devenv";
import { PanelHeader } from "@/components/panel-header";
import { consoleForkUrl } from "@/lib/fork-url";
import { ForkControls } from "./fork-controls";
import { StuckTransactions } from "./stuck-transactions";

export const dynamic = "force-dynamic";

export default async function ForkPage() {
  const clock = await forkClock(consoleForkUrl()).catch(() => null);
  const pinnedBlock = readForkConfig().blockNumber;
  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        title="Fork controls"
        description="Snapshot, revert, mine and move time on the local anvil fork. Every action first checks that the target is the anvil fork on 127.0.0.1."
      />
      <ForkControls initialClock={clock} pinnedBlock={pinnedBlock} />
      <StuckTransactions />
    </div>
  );
}
