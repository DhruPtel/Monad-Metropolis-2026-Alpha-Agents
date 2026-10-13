"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { useEffect, useMemo, useState } from "react";
import { type Address, parseAbi, zeroAddress } from "viem";
import { type ApiAgent, api } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { agentNftDeployment } from "./agent-nft";
import { chainClient } from "./chain";
import { type HomeAgentInput, type HomeView, homeView } from "./home-view";
import { schedulePoll } from "./poll";

/** How often the home page re-reads everything while it is shown. */
const HOME_POLL_MS = 30_000;
/** Multicall3's canonical address, deployed on Monad mainnet and testnet. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const ACCOUNT_ABI = parseAbi([
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
  "function navUsdc() view returns (uint256)",
  "function principal() view returns (uint256)",
]);

/** A mint block's time never changes, so each is read once per page load. */
const blockTimes = new Map<number, number>();

export type HomeStatus =
  | { readonly state: "not-deployed" }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly view: HomeView; readonly at: number };

/**
 * UI-FAST: the home page's data, from public reads only: the agents in the
 * index, each one's activity, vault and goal summary from the API, and its
 * personal account's value and principal from AccountFactoryV3 onchain (the
 * factory's address is the one the vault read names). Re-read every 30 s
 * while the tab is shown.
 */
export function useHome(environment: EnvironmentId): HomeStatus {
  const wallet = useWalletSession();
  const client = useMemo(() => chainClient(wallet.target), [wallet.target]);
  const deployed = useMemo(() => agentNftDeployment(environment) !== null, [environment]);
  const [status, setStatus] = useState<HomeStatus>({ state: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!deployed) return;
    let live = true;
    // Every account read rides one Multicall3 call per step (two per refresh), so a public
    // RPC's rate limit is not spent on one call per agent; a failed read is null, never 0.
    const accounts = async (
      agents: readonly ApiAgent[],
      factory: Address | null,
    ): Promise<HomeAgentInput["account"][]> => {
      if (!factory || agents.length === 0) return agents.map(() => null);
      try {
        const addrs = await client.multicall({
          multicallAddress: MULTICALL3,
          allowFailure: true,
          contracts: agents.map((a) => ({
            address: factory,
            abi: ACCOUNT_ABI,
            functionName: "personalAccountOf" as const,
            args: [a.id, a.owner] as const,
          })),
        });
        const funded = addrs.flatMap((r) =>
          r.status === "success" && r.result !== zeroAddress ? [r.result] : [],
        );
        const values = await client.multicall({
          multicallAddress: MULTICALL3,
          allowFailure: true,
          contracts: funded.flatMap((acct) => [
            { address: acct, abi: ACCOUNT_ABI, functionName: "navUsdc" as const },
            { address: acct, abi: ACCOUNT_ABI, functionName: "principal" as const },
          ]),
        });
        return addrs.map((r) => {
          if (r.status !== "success") return null;
          if (r.result === zeroAddress) return "none";
          const i = funded.indexOf(r.result);
          const nav = values[2 * i];
          const principal = values[2 * i + 1];
          if (nav?.status !== "success" || principal?.status !== "success") return null;
          return { navUsdcE6: nav.result, principalUsdcE6: principal.result };
        });
      } catch {
        return agents.map(() => null);
      }
    };
    const mintTimes = async (agents: readonly ApiAgent[]) => {
      const missing = [
        ...new Set(agents.flatMap((a) => (a.mintedBlock === undefined ? [] : [a.mintedBlock]))),
      ].filter((b) => !blockTimes.has(b));
      // One at a time: a public RPC limits bursts, and each block is read only once.
      for (const b of missing) {
        try {
          const block = await client.getBlock({ blockNumber: BigInt(b) });
          blockTimes.set(b, Number(block.timestamp));
        } catch {
          // Left unread: the age shows "–" and the next refresh tries again.
        }
      }
    };
    void (async () => {
      try {
        const agents = await api.agents({});
        const reads = await Promise.all(
          agents.map(async (agent) => {
            const [activity, vault, goal] = await Promise.all([
              api.activity(agent.id).catch(() => null),
              api.vault(agent.id).catch(() => null),
              api.goalSummary(agent.id).catch(() => null),
            ]);
            return { agent, activity, vault, goal };
          }),
        );
        const factory = reads.find((r) => r.vault)?.vault?.vault.contracts.accountFactory ?? null;
        const onchain = await accounts(agents, factory);
        await mintTimes(agents);
        const inputs: HomeAgentInput[] = reads.map((r, i) => ({
          ...r,
          account: onchain[i] ?? null,
          mintedAt:
            r.agent.mintedBlock === undefined
              ? null
              : (blockTimes.get(r.agent.mintedBlock) ?? null),
        }));
        if (live) setStatus({ state: "ready", view: homeView(inputs, Date.now()), at: Date.now() });
      } catch {
        if (live)
          setStatus((s) =>
            s.state === "ready"
              ? s
              : { state: "error", message: "Could not reach the platform API." },
          );
      }
    })();
    const cancel = schedulePoll(() => setTick((t) => t + 1), HOME_POLL_MS);
    return () => {
      live = false;
      cancel();
    };
  }, [client, deployed, tick]);

  return deployed ? status : { state: "not-deployed" };
}
