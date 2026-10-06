import { randomUUID } from "node:crypto";
import { refundEntry, reversalEntry } from "@alpha-agents/accounting";
import { assertLocalFork, rpc } from "@alpha-agents/devenv";
import { AGENT_NFT_ABI } from "@alpha-agents/domain";
import {
  type Chain,
  type Hex,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
} from "viem";
import type { HDAccount } from "viem/accounts";
import type { Log, Redactor } from "../secrets.ts";
import { errorText } from "../secrets.ts";
import type { AgentRef, Store } from "../store.ts";
import type { FundingKeys } from "./funding.ts";
import type { Ledger } from "./ledger.ts";
import type { CreditService } from "./service.ts";

/**
 * Refunds (A-20, D-210). A request names the owner and ownership epoch it was
 * made under. Processing rechecks both on chain, refunds the agent's spendable
 * credits plus any held deposits from the funding address to that owner, and
 * writes the signed transaction and the ledger entry in one database
 * transaction before broadcasting, so a restart rebroadcasts the same
 * transaction instead of paying twice. A request whose owner or epoch no
 * longer matches is refused: credits stay with the agent across a sale.
 */
export interface RefundChain {
  ownership(agentId: number): Promise<{ owner: Hex; epoch: bigint } | null>;
  usdcBalance(address: Hex): Promise<bigint>;
  /** Signs a USDC transfer from the account; nothing is sent. */
  signTransfer(account: HDAccount, to: Hex, amount: bigint): Promise<{ raw: Hex; hash: Hex }>;
  /** Broadcasts a signed transaction; a transaction the node already has is not an error. */
  broadcast(raw: Hex): Promise<void>;
  /** Waits for the receipt: true for success, false for a revert. */
  receipt(hash: Hex, timeoutMs: number): Promise<boolean>;
}

const USDC_ABI = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

export class ViemRefundChain implements RefundChain {
  private readonly pub;
  private readonly chain: Chain;
  private readonly o: {
    rpcUrl: string;
    chainId: number;
    agentNft: Hex;
    usdc: Hex;
    localFork: boolean;
  };

  constructor(o: ViemRefundChain["o"]) {
    this.o = o;
    this.chain = defineChain({
      id: o.chainId,
      name: `chain ${o.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [o.rpcUrl] } },
    });
    this.pub = createPublicClient({ chain: this.chain, transport: http(o.rpcUrl) });
  }

  async ownership(agentId: number) {
    try {
      const [owner, epoch] = await Promise.all([
        this.pub.readContract({
          address: this.o.agentNft,
          abi: AGENT_NFT_ABI,
          functionName: "ownerOf",
          args: [BigInt(agentId)],
        } as never) as Promise<Hex>,
        this.pub.readContract({
          address: this.o.agentNft,
          abi: AGENT_NFT_ABI,
          functionName: "ownerEpoch",
          args: [BigInt(agentId)],
        } as never) as Promise<bigint>,
      ]);
      return { owner, epoch };
    } catch (err) {
      if (err instanceof Error && /revert/i.test(err.message)) return null;
      throw err;
    }
  }

  usdcBalance(address: Hex): Promise<bigint> {
    return this.pub.readContract({
      address: this.o.usdc,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [address],
    });
  }

  async signTransfer(account: HDAccount, to: Hex, amount: bigint) {
    const data = encodeFunctionData({
      abi: USDC_ABI,
      functionName: "transfer",
      args: [to, amount],
    });
    const [nonce, gasPrice, gas] = await Promise.all([
      this.pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
      this.pub.getGasPrice(),
      this.pub.estimateGas({ account: account.address, to: this.o.usdc, data }),
    ]);
    const fee = gasPrice * 2n;
    const limit = (gas * 3n) / 2n;
    if (this.o.localFork) {
      // Gas top-ups are a later unit (A-19); on the local fork the funding address gets MON here.
      const balance = await this.pub.getBalance({ address: account.address });
      if (balance < fee * limit) {
        await assertLocalFork(this.o.rpcUrl);
        await rpc(this.o.rpcUrl, "anvil_setBalance", [
          account.address,
          `0x${(fee * limit * 10n).toString(16)}`,
        ]);
      }
    }
    const raw = await account.signTransaction({
      type: "legacy",
      chainId: this.o.chainId,
      to: this.o.usdc,
      data,
      nonce,
      gas: limit,
      gasPrice: fee,
    });
    return { raw, hash: keccak256(raw) };
  }

  async broadcast(raw: Hex): Promise<void> {
    try {
      await this.pub.sendRawTransaction({ serializedTransaction: raw });
    } catch (err) {
      // Already sent by an earlier attempt: the receipt decides.
      if (err instanceof Error && /already known|nonce too low|already imported/i.test(err.message))
        return;
      throw err;
    }
  }

  async receipt(hash: Hex, timeoutMs: number): Promise<boolean> {
    const r = await this.pub.waitForTransactionReceipt({ hash, timeout: timeoutMs });
    return r.status === "success";
  }
}

export interface RefundOptions {
  readonly store: Store;
  readonly ledger: Ledger;
  readonly credits: CreditService;
  readonly keys: FundingKeys;
  readonly chain: RefundChain;
  readonly chainId: number;
  readonly environment: Parameters<typeof refundEntry>[0]["environment"];
  readonly redactor: Redactor;
  readonly log: Log;
}

export type RefundRequester = "owner" | "console";

export class RefundService {
  private readonly o: RefundOptions;

  constructor(options: RefundOptions) {
    this.o = options;
  }

  /** Records a request for the owner and epoch it was made under. One open request per agent. */
  async request(agentId: number, owner: Hex, epoch: bigint, by: RefundRequester): Promise<string> {
    return requestRefund(this.o.store, this.o.chainId, agentId, owner, epoch, by);
  }

  /** Processes every refund that is requested or signed but not yet confirmed. */
  async tick(): Promise<void> {
    const open = await this.o.store.db
      .selectFrom("platform.refunds")
      .select(["refund_id", "agent_id"])
      .where("chain_id", "=", this.o.chainId)
      .where("status", "in", ["requested", "signed"])
      .orderBy("created_at")
      .execute();
    for (const r of open) {
      try {
        await this.process(r.refund_id);
      } catch (err) {
        this.o.log(`refund ${r.refund_id}: ${errorText(err, this.o.redactor)}; retried next pass`);
      }
    }
  }

  async process(refundId: string): Promise<void> {
    const row = await this.row(refundId);
    if (!row) return;
    const ref: AgentRef = { chainId: this.o.chainId, agentId: row.agent_id };
    await this.o.store.withAgentLock(ref, async () => {
      const current = await this.row(refundId);
      if (current?.status === "requested") await this.signLocked(refundId);
    });
    const signed = await this.row(refundId);
    if (signed?.status === "signed" && signed.raw_tx && signed.tx_hash) {
      await this.o.chain.broadcast(signed.raw_tx as Hex);
      const ok = await this.o.chain.receipt(signed.tx_hash as Hex, 120_000);
      await this.o.store.withAgentLock(ref, async () => {
        if (ok) {
          await this.set(refundId, { status: "sent" });
          this.o.log(`agent ${row.agent_id}: refund ${refundId} sent (tx ${signed.tx_hash})`);
        } else {
          // The transfer reverted: nothing left the funding address, so the entry is reversed.
          await this.reverseLocked(refundId, row.agent_id);
          await this.set(refundId, { status: "failed", reason: "the refund transfer reverted" });
          this.o.log(
            `agent ${row.agent_id}: refund ${refundId} reverted on chain; ledger restored`,
          );
        }
        await this.o.credits.syncBudgetLocked(row.agent_id);
      });
    }
  }

  private async signLocked(refundId: string): Promise<void> {
    const r = await this.row(refundId);
    if (!r) return;
    const refuse = async (reason: string) => {
      await this.set(refundId, { status: "refused", reason });
      this.o.log(`agent ${r.agent_id}: refund ${refundId} refused: ${reason}`);
    };
    const now = await this.o.chain.ownership(r.agent_id);
    if (!now || !isAddressEqual(now.owner, r.owner as Hex))
      return refuse("not_owner: the agent has a different owner now");
    if (now.epoch !== BigInt(r.owner_epoch))
      return refuse("stale_epoch: the agent changed hands since the refund was requested");

    const c = await this.o.ledger.balances(this.o.chainId, r.agent_id);
    const credits = c.credits > 0n ? c.credits : 0n;
    const total = credits + c.held;
    if (total === 0n) return refuse("nothing_to_refund: no credits or held deposits");
    const account = this.o.keys.account(r.agent_id);
    const onchain = await this.o.chain.usdcBalance(account.address);
    if (onchain < total) {
      await this.set(refundId, {
        status: "failed",
        reason: `the funding address holds ${onchain}, less than the ${total} the ledger owes`,
      });
      return;
    }
    const signed = await this.o.chain.signTransfer(account, now.owner, total);
    await this.o.ledger.post(
      refundEntry(
        {
          environment: this.o.environment,
          entryId: randomUUID(),
          occurredAt: Math.floor(Date.now() / 1000),
          agentId: r.agent_id,
        },
        credits,
        c.held,
      ),
      {
        chainId: this.o.chainId,
        agentId: r.agent_id,
        idempotencyKey: `refund:${refundId}`,
        source: { kind: "refund", refundId, to: now.owner.toLowerCase(), txHash: signed.hash },
      },
      async (trx) => {
        await trx
          .updateTable("platform.refunds")
          .set({
            status: "signed",
            raw_tx: signed.raw,
            tx_hash: signed.hash,
            credits_usdc_e6: credits.toString(),
            held_usdc_e6: c.held.toString(),
            updated_at: new Date(),
          })
          .where("refund_id", "=", refundId)
          .execute();
      },
    );
  }

  private async reverseLocked(refundId: string, agentId: number): Promise<void> {
    const entry = await this.o.store.db
      .selectFrom("platform.ledger_entries")
      .select("entry_id")
      .where("idempotency_key", "=", `refund:${refundId}`)
      .executeTakeFirst();
    if (!entry) return;
    const lines = await this.o.store.db
      .selectFrom("platform.ledger_lines")
      .selectAll()
      .where("entry_id", "=", entry.entry_id)
      .orderBy("line_no")
      .execute();
    await this.o.ledger.post(
      reversalEntry(
        {
          environment: this.o.environment,
          entryId: randomUUID(),
          occurredAt: Math.floor(Date.now() / 1000),
        },
        {
          environment: this.o.environment,
          entryId: entry.entry_id,
          occurredAt: 0,
          kind: "credits_refunded",
          lines: lines.map((l) => ({
            account: l.account as "agent_credits",
            asset: "USDC" as const,
            amountRaw: BigInt(l.amount),
            ...(l.agent_id === null ? {} : { agentId: l.agent_id }),
          })),
        },
      ),
      {
        chainId: this.o.chainId,
        agentId,
        idempotencyKey: `reversal:${entry.entry_id}`,
        source: { kind: "refund_reverted", refundId },
      },
    );
  }

  private row(refundId: string) {
    return this.o.store.db
      .selectFrom("platform.refunds")
      .selectAll()
      .where("refund_id", "=", refundId)
      .executeTakeFirst();
  }

  private async set(
    refundId: string,
    v: { status: "sent" | "refused" | "failed"; reason?: string },
  ) {
    await this.o.store.db
      .updateTable("platform.refunds")
      .set({ status: v.status, reason: v.reason ?? null, updated_at: new Date() })
      .where("refund_id", "=", refundId)
      .execute();
  }
}

/** Thrown when an agent already has a refund in flight. */
export class RefundOpenError extends Error {
  constructor(agentId: number) {
    super(`agent ${agentId} already has a refund in progress`);
    this.name = "RefundOpenError";
  }
}

/** Inserts a refund request; shared with the control API, which has no funding keys. */
export async function requestRefund(
  store: Pick<Store, "db">,
  chainId: number,
  agentId: number,
  owner: Hex,
  epoch: bigint,
  by: RefundRequester,
): Promise<string> {
  const refundId = randomUUID();
  try {
    await store.db
      .insertInto("platform.refunds")
      .values({
        refund_id: refundId,
        chain_id: chainId,
        agent_id: agentId,
        owner: owner.toLowerCase(),
        owner_epoch: Number(epoch),
        requested_by: by,
        status: "requested",
      })
      .execute();
  } catch (err) {
    if (err instanceof Error && /refunds_one_open/.test(err.message))
      throw new RefundOpenError(agentId);
    throw err;
  }
  return refundId;
}
