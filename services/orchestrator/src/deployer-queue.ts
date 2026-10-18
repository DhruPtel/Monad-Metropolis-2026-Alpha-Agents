/**
 * 2026-10-18: the testnet deployer's sends, one at a time. The gas top-ups and
 * the pool recycler share the deployer's key, so two sends at once would take
 * the same nonce; and Monad reverts a transaction that moves an account's MON
 * a few blocks after that account's previous one (L-270), so each send starts
 * at least `spacingMs` after the last one ended.
 */
export class DeployerQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private lastEnded = 0;
  private readonly spacingMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    o: {
      spacingMs?: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    } = {},
  ) {
    this.spacingMs = o.spacingMs ?? 8_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  /** Runs `fn` after every send queued before it, and at least the spacing after the last one. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const wait = this.lastEnded + this.spacingMs - this.now();
      if (this.lastEnded > 0 && wait > 0) await this.sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastEnded = this.now();
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
