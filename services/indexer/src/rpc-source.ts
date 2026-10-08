import type { Hex } from "viem";
import {
  type BlockRef,
  type LogFilter,
  type LogSource,
  RangeTooLargeError,
  type RawLog,
} from "./source.ts";

/**
 * The JSON-RPC log source (D-197): plain eth_* calls, so it works on the local
 * fork, Monad testnet and Monad mainnet alike. Errors are classified before
 * anything reacts (L-21): a rate limit backs off and retries the same request;
 * a range the node refuses as too large is reported for the poller to split;
 * anything else is thrown. The RPC URL can hold an API key, so it never
 * appears in an error or a log line.
 */
export interface RpcSourceOptions {
  readonly url: string;
  /**
   * A second provider (P2-EC): a network failure, a rate limit or a server
   * error on one moves the call to the other at once; after `stickMs` on the
   * fallback the next call tries the primary again.
   */
  readonly fallbackUrl?: string;
  readonly stickMs?: number;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Retries after a rate limit before giving up. */
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
}

export class RpcError extends Error {
  readonly method: string;
  readonly code: number | undefined;

  constructor(method: string, code: number | undefined, message: string) {
    super(`${method}: ${message}${code === undefined ? "" : ` (code ${code})`}`);
    this.method = method;
    this.code = code;
    this.name = "RpcError";
  }
}

const RATE_LIMIT = /rate|too many requests|capacity|throttl/i;
const RANGE = /range|block limit|too many blocks|results|response size|too large|exceed/i;

export type RpcFailure = "rate-limit" | "range" | "other";

/** How to react to a failed call, from the HTTP status and the JSON-RPC error. */
export function classifyRpcFailure(
  status: number,
  code: number | undefined,
  message: string,
): RpcFailure {
  if (status === 429 || RATE_LIMIT.test(message)) return "rate-limit";
  if (code === -32005 || code === -32602 || code === -32600 || code === -32000) {
    if (RANGE.test(message)) return "range";
  }
  if (RANGE.test(message) && /log|block|range/i.test(message)) return "range";
  return "other";
}

const hexNumber = (n: number) => `0x${n.toString(16)}`;

interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
}

export class RpcLogSource implements LogSource {
  private readonly urls: readonly string[];
  private readonly stickMs: number;
  private readonly now: () => number;
  /** 0 the primary, 1 the fallback; and when the fallback was taken. */
  private active = 0;
  private switchedAt = 0;
  /** How many times a call moved to the other provider. */
  failovers = 0;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private id = 0;

  constructor(options: RpcSourceOptions) {
    this.urls =
      options.fallbackUrl && options.fallbackUrl !== options.url
        ? [options.url, options.fallbackUrl]
        : [options.url];
    this.stickMs = options.stickMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 500;
  }

  /** The chain ID each configured provider answers, primary first. */
  async chainIds(): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < this.urls.length; i++) {
      this.active = i;
      ids.push(Number(await this.callOnce<Hex>("eth_chainId", [])));
    }
    this.active = 0;
    return ids;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    if (this.active === 1 && this.now() - this.switchedAt > this.stickMs) this.active = 0;
    return this.callOnce<T>(method, params);
  }

  private async callOnce<T>(method: string, params: unknown[]): Promise<T> {
    let switched = 0;
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let code: number | undefined;
      let message: string;
      try {
        const res = await this.fetchFn(this.urls[this.active] as string, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        });
        status = res.status;
        const body = (await res.json().catch(() => null)) as {
          result?: T;
          error?: { code?: number; message?: string };
        } | null;
        if (res.ok && body && !body.error && "result" in body) return body.result as T;
        code = body?.error?.code;
        message = body?.error?.message ?? `HTTP ${res.status}`;
      } catch (err) {
        // A network failure: the message is the runtime's, which never holds the URL.
        message = err instanceof Error ? err.name : "network error";
      }
      const failure = classifyRpcFailure(status, code, message);
      if (failure === "range") throw new RpcError(method, code, message);
      // The provider failed rather than the request: the other provider tries it at once.
      const providerFailed =
        status === 0 || status === 429 || status >= 500 || failure === "rate-limit";
      if (providerFailed && this.urls.length > 1 && switched < this.urls.length - 1) {
        switched++;
        this.failovers++;
        this.active = this.active === 0 ? 1 : 0;
        this.switchedAt = this.now();
        attempt--;
        continue;
      }
      if (failure === "rate-limit" && attempt < this.maxRetries) {
        await this.sleep(this.baseDelayMs * 2 ** attempt);
        continue;
      }
      throw new RpcError(method, code, message);
    }
  }

  async chainId(): Promise<number> {
    return Number(await this.call<Hex>("eth_chainId", []));
  }

  async head(): Promise<number> {
    return Number(await this.call<Hex>("eth_blockNumber", []));
  }

  async block(number: number): Promise<BlockRef | null> {
    const block = await this.call<{ number: Hex; hash: Hex } | null>("eth_getBlockByNumber", [
      hexNumber(number),
      false,
    ]);
    return block ? { number: Number(block.number), hash: block.hash } : null;
  }

  async logs(filter: LogFilter): Promise<RawLog[]> {
    let logs: RpcLog[];
    try {
      logs = await this.call<RpcLog[]>("eth_getLogs", [
        {
          address: filter.address,
          topics: filter.topics ?? [],
          fromBlock: hexNumber(filter.fromBlock),
          toBlock: hexNumber(filter.toBlock),
        },
      ]);
    } catch (err) {
      if (err instanceof RpcError && classifyRpcFailure(0, err.code, err.message) === "range") {
        throw new RangeTooLargeError(filter.fromBlock, filter.toBlock);
      }
      throw err;
    }
    return logs
      .filter((l) => !l.removed)
      .map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: Number(l.blockNumber),
        blockHash: l.blockHash,
        transactionHash: l.transactionHash,
        logIndex: Number(l.logIndex),
      }));
  }
}
