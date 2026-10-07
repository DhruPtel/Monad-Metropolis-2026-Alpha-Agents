import { REJECTION_CODES } from "@alpha-agents/domain";
import {
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  type Hex,
  HttpRequestError,
  type PublicClient,
  TimeoutError,
  createPublicClient,
  decodeErrorResult,
  defineChain,
  http,
} from "viem";
import { ERC20_ABI, EXECUTOR_ABI } from "./abi.ts";

/**
 * What the signer reads from and sends to the chain. Two providers (P2-U4
 * item 9): reads and sends go to the primary first; receipts and log ranges
 * go to the secondary (MONAD_RPC_URL_SECONDARY) first, since it serves wide
 * ranges (D-171). Either falls over to the other when one is unreachable.
 * Both must answer the environment's chain ID before the signer starts.
 */
export interface Receipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly gasUsed: bigint;
  readonly logs: readonly { address: Hex; topics: readonly Hex[]; data: Hex }[];
}

export type Simulation =
  { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };

/** What a broadcast did. `unknown` is never `failed`: the transaction may still land. */
export type SendResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "unknown"; readonly detail: string }
  | { readonly kind: "rejected"; readonly nonceConsumed: boolean; readonly detail: string };

export interface ChainClient {
  /** The chain ID every provider answers; throws if they disagree. */
  verifyChain(): Promise<number>;
  nonce(address: Hex, tag: "latest" | "pending"): Promise<number>;
  fees(): Promise<{ baseFee: bigint; priorityFee: bigint }>;
  nativeBalance(address: Hex): Promise<bigint>;
  /** The call as the key would make it, against the latest block. */
  simulate(from: Hex, to: Hex, data: Hex): Promise<Simulation>;
  sendRaw(raw: Hex): Promise<SendResult>;
  receipt(hash: Hex): Promise<Receipt | null>;
  /** True while a node still holds the transaction (in its pool or mined). */
  known(hash: Hex): Promise<boolean>;
  /** Why a mined call reverted, replayed at its block's parent. */
  revertReason(from: Hex, to: Hex, data: Hex, blockNumber: bigint): Promise<Simulation>;
  tokenBalance(token: Hex, who: Hex, blockNumber: bigint): Promise<bigint>;
  blockTime(blockNumber: bigint): Promise<number>;
}

/** The Executor's refusal by name, or the error's short text. */
export function refusalOf(err: unknown): { code: string; message: string } {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data) {
      if (r.data.errorName === "Rejected") {
        const code = REJECTION_CODES[Number(r.data.args?.[0])] ?? "EXECUTOR_REVERTED";
        return { code, message: `the Executor refused: ${code}` };
      }
      return { code: "EXECUTOR_REVERTED", message: `the Executor reverted: ${r.data.errorName}` };
    }
    const data = (
      err.walk((e) => typeof (e as { data?: unknown }).data === "string") as {
        data?: Hex;
      } | null
    )?.data;
    if (data && data.length >= 10) {
      try {
        const d = decodeErrorResult({ abi: EXECUTOR_ABI, data });
        if (d.errorName === "Rejected") {
          const code = REJECTION_CODES[Number(d.args[0])] ?? "EXECUTOR_REVERTED";
          return { code, message: `the Executor refused: ${code}` };
        }
      } catch {
        // not one of ours
      }
    }
    return { code: "EXECUTOR_REVERTED", message: err.shortMessage.slice(0, 200) };
  }
  return { code: "EXECUTOR_REVERTED", message: String(err).slice(0, 200) };
}

/** A transport failure: the provider did not answer, so another may. */
export function unreachable(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return Boolean(
    err.walk(
      (e) => e instanceof TimeoutError || (e instanceof HttpRequestError && e.status === undefined),
    ),
  );
}

function classifySend(err: unknown): SendResult {
  const text = err instanceof BaseError ? `${err.shortMessage} ${err.details}` : String(err);
  if (unreachable(err)) return { kind: "unknown", detail: text.slice(0, 200) };
  if (/already known|known transaction|already imported/i.test(text)) return { kind: "accepted" };
  if (/nonce too low|nonce has already been used/i.test(text))
    return { kind: "rejected", nonceConsumed: true, detail: text.slice(0, 200) };
  if (err instanceof BaseError)
    return { kind: "rejected", nonceConsumed: false, detail: text.slice(0, 200) };
  return { kind: "unknown", detail: text.slice(0, 200) };
}

export interface ViemChainOptions {
  readonly chainId: number;
  readonly primaryUrl: string;
  /** The second provider; the primary alone when absent (the local fork). */
  readonly secondaryUrl?: string;
  readonly timeoutMs?: number;
}

export class ViemChainClient implements ChainClient {
  private readonly primary: PublicClient;
  private readonly secondary: PublicClient | null;
  private readonly chainId: number;

  constructor(o: ViemChainOptions) {
    this.chainId = o.chainId;
    const chain: Chain = defineChain({
      id: o.chainId,
      name: `chain ${o.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [o.primaryUrl] } },
    });
    // retryCount 0: a failure is classified here, never retried blindly by the transport.
    const client = (url: string) =>
      createPublicClient({
        chain,
        transport: http(url, { timeout: o.timeoutMs ?? 10_000, retryCount: 0 }),
      }) as PublicClient;
    this.primary = client(o.primaryUrl);
    this.secondary = o.secondaryUrl ? client(o.secondaryUrl) : null;
  }

  /** Primary first, the secondary when the primary does not answer. */
  private async read<T>(fn: (c: PublicClient) => Promise<T>, secondaryFirst = false): Promise<T> {
    const order = [this.primary, this.secondary].filter((c): c is PublicClient => c !== null);
    if (secondaryFirst) order.reverse();
    let last: unknown;
    for (const c of order) {
      try {
        return await fn(c);
      } catch (err) {
        if (!unreachable(err)) throw err;
        last = err;
      }
    }
    throw last;
  }

  async verifyChain(): Promise<number> {
    for (const c of [this.primary, this.secondary]) {
      if (!c) continue;
      const id = await c.getChainId();
      if (id !== this.chainId)
        throw new Error(
          `a signer RPC provider answers chain ${id}, not the pinned ${this.chainId}`,
        );
    }
    return this.chainId;
  }

  nonce(address: Hex, tag: "latest" | "pending"): Promise<number> {
    return this.read((c) => c.getTransactionCount({ address, blockTag: tag }));
  }

  async fees() {
    return this.read(async (c) => {
      const block = await c.getBlock({ blockTag: "latest" });
      const priorityFee = await c.estimateMaxPriorityFeePerGas().catch(() => 1_000_000_000n);
      return { baseFee: block.baseFeePerGas ?? 0n, priorityFee };
    });
  }

  nativeBalance(address: Hex): Promise<bigint> {
    return this.read((c) => c.getBalance({ address }));
  }

  async simulate(from: Hex, to: Hex, data: Hex): Promise<Simulation> {
    try {
      await this.read((c) => c.call({ account: from, to, data }));
      return { ok: true };
    } catch (err) {
      if (unreachable(err)) throw err;
      return { ok: false, ...refusalOf(err) };
    }
  }

  async sendRaw(raw: Hex): Promise<SendResult> {
    try {
      await this.primary.sendRawTransaction({ serializedTransaction: raw });
      return { kind: "accepted" };
    } catch (err) {
      const first = classifySend(err);
      // Only a primary that never answered is worth the secondary: the same signed
      // bytes, so the same nonce and hash; never a new transaction.
      if (first.kind !== "unknown" || !this.secondary || !(err instanceof HttpRequestError))
        return first;
      try {
        await this.secondary.sendRawTransaction({ serializedTransaction: raw });
        return { kind: "accepted" };
      } catch (err2) {
        return classifySend(err2);
      }
    }
  }

  async receipt(hash: Hex): Promise<Receipt | null> {
    const r = await this.read(
      (c) =>
        c.getTransactionReceipt({ hash }).catch((err: unknown) => {
          if (err instanceof BaseError && /could not be found|not found/i.test(err.shortMessage))
            return null;
          throw err;
        }),
      true,
    );
    if (!r) return null;
    return {
      status: r.status,
      blockNumber: r.blockNumber,
      blockHash: r.blockHash,
      gasUsed: r.gasUsed,
      logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
    };
  }

  async known(hash: Hex): Promise<boolean> {
    return this.read(async (c) => {
      try {
        await c.getTransaction({ hash });
        return true;
      } catch (err) {
        if (err instanceof BaseError && /could not be found|not found/i.test(err.shortMessage))
          return false;
        throw err;
      }
    }, true);
  }

  async revertReason(from: Hex, to: Hex, data: Hex, blockNumber: bigint): Promise<Simulation> {
    try {
      await this.read((c) => c.call({ account: from, to, data, blockNumber: blockNumber - 1n }));
      return {
        ok: false,
        code: "EXECUTOR_REVERTED",
        message: "reverted on chain; the replay passed",
      };
    } catch (err) {
      if (unreachable(err)) throw err;
      return { ok: false, ...refusalOf(err) };
    }
  }

  tokenBalance(token: Hex, who: Hex, blockNumber: bigint): Promise<bigint> {
    return this.read((c) =>
      c.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [who],
        blockNumber,
      }),
    );
  }

  async blockTime(blockNumber: bigint): Promise<number> {
    const b = await this.read((c) => c.getBlock({ blockNumber }));
    return Number(b.timestamp);
  }
}
