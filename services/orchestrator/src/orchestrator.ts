import { randomUUID } from "node:crypto";
import type { JournalEntry } from "@alpha-agents/accounting";
import { type FundingKeys, ensureFundingAddresses } from "./credits/funding.ts";
import { Ledger } from "./credits/ledger.ts";
import { type RefundChain, RefundService, type RefundSigner } from "./credits/refunds.ts";
import { CreditService } from "./credits/service.ts";
import type { WebProvider } from "@alpha-agents/data-tools";
import { type Gate, startGate } from "./gate.ts";
import { gateResolver } from "./gate-resolver.ts";
import type { GatewayAdmin } from "./gateway-admin.ts";
import { RevealKeeper } from "./keeper.ts";
import type { LocalFeedRefresher } from "./local-feeds.ts";
import type { RevealSteering } from "./reveal-steer.ts";
import { LeaseManager } from "./leases.ts";
import { Narrator } from "./narrator.ts";
import { type TaskContext, runNoopTask } from "./noop.ts";
import { Provisioner } from "./provisioner.ts";
import { type JobData, OrchestratorQueue } from "./queue.ts";
import { reconcileOnce } from "./reconciler.ts";
import { SCAN_MIN_CREDITS_USDC_E6, runScanTask, scanDue } from "./scan.ts";
import { runChainCheckTask } from "./chain-check.ts";
import { HERMES_TEMPLATE, type SandboxProvider } from "./sandbox.ts";
import { type Log, type Redactor, errorText, randomToken } from "./secrets.ts";
import { type AgentRef, OpenScanExistsError, type Store, type TaskRequester } from "./store.ts";
import { startupSweep, type SweepReport } from "./sweep.ts";
import { type ChainToolsWiring, type ToolServers, startToolServers } from "./tools/servers.ts";
import { type Tunnel, startTunnel, tunnelPidFile } from "./tunnel.ts";
import { TradeStore, approveByOwner, confirmArming, disarm } from "@alpha-agents/trading";
import type { Hex } from "viem";
import { TradeFlow, type TradeFlowGas, type TradeFlowSigner } from "./trade-flow.ts";

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
  /** Every refund goes through the signer's outbox (D-261); null leaves requests waiting. */
  readonly refundSigner?: RefundSigner | null;
  readonly environment: JournalEntry["environment"];
  readonly cap?: bigint;
}

/** A Scan was asked for while one is already queued or running for the agent (D-216). */
export { OpenScanExistsError as ScanOpenError } from "./store.ts";

/** D-216's default cadence: 360 minutes between scheduled Scans. */
export const DEFAULT_SCAN_INTERVAL_MS = 360 * 60_000;

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
  /** D-237: fresh Chainlink feeds on the local fork; null everywhere else. */
  readonly localFeeds?: LocalFeedRefresher | null;
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
  /** Minutes between scheduled Scans, as milliseconds (SCAN_INTERVAL_MINUTES, D-216). */
  readonly scanIntervalMs?: number;
  /** How often the scheduler looks for due Scans; 0 turns scheduling off (tests). */
  readonly scheduleMs?: number;
  /** D-221: steered reveals, on the local fork only; null elsewhere. */
  readonly revealSteering?: RevealSteering | null;
  /** P2-U5: the chain tools' reader and the signer's session keys; none runs every chain tool as "not deployed". */
  readonly chain?: Omit<ChainToolsWiring, "onProposed">;
  /**
   * P2-U6: what the trade flow sends swaps with. Without it (or without a chain
   * reader) proposals wait and nothing is ever sent.
   */
  readonly trading?: {
    readonly signer: TradeFlowSigner;
    readonly gas: TradeFlowGas;
    readonly finalizedBlock: () => Promise<bigint | null>;
    readonly everyMs?: number;
  } | null;
}

export class Orchestrator {
  readonly runTag = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  readonly leases: LeaseManager;
  readonly provisioner: Provisioner;
  readonly queue: OrchestratorQueue;
  readonly ledger: Ledger;
  readonly credits: CreditService | null;
  readonly refunds: RefundService | null;
  readonly narrator: Narrator | null;
  /** P2-U6: arming and intent records, and the worker that turns intents into trades. */
  readonly trades: TradeStore;
  readonly tradeFlow: TradeFlow | null;
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
            signer: c.refundSigner ?? null,
            chainId: options.chainId,
            environment: c.environment,
            redactor,
            log,
          })
        : null;
    this.narrator = this.credits
      ? new Narrator({
          store,
          gateway: options.gateway,
          credits: this.credits,
          namespace,
          litellmUrl: options.litellmUrl,
          secret: options.secret,
          redactor,
          log,
        })
      : null;
    this.trades = new TradeStore(store.db);
    const reader = options.chain?.reader ?? null;
    this.tradeFlow =
      reader && options.trading
        ? new TradeFlow({
            chainId: options.chainId,
            store: this.trades,
            reader,
            signer: options.trading.signer,
            gas: options.trading.gas,
            finalizedBlock: options.trading.finalizedBlock,
            narrator: this.narrator,
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

  /** The local fork's reveal steering (D-221), or null in every other environment. */
  get revealSteering(): RevealSteering | null {
    return this.o.revealSteering ?? null;
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
        chain: {
          reader: this.o.chain?.reader ?? null,
          ...(this.o.chain?.sessionKeyOf ? { sessionKeyOf: this.o.chain.sessionKeyOf } : {}),
          onProposed: (identity, intent) => {
            void this.narrator
              ?.narrateIntent(identity.chainId, identity.agentId, intent.intentId)
              .catch((err: unknown) =>
                this.o.log(
                  `intent ${intent.intentId}: no activity entry: ${errorText(err, this.o.redactor)}`,
                ),
              );
          },
        },
        log: this.o.log,
      });
    this.gate = await startGate({
      litellmUrl: this.o.litellmUrl,
      probeToken: this.probeToken,
      resolve: gateResolver(this.o.store, this.provisioner, this.credits),
      ...(this.tools
        ? {
            tools: {
              data: this.tools.data.url,
              platform: this.tools.platform.url,
              chain: this.tools.chain.url,
            },
          }
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
    if (this.credits)
      this.every(2_000, "requested scans", async () => {
        await this.queueRequestedScans();
      });
    if (this.credits && (this.o.scheduleMs ?? 30_000) > 0)
      this.every(this.o.scheduleMs ?? 30_000, "scan scheduler", async () => {
        await this.scheduleScans();
      });
    if (this.tools) {
      const intents = this.tools.intents;
      this.every(30_000, "intent expiry", async () => {
        const n = await intents.expireDue(this.o.chainId);
        if (n > 0) this.o.log(`${n} intents expired before approval`);
      });
    }
    if (this.tradeFlow) {
      const flow = this.tradeFlow;
      this.every(this.o.trading?.everyMs ?? 2_000, "trade flow", () => flow.tick());
    }
    if (this.o.localFeeds) {
      const feeds = this.o.localFeeds;
      this.every(feeds.everyMs, "local feeds", () => feeds.refresh());
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
        return runNoopTask(this.taskContext(), job.taskId);
      case "scan":
        return runScanTask({ ...this.taskContext(), narrator: this.narrator }, job.taskId);
      case "chain_check":
        return runChainCheckTask(this.taskContext(), job.taskId);
    }
  }

  private taskContext(): TaskContext {
    return {
      store: this.o.store,
      leases: this.leases,
      provider: this.o.provider ?? unavailableProvider,
      template: this.o.template ?? HERMES_TEMPLATE,
      tunnelHost: () => this.tunnelHost(),
      gate: this.requireGate(),
      redactor: this.o.redactor,
      log: this.o.log,
    };
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

  /**
   * The dev console's chain check (P2-U5): an LLM task, so it needs credits like a
   * Scan, and one sandbox per agent at a time.
   */
  async enqueueChainCheck(ref: AgentRef): Promise<string> {
    const runtime = await this.o.store.runtime(ref);
    if (runtime?.status !== "ready") throw new Error(`agent ${ref.agentId} is not provisioned`);
    if (!this.tools) throw new Error("the tool servers are not running");
    if (this.credits && (await this.credits.creditsOf(ref.agentId)).restricted)
      throw new CreditsExhaustedError(ref.agentId);
    const taskId = randomUUID();
    await this.o.store.insertTask(taskId, ref, "chain_check", "console");
    await this.queue.add({ kind: "chain_check", ref, taskId });
    return taskId;
  }

  /** An agent's intents, newest first, with expiry applied (the dev console's view). */
  async intents(ref: AgentRef, limit = 20) {
    return this.tools ? this.tools.intents.list(ref.chainId, ref.agentId, limit) : [];
  }

  /** The agent's arming state now and its newest arming record (P2-U6). */
  async arming(ref: AgentRef) {
    const last = await this.trades.lastArming(ref.chainId, ref.agentId);
    return { last, open: last && last.status !== "ended" ? last : null };
  }

  /** The agent's funding address: its session key in the signer (D-243). */
  async fundingAddress(ref: AgentRef): Promise<Hex | null> {
    const row = await this.o.store.db
      .selectFrom("platform.funding_addresses")
      .select("address")
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .executeTakeFirst();
    return (row?.address as Hex | undefined) ?? null;
  }

  /** Records the owner's grant once it is on chain (the console's arm, after its wallet call). */
  async confirmArming(ref: AgentRef, owner: Hex) {
    const reader = this.o.chain?.reader;
    if (!reader) throw new Error("the trading contracts are not deployed here");
    return confirmArming(this.trades, await reader.agent(ref.agentId), {
      chainId: ref.chainId,
      agentId: ref.agentId,
      owner,
      fundingAddress: await this.fundingAddress(ref),
    });
  }

  /** The owner approves a waiting intent; the first approval after the grant arms the agent. */
  async approveIntent(ref: AgentRef, intentId: string) {
    const r = await approveByOwner(this.trades, ref.chainId, ref.agentId, intentId);
    if (r.ok && r.armed) this.o.log(`agent ${ref.agentId}: armed by the owner's first approval`);
    return r;
  }

  /** The owner disarms the agent; its wallet then revokes the grant on chain. */
  async disarm(ref: AgentRef) {
    return disarm(this.trades, ref.chainId, ref.agentId);
  }

  /** Why the agent did not trade: its arming and its recent blocked trades. */
  async whyNotTraded(ref: AgentRef) {
    return this.trades.whyNotTraded(ref.chainId, ref.agentId);
  }

  /** The agent's owner and ownership epoch, read from the chain. */
  async ownership(agentId: number) {
    const chain = this.o.credits?.refundChain;
    if (!chain) throw new Error("refunds are not configured");
    return chain.ownership(agentId);
  }

  /**
   * Queues a Scan (D-216): from the dev console at once, or from the scheduler.
   * Refused without enough credits or while one is already open.
   */
  async enqueueScan(ref: AgentRef, requestedBy: TaskRequester = "console"): Promise<string> {
    const runtime = await this.o.store.runtime(ref);
    if (runtime?.status !== "ready") throw new Error(`agent ${ref.agentId} is not provisioned`);
    if (!this.credits) throw new Error("credits are not configured");
    if ((await this.credits.creditsOf(ref.agentId)).spendable < SCAN_MIN_CREDITS_USDC_E6)
      throw new CreditsExhaustedError(ref.agentId);
    if (await this.openScan(ref)) throw new OpenScanExistsError(ref.agentId);
    const taskId = randomUUID();
    await this.o.store.insertTask(taskId, ref, "scan", requestedBy);
    await this.queue.add({ kind: "scan", ref, taskId });
    return taskId;
  }

  /**
   * Puts every queued Scan task on the queue (D-219): the control API records
   * an owner's Scan in Postgres only. Job IDs are the task IDs, so a task
   * already on the queue is not added twice, and a task a worker has started
   * is no longer queued.
   */
  async queueRequestedScans(): Promise<number> {
    const queued = await this.o.store.queuedScans(this.o.chainId);
    for (const task of queued)
      await this.queue.add({ kind: "scan", ref: task, taskId: task.taskId });
    return queued.length;
  }

  private async openScan(ref: AgentRef): Promise<boolean> {
    const open = await this.o.store.db
      .selectFrom("platform.agent_tasks")
      .select("task_id")
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .where("kind", "=", "scan")
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    return open !== undefined;
  }

  /** One scheduler pass: queues a Scan for every provisioned agent that is due (D-216). */
  async scheduleScans(now = new Date()): Promise<number[]> {
    if (!this.credits) return [];
    const queued: number[] = [];
    const db = this.o.store.db;
    for (const r of await this.o.store.runtimes(this.o.chainId)) {
      if (r.status !== "ready") continue;
      const last = await db
        .selectFrom("platform.agent_tasks")
        .select((eb) => eb.fn.max("created_at").as("at"))
        .where("chain_id", "=", r.chainId)
        .where("agent_id", "=", r.agentId)
        .where("kind", "=", "scan")
        .executeTakeFirst();
      const firstCredit = await db
        .selectFrom("platform.ledger_entries")
        .select((eb) => eb.fn.min("created_at").as("at"))
        .where("chain_id", "=", r.chainId)
        .where("agent_id", "=", r.agentId)
        .where("kind", "in", ["credits_received", "deposit_held"])
        .executeTakeFirst();
      const due = scanDue({
        now,
        intervalMs: this.o.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
        spendable: (await this.credits.creditsOf(r.agentId)).spendable,
        openScan: await this.openScan(r),
        lastScanAt: last?.at ? new Date(last.at) : null,
        firstCreditAt: firstCredit?.at ? new Date(firstCredit.at) : null,
      });
      if (!due) continue;
      await this.enqueueScan(r, "schedule");
      queued.push(r.agentId);
      this.o.log(`agent ${r.agentId}: scheduled a Scan`);
    }
    return queued;
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
