import type { Hex } from "viem";

/**
 * Where the indexer reads the chain from (D-197). The RPC implementation
 * (rpc-source.ts) serves every environment today; a HyperSync one can replace
 * it later without touching the projections. Tests use an in-memory chain.
 */
export interface BlockRef {
  readonly number: number;
  readonly hash: Hex;
}

export interface RawLog {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: number;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface LogFilter {
  readonly address: Hex;
  /** Per position: a topic, any of several, or null for any. */
  readonly topics?: readonly (Hex | readonly Hex[] | null)[];
  readonly fromBlock: number;
  readonly toBlock: number;
}

export interface LogSource {
  chainId(): Promise<number>;
  /** The latest block number. */
  head(): Promise<number>;
  /** A block's hash, or null when the chain has no block at that number. */
  block(number: number): Promise<BlockRef | null>;
  logs(filter: LogFilter): Promise<RawLog[]>;
}

/** The source refused a range as too large: the indexer halves it and retries. */
export class RangeTooLargeError extends Error {
  constructor(from: number, to: number) {
    super(`the log source refused blocks ${from} to ${to} as too large a range`);
    this.name = "RangeTooLargeError";
  }
}
