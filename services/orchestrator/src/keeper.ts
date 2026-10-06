import { type Log, type Redactor, errorText } from "./secrets.ts";

/**
 * The reveal keeper (D-201, resolving D-191). AgentNFT reveals in batches: one
 * Entropy request covers every agent minted so far, and its 1.4 MON fee is paid
 * per request (D-187), so the keeper waits a short batch window after it first
 * sees an unrevealed agent before requesting, letting every mint in the window
 * share one fee. When the number has arrived it applies the reveal in chunks.
 *
 * On the local fork Pyth's keeper never delivers, so `deliver` impersonates
 * Entropy (as P1-U11's dev path did). Elsewhere the keeper waits, and requests
 * again only after AgentNFT's REVEAL_TIMEOUT, which the contract allows.
 */
export interface PendingReveal {
  readonly sequence: bigint;
  /** Chain time of the request, seconds. */
  readonly requestedAt: number;
  readonly batchLast: number;
  readonly seedReady: boolean;
}

export interface RevealState {
  readonly totalMinted: number;
  readonly nextToReveal: number;
  readonly pending: PendingReveal;
  /** Chain time of the latest block, seconds. */
  readonly chainTime: number;
}

export interface RevealChain {
  state(): Promise<RevealState>;
  requestReveal(): Promise<string>;
  reveal(maxCount: number): Promise<string>;
  /** Local fork only: delivers a random number as Entropy would. */
  deliver?(sequence: bigint): Promise<string>;
}

export interface KeeperPolicy {
  /** How long the first unrevealed agent waits before a request, so mints share a fee. */
  readonly batchWindowMs: number;
  /** Agents revealed per transaction. */
  readonly chunk: number;
  /** AgentNFT.REVEAL_TIMEOUT: after it, a request with no number may be replaced. */
  readonly revealTimeoutSeconds: number;
}

/** Local fork: 10 seconds. Testnet and beta: 60 seconds (D-201). */
export const KEEPER_POLICY = {
  local: { batchWindowMs: 10_000, chunk: 50, revealTimeoutSeconds: 3_600 },
  remote: { batchWindowMs: 60_000, chunk: 50, revealTimeoutSeconds: 3_600 },
} as const satisfies Record<string, KeeperPolicy>;

export type KeeperAction =
  | { readonly kind: "idle" }
  | { readonly kind: "waiting"; readonly unrevealed: number; readonly msLeft: number }
  | {
      readonly kind: "requested";
      readonly first: number;
      readonly last: number;
      readonly tx: string;
    }
  | { readonly kind: "awaiting-number"; readonly sequence: bigint }
  | { readonly kind: "delivered"; readonly sequence: bigint; readonly tx: string }
  | { readonly kind: "re-requested"; readonly sequence: bigint; readonly tx: string }
  | { readonly kind: "revealed"; readonly upTo: number; readonly tx: string }
  | { readonly kind: "error"; readonly message: string };

export class RevealKeeper {
  private readonly chain: RevealChain;
  private readonly policy: KeeperPolicy;
  private readonly log: Log;
  private readonly redactor: Redactor;
  private readonly clock: () => number;
  private waitingSince: number | null = null;
  private busy = false;
  readonly actions: KeeperAction[] = [];

  constructor(o: {
    chain: RevealChain;
    policy: KeeperPolicy;
    log: Log;
    redactor: Redactor;
    clock?: () => number;
  }) {
    this.chain = o.chain;
    this.policy = o.policy;
    this.log = o.log;
    this.redactor = o.redactor;
    this.clock = o.clock ?? Date.now;
  }

  /** One step. Never throws; a failed step is logged and retried on the next tick. */
  async tick(): Promise<KeeperAction> {
    if (this.busy) return { kind: "idle" };
    this.busy = true;
    try {
      const action = await this.step();
      if (action.kind !== "idle" && action.kind !== "waiting" && action.kind !== "awaiting-number")
        this.log(describe(action));
      this.record(action);
      return action;
    } catch (err) {
      const action: KeeperAction = { kind: "error", message: errorText(err, this.redactor) };
      this.log(describe(action));
      this.record(action);
      return action;
    } finally {
      this.busy = false;
    }
  }

  private record(action: KeeperAction): void {
    this.actions.push(action);
    if (this.actions.length > 200) this.actions.splice(0, this.actions.length - 200);
  }

  private async step(): Promise<KeeperAction> {
    const s = await this.chain.state();
    const { pending } = s;
    if (pending.sequence === 0n) {
      const unrevealed = s.totalMinted - s.nextToReveal + 1;
      if (unrevealed <= 0) {
        this.waitingSince = null;
        return { kind: "idle" };
      }
      const now = this.clock();
      this.waitingSince ??= now;
      const msLeft = this.waitingSince + this.policy.batchWindowMs - now;
      if (msLeft > 0) return { kind: "waiting", unrevealed, msLeft };
      const tx = await this.chain.requestReveal();
      this.waitingSince = null;
      return { kind: "requested", first: s.nextToReveal, last: s.totalMinted, tx };
    }
    if (!pending.seedReady) {
      if (this.chain.deliver) {
        const tx = await this.chain.deliver(pending.sequence);
        return { kind: "delivered", sequence: pending.sequence, tx };
      }
      if (s.chainTime >= pending.requestedAt + this.policy.revealTimeoutSeconds) {
        const tx = await this.chain.requestReveal();
        return { kind: "re-requested", sequence: pending.sequence, tx };
      }
      return { kind: "awaiting-number", sequence: pending.sequence };
    }
    const upTo = Math.min(pending.batchLast, s.nextToReveal + this.policy.chunk - 1);
    const tx = await this.chain.reveal(this.policy.chunk);
    return { kind: "revealed", upTo, tx };
  }

  /** Ticks every intervalMs until the signal aborts. */
  async run(signal: AbortSignal, intervalMs = 2_000): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }
}

function describe(a: KeeperAction): string {
  switch (a.kind) {
    case "requested":
      return `reveal requested for agents ${a.first} to ${a.last} (tx ${a.tx})`;
    case "delivered":
      return `random number delivered for request ${a.sequence} (local fork, tx ${a.tx})`;
    case "re-requested":
      return `request ${a.sequence} timed out; requested again (tx ${a.tx})`;
    case "revealed":
      return `revealed agents up to ${a.upTo} (tx ${a.tx})`;
    case "error":
      return `keeper step failed: ${a.message}`;
    default:
      return a.kind;
  }
}
