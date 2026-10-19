import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@alpha-agents/config";
import { type Db, createDb } from "@alpha-agents/db";
import { type ArmingStatus, TradeStore, disarm, grantDate } from "@alpha-agents/trading";
import { type ArmingFacts, templateArmingEntry } from "./narrator.ts";
import { ResearchStore } from "./research-loop.ts";

/**
 * CO-U1 (2026-10-19, owner): the platform turns automatic trading and scheduled research off for
 * every agent on one chain, the way an owner's own Turn off and research pause do: the arming
 * ends through packages/trading's disarm (what the control API's disarm route calls), the
 * research schedule is paused as the pause route does, and nothing else changes. The grant stays
 * on chain, so the owner's Turn on arms the agent again as always. Each disarmed agent's activity
 * gets the arming's "ended" entry with the platform's reason, under the key the trade flow uses.
 *
 *   node services/orchestrator/src/platform-pause.ts          lists what it would change
 *   node services/orchestrator/src/platform-pause.ts --send   changes it
 */
export const PLATFORM_PAUSE_REASON =
  "Paused by the platform to reduce load; turn it back on anytime.";

export interface PauseResult {
  readonly disarmed: readonly { agentId: number; armingId: string; was: ArmingStatus }[];
  readonly researchPaused: readonly number[];
}

export async function pausePlatform(db: Db, chainId: number, send: boolean): Promise<PauseResult> {
  const trades = new TradeStore(db);
  const research = new ResearchStore(db);
  const disarmed: { agentId: number; armingId: string; was: ArmingStatus }[] = [];
  for (const open of await trades.openArmings(chainId)) {
    if (!send) {
      disarmed.push({ agentId: open.agentId, armingId: open.armingId, was: open.status });
      continue;
    }
    const ended = await disarm(trades, chainId, open.agentId);
    if (!ended) continue;
    disarmed.push({ agentId: open.agentId, armingId: open.armingId, was: open.status });
    const facts: ArmingFacts = {
      agent: `Agent #${open.agentId}`,
      activity: "arming",
      event: "ended",
      grantValidUntil: grantDate(ended.validUntil),
      endReason: PLATFORM_PAUSE_REASON,
    };
    await db
      .insertInto("platform.activity_entries")
      .values({
        entry_id: `act-${randomUUID()}`,
        chain_id: chainId,
        agent_id: open.agentId,
        task_id: `${ended.armingId}:ended`,
        kind: "arming",
        text: templateArmingEntry(facts),
        rendered_by: "template",
        facts: JSON.stringify(facts),
        rejections: "[]",
        model: null,
      })
      .onConflict((oc) => oc.column("task_id").doNothing())
      .execute();
  }

  // Every agent the chain knows, with a goal or a schedule; already paused ones stay as they are.
  const ids = new Set<number>();
  for (const table of [
    "indexer.agents",
    "platform.agent_goals",
    "platform.research_schedules",
  ] as const)
    for (const r of await db
      .selectFrom(table)
      .select("agent_id")
      .distinct()
      .where("chain_id", "=", chainId)
      .execute())
      ids.add(r.agent_id);
  const researchPaused: number[] = [];
  for (const agentId of [...ids].sort((a, b) => a - b)) {
    const ref = { chainId, agentId };
    if ((await research.schedule(ref)).paused) continue;
    researchPaused.push(agentId);
    if (send) await research.update(ref, { paused: true, waitingReason: null, waitingSince: null });
  }
  return { disarmed, researchPaused };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig({
    name: "platform-pause",
    requires: ["DATABASE_URL"],
    usesChain: false,
  });
  const url = (config.values.DATABASE_URL as { reveal(): string } | undefined)?.reveal() ?? "";
  const chainId = config.environment.chainId;
  const send = process.argv.includes("--send");
  const db = createDb(url, { max: 2 });
  try {
    const r = await pausePlatform(db, chainId, send);
    console.log(`chain ${chainId}: ${send ? "changed" : "would change (dry run)"}`);
    console.log(
      `automatic trading off: ${r.disarmed.map((d) => `#${d.agentId} (${d.was})`).join(", ") || "none armed"}`,
    );
    console.log(
      `scheduled research paused: ${r.researchPaused.map((a) => `#${a}`).join(", ") || "none"}`,
    );
  } finally {
    await db.destroy();
  }
}
