import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import type { Log, Redactor } from "./secrets.ts";
import { errorText } from "./secrets.ts";
import type { AgentRef } from "./store.ts";

/**
 * The orchestrator's Redis job queue (D-202). Job IDs are deterministic, so a
 * job added again while it is still waiting or running is ignored by BullMQ;
 * the handlers are idempotent as well, so a job added again after it finished
 * changes nothing. Postgres stays the source of truth: Redis only carries work.
 */
export type JobData =
  | { readonly kind: "provision"; readonly ref: AgentRef }
  | { readonly kind: "deprovision"; readonly ref: AgentRef; readonly reason: string }
  | { readonly kind: "reset"; readonly ref: AgentRef }
  | { readonly kind: "noop"; readonly ref: AgentRef; readonly taskId: string };

export type JobHandler = (data: JobData) => Promise<unknown>;

/** BullMQ refuses ':' in custom IDs; these use '-'. */
export function jobId(data: JobData): string {
  const agent = `${data.ref.chainId}-${data.ref.agentId}`;
  return data.kind === "noop" ? `noop-${data.taskId}` : `${data.kind}-${agent}`;
}

/** Redis connection options from a redis:// URL, without the URL itself ever being logged. */
export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export interface QueueOptions {
  readonly redisUrl: string;
  /** The sweep namespace; each gets its own queue, so tests never share one with dev. */
  readonly namespace: string;
  readonly log: Log;
  readonly redactor: Redactor;
  readonly concurrency?: number;
}

export class OrchestratorQueue {
  readonly name: string;
  private readonly queue: Queue<JobData>;
  private worker: Worker<JobData> | undefined;
  private readonly o: QueueOptions;

  constructor(options: QueueOptions) {
    this.o = options;
    this.name = `orchestrator-${options.namespace}`;
    this.queue = new Queue<JobData>(this.name, {
      connection: redisConnection(options.redisUrl),
      prefix: "aa",
    });
  }

  /** Adds a job unless one with the same ID is already waiting or running. */
  async add(data: JobData): Promise<{ id: string; added: boolean }> {
    const id = jobId(data);
    const existing = await this.queue.getJob(id);
    const state = existing ? await existing.getState() : null;
    if (existing && state !== "completed" && state !== "failed") return { id, added: false };
    if (existing) await existing.remove().catch(() => undefined);
    await this.queue.add(data.kind, data, {
      jobId: id,
      removeOnComplete: true,
      removeOnFail: true,
      // Provisioning retries a few times; a task runs once and records its own failure.
      attempts: data.kind === "noop" ? 1 : 3,
      backoff: { type: "exponential", delay: 2_000 },
    });
    return { id, added: true };
  }

  /** Jobs waiting, delayed or running. */
  async pending(): Promise<number> {
    const counts = await this.queue.getJobCounts("waiting", "active", "delayed", "prioritized");
    return Object.values(counts).reduce((a, b) => a + b, 0);
  }

  start(handler: JobHandler): void {
    if (this.worker) return;
    this.worker = new Worker<JobData>(this.name, async (job: Job<JobData>) => handler(job.data), {
      connection: redisConnection(this.o.redisUrl),
      prefix: "aa",
      concurrency: this.o.concurrency ?? 4,
      // A job whose worker died is retried once BullMQ sees it stalled.
      stalledInterval: 15_000,
    });
    this.worker.on("failed", (job, err) => {
      this.o.log(`job ${job?.id ?? "?"} failed: ${errorText(err, this.o.redactor)}`);
    });
    this.worker.on("error", (err) => {
      this.o.log(`queue worker error: ${errorText(err, this.o.redactor)}`);
    });
  }

  /** Waits until no job is waiting or running (tests). */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((await this.pending()) > 0) {
      if (Date.now() > deadline) throw new Error(`queue ${this.name} did not drain`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Removes every job of this queue (tests and a namespace's teardown). */
  async obliterate(): Promise<void> {
    await this.queue.obliterate({ force: true });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
