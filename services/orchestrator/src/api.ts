import { TIER_IDS } from "@alpha-agents/domain";
import { Hono } from "hono";
import type { Orchestrator } from "./orchestrator.ts";
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
      const taskId = await o.orchestrator.enqueueNoop(ref);
      return c.json({ taskId }, 202);
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
