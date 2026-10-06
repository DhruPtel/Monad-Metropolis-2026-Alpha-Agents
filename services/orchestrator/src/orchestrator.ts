import { randomUUID } from "node:crypto";
import type { JournalEntry } from "@alpha-agents/accounting";
import { type FundingKeys, ensureFundingAddresses } from "./credits/funding.ts";
import { Ledger } from "./credits/ledger.ts";
import { type RefundChain, RefundService } from "./credits/refunds.ts";
import { CreditService } from "./credits/service.ts";
import type { WebProvider } from "@alpha-agents/data-tools";
import { type Gate, startGate } from "./gate.ts";
import { gateResolver } from "./gate-resolver.ts";
import type { GatewayAdmin } from "./gateway-admin.ts";
import { RevealKeeper } from "./keeper.ts";
import { LeaseManager } from "./leases.ts";
import { runNoopTask } from "./noop.ts";
import { Provisioner } from "./provisioner.ts";
import { type JobData, OrchestratorQueue } from "./queue.ts";
import { reconcileOnce } from "./reconciler.ts";
import { HERMES_TEMPLATE, type SandboxProvider } from "./sandbox.ts";
import { type Log, type Redactor, errorText, randomToken } from "./secrets.ts";
import type { AgentRef, Store } from "./store.ts";
import { startupSweep, type SweepReport } from "./sweep.ts";
import { type ToolServers, startToolServers } from "./tools/servers.ts";
import { type Tunnel, startTunnel, tunnelPidFile } from "./tunnel.ts";

/**
 * Wires the orchestrator's parts into one service (D-202): the startup sweep,
 * the queue worker, the reconciler (every second), the reveal keeper (every two
 * seconds), the lease reaper, the gate with its tunnel, started on the first
 * task that needs a sandbox, and credits (P1-U6): funding addresses, deposits,
 * metering, budget sync and refunds, every two seconds.
 */
export interface CreditsOptions {
  readonly keys: FundingKeys;
  /** Null where AgentNFT or USDC is not deployed: refunds then stay requested. */
  readonly refundChain: RefundChain | null;
  readonly environment: JournalEntry["environment"];
  readonly cap?: bigint;
}

/** An LLM task was asked for an agent with no spendable credits (D-129). */
export class CreditsExhaustedError extends Error {
  constructor(agentId: number) {
    super(`Agent ${agentId} has no credits left: add USDC to its funding address.`);
    this.name = "CreditsExhaustedError";
  }
}

export interface OrchestratorOptions {
  readonly store: Store;
  readonly gateway: GatewayAdmin;
  readonly provider: SandboxProvider | null;
  readonly keeper: RevealKeeper | null;
  readonly chainId: number;
  readonly namespace: string;
  readonly redisUrl: string;
  readonly secret: string;
  readonly litellmUrl: string;
  readonly devDir: string;
  readonly cloudflared: string | null;
  readonly startingBudgetUsd: number;
  readonly redactor: Redactor;
  readonly log: Log;
  readonly template?: string;
  readonly reconcileMs?: number;
  readonly keeperMs?: number;
  /** P1-U6 credits; null runs the orchestrator without them (P1-U5 tests). */
  readonly credits: CreditsOptions | null;
  readonly creditsMs?: number;
  /**
   * P1-U7: the web provider behind the data tools (Tavily), or null when it is not
   * configured. The tool servers run whenever credits do, since every paid call is metered.
   */
  readonly web?: WebProvider | null;
}

export class Orchestrator {
  readonly runTag = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  readonly leases: LeaseManager;
  readonly provisioner: Provisioner;
  readonly queue: OrchestratorQueue;
  readonly ledger: Ledger;
  readonly credits: CreditService | null;
  readonly refunds: RefundService | null;
  readonly probeToken = randomToken();
  sweep: SweepReport | null = null;
  private readonly o: OrchestratorOptions;
  private readonly controller = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private gate: Gate | null = null;
  private tools: ToolServers | null = null;
  private tunnel: Promise<Tunnel> | null = null;

  constructor(options: OrchestratorOptions) {
    this.o = options;
    options.redactor.add(this.probeToken);
    const { store, redactor, log, namespace } = options;
    this.leases = new LeaseManager({
      store,
      provider: options.provider ?? unavailableProvider,
      namespace,
      runTag: this.runTag,
      redactor,
      log,
    });
    this.ledger = new Ledger(store.db);
    const c = options.credits;
    this.credits = c
      ? new CreditService({
          store,
          ledger: this.ledger,
          gateway: options.gateway,
          chainId: options.chainId,
          environment: c.environment,
          keyOf: (runtime) => this.provisioner.virtualKey(runtime),
          redactor,
          log,
          ...(c.cap === undefined ? {} : { cap: c.cap }),
        })
      : null;
    this.refunds =
      c && c.refundChain && this.credits
        ? new RefundService({
            store,
            ledger: this.ledger,
            credits: this.credits,
            keys: c.keys,
            chain: c.refundChain,
            chainId: options.chainId,
            environment: c.environment,
            redactor,
            log,
          })
        : null;
    this.provisioner = new Provisioner({
      store,
      gateway: options.gateway,
      leases: this.leases,
      namespace,
      secret: options.secret,
      redactor,
      log,
      startingBudgetUsd: options.startingBudgetUsd,
      ...(this.credits ? { credits: this.credits } : {}),
    });
    this.queue = new OrchestratorQueue({ redisUrl: options.redisUrl, namespace, log, redactor });
  }

  get keeper(): RevealKeeper | null {
    return this.o.keeper;
  }

  async start(): Promise<void> {
    this.sweep = await startupSweep({
      store: this.o.store,
      provider: this.o.provider,
      gateway: this.o.gateway,
      namespace: this.o.namespace,
      tunnelPidFile: tunnelPidFile(this.o.devDir, this.o.namespace),
      redactor: this.o.redactor,
      log: this.o.log,
    });
    if (this.credits && this.o.credits)
      this.tools = await startToolServers({
        store: this.o.store,
        ledger: this.ledger,
        credits: this.credits,
        environment: this.o.credits.environment,
        provider: this.o.web ?? null,
        log: this.o.log,
      });
    this.gate = await startGate({
      litellmUrl: this.o.litellmUrl,
      probeToken: this.probeToken,
      resolve: gateResolver(this.o.store, this.provisioner, this.credits),
      ...(this.tools
        ? { tools: { data: this.tools.data.url, platform: this.tools.platform.url } }
        : {}),
    });
    this.queue.start((job) => this.handle(job));
    this.every(this.o.reconcileMs ?? 1_000, "reconcile", async () => {
      await reconcileOnce(this.o.store, this.queue, this.o.chainId);
    });
    this.every(15_000, "lease reaper", async () => {
      await this.leases.reapExpired();
    });
    if (this.o.credits) {
      const keys = this.o.credits.keys;
      this.every(this.o.creditsMs ?? 2_000, "credits", async () => {
        await ensureFundingAddresses(this.o.store, keys, this.o.chainId);
        await this.credits?.tick();
        await this.refunds?.tick();
      });
    }
    if (this.o.keeper) {
      const keeper = this.o.keeper;
      this.loops.push(keeper.run(this.controller.signal, this.o.keeperMs ?? 2_000));
    }
    this.o.log(`started ${this.runTag} (namespace ${this.o.namespace}, chain ${this.o.chainId})`);
  }

  private every(ms: number, name: string, fn: () => Promise<void>): void {
    const signal = this.controller.signal;
    this.loops.push(
      (async () => {
        while (!signal.aborted) {
          try {
            await fn();
          } catch (err) {
            this.o.log(`${name} failed: ${errorText(err, this.o.redactor)}`);
          }
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ms);
            signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
          });
        }
      })(),
    );
  }

  private async handle(job: JobData): Promise<unknown> {
    switch (job.kind) {
      case "provision":
        return this.provisioner.provision(job.ref);
      case "deprovision":
        return this.provisioner.deprovision(job.ref, job.reason);
      case "reset":
        return this.provisioner.reset(job.ref);
      case "noop":
        return runNoopTask(
          {
            store: this.o.store,
            leases: this.leases,
            provider: this.o.provider ?? unavailableProvider,
            template: this.o.template ?? HERMES_TEMPLATE,
            tunnelHost: () => this.tunnelHost(),
            gate: this.requireGate(),
            redactor: this.o.redactor,
            log: this.o.log,
          },
          job.taskId,
        );
    }
  }

  private requireGate(): Gate {
    if (!this.gate) throw new Error("the gate is not running");
    return this.gate;
  }

  /** The tunnel's public host, starting the tunnel once and checking it reaches the gate. */
  async tunnelHost(): Promise<string> {
    const gate = this.requireGate();
    if (!this.o.cloudflared) throw new Error("cloudflared is not installed");
    const binary = this.o.cloudflared;
    this.tunnel ??= startTunnel(binary, gate.url, tunnelPidFile(this.o.devDir, this.o.namespace));
    let tunnel: Tunnel;
    try {
      tunnel = await this.tunnel;
    } catch (err) {
      this.tunnel = null;
      throw err;
    }
    // A new quick tunnel's DNS takes a few seconds; the probe token may only call /healthz.
    for (let i = 0; i < 45; i += 1) {
      try {
        const res = await fetch(`${tunnel.url}/healthz`, {
          headers: { "x-alpha-gate": this.probeToken },
          signal: AbortSignal.timeout(5_000),
        });
        if (res.status === 200) return tunnel.host;
      } catch {
        // not reachable yet
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error("the tunnel never reached the gate");
  }

  /** The dev console's no-op task: recorded, then run by a queue worker. */
  async enqueueNoop(ref: AgentRef): Promise<string> {
    const runtime = await this.o.store.runtime(ref);
    if (runtime?.status !== "ready") throw new Error(`agent ${ref.agentId} is not provisioned`);
    // D-129: LLM work stops at zero credits; deterministic work does not come through here.
    if (this.credits && (await this.credits.creditsOf(ref.agentId)).restricted)
      throw new CreditsExhaustedError(ref.agentId);
    const taskId = randomUUID();
    await this.o.store.insertTask(taskId, ref, "noop");
    await this.queue.add({ kind: "noop", ref, taskId });
    return taskId;
  }

  /** The agent's owner and ownership epoch, read from the chain. */
  async ownership(agentId: number) {
    const chain = this.o.credits?.refundChain;
    if (!chain) throw new Error("refunds are not configured");
    return chain.ownership(agentId);
  }

  async enqueueReset(ref: AgentRef): Promise<void> {
    await this.queue.add({ kind: "reset", ref });
  }

  /** Stops the loops, ends this run's leases (stopping their sandboxes) and the tunnel. */
  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.loops);
    await this.queue.close();
    for (const lease of await this.o.store.activeLeases({ namespace: this.o.namespace }))
      if (lease.runTag === this.runTag)
        await this.leases.release(lease.leaseId, "orchestrator stopped");
    if (this.tunnel) await (await this.tunnel.catch(() => null))?.close();
    await this.gate?.close();
    await this.tools?.close();
    this.o.log(`stopped ${this.runTag}`);
  }

  /** The gate's URL, for tests. */
  get gateUrl(): string | null {
    return this.gate?.url ?? null;
  }
}

const unavailableProvider: SandboxProvider = {
  create: () => Promise.reject(new Error("sandboxes are not configured (E2B_API_KEY)")),
  kill: () => Promise.resolve(),
  list: () => Promise.resolve([]),
};
