import type { GatewayAdmin } from "./gateway-admin.ts";
import { aliasPrefix } from "./provisioner.ts";
import type { SandboxProvider } from "./sandbox.ts";
import { type Log, type Redactor, errorText } from "./secrets.ts";
import type { Store } from "./store.ts";
import { stopTunnelFromPidFile } from "./tunnel.ts";

/**
 * The startup sweep (L-19, D-165). In-process teardown cannot run after a
 * SIGKILL, an out-of-memory kill or a crash, so every orchestrator run starts
 * by removing what an earlier run of the same namespace left behind, found by
 * tag rather than by memory:
 *
 * 1. the tunnel named by the namespace's PID file;
 * 2. every sandbox tagged with the namespace (leases do not survive a restart);
 * 3. every active lease, which also revokes its gate token, and tasks left running;
 * 4. every LiteLLM key with the namespace's alias prefix that no live runtime owns.
 */
export interface SweepReport {
  readonly tunnel: number | null;
  readonly sandboxes: readonly string[];
  readonly leases: number;
  readonly tasks: number;
  readonly keys: readonly string[];
  readonly errors: readonly string[];
}

export interface SweepOptions {
  readonly store: Store;
  readonly provider: SandboxProvider | null;
  readonly gateway: GatewayAdmin;
  readonly namespace: string;
  readonly tunnelPidFile: string;
  readonly redactor: Redactor;
  readonly log: Log;
}

export async function startupSweep(o: SweepOptions): Promise<SweepReport> {
  const errors: string[] = [];
  const attempt = async <T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${what}: ${errorText(err, o.redactor)}`);
      return fallback;
    }
  };

  const tunnel = await attempt("tunnel", () => stopTunnelFromPidFile(o.tunnelPidFile), null);

  const sandboxes = await attempt(
    "sandboxes",
    async () => {
      if (!o.provider) return [];
      const found = await o.provider.list({ app: "alpha-agents", namespace: o.namespace });
      for (const s of found) await o.provider.kill(s.id);
      return found.map((s) => s.id);
    },
    [] as string[],
  );

  const leases = await attempt(
    "leases",
    async () => {
      const active = await o.store.activeLeases({ namespace: o.namespace });
      for (const l of active) await o.store.endLease(l.leaseId, "swept at startup");
      return active.length;
    },
    0,
  );
  const tasks = await attempt(
    "tasks",
    () => o.store.failUnfinishedTasks("the orchestrator stopped while the task ran"),
    0,
  );

  const keys = await attempt(
    "keys",
    async () => {
      const owned = new Set<string>();
      for (const chainId of await chainIds(o.store))
        for (const rt of await o.store.runtimes(chainId))
          if (rt.status !== "deprovisioned") owned.add(rt.keyAlias);
      const orphans = (await o.gateway.listAliases(aliasPrefix(o.namespace))).filter(
        (a) => !owned.has(a),
      );
      await o.gateway.deleteAliases(orphans);
      return orphans;
    },
    [] as string[],
  );

  const report = { tunnel, sandboxes, leases, tasks, keys, errors };
  o.log(
    `startup sweep (${o.namespace}): tunnel ${tunnel ?? "none"}, ${sandboxes.length} sandboxes, ` +
      `${leases} leases, ${tasks} tasks, ${keys.length} orphan keys` +
      (errors.length ? `; errors: ${errors.join("; ")}` : ""),
  );
  return report;
}

async function chainIds(store: Store): Promise<number[]> {
  const rows = await store.db
    .selectFrom("platform.agent_runtimes")
    .select("chain_id")
    .distinct()
    .execute();
  return rows.map((r) => r.chain_id);
}
