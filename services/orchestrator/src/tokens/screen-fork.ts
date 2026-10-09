import type { Hex } from "viem";
import { ForkSimulator } from "./simulate.ts";

/**
 * The screen's fork (F-U1): one anvil fork of Monad mainnet at the latest
 * block, on a port of its own and never the playtest fork's. It starts on the
 * first screen, is restarted at a newer block once it is older than
 * `maxAgeMs`, and runs one screen at a time: each screen takes a snapshot and
 * reverts to it afterwards, so no screen sees another's trades.
 */
/** The orchestrator's screen fork: never 8545 (the playtest fork) nor a test port (8546 to 8578). */
export const SCREEN_FORK_PORT = 8579;

export interface StartedFork {
  readonly url: string;
  readonly block: number;
  stop(): Promise<void>;
}

export interface ScreenForkOptions {
  readonly start: () => Promise<StartedFork>;
  /** A fork older than this is replaced by a fork of the latest block. */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

export class ScreenFork {
  private readonly o: ScreenForkOptions;
  private fork: { started: StartedFork; at: number; sim: ForkSimulator } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: ScreenForkOptions) {
    this.o = o;
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private async current() {
    const maxAge = this.o.maxAgeMs ?? 15 * 60_000;
    if (this.fork && this.now() - this.fork.at < maxAge) return this.fork;
    if (this.fork) await this.fork.started.stop().catch(() => undefined);
    this.fork = null;
    const started = await this.o.start();
    this.fork = { started, at: this.now(), sim: new ForkSimulator(started.url) };
    return this.fork;
  }

  /** Runs `fn` on the fork, one caller at a time, and reverts whatever it did. */
  run<T>(fn: (sim: ForkSimulator, block: bigint) => Promise<T>): Promise<T> {
    const job = this.queue.then(async () => {
      const f = await this.current();
      const snap: Hex = await f.sim.snapshot();
      try {
        return await fn(f.sim, (await f.sim.block()).number);
      } finally {
        await f.sim.revert(snap).catch(async () => {
          // A fork that cannot revert is not trusted again.
          await f.started.stop().catch(() => undefined);
          this.fork = null;
        });
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async stop(): Promise<void> {
    await this.queue.catch(() => undefined);
    if (this.fork) await this.fork.started.stop().catch(() => undefined);
    this.fork = null;
  }
}
