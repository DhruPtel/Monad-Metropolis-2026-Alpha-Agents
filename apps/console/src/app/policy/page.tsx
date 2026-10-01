import { PanelHeader } from "@/components/panel-header";
import { PolicySandbox } from "./policy-sandbox";

export default function PolicyPage() {
  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        title="Policy sandbox"
        description='Build a swap and an account, run them through the launch hard limits, and read the result as the owner will under "why the agent did not trade".'
      />
      <PolicySandbox />
    </div>
  );
}
