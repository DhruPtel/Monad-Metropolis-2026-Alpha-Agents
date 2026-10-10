import type { MarketData, ResearchSources } from "@alpha-agents/market";
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
import { runResearchCheckTask } from "./research-check.ts";
import { HERMES_TEMPLATE, type SandboxProvider } from "./sandbox.ts";
import { type Log, type Redactor, errorText, randomToken } from "./secrets.ts";
import { type AgentRef, OpenScanExistsError, type Store, type TaskRequester } from "./store.ts";
import { startupSweep, type SweepReport } from "./sweep.ts";
import { type ChainToolsWiring, type ToolServers, startToolServers } from "./tools/servers.ts";
import { type Tunnel, startTunnel, tunnelPidFile } from "./tunnel.ts";
import {
  DecisionStore,
  GoalStore,
  PlanStore,
  SnapshotStore,
  TradeStore,
  approveByOwner,
  confirmArming,
  disarm,
} from "@alpha-agents/trading";
import { SnapshotRecorder } from "./snapshots.ts";
import {
  assessTradeV3,
  floorForV3,
  parseTokenAmountV3,
  resolveToken,
  routeTokensOf,
} from "@alpha-agents/chain-tools";
import {
  type CustodyPath,
  INTENT_SCHEMA_VERSION_V3,
  ROUTE_ADAPTER_ID,
  executorV3SwapGasLimit,
} from "@alpha-agents/domain";
import type { SwapIntentV3Args } from "@alpha-agents/signer";
import type { TargetPortfolioParams } from "@alpha-agents/policy";
import { type Hex, isAddressEqual, keccak256, toBytes } from "viem";
import {
  type TestFindingV2,
  type TestInputsV2,
  checkPortfolioProposal,
} from "./cycle/test-stage.ts";
import {
  TradeFlow,
  type TradeFlowGas,
  type TradeFlowSigner,
  minAmountOutFor,
} from "./trade-flow.ts";
import { RUNNER_EVERY_MS, TemplateRunner } from "./runner.ts";
import { runCycleTask } from "./cycle/cycle.ts";
import { CycleResearch } from "./cycle/research.ts";
import { type CycleKind, isReasoningAlias } from "./cycle/stages.ts";
import { CycleStore } from "./cycle/store.ts";
import { skillRuns } from "./cycle/validator.ts";
import { builtinSet } from "./hermes/materialize.ts";
import { PgIntentStore } from "./tools/chain-store.ts";
import type { TokenRegistry } from "./tokens/registry.ts";
import { registryToolSource } from "./tokens/tool-source.ts";
import { runTokenCheckTask } from "./token-check.ts";

/** F-U1: discovery every 30 minutes; screens of due tokens every 10 minutes, two at a time. */
export const TOKEN_DISCOVERY_EVERY_MS = 30 * 60_000;
export const TOKEN_SCREEN_EVERY_MS = 10 * 60_000;

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

/** A cycle was asked for while one is already queued or running for the agent (P3-U4). */
export class CycleOpenError extends Error {
  constructor(agentId: number) {
    super(`Agent ${agentId} already has a research cycle queued or running.`);
    this.name = "CycleOpenError";
  }
}

/** A cycle needs the owner's goal: its reasoning model, intensity and daily budget (P3-U1). */
export class NoGoalError extends Error {
  constructor(agentId: number) {
    super(`Agent ${agentId} has no goal: its owner sets one on the Goal page first.`);
    this.name = "NoGoalError";
  }
}

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
  /** P3-U2: the platform's market data, one per process, shared by every agent's tools. */
  readonly market?: MarketData | null;
  /** P3-U9: the research sources on the same cache, shared by every agent's tools. */
  readonly research?: ResearchSources | null;
  /** Minutes between scheduled Scans, as milliseconds (SCAN_INTERVAL_MINUTES, D-216). */
  readonly scanIntervalMs?: number;
  /** How often the scheduler looks for due Scans; 0 turns scheduling off (tests). */
  readonly scheduleMs?: number;
  /** D-221: steered reveals, on the local fork only; null elsewhere. */
  readonly revealSteering?: RevealSteering | null;
  /** P2-U5: the chain tools' reader and the signer's session keys; none runs every chain tool as "not deployed". */
  readonly chain?: Omit<ChainToolsWiring, "onProposed">;
  /**
   * P2-EC: the reader value snapshots use, when it must differ from the chain
   * tools' (testnet's tools reader re-dates the feeds before a market read,
   * D-307; a snapshot is not an action and never does). Defaults to that reader.
   */
  readonly snapshotReader?: ChainToolsWiring["reader"];
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
  /**
   * P3-U3: the template runner's market input. With trading and a chain reader
   * the runner turns each agent's plan into legs every minute; without it, or
   * without trading, plans are stored and nothing trades.
   */
  readonly runner?: {
    /** MON's annualized 24-hour realized volatility in percent, null when unreadable. */
    readonly volatility24hPct: () => Promise<number | null>;
    readonly everyMs?: number;
  } | null;
  /**
   * F-U1: the token registry. Discovery runs every `discoverEveryMs` and
   * screens of tokens whose screen is missing or expired every
   * `screenEveryMs` (`screensPerTick` at a time); 0 turns a loop off.
   */
  readonly tokens?: {
    readonly registry: TokenRegistry;
    readonly discoverEveryMs?: number;
    readonly screenEveryMs?: number;
    readonly screensPerTick?: number;
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
  /** P3-U3: the plans, the runner's decisions, and the runner itself where trading runs. */
  readonly plans: PlanStore;
  readonly decisions: DecisionStore;
  readonly goals: GoalStore;
  readonly runner: TemplateRunner | null;
  /** P3-U4: research cycles, their stages, briefs and the research behind the platform tools. */
  readonly cycles: CycleStore;
  readonly research: CycleResearch;
  /** Phase 2 tuning: value snapshots for W-3's charts, where the chain tools can read. */
  readonly snapshots: SnapshotRecorder | null;
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
    this.cycles = new CycleStore(store.db);
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
          cycles: this.cycles,
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
    const snapshotReader = options.snapshotReader ?? reader;
    this.snapshots = snapshotReader
      ? new SnapshotRecorder({
          chainId: options.chainId,
          store,
          snapshots: new SnapshotStore(store.db, options.credits?.environment ?? "local"),
          reader: snapshotReader,
          readerV3: options.chain?.readerV3 ?? null,
          log,
        })
      : null;
    const recorder = this.snapshots;
    this.tradeFlow =
      reader && options.trading
        ? new TradeFlow({
            chainId: options.chainId,
            store: this.trades,
            reader,
            readerV3: options.chain?.readerV3 ?? null,
            signer: options.trading.signer,
            gas: options.trading.gas,
            finalizedBlock: options.trading.finalizedBlock,
            narrator: this.narrator,
            ...(recorder
              ? { onSettled: (i) => recorder.observe(i.agentId, "trade", i.intentId) }
              : {}),
            log,
          })
        : null;
    this.plans = new PlanStore(store.db);
    this.decisions = new DecisionStore(store.db);
    this.goals = new GoalStore(store.db);
    let runs: Set<string> | null = null;
    this.research = new CycleResearch({
      cycles: this.cycles,
      goals: this.goals,
      plans: this.plans,
      // Every mounted skill's and playbook's text, once per process (the brief validator's skill check).
      skillRuns: () =>
        (runs ??= skillRuns(
          builtinSet().packages.flatMap((p) =>
            p.files.filter((f) => /\.md$/.test(f.path)).map((f) => f.bytes.toString("utf8")),
          ),
        )),
      // F-U6: the Test stage v2 over a target portfolio, on the fund agent's set.
      portfolio: { inputs: (cycle) => this.portfolioTestInputs(cycle) },
    });
    const trading = options.trading;
    this.runner =
      reader && trading && options.runner
        ? new TemplateRunner({
            chainId: options.chainId,
            reader,
            plans: this.plans,
            decisions: this.decisions,
            goals: this.goals,
            trades: this.trades,
            intents: new PgIntentStore(store),
            sessionKeyOf: (agentId) => trading.signer.createKey(agentId),
            volatility24hPct: options.runner.volatility24hPct,
            // F-U6: a target portfolio runs on the fund agent's set, with the platform's screens.
            readerV3: options.chain?.readerV3 ?? null,
            screenFresh: (token) => this.screenFresh(token),
            volatilityOf: null,
            gas: trading.gas,
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
    const interrupted = await this.cycles.failInterrupted();
    if (interrupted > 0)
      this.o.log(`${interrupted} research stage(s) cut off by a restart ended as INTERRUPTED`);
    if (this.credits && this.o.credits)
      this.tools = await startToolServers({
        store: this.o.store,
        ledger: this.ledger,
        credits: this.credits,
        environment: this.o.credits.environment,
        provider: this.o.web ?? null,
        market: this.o.market ?? null,
        research: this.o.research ?? null,
        tokens: this.o.tokens ? registryToolSource(this.o.tokens.registry) : null,
        cycles: { store: this.cycles, research: this.research },
        chain: {
          reader: this.o.chain?.reader ?? null,
          readerV3: this.o.chain?.readerV3 ?? null,
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
      resolve: gateResolver(this.o.store, this.provisioner, this.credits, this.cycles),
      // P3-U4: every forwarded model call's usage, with the stage it ran under.
      onModelCall: async (e) => {
        if (!e.usage) return;
        await this.cycles.recordModelCall({
          ref: e.lease,
          leaseId: e.lease.leaseId,
          stageRunId: e.stageRunId ?? null,
          model: e.model ?? "unknown",
          status: e.status,
          usage: e.usage,
        });
      },
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
    if (this.snapshots) {
      const recorder = this.snapshots;
      this.every(60_000, "value snapshots", async () => {
        await recorder.tick();
      });
    }
    if (this.tradeFlow) {
      const flow = this.tradeFlow;
      this.every(this.o.trading?.everyMs ?? 2_000, "trade flow", () => flow.tick());
    }
    if (this.runner) {
      const runner = this.runner;
      this.every(this.o.runner?.everyMs ?? RUNNER_EVERY_MS, "template runner", async () => {
        await runner.tick();
      });
    }
    if (this.o.localFeeds) {
      const feeds = this.o.localFeeds;
      this.every(feeds.everyMs, "local feeds", () => feeds.refresh());
    }
    const tokens = this.o.tokens;
    if (tokens?.registry.configured.discovery && tokens.discoverEveryMs !== 0) {
      this.every(
        tokens.discoverEveryMs ?? TOKEN_DISCOVERY_EVERY_MS,
        "token discovery",
        async () => {
          const d = await tokens.registry.discover();
          this.o.log(
            `token discovery: ${d.tokens} tokens (${d.classF} class F, ${d.classA} class A), ${d.pools} pools, ${d.newPools} new`,
          );
        },
      );
    }
    if (tokens?.registry.configured.screen && tokens.screenEveryMs !== 0) {
      this.every(tokens.screenEveryMs ?? TOKEN_SCREEN_EVERY_MS, "token screens", async () => {
        const done = await tokens.registry.screenDue(tokens.screensPerTick ?? 2);
        if (done.length > 0)
          this.o.log(
            `token screens: ${done.map((s) => `${s.address.slice(0, 10)} ${s.verdict}`).join(", ")}`,
          );
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
        return runNoopTask(this.taskContext(), job.taskId);
      case "scan":
        return runScanTask({ ...this.taskContext(), narrator: this.narrator }, job.taskId);
      case "chain_check":
        return runChainCheckTask(this.taskContext(), job.taskId);
      case "research_check":
        return runResearchCheckTask(this.taskContext(), job.taskId);
      case "token_check":
        return runTokenCheckTask(this.taskContext(), job.taskId);
      case "cycle": {
        if (!this.credits) throw new Error("credits are not configured");
        return runCycleTask(
          {
            ...this.taskContext(),
            cycles: this.cycles,
            research: this.research,
            goals: this.goals,
            plans: this.plans,
            credits: this.credits,
            narrator: this.narrator,
          },
          job.taskId,
        );
      }
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

  /**
   * The dev console's research check (P3-U9): the agent uses each research
   * source once. An LLM task with paid tools, so it needs credits.
   */
  async enqueueResearchCheck(
    ref: AgentRef,
    kind: "research_check" | "token_check" = "research_check",
  ): Promise<string> {
    const runtime = await this.o.store.runtime(ref);
    if (runtime?.status !== "ready") throw new Error(`agent ${ref.agentId} is not provisioned`);
    if (!this.tools) throw new Error("the tool servers are not running");
    if (this.credits && (await this.credits.creditsOf(ref.agentId)).restricted)
      throw new CreditsExhaustedError(ref.agentId);
    const taskId = randomUUID();
    await this.o.store.insertTask(taskId, ref, kind, "console");
    await this.queue.add({ kind, ref, taskId });
    return taskId;
  }

  /**
   * A research cycle (P3-U4) from the dev console: ROUTINE (Scan, Dives the
   * Scan earns, Challenge, Test, Zoom out) or ACTIVATION-shaped (the wide Scan,
   * two Dives, Challenge, Test, Zoom out with an overview). It needs the
   * owner's goal and credits; one cycle per agent at a time.
   */
  async enqueueCycle(ref: AgentRef, kind: CycleKind, requestedBy: TaskRequester = "console") {
    const runtime = await this.o.store.runtime(ref);
    if (runtime?.status !== "ready") throw new Error(`agent ${ref.agentId} is not provisioned`);
    if (!this.tools || !this.credits) throw new Error("the tool servers are not running");
    if ((await this.credits.creditsOf(ref.agentId)).restricted)
      throw new CreditsExhaustedError(ref.agentId);
    const goal = await this.goals.currentGoal(ref.chainId, ref.agentId);
    if (!goal) throw new NoGoalError(ref.agentId);
    if (await this.cycles.openCycle(ref)) throw new CycleOpenError(ref.agentId);
    const alias = goal.config.model.alias;
    if (!isReasoningAlias(alias))
      throw new Error(`the goal's model ${alias} is not a reasoning model`);
    await this.provisioner.allowCycleModels(runtime);
    const taskId = randomUUID();
    await this.o.store.insertTask(taskId, ref, "cycle", requestedBy);
    const cycle = await this.cycles.createCycle({ ref, taskId, kind, reasoningAlias: alias });
    await this.queue.add({ kind: "cycle", ref, taskId });
    return { taskId, cycleId: cycle.cycleId };
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

  /** F-U6 (D-339): whether the token has a passing screen that is still fresh; null when no registry runs here. */
  async screenFresh(token: Hex): Promise<boolean | null> {
    const registry = this.o.tokens?.registry;
    if (!registry) return null;
    const r = await registry.freshScreen(token).catch(() => null);
    return r !== null && r.verdict === "passed";
  }

  /**
   * F-U6: the Test stage v2's inputs for the agent: the fund agent's market and
   * the account now, the goal's aggressiveness (from its risk preset until
   * F-U7, A-74), the platform's screens, quotes along the best route for
   * depth, and the cooldown. Null off the v3 set or without a goal.
   */
  async portfolioTestInputs(ref: {
    readonly chainId: number;
    readonly agentId: number;
  }): Promise<TestInputsV2 | null> {
    const v3 = this.o.chain?.readerV3;
    if (!v3) return null;
    const goal = await this.goals.currentGoal(ref.chainId, ref.agentId);
    if (!goal) return null;
    const [market, agent] = await Promise.all([v3.market(), v3.agent(ref.agentId)]);
    if (!agent?.account) return null;
    const history = await this.plans.history(ref.chainId, ref.agentId, 20);
    const last = history.find((p) => p.setBy === "agent");
    return {
      aggressiveness: goal.config.aggressiveness,
      market,
      agent,
      screenFresh: (token) => this.screenFresh(token),
      quoteBuy: async (token, usdcE6) => {
        const q = await v3
          .bestRoute(market.usdc, token, usdcE6, {
            optedIn: agent.screenedOptIn,
            intoUsdc: false,
            sellsScreened: false,
          })
          .catch(() => null);
        return q?.amountOut ?? null;
      },
      lastAgentChangeAt: last?.createdAt ?? null,
      now: new Date(),
    };
  }

  /** F-U6: a target portfolio draft through the Test stage v2; refused off the fund agent's set. */
  async checkPortfolioPlan(
    ref: { readonly chainId: number; readonly agentId: number },
    params: TargetPortfolioParams,
  ): Promise<
    | { ok: true; findings: TestFindingV2[] }
    | { ok: false; error: "not_on_v3" | "no_goal"; message: string }
  > {
    if (!(await this.goals.currentGoal(ref.chainId, ref.agentId)))
      return { ok: false, error: "no_goal", message: "The agent has no goal yet." };
    const inputs = await this.portfolioTestInputs(ref);
    if (!inputs)
      return {
        ok: false,
        error: "not_on_v3",
        message:
          "A target portfolio needs the fund agent's set: the agent has no PersonalAccountV3 here, or the set is not deployed.",
      };
    return { ok: true, findings: await checkPortfolioProposal(params, inputs) };
  }

  /** F-U6: what the console's portfolio form offers: the registered tokens, when the agent is on the v3 set. */
  async portfolioPlanView(ref: { readonly chainId: number; readonly agentId: number }): Promise<{
    custody: CustodyPath;
    tokens: {
      token: Hex;
      symbol: string;
      decimals: number;
      class: string;
      lane: string;
      status: string;
      capBps: number;
    }[];
  } | null> {
    const v3 = this.o.chain?.readerV3;
    const custody = await this.custodyPath(ref.agentId);
    if (!v3 || custody !== "v3") return null;
    const m = await v3.market();
    return {
      custody,
      tokens: m.tokens.map((t) => ({
        token: t.token,
        symbol: t.symbol,
        decimals: t.decimals,
        class: t.priceClass,
        lane: t.lane,
        status: t.status,
        capBps: t.maxPositionBps,
      })),
    };
  }

  /** Which custody set serves the agent (D-367): v3 where the set is deployed and the agent is on it. */
  async custodyPath(agentId: number): Promise<CustodyPath> {
    const v3 = this.o.chain?.readerV3;
    if (!v3) return "v2";
    const path = await v3.custodyPath(agentId);
    return path ?? (this.o.chain?.reader ? "v2" : "v3");
  }

  /** The Executor the agent's grants target on its custody set, or null where none is deployed. */
  async executorFor(agentId: number): Promise<{ custody: CustodyPath; executor: Hex | null }> {
    const custody = await this.custodyPath(agentId);
    const v3 = this.o.chain?.readerV3;
    if (custody === "v3" && v3) return { custody, executor: v3.executorAddress };
    // The v2 Executor is the environment's one and only; its armings record no address.
    return { custody: "v2", executor: null };
  }

  /** Records the owner's grant once it is on chain (the console's arm, after its wallet call). */
  async confirmArming(ref: AgentRef, owner: Hex) {
    const { custody, executor } = await this.executorFor(ref.agentId);
    const v3 = this.o.chain?.readerV3;
    const reader = custody === "v3" && v3 ? v3 : this.o.chain?.reader;
    if (!reader) throw new Error("the trading contracts are not deployed here");
    return confirmArming(this.trades, await reader.agent(ref.agentId), {
      chainId: ref.chainId,
      agentId: ref.agentId,
      owner,
      fundingAddress: await this.fundingAddress(ref),
      custody,
      executor,
    });
  }

  /** The agent's owner as the chain says now, or null where trading is not deployed. */
  async chainOwner(agentId: number): Promise<Hex | null> {
    const v3 = this.o.chain?.readerV3;
    const from = this.o.chain?.reader ?? v3;
    return (await from?.agent(agentId))?.owner ?? null;
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

  /**
   * Local only (the console): records a proposal of half the account's USDC,
   * over the 10% trade size, as an agent ignoring its limits would. It waits
   * while unarmed; armed, the trade flow approves it and the re-check at
   * submission blocks it with its reasons.
   */
  async proposeOverLimitForTest(ref: AgentRef): Promise<string> {
    const a = await this.o.chain?.reader?.agent(ref.agentId);
    if (!a?.account) throw new Error("The agent has no trading account on this chain.");
    if (a.usdc < 2n) throw new Error("The agent's account holds no USDC to propose with.");
    const intentId = `intent-${randomUUID()}`;
    await this.o.store.db
      .insertInto("platform.intents")
      .values({
        intent_id: intentId,
        chain_id: ref.chainId,
        agent_id: ref.agentId,
        lease_id: "console-over-limit",
        kind: "swap",
        account: a.account.toLowerCase(),
        sell: "USDC",
        buy: "WMON",
        amount_in: (a.usdc / 2n).toString(),
        reason: "Dev console: a proposal over the trade size limit.",
        idempotency_key: intentId,
        status: "awaiting_approval",
        reason_codes: "[]",
        checks: "{}",
        owner_epoch: a.ownerEpoch.toString(),
        config_epoch: a.configEpoch.toString(),
        expires_at: new Date(Date.now() + 30 * 60_000),
      })
      .execute();
    return intentId;
  }

  /**
   * Local only (the console): a test swap on the fund agent's set for any
   * registered pair, through the signer and Executor v3 along the best route
   * now, with the gas rule's limit (F-U5). The Executor decides; the outbox
   * shows its answer and, once reconciled, every balance change.
   */
  async testSwapV3(ref: AgentRef, sellRef: string, buyRef: string, amountText: string) {
    const v3 = this.o.chain?.readerV3;
    const trading = this.o.trading;
    if (!v3) throw new RangeError("The fund agent's set is not deployed on this chain.");
    if (!trading) throw new RangeError("The signer is not running.");
    const m = await v3.market();
    let sell;
    let buy;
    let amountIn: bigint;
    try {
      sell = resolveToken(m, sellRef);
      buy = resolveToken(m, buyRef);
      amountIn = parseTokenAmountV3(amountText, sell);
    } catch (err) {
      throw new RangeError(err instanceof Error ? err.message : String(err), { cause: err });
    }
    if (amountIn === 0n) throw new RangeError("The amount must be above zero.");
    const key = await trading.signer.createKey(ref.agentId);
    const assessed = await assessTradeV3(v3, ref.agentId, sell.token, buy.token, amountIn, key, 0);
    if (!assessed) throw new RangeError("The agent has no fund account on this chain.");
    const { a, quote } = assessed;
    if (!quote)
      throw new RangeError(
        `No registered route could be quoted from ${sell.symbol} to ${buy.symbol}.`,
      );
    const hops = quote.route.length;
    const heldAfter =
      a.holdings.filter((h) => h.balance > 0n).length +
      (a.holdings.some((h) => isAddressEqual(h.token, buy.token) && h.balance > 0n) ? 0 : 1);
    const gas = executorV3SwapGasLimit(hops, Math.min(Math.max(heldAfter, 1), 16));
    const classA = sell.priceClass === "A" || buy.priceClass === "A";
    const floor = floorForV3(m, sell, buy, amountIn);
    const minAmountOut = minAmountOutFor(
      quote.amountOut,
      floor,
      classA ? m.policy.maxSlippageClassABps : m.policy.maxSlippageBps,
    );
    const swap: SwapIntentV3Args = {
      schemaVersion: INTENT_SCHEMA_VERSION_V3,
      chainId: BigInt(ref.chainId),
      agentId: BigInt(ref.agentId),
      account: a.account,
      actionId: keccak256(toBytes(`alpha-agents:test-swap-v3:${ref.chainId}:${randomUUID()}`)),
      ownerEpoch: a.ownerEpoch,
      configEpoch: a.configEpoch,
      policyHash: m.policyHash,
      adapterId: ROUTE_ADAPTER_ID,
      tokenIn: sell.token,
      tokenOut: buy.token,
      amountIn,
      minAmountOut,
      deadline: m.timestamp + BigInt(m.policy.deadlineSeconds),
      route: quote.route.map((p) => p.poolId),
      attestationIn: "0x",
      attestationOut: "0x",
    };
    const accepted = await trading.signer.submitSwapV3(
      ref.agentId,
      swap,
      gas,
      routeTokensOf(quote, sell.token),
    );
    return {
      ...accepted,
      sell: sell.symbol,
      buy: buy.symbol,
      hops,
      route: swap.route,
      gas: gas.toString(),
      expectedOut: quote.amountOut.toString(),
      minAmountOut: minAmountOut.toString(),
      blockers: assessed.blockers.map((b) => b.code),
    };
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
    await this.o.tokens?.registry.stop();
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
