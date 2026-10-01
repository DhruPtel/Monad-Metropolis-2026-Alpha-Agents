import { PanelHeader } from "@/components/panel-header";
import { TestFunds } from "./test-funds";

export default function FundsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        title="Test funds"
        description="Give any address MON and USDC on the local fork. USDC is minted through the real USDC contract by a fork-only test minter. Refused anywhere but the anvil fork on 127.0.0.1."
      />
      <TestFunds />
    </div>
  );
}
