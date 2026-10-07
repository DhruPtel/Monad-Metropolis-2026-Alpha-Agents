import {
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";
import { EXECUTOR_ABI, type SwapIntentArgs } from "./abi.ts";
import type { ChainClient, Receipt, SendResult, Simulation } from "./chain.ts";

/**
 * A chain for the signer's tests: it checks nonces like a node, mines a swap
 * into a receipt carrying the Executor's IntentExecuted event, keeps token
 * balances per block, and can time out, refuse, lose or delay a broadcast.
 */
export type SendMode =
  | "mine"
  | "timeout-landed"
  | "timeout-lost"
  | "timeout-pooled"
  | "reject"
  | "reject-nonce"
  | "crash";

export class FakeChain implements ChainClient {
  chainId: number;
  readonly executor: Hex;
  block = 100n;
  baseFee = 50_000_000_000n;
  mode: SendMode = "mine";
  simulation: Simulation = { ok: true };
  /** The next mined swap reverts, with this Executor reason. */
  revertNext: string | null = null;
  /** Reconciliation breakers: an extra balance change, or no event at all. */
  extraInDelta = 0n;
  dropEvent = false;
  /** A provider that reports this pending nonce instead of the truth. */
  pendingOverride: number | null = null;
  readonly sent: Hex[] = [];
  readonly mined = new Map<string, number>();
  readonly pool = new Map<Hex, Hex>();
  readonly receipts = new Map<Hex, Receipt>();
  private readonly balances = new Map<string, { block: bigint; value: bigint }[]>();

  constructor(chainId: number, executor: Hex) {
    this.chainId = chainId;
    this.executor = executor;
  }

  setBalance(token: Hex, who: Hex, value: bigint): void {
    const k = `${token.toLowerCase()}:${who.toLowerCase()}`;
    const list = this.balances.get(k) ?? [];
    list.push({ block: this.block, value });
    this.balances.set(k, list);
  }

  private balanceAt(token: Hex, who: Hex, block: bigint): bigint {
    const list = this.balances.get(`${token.toLowerCase()}:${who.toLowerCase()}`) ?? [];
    let v = 0n;
    for (const e of list) if (e.block <= block) v = e.value;
    return v;
  }

  async verifyChain() {
    return this.chainId;
  }
  async nonce(address: Hex, tag: "latest" | "pending") {
    const mined = this.mined.get(address.toLowerCase()) ?? 0;
    if (tag === "latest") return mined;
    if (this.pendingOverride !== null) return this.pendingOverride;
    let pooled = 0;
    for (const raw of this.pool.values()) {
      const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
      if (from.toLowerCase() === address.toLowerCase()) pooled++;
    }
    return mined + pooled;
  }
  async fees() {
    return { baseFee: this.baseFee, priorityFee: 1_000_000_000n };
  }
  async nativeBalance() {
    return 10n ** 21n;
  }
  async simulate(): Promise<Simulation> {
    return this.simulation;
  }

  async sendRaw(raw: Hex): Promise<SendResult> {
    if (this.mode === "crash") throw new Error("the process stopped here");
    this.sent.push(raw);
    const hash = keccak256(raw);
    switch (this.mode) {
      case "mine":
        await this.mine(raw);
        return { kind: "accepted" };
      case "timeout-landed":
        await this.mine(raw);
        return { kind: "unknown", detail: "The request took too long to respond." };
      case "timeout-lost":
        return { kind: "unknown", detail: "The request took too long to respond." };
      case "timeout-pooled":
        this.pool.set(hash, raw);
        return { kind: "unknown", detail: "The request took too long to respond." };
      case "reject":
        return { kind: "rejected", nonceConsumed: false, detail: "insufficient funds for gas" };
      case "reject-nonce":
        return { kind: "rejected", nonceConsumed: true, detail: "nonce too low" };
    }
  }

  /** Mines a signed swap: checks its nonce, moves the balances, writes the receipt. */
  async mine(raw: Hex): Promise<void> {
    const tx = parseTransaction(raw);
    const from = (
      await recoverTransactionAddress({ serializedTransaction: raw as never })
    ).toLowerCase();
    const expected = this.mined.get(from) ?? 0;
    if (tx.nonce !== expected) throw new Error(`nonce ${tx.nonce}, expected ${expected}`);
    this.mined.set(from, expected + 1);
    this.pool.delete(keccak256(raw));
    this.block += 1n;
    const hash = keccak256(raw);
    const { args } = decodeFunctionData({ abi: EXECUTOR_ABI, data: tx.data as Hex });
    const i = args[0] as SwapIntentArgs;
    if (this.revertNext) {
      this.receipts.set(hash, {
        status: "reverted",
        blockNumber: this.block,
        blockHash: `0x${this.block.toString(16).padStart(64, "0")}`,
        gasUsed: 90_000n,
        logs: [],
      });
      return;
    }
    const amountOut = i.minAmountOut + 1n;
    this.setBalance(
      i.tokenIn,
      i.account,
      this.balanceAt(i.tokenIn, i.account, this.block) - i.amountIn - this.extraInDelta,
    );
    this.setBalance(
      i.tokenOut,
      i.account,
      this.balanceAt(i.tokenOut, i.account, this.block) + amountOut,
    );
    const topics = encodeEventTopics({
      abi: EXECUTOR_ABI,
      eventName: "IntentExecuted",
      args: { actionId: i.actionId, account: i.account, agentId: i.agentId },
    }) as Hex[];
    const data = encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [i.tokenIn, i.tokenOut, i.amountIn, amountOut, 3n * 10n ** 16n, 100_000_000n, 99_990_000n],
    );
    this.receipts.set(hash, {
      status: "success",
      blockNumber: this.block,
      blockHash: `0x${this.block.toString(16).padStart(64, "0")}`,
      gasUsed: 1_000_000n,
      logs: this.dropEvent ? [] : [{ address: this.executor, topics, data }],
    });
  }

  /** Another transaction from the same key lands (a refund, or a rogue resend). */
  consumeNonce(address: Hex): void {
    const k = address.toLowerCase();
    this.mined.set(k, (this.mined.get(k) ?? 0) + 1);
    this.block += 1n;
  }

  async receipt(hash: Hex) {
    return this.receipts.get(hash) ?? null;
  }
  async known(hash: Hex) {
    return this.pool.has(hash) || this.receipts.has(hash);
  }
  async revertReason(): Promise<Simulation> {
    return {
      ok: false,
      code: this.revertNext ?? "EXECUTOR_REVERTED",
      message: `the Executor refused: ${this.revertNext}`,
    };
  }
  async tokenBalance(token: Hex, who: Hex, block: bigint) {
    return this.balanceAt(token, who, block);
  }
  async blockTime(block: bigint) {
    return 1_790_000_000 + Number(block);
  }
}
