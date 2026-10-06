import type { JournalEntry } from "@alpha-agents/accounting";
import {
  type Lookup,
  UpstreamError,
  type WebProvider,
  startDataTools,
} from "@alpha-agents/data-tools";
import { startPlatformTools } from "@alpha-agents/platform-tools";
import type { ToolServer } from "@alpha-agents/tool-server";
import type { Ledger } from "../credits/ledger.ts";
import type { CreditService } from "../credits/service.ts";
import type { Log } from "../secrets.ts";
import type { Store } from "../store.ts";
import { leaseIdentity } from "./identity.ts";
import { ToolMeter } from "./meter.ts";
import { PgPlatformStore } from "./platform-store.ts";

/**
 * The data and platform tools servers, run inside the orchestrator until
 * hosting is chosen (D-213), each on its own loopback port behind the gate.
 */
export interface ToolServers {
  readonly data: ToolServer;
  readonly platform: ToolServer;
  close(): Promise<void>;
}

export interface ToolServersOptions {
  readonly store: Store;
  readonly ledger: Ledger;
  readonly credits: CreditService;
  readonly environment: JournalEntry["environment"];
  /** Tavily, or null when TAVILY_API_KEY is not set: web tools then answer "not configured". */
  readonly provider: WebProvider | null;
  readonly lookup?: Lookup;
  readonly log: Log;
}

/** Stands in when no web provider is configured; every call is reversed, so nothing is charged. */
export const unconfiguredProvider: WebProvider = {
  name: "none",
  search: () =>
    Promise.reject(
      new UpstreamError("web search is not configured on this platform", false, null, null),
    ),
  extract: () =>
    Promise.reject(
      new UpstreamError("web reading is not configured on this platform", false, null, null),
    ),
};

export async function startToolServers(o: ToolServersOptions): Promise<ToolServers> {
  const resolve = leaseIdentity(o.store);
  const meter = new ToolMeter({
    store: o.store,
    ledger: o.ledger,
    credits: o.credits,
    environment: o.environment,
    log: o.log,
  });
  const data = await startDataTools({
    resolve,
    meter,
    provider: o.provider ?? unconfiguredProvider,
    ...(o.lookup ? { lookup: o.lookup } : {}),
  });
  const platform = await startPlatformTools({ resolve, store: new PgPlatformStore(o.store) });
  return {
    data,
    platform,
    close: async () => {
      await Promise.allSettled([data.close(), platform.close()]);
    },
  };
}
