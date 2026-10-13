import type { Db } from "@alpha-agents/db";

/**
 * RP-U1: the research reports as the owner reads them: the list for an
 * agent (newest first) and one report by its cycle. Read straight from the
 * environment's database; the orchestrator writes them.
 */
export interface ReportListItem {
  readonly cycleId: string;
  readonly kind: string;
  readonly status: string;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly chargedUsdcE6: string;
  readonly ceilingUsdcE6: string;
  readonly tokens: number;
  readonly summary: string | null;
}

const e6 = (v: unknown) => String(v ?? "0").split(".")[0] ?? "0";

export async function listReports(db: Db, chainId: number, agentId: number, limit = 30) {
  const rows = await db
    .selectFrom("platform.research_reports as r")
    .leftJoin("platform.research_cycles as c", "c.cycle_id", "r.cycle_id")
    .select([
      "r.cycle_id",
      "r.status",
      "r.reason",
      "r.created_at",
      "r.charged_usdc_e6",
      "r.ceiling_usdc_e6",
      "r.body",
      "c.kind",
    ])
    .where("r.chain_id", "=", chainId)
    .where("r.agent_id", "=", agentId)
    .orderBy("r.created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((r): ReportListItem => {
    const body = r.body as { report?: { executiveSummary?: string; tokens?: unknown[] } } | null;
    return {
      cycleId: r.cycle_id,
      kind: r.kind ?? "UNKNOWN",
      status: r.status,
      reason: r.reason,
      createdAt: new Date(r.created_at).toISOString(),
      chargedUsdcE6: e6(r.charged_usdc_e6),
      ceilingUsdcE6: e6(r.ceiling_usdc_e6),
      tokens: body?.report?.tokens?.length ?? 0,
      summary: body?.report?.executiveSummary?.slice(0, 280) ?? null,
    };
  });
}

export async function readReport(db: Db, chainId: number, agentId: number, cycleId: string) {
  const r = await db
    .selectFrom("platform.research_reports")
    .selectAll()
    .where("cycle_id", "=", cycleId)
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .executeTakeFirst();
  if (!r) return null;
  return {
    cycleId: r.cycle_id,
    status: r.status,
    reason: r.reason,
    createdAt: new Date(r.created_at).toISOString(),
    model: r.model,
    chargedUsdcE6: e6(r.charged_usdc_e6),
    ceilingUsdcE6: e6(r.ceiling_usdc_e6),
    checks: r.checks,
    body: r.body,
  };
}

/** The cycle of an agent's newest activation, and of its newest proposal, when their reports are written. */
export async function reportLinks(db: Db, chainId: number, agentId: number) {
  const written = (cycleId: string | null | undefined) =>
    cycleId
      ? db
          .selectFrom("platform.research_reports")
          .select("cycle_id")
          .where("cycle_id", "=", cycleId)
          .where("status", "=", "written")
          .executeTakeFirst()
          .then((x) => x?.cycle_id ?? null)
      : Promise.resolve(null);
  const activation = await db
    .selectFrom("platform.activations")
    .select("cycle_id")
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  const proposal = await db
    .selectFrom("platform.plan_proposals")
    .select("cycle_id")
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .where("cycle_id", "is not", null)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return {
    activation: await written(activation?.cycle_id),
    plan: await written(proposal?.cycle_id),
  };
}
