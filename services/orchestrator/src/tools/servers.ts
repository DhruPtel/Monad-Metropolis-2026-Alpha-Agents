import type { JournalEntry } from "@alpha-agents/accounting";
import {
  type Lookup,
  UpstreamError,
  type WebProvider,
  startDataTools,
} from "@alpha-agents/data-tools";
import { type ChainReader, type IntentRecord, startChainTools } from "@alpha-agents/chain-tools";
import type { MarketData, ResearchSources } from "@alpha-agents/market";
import { startPlatformTools } from "@alpha-agents/platform-tools";
import type { AgentIdentity } from "@alpha-agents/tool-server";
import type { Hex } from "viem";
import type { ToolServer } from "@alpha-agents/tool-server";
import type { Ledger } from "../credits/ledger.ts";
import type { CycleResearch } from "../cycle/research.ts";
import type { CycleStore } from "../cycle/store.ts";
import type { CreditService } from "../credits/service.ts";
import type { Log } from "../secrets.ts";
import type { Store } from "../store.ts";
import { goalsReader } from "./goals.ts";
import { leaseIdentity } from "./identity.ts";
import { ToolMeter } from "./meter.ts";
import { PgChainCallLog, PgIntentStore } from "./chain-store.ts";
import { PgPlatformStore } from "./platform-store.ts";

/**
 * The data, platform and chain tools servers, run inside the orchestrator
 * until hosting is chosen (D-213), each on its own loopback port behind the gate.
 */
export interface ToolServers {
  readonly data: ToolServer;
  readonly platform: ToolServer;
  readonly chain: ToolServer;
  readonly intents: PgIntentStore;
  close(): Promise<void>;
}

/** What the chain tools need from the orchestrator (P2-U5). */
export interface ChainToolsWiring {
  /** Null where the trading contracts are not deployed: every chain tool says so. */
  readonly reader: ChainReader | null;
  /** The agent's session key in the signer, to check the Executor grant names it. */
  readonly sessionKeyOf?: (agentId: number) => Promise<Hex | null>;
  /** One activity entry per new intent. */
  readonly onProposed?: (identity: AgentIdentity, intent: IntentRecord) => void;
}

export interface ToolServersOptions {
  readonly store: Store;
  readonly ledger: Ledger;
  readonly credits: CreditService;
  readonly environment: JournalEntry["environment"];
  /** Tavily, or null when TAVILY_API_KEY is not set: web tools then answer "not configured". */
  readonly provider: WebProvider | null;
  readonly lookup?: Lookup;
  /** P3-U9: the fetch read_url's redirect check probes hops with; tests give a fake. */
  readonly probe?: typeof fetch;
  /** The chain tools' wiring; none answers every chain tool with "not deployed". */
  readonly chain?: ChainToolsWiring;
  /** P3-U2: the platform's market data, shared by every agent; none answers market tools "not configured". */
  readonly market?: MarketData | null;
  /** P3-U9: X search, saved Dune queries and mainnet lookups; none answers them "not configured". */
  readonly research?: ResearchSources | null;
  /** P3-U4: the research cycles' records; the tools then meter, record and check per stage. */
  readonly cycles?: { readonly store: CycleStore; readonly research: CycleResearch } | null;
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
    ...(o.cycles ? { cycles: o.cycles.store } : {}),
  });
  const data = await startDataTools({
    resolve,
    meter,
    provider: o.provider ?? unconfiguredProvider,
    market: o.market ?? null,
    research: o.research ?? null,
    ...(o.lookup ? { lookup: o.lookup } : {}),
    ...(o.probe ? { probe: o.probe } : {}),
  });
  const platformStore = new PgPlatformStore(o.store, o.cycles ?? null);
  const goals = goalsReader(o.store.db, o.chain?.reader ?? null);
  const platform = await startPlatformTools({
    resolve,
    store: platformStore,
    goals: {
      // Inside a cycle stage the answer is stored, so a brief may quote the goal and limits.
      read: async (identity) => {
        const answer = await goals.read(identity);
        await platformStore.recordRead(identity, "get_goals_and_limits", answer);
        return answer;
      },
    },
  });
  const intents = new PgIntentStore(o.store);
  const chain = await startChainTools({
    resolve,
    reader: o.chain?.reader ?? null,
    log: new PgChainCallLog(o.store, undefined, o.cycles?.store ?? null),
    intents,
    market: o.market ?? null,
    research: o.research ?? null,
    ...(o.chain?.sessionKeyOf ? { sessionKeyOf: o.chain.sessionKeyOf } : {}),
    ...(o.chain?.onProposed ? { onProposed: o.chain.onProposed } : {}),
  });
  return {
    data,
    platform,
    chain,
    intents,
    close: async () => {
      await Promise.allSettled([data.close(), platform.close(), chain.close()]);
    },
  };
}
