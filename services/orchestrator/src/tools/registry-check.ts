import { MemoryCallLog, MemoryIntentStore, startChainTools } from "@alpha-agents/chain-tools";
import { startDataTools } from "@alpha-agents/data-tools";
import {
  type RegistryProblem,
  TOOL_DEFERRALS,
  TOOL_REGISTRY,
  type ToolServer,
  checkToolRegistry,
} from "@alpha-agents/domain";
import { MemoryPlatformStore, startPlatformTools } from "@alpha-agents/platform-tools";
import { LAUNCH_SKILL_MANIFESTS } from "@alpha-agents/skills";
import { loadBuiltinSet } from "@alpha-agents/skills/packages";
import type { AgentIdentity, ToolServer as RunningServer } from "@alpha-agents/tool-server";
import { connectClient, staticResolver } from "@alpha-agents/tool-server/testing";
import { unconfiguredProvider } from "./servers.ts";

/**
 * The registry check (P3-U9): starts the three tool servers exactly as the
 * orchestrator registers them (with stand-in stores, so no database or chain
 * is needed), asks each for tools/list over MCP, and checks the canonical
 * registry and the launch skills' declarations against what is live.
 */
const TOKEN = "r".repeat(43);
const IDENTITY: AgentIdentity = { chainId: 1, agentId: 1, tier: "pro", leaseId: "registry-check" };

const noMeter = {
  begin: async () => "call-registry-check",
  finish: async () => undefined,
  refuse: async () => undefined,
};

export async function liveToolNames(): Promise<Record<ToolServer, string[]>> {
  const resolve = staticResolver({ [TOKEN]: IDENTITY });
  const started: RunningServer[] = [];
  try {
    const data = await startDataTools({ resolve, meter: noMeter, provider: unconfiguredProvider });
    started.push(data);
    const chain = await startChainTools({
      resolve,
      reader: null,
      log: new MemoryCallLog(),
      intents: new MemoryIntentStore(),
    });
    started.push(chain);
    const platform = await startPlatformTools({ resolve, store: new MemoryPlatformStore() });
    started.push(platform);
    const list = async (s: RunningServer) => {
      const client = await connectClient(s.url, TOKEN);
      try {
        return (await client.listTools()).tools.map((t) => t.name).sort();
      } finally {
        await client.close();
      }
    };
    return { chain: await list(chain), data: await list(data), platform: await list(platform) };
  } finally {
    await Promise.all(started.map((s) => s.close()));
  }
}

export interface RegistryReport {
  readonly live: Record<ToolServer, string[]>;
  readonly resolved: string[];
  readonly deferred: { id: string; unit: string; reason: string }[];
  readonly problems: RegistryProblem[];
}

export async function registryReport(): Promise<RegistryReport> {
  const live = await liveToolNames();
  // The built-in skills and playbooks as written (P3-U7), and the launch skills not yet written
  // (token-risk-screen, wallet-intel, wmon-dca-accumulator: W-1) from their fixtures.
  const builtin = loadBuiltinSet().packages.map((p) => p.manifest);
  const written = new Set(builtin.map((m) => m.id));
  const fixtures = (
    LAUNCH_SKILL_MANIFESTS as { id: string; required_tools: string[]; intents: string[] }[]
  ).filter((m) => !written.has(m.id) && m.id !== "venue-swap");
  const declared = [...builtin, ...fixtures].map((m) => ({
    skill: m.id,
    tools: [...m.required_tools, ...m.intents],
  }));
  const problems = checkToolRegistry({
    registry: TOOL_REGISTRY,
    deferrals: TOOL_DEFERRALS,
    live,
    declared,
  });
  const deferred = TOOL_REGISTRY.flatMap((t) => {
    const d = TOOL_DEFERRALS[t.id];
    return d ? [{ id: t.id, unit: d.unit, reason: d.reason }] : [];
  });
  const resolved = TOOL_REGISTRY.filter((t) => !TOOL_DEFERRALS[t.id]).map((t) => t.id);
  return { live, resolved, deferred, problems };
}
