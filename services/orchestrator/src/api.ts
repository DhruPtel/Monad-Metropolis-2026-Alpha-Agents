import { TIER_IDS } from "@alpha-agents/domain";
import { Hono } from "hono";
import { RefundOpenError } from "./credits/refunds.ts";
import { CreditsExhaustedError, type Orchestrator } from "./orchestrator.ts";
import type { Runtime, Store, Task } from "./store.ts";

/**
 * The orchestrator's internal API (D-205), on loopback only. Reads serve the
 * dev console: runtimes with their lease and latest task, one task, and the
 * keeper's recent actions. The write routes (run the no-op task, reset an
 * agent) exist only when `devActions` is on, which main.ts allows only with
 * APP_ENV=local. Nothing here returns a key, a token or a ciphertext.
 */
export interface ApiOptions {
  readonly orchestrator: Orchestrator;
  readonly store: Store;
  readonly chainId: number;
  readonly devActions: boolean;
}

const runtimeView = (r: Runtime) => ({
  agentId: String(r.agentId),
  generation: r.generation,
  status: r.status,
  tier: TIER_IDS[r.tier - 1] ?? null,
  species: r.species,
  slots: (r.config as { tier?: { slots?: number } }).tier?.slots ?? null,
  playbook:
    (r.config as { tier?: { playbook?: { version?: string } } }).tier?.playbook?.version ?? null,
  configHash: r.configHash,
  keyAlias: r.keyAlias,
  budgetUsd: r.budgetUsd,
  lastError: r.lastError,
  provisionedAt: r.provisionedAt?.toISOString() ?? null,
  updatedAt: r.updatedAt.toISOString(),
});

export const taskView = (t: Task) => ({
  taskId: t.taskId,
  agentId: String(t.agentId),
  kind: t.kind,
  status: t.status,
  result: t.result,
  error: t.error,
  createdAt: t.createdAt.toISOString(),
  startedAt: t.startedAt?.toISOString() ?? null,
  finishedAt: t.finishedAt?.toISOString() ?? null,
});

function agentRef(raw: string, chainId: number) {
  if (!/^[1-9]\d{0,4}$/.test(raw)) return null;
  return { chainId, agentId: Number(raw) };
}

export function createApi(o: ApiOptions): Hono {
  const app = new Hono();
  app.onError((err, c) => c.json({ error: "internal", message: err.message.slice(0, 200) }, 500));

  app.get("/health", (c) => c.json({ ok: true, runTag: o.orchestrator.runTag }));

  app.get("/v1/runtimes", async (c) => {
    const [runtimes, leases, tasks] = await Promise.all([
      o.store.runtimes(o.chainId),
      o.store.activeLeases(),
      o.store.latestTasks(o.chainId),
    ]);
    return c.json({
      devActions: o.devActions,
      runtimes: runtimes.map((r) => {
        const lease = leases.find((l) => l.chainId === r.chainId && l.agentId === r.agentId);
        const task = tasks.find((t) => t.agentId === r.agentId);
        return {
          ...runtimeView(r),
          lease: lease
            ? {
                leaseId: lease.leaseId,
                purpose: lease.purpose,
                sandboxId: lease.sandboxId,
                expiresAt: lease.expiresAt.toISOString(),
              }
            : null,
          latestTask: task ? taskView(task) : null,
        };
      }),
    });
  });

  app.get("/v1/tasks/:taskId", async (c) => {
    const task = await o.store.task(c.req.param("taskId"));
    return task ? c.json(taskView(task)) : c.json({ error: "not_found" }, 404);
  });

  /** P1-U6: every indexed agent's funding address, credits and recent ledger entries. */
  app.get("/v1/credits", async (c) => {
    const credits = o.orchestrator.credits;
    if (!credits) return c.json({ enabled: false, agents: [] });
    const rows = await o.store.db
      .selectFrom("indexer.agents as a")
      .leftJoin("platform.funding_addresses as f", (j) =>
        j.onRef("f.chain_id", "=", "a.chain_id").onRef("f.agent_id", "=", "a.agent_id"),
      )
      .select(["a.agent_id", "f.address"])
      .where("a.chain_id", "=", o.chainId)
      .orderBy("a.agent_id")
      .execute();
    const agents = [];
    for (const r of rows) {
      const v = await credits.creditsOf(r.agent_id);
      const recent = await o.orchestrator.ledger.recent(o.chainId, r.agent_id, 5);
      agents.push({
        agentId: String(r.agent_id),
        fundingAddress: r.address,
        creditsUsdcE6: v.credits.toString(),
        spendableUsdcE6: v.spendable.toString(),
        heldUsdcE6: v.held.toString(),
        unsettledUsdcE6: v.unsettled.toString(),
        fundingAddressUsdcE6: v.fundingAddress.toString(),
        restricted: v.restricted,
        recent: recent.map((e) => ({
          kind: e.kind,
          creditsDeltaUsdcE6: e.creditsDelta.toString(),
          at: e.occurredAt.toISOString(),
        })),
      });
    }
    return c.json({ enabled: true, agents });
  });

  app.get("/v1/refunds/:refundId", async (c) => {
    const r = await o.store.db
      .selectFrom("platform.refunds")
      .select([
        "refund_id",
        "agent_id",
        "owner",
        "owner_epoch",
        "status",
        "credits_usdc_e6",
        "held_usdc_e6",
        "tx_hash",
        "reason",
        "created_at",
        "updated_at",
      ])
      .where("refund_id", "=", c.req.param("refundId"))
      .executeTakeFirst();
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({
      refundId: r.refund_id,
      agentId: String(r.agent_id),
      owner: r.owner,
      ownerEpoch: String(r.owner_epoch),
      status: r.status,
      creditsUsdcE6: r.credits_usdc_e6,
      heldUsdcE6: r.held_usdc_e6,
      txHash: r.tx_hash,
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    });
  });

  app.get("/v1/keeper", (c) => {
    const keeper = o.orchestrator.keeper;
    if (!keeper) return c.json({ running: false, recent: [] });
    const recent = keeper.actions
      .filter((a) => a.kind !== "idle" && a.kind !== "waiting")
      .slice(-20)
      .map((a) =>
        JSON.parse(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? String(v) : v))),
      );
    return c.json({ running: true, recent });
  });

  if (o.devActions) {
    app.post("/v1/agents/:agentId/tasks/noop", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const runtime = await o.store.runtime(ref);
      if (runtime?.status !== "ready")
        return c.json(
          { error: "not_provisioned", message: `Agent ${ref.agentId} is not provisioned yet.` },
          409,
        );
      const held = await o.store.activeLease(ref);
      if (held)
        return c.json(
          { error: "lease_held", message: `Agent ${ref.agentId} already has a sandbox running.` },
          409,
        );
      try {
        const taskId = await o.orchestrator.enqueueNoop(ref);
        return c.json({ taskId }, 202);
      } catch (err) {
        if (err instanceof CreditsExhaustedError)
          return c.json({ error: "credits_exhausted", message: err.message }, 409);
        throw err;
      }
    });

    /** The console's refund: for the agent's current owner and epoch, read from the chain. */
    app.post("/v1/agents/:agentId/refund", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const refunds = o.orchestrator.refunds;
      if (!refunds) return c.json({ error: "not_configured", message: "Refunds are off." }, 503);
      const ownership = await o.orchestrator.ownership(ref.agentId);
      if (!ownership)
        return c.json({ error: "not_found", message: `Agent ${ref.agentId} does not exist.` }, 404);
      try {
        const refundId = await refunds.request(
          ref.agentId,
          ownership.owner,
          ownership.epoch,
          "console",
        );
        return c.json(
          { refundId, owner: ownership.owner, ownerEpoch: String(ownership.epoch) },
          202,
        );
      } catch (err) {
        if (err instanceof RefundOpenError)
          return c.json({ error: "refund_open", message: err.message }, 409);
        throw err;
      }
    });

    app.post("/v1/agents/:agentId/reset", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      if (!(await o.store.runtime(ref)))
        return c.json(
          { error: "not_provisioned", message: `Agent ${ref.agentId} has no runtime.` },
          409,
        );
      await o.orchestrator.enqueueReset(ref);
      return c.json({ queued: true }, 202);
    });
  }

  return app;
}
