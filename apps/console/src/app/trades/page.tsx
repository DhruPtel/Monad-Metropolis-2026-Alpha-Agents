import { addressEntry } from "@alpha-agents/domain";
import { BREAKABLE_LIMITS, BREAKABLE_LIMIT_TEXT } from "@alpha-agents/signer/dev";
import { PanelHeader } from "@/components/panel-header";
import { TradesPanel } from "./trades-panel";

export default function TradesPage() {
  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        title="Trades"
        description="Test swaps on the playtest fork through the signer and the Executor of the agent's custody set: v2 on the real Uniswap v4 MON/USDC pool, or the fund agent's v3 set with many tokens along routes of registered pools. Nothing here changes the fork until you press a button. Local fork only."
      />
      <TradesPanel
        usdc={addressEntry("local", "usdc").address ?? ""}
        wmon={addressEntry("local", "wmon").address ?? ""}
        limits={BREAKABLE_LIMITS.map((code) => ({ code, text: BREAKABLE_LIMIT_TEXT[code] }))}
      />
    </div>
  );
}
