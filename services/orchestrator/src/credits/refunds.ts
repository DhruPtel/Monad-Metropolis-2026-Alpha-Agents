import { rpcTransport } from "@alpha-agents/chain-tools";
import { randomUUID } from "node:crypto";
import {
  type ContributionWeights,
  ownShare,
  refundEntry,
  reversalEntry,
  shareOf,
} from "@alpha-agents/accounting";
import { type Db, readContributionWeights } from "@alpha-agents/db";
import { AGENT_NFT_ABI } from "@alpha-agents/domain";
import {
  type Chain,
  type Hex,
  createPublicClient,
  defineChain,
  isAddressEqual,
  parseAbi,
} from "viem";
import type { Log, Redactor } from "../secrets.ts";
import { errorText } from "../secrets.ts";
import type { AgentRef, Store } from "../store.ts";
import type { FundingKeys } from "./funding.ts";
import type { Ledger } from "./ledger.ts";
import type { CreditService } from "./service.ts";

/**
 * Refunds (D-210, D-242, D-261). A request names the owner and ownership
 * epoch it was made under. Processing rechecks both on chain and refunds only
 * the owner's own share of the agent's spendable credits and held deposits
 * (D-242): the owner's contributions to the funding address, less those
 * earlier refunds consumed, over everyone's. Other contributors' shares stay
 * with the agent. A request whose owner or epoch no longer matches is
 * refused: credits stay with the agent across a sale.
 *
 * The transfer goes through the signer's outbox (D-261), like every platform
 * transaction: the ledger entry and the outbox row are written in one
 * database transaction, and the signer then signs with the next fenced nonce,
 * resolves a lost answer as unknown rather than failed, and checks the
 * recipient is still the agent's owner when it signs. This service follows
 * the outbox row: reconciled means sent; failed means nothing left the
 * funding address, so the ledger entry is reversed. A refund signed before
 * D-261 keeps its own raw transaction and is finished the old way.
 */
export interface RefundChain {
  ownership(agentId: number): Promise<{ owner: Hex; epoch: bigint } | null>;
  usdcBalance(address: Hex): Promise<bigint>;
  /** Broadcasts a signed transaction (a refund signed before D-261); a transaction the node already has is not an error. */
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
    /** The environment's second provider, used when the first fails (P2-EC). */
    fallbackRpcUrl?: string | null;
    chainId: number;
    agentNft: Hex;
    usdc: Hex;
  };

  constructor(o: ViemRefundChain["o"]) {
    this.o = o;
    this.chain = defineChain({
      id: o.chainId,
      name: `chain ${o.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [o.rpcUrl] } },
    });
    this.pub = createPublicClient({
      chain: this.chain,
      transport: rpcTransport(o.rpcUrl, o.fallbackRpcUrl),
    });
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

/** The part of the signer refunds use (packages/signer's Signer). */
export interface RefundSigner {
  acceptTransfer(
    agentId: number,
    t: { kind: "usdc_refund"; to: Hex; amount: bigint; actionKey: string },
    db?: Db,
  ): Promise<{ txId: string; status: string; reasonCode: string | null }>;
  transaction(txId: string): Promise<
    | {
        status: string;
        reason_code: string | null;
        reason: string | null;
        tx_hash: string | null;
      }
    | undefined
  >;
}

export interface RefundOptions {
  readonly store: Store;
  readonly ledger: Ledger;
  readonly credits: CreditService;
  readonly keys: FundingKeys;
  readonly chain: RefundChain;
  /** The signer every refund goes through (D-261). Null: requests wait, nothing is signed. */
  readonly signer: RefundSigner | null;
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
    if (row.status === "requested") {
      if (!this.o.signer) return; // the signer is off: the request waits
      await this.o.store.withAgentLock(ref, async () => {
        const current = await this.row(refundId);
        if (current?.status === "requested") await this.signLocked(refundId);
      });
      return;
    }
    if (row.status !== "signed") return;
    if (row.signer_tx_id) return this.follow(refundId, row.agent_id, row.signer_tx_id);
    if (row.raw_tx && row.tx_hash) return this.finishLegacy(refundId, row.agent_id, row);
  }

  /** Follows the refund's outbox row: reconciled is sent, failed restores the ledger, anything else waits. */
  private async follow(refundId: string, agentId: number, txId: string): Promise<void> {
    const tx = await this.o.signer?.transaction(txId);
    if (!tx) return;
    const ref: AgentRef = { chainId: this.o.chainId, agentId };
    if (tx.status === "reconciled" || (tx.status === "confirmed" && tx.reason_code)) {
      await this.o.store.withAgentLock(ref, async () => {
        await this.set(refundId, {
          status: "sent",
          ...(tx.reason_code ? { reason: `${tx.reason_code}: ${tx.reason ?? ""}` } : {}),
          txHash: tx.tx_hash,
        });
        await this.o.credits.syncBudgetLocked(agentId);
      });
      this.o.log(`agent ${agentId}: refund ${refundId} sent (tx ${tx.tx_hash})`);
      return;
    }
    if (tx.status !== "failed") return;
    await this.o.store.withAgentLock(ref, async () => {
      // Failed in the outbox means it never landed (refused, rejected, dropped, nonce
      // consumed by another) or it reverted: nothing left the funding address.
      await this.reverseLocked(refundId, agentId);
      await this.set(refundId, {
        status: "failed",
        reason: `${tx.reason_code ?? "FAILED"}: ${tx.reason ?? "the signer could not send it"}`,
        txHash: tx.tx_hash,
      });
      await this.o.credits.syncBudgetLocked(agentId);
    });
    this.o.log(
      `agent ${agentId}: refund ${refundId} failed in the signer (${tx.reason_code}); ledger restored`,
    );
  }

  /** A refund signed before D-261 kept its raw transaction: rebroadcast it and settle on its receipt. */
  private async finishLegacy(
    refundId: string,
    agentId: number,
    signed: { raw_tx: string | null; tx_hash: string | null },
  ): Promise<void> {
    const ref: AgentRef = { chainId: this.o.chainId, agentId };
    await this.o.chain.broadcast(signed.raw_tx as Hex);
    const ok = await this.o.chain.receipt(signed.tx_hash as Hex, 120_000);
    await this.o.store.withAgentLock(ref, async () => {
      if (ok) {
        await this.set(refundId, { status: "sent" });
        this.o.log(`agent ${agentId}: refund ${refundId} sent (tx ${signed.tx_hash})`);
      } else {
        await this.reverseLocked(refundId, agentId);
        await this.set(refundId, { status: "failed", reason: "the refund transfer reverted" });
        this.o.log(`agent ${agentId}: refund ${refundId} reverted on chain; ledger restored`);
      }
      await this.o.credits.syncBudgetLocked(agentId);
    });
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
    const pool = c.credits > 0n ? c.credits : 0n;
    if (pool + c.held === 0n) return refuse("nothing_to_refund: no credits or held deposits");
    // Only the owner's own share (D-242).
    const w = await contributionWeights(this.o.store, this.o.chainId, r.agent_id, now.owner);
    const share = ownShare(w, pool + c.held);
    if (share.amount === 0n)
      return refuse(
        "nothing_to_refund: the owner's own contributions are already refunded or were never made",
      );
    const credits = shareOf(pool, share, w);
    const held = shareOf(c.held, share, w);
    const total = credits + held;
    const account = this.o.keys.account(r.agent_id);
    const onchain = await this.o.chain.usdcBalance(account.address);
    if (onchain < total) {
      await this.set(refundId, {
        status: "failed",
        reason: `the funding address holds ${onchain}, less than the ${total} the ledger owes`,
      });
      return;
    }
    const signer = this.o.signer;
    if (!signer) return;
    await this.o.ledger.post(
      refundEntry(
        {
          environment: this.o.environment,
          entryId: randomUUID(),
          occurredAt: Math.floor(Date.now() / 1000),
          agentId: r.agent_id,
        },
        credits,
        held,
      ),
      {
        chainId: this.o.chainId,
        agentId: r.agent_id,
        idempotencyKey: `refund:${refundId}`,
        source: {
          kind: "refund",
          refundId,
          to: now.owner.toLowerCase(),
          contributionBasis: share.basis.toString(),
        },
      },
      async (trx) => {
        // The outbox row and the ledger entry commit together (D-261).
        const accepted = await signer.acceptTransfer(
          r.agent_id,
          { kind: "usdc_refund", to: now.owner, amount: total, actionKey: `refund:${refundId}` },
          trx,
        );
        await trx
          .updateTable("platform.refunds")
          .set({
            status: "signed",
            signer_tx_id: accepted.txId,
            credits_usdc_e6: credits.toString(),
            held_usdc_e6: held.toString(),
            contribution_basis_usdc_e6: share.basis.toString(),
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
    v: { status: "sent" | "refused" | "failed"; reason?: string; txHash?: string | null },
  ) {
    await this.o.store.db
      .updateTable("platform.refunds")
      .set({
        status: v.status,
        reason: v.reason ?? null,
        ...(v.txHash ? { tx_hash: v.txHash } : {}),
        updated_at: new Date(),
      })
      .where("refund_id", "=", refundId)
      .execute();
  }
}

/**
 * A contributor's weight in the agent's credits (D-242): what it and everyone
 * sent to the funding address, and the basis of the refunds already signed or
 * sent (a reverted refund consumed nothing).
 */
export function contributionWeights(
  store: Pick<Store, "db">,
  chainId: number,
  agentId: number,
  contributor: Hex,
): Promise<ContributionWeights> {
  return readContributionWeights(store.db, chainId, agentId, contributor);
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
