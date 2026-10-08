import { randomUUID } from "node:crypto";
import { assertJournalEntry, tradeEntry } from "@alpha-agents/accounting";
import { ENVIRONMENTS, type EnvironmentId } from "@alpha-agents/config";
import { type Db, type SignerStatus, insertJournal, sql } from "@alpha-agents/db";
import { redact } from "@alpha-agents/devenv";
import type { AssetId } from "@alpha-agents/domain";
import {
  type Hex,
  type TransactionSerializableEIP1559,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  serializeTransaction,
} from "viem";
import { ERC20_ABI, EXECUTOR_ABI, type SwapIntentArgs } from "./abi.ts";
import type { ChainClient, Receipt } from "./chain.ts";
import type { KeyProvider } from "./keys.ts";
import {
  CHAIN_PINS,
  MAX_FEE_PER_GAS_CAP,
  MAX_PRIORITY_FEE_CAP,
  SWAP_GAS_LIMIT,
  type SignRequest,
  TRANSFER_GAS_LIMIT,
  type TransactionKind,
  type TransferKind,
  checkSignRequest,
  checkTransferRequest,
} from "./policy.ts";
import { reconcileSwap } from "./reconcile.ts";

/**
 * The signer (P2-U4). Every platform transaction moves through a Postgres
 * outbox: Executor swaps, and since P2-U5 step 0 the USDC transfers credits
 * need (refunds to the agent's current owner, settlements to the treasury),
 * all from the agent's one key, the funding address (D-243, D-261):
 *
 *   accepted -> signed -> submitted -> confirmed -> reconciled
 *                            |  ^
 *                            v  |
 *                          unknown
 *   and any of them -> failed, with a reason code and a reason.
 *
 * - accepted: the request passed the allowlist and chain pin (policy.ts).
 * - signed: a nonce was allocated and the signed bytes stored, in one
 *   database transaction, before anything is broadcast.
 * - submitted: a provider took the transaction.
 * - unknown: a broadcast or a receipt wait timed out. Unknown is not failed:
 *   it is resolved by the transaction's hash and its nonce, and the signer
 *   never sends it again (D-245).
 * - confirmed: mined and successful. reconciled: for a swap, the Executor's
 *   event matched the account's balance changes and the trade's ledger entry
 *   was written in the same database transaction; for a transfer, its USDC
 *   Transfer event matched the recipient and amount (the caller wrote the
 *   credit ledger entry when it asked). A mismatch stays confirmed and is flagged.
 *
 * One key sends one transaction at a time: a key's next request is signed
 * only after its previous one is confirmed or failed, so a nonce is never
 * skipped. A writer claims each key with a fence; a second signer process
 * that claims the key later makes this one stop using it.
 */
export interface SignerOptions {
  readonly db: Db;
  readonly environment: EnvironmentId;
  readonly chain: ChainClient;
  readonly keys: KeyProvider;
  readonly executor: Hex;
  /** USDC, the only token the signer transfers. Transfers are refused without it. */
  readonly usdc?: Hex;
  /** The platform treasury, the only settlement recipient. Settlements are refused without it. */
  readonly treasury?: Hex;
  /**
   * The agent's current owner, read from the chain: the only refund recipient,
   * checked when the refund is accepted and again when it is signed. Refunds
   * are refused without it.
   */
  readonly ownerOf?: (agentId: number) => Promise<Hex | null>;
  /** Token address (any case) to its asset, for the ledger. */
  readonly assets: Readonly<Record<string, AssetId>>;
  /** RPC URLs, redacted from every stored reason and log line. */
  readonly secrets?: readonly (string | undefined)[];
  readonly log?: (line: string) => void;
  /** Local fork only: gives the key MON for gas (A-19 builds the real top-up). */
  readonly topUpGas?: (address: Hex, wei: bigint) => Promise<void>;
  /** How long a submitted transaction waits for a receipt before it is unknown. */
  readonly receiptTimeoutMs?: number;
  /** How long an unknown transaction whose nonce moved on waits for its receipt before it is called replaced. */
  readonly consumedGraceMs?: number;
  /** How long an unknown transaction no node knows of waits before it is called dropped. */
  readonly dropGraceMs?: number;
  readonly now?: () => Date;
}

export interface AcceptResult {
  readonly txId: string;
  readonly status: SignerStatus;
  readonly reasonCode: string | null;
  /** True when this action was already in the outbox: the first request stands. */
  readonly duplicate: boolean;
}

export interface OutboxView {
  readonly txId: string;
  readonly agentId: number;
  readonly kind: TransactionKind;
  readonly status: SignerStatus;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly actionId: string | null;
  readonly keyAddress: string;
  readonly nonce: number | null;
  readonly txHash: string | null;
  readonly blockNumber: number | null;
  readonly gasUsed: string | null;
  readonly intent: Record<string, unknown> | null;
  readonly amountOut: string | null;
  readonly balances: Record<string, unknown> | null;
  readonly ledgerEntryId: string | null;
  readonly history: readonly { status: string; at: string; detail?: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class FencedOutError extends Error {
  constructor(agentId: number) {
    super(`another signer process took over agent ${agentId}'s key`);
    this.name = "FencedOutError";
  }
}

export class NoSessionKeyError extends Error {
  constructor(agentId: number) {
    super(`agent ${agentId} has no session key in the signer; create it first`);
    this.name = "NoSessionKeyError";
  }
}

type Row = Awaited<ReturnType<Signer["rowsIn"]>>[number];

const TRANSFER_EVENT = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

const IN_FLIGHT: readonly SignerStatus[] = ["signed", "submitted", "unknown"];

const intentJson = (i: SwapIntentArgs): Record<string, string | number> => ({
  schemaVersion: i.schemaVersion,
  chainId: i.chainId.toString(),
  agentId: i.agentId.toString(),
  account: i.account,
  actionId: i.actionId,
  ownerEpoch: i.ownerEpoch.toString(),
  configEpoch: i.configEpoch.toString(),
  policyHash: i.policyHash,
  adapterId: i.adapterId,
  tokenIn: i.tokenIn,
  tokenOut: i.tokenOut,
  amountIn: i.amountIn.toString(),
  minAmountOut: i.minAmountOut.toString(),
  deadline: i.deadline.toString(),
});

const intentArgs = (j: Record<string, unknown>): SwapIntentArgs => ({
  schemaVersion: Number(j.schemaVersion),
  chainId: BigInt(j.chainId as string),
  agentId: BigInt(j.agentId as string),
  account: j.account as Hex,
  actionId: j.actionId as Hex,
  ownerEpoch: BigInt(j.ownerEpoch as string),
  configEpoch: BigInt(j.configEpoch as string),
  policyHash: j.policyHash as Hex,
  adapterId: j.adapterId as Hex,
  tokenIn: j.tokenIn as Hex,
  tokenOut: j.tokenOut as Hex,
  amountIn: BigInt(j.amountIn as string),
  minAmountOut: BigInt(j.minAmountOut as string),
  deadline: BigInt(j.deadline as string),
});

export class Signer {
  readonly #o: SignerOptions;
  private readonly chainId: number;
  /** This process's fence per agent key; absent until it claims the key. */
  private readonly fences = new Map<number, number>();
  private readonly fencedOut = new Set<number>();

  constructor(o: SignerOptions) {
    this.#o = o;
    this.chainId = CHAIN_PINS[o.environment];
  }

  get pinnedChainId(): number {
    return this.chainId;
  }

  private now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  private clean(text: string): string {
    return redact(text, this.#o.secrets ?? [])
      .replace(/https?:\/\/\S+/g, "<rpc>")
      .slice(0, 300);
  }

  private log(line: string): void {
    this.#o.log?.(this.clean(line));
  }

  /** Refuses to run unless every provider answers this environment's pinned chain. */
  async start(): Promise<void> {
    const id = await this.#o.chain.verifyChain();
    if (id !== this.chainId)
      throw new Error(
        `the signer for ${this.#o.environment} signs for chain ${this.chainId}, not ${id}`,
      );
  }

  // ---- keys ----

  /**
   * Creates the agent's session key in its provider (or finds it) and records
   * it. The key never leaves the provider; this returns its address, which
   * the owner registers as the agent's grant on the Executor.
   */
  async createKey(agentId: number): Promise<Hex> {
    const key = await this.#o.keys.key(agentId);
    await this.#o.db
      .insertInto("platform.signer_keys")
      .values({
        chain_id: this.chainId,
        agent_id: agentId,
        address: key.address.toLowerCase(),
        provider: this.#o.keys.kind,
        kms_key_id: null,
      })
      .onConflict((oc) => oc.columns(["chain_id", "agent_id"]).doNothing())
      .execute();
    const row = await this.keyRow(agentId);
    if (!row || row.address !== key.address.toLowerCase())
      throw new Error(`agent ${agentId}'s recorded session key differs from its provider's`);
    return key.address;
  }

  async keyAddress(agentId: number): Promise<Hex | null> {
    const row = await this.keyRow(agentId);
    return row ? getAddress(row.address) : null;
  }

  private keyRow(agentId: number) {
    return this.#o.db
      .selectFrom("platform.signer_keys")
      .selectAll()
      .where("chain_id", "=", this.chainId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();
  }

  /** Takes the key's writer fence for this process; an older process's allocations then fail. */
  private async claim(agentId: number): Promise<number> {
    const held = this.fences.get(agentId);
    if (held !== undefined) return held;
    const row = await this.#o.db
      .updateTable("platform.signer_keys")
      .set({ writer_fence: sql`writer_fence + 1`, updated_at: sql`now()` })
      .where("chain_id", "=", this.chainId)
      .where("agent_id", "=", agentId)
      .returning("writer_fence")
      .executeTakeFirst();
    if (!row) throw new NoSessionKeyError(agentId);
    this.fences.set(agentId, row.writer_fence);
    return row.writer_fence;
  }

  // ---- requests ----

  /** Puts an Executor swap in the outbox for the agent's key. */
  submitSwap(agentId: number, intent: SwapIntentArgs): Promise<AcceptResult> {
    return this.accept(agentId, {
      chainId: Number(intent.chainId),
      to: this.#o.executor,
      data: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "swap", args: [intent] }),
      value: 0n,
    });
  }

  /**
   * Accepts any requested call into the outbox, refusing it at once, before
   * anything is signed, unless it is an Executor swap for this chain and this
   * agent. A refused request is kept as failed so the refusal is visible.
   */
  async accept(
    agentId: number,
    req: { chainId: number; to: Hex | null; data: Hex; value: bigint },
  ): Promise<AcceptResult> {
    const key = await this.keyRow(agentId);
    if (!key) throw new NoSessionKeyError(agentId);
    const verdict = checkSignRequest(
      { ...req, gas: SWAP_GAS_LIMIT, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
      { environment: this.#o.environment, executor: this.#o.executor, agentId },
    );
    const txId = randomUUID();
    const at = this.now().toISOString();
    const base = {
      tx_id: txId,
      environment: ENVIRONMENTS[this.#o.environment].label,
      chain_id: this.chainId,
      agent_id: agentId,
      key_address: key.address,
      kind: "executor_swap" as const,
      request: JSON.stringify({
        chainId: req.chainId,
        to: req.to,
        data: req.data,
        value: req.value.toString(),
      }),
    };
    if (!verdict.ok) {
      await this.#o.db
        .insertInto("platform.signer_outbox")
        .values({
          ...base,
          status: "failed",
          reason_code: verdict.code,
          reason: `refused before signing: ${verdict.message}`,
          history: JSON.stringify([{ status: "failed", at, detail: verdict.code }]),
        })
        .execute();
      this.log(`agent ${agentId}: refused before signing: ${verdict.code}`);
      return { txId, status: "failed", reasonCode: verdict.code, duplicate: false };
    }
    const inserted = await this.#o.db
      .insertInto("platform.signer_outbox")
      .values({
        ...base,
        action_id: verdict.intent.actionId.toLowerCase(),
        intent: JSON.stringify(intentJson(verdict.intent)),
        status: "accepted",
        history: JSON.stringify([{ status: "accepted", at }]),
      })
      .onConflict((oc) => oc.columns(["chain_id", "action_id"]).doNothing())
      .returning("tx_id")
      .executeTakeFirst();
    if (inserted) return { txId, status: "accepted", reasonCode: null, duplicate: false };
    const first = await this.#o.db
      .selectFrom("platform.signer_outbox")
      .select(["tx_id", "status", "reason_code"])
      .where("chain_id", "=", this.chainId)
      .where("action_id", "=", verdict.intent.actionId.toLowerCase())
      .executeTakeFirstOrThrow();
    return {
      txId: first.tx_id,
      status: first.status,
      reasonCode: first.reason_code,
      duplicate: true,
    };
  }

  /** The one address a transfer of this kind may pay, or null to refuse. */
  private async recipientFor(kind: TransferKind, agentId: number): Promise<Hex | null> {
    if (kind === "usdc_settlement") return this.#o.treasury ?? null;
    return this.#o.ownerOf ? this.#o.ownerOf(agentId) : null;
  }

  /**
   * Puts a USDC transfer from the agent's key in the outbox: a refund to the
   * agent's current owner or a settlement to the treasury. `actionKey` makes
   * it idempotent (a second request with the same key returns the first).
   * Pass `db` to accept it inside the caller's database transaction, so the
   * caller's ledger entry and this row commit together. A refused request is
   * kept as failed, as for swaps.
   */
  async acceptTransfer(
    agentId: number,
    t: { kind: TransferKind; to: Hex; amount: bigint; actionKey: string },
    db: Db = this.#o.db,
  ): Promise<AcceptResult> {
    // Every agent's funding address is its session key (D-243), so a credit transfer
    // records the key itself when nobody has yet: a refund never waits for a trading grant.
    if (!(await this.keyRow(agentId))) await this.createKey(agentId);
    const key = await this.keyRow(agentId);
    if (!key) throw new NoSessionKeyError(agentId);
    const usdc = this.#o.usdc ?? null;
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [t.to, t.amount],
    });
    const req = { chainId: this.chainId, to: usdc, data, value: 0n };
    const verdict = usdc
      ? checkTransferRequest(
          { ...req, gas: TRANSFER_GAS_LIMIT, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
          {
            environment: this.#o.environment,
            usdc,
            kind: t.kind,
            recipient: await this.recipientFor(t.kind, agentId),
          },
        )
      : ({
          ok: false,
          code: "TARGET_NOT_ALLOWED",
          message: "the signer has no USDC address",
        } as const);
    const txId = randomUUID();
    const at = this.now().toISOString();
    const base = {
      tx_id: txId,
      environment: ENVIRONMENTS[this.#o.environment].label,
      chain_id: this.chainId,
      agent_id: agentId,
      key_address: key.address,
      kind: t.kind,
      action_id: t.actionKey,
      request: JSON.stringify({ ...req, value: "0" }),
      intent: JSON.stringify({ kind: t.kind, to: t.to, amount: t.amount.toString() }),
    };
    const inserted = await db
      .insertInto("platform.signer_outbox")
      .values(
        verdict.ok
          ? { ...base, status: "accepted", history: JSON.stringify([{ status: "accepted", at }]) }
          : {
              ...base,
              status: "failed",
              reason_code: verdict.code,
              reason: `refused before signing: ${verdict.message}`,
              history: JSON.stringify([{ status: "failed", at, detail: verdict.code }]),
            },
      )
      .onConflict((oc) => oc.columns(["chain_id", "action_id"]).doNothing())
      .returning("tx_id")
      .executeTakeFirst();
    if (inserted) {
      if (!verdict.ok)
        this.log(`agent ${agentId}: ${t.kind} refused before signing: ${verdict.code}`);
      return verdict.ok
        ? { txId, status: "accepted", reasonCode: null, duplicate: false }
        : { txId, status: "failed", reasonCode: verdict.code, duplicate: false };
    }
    const first = await db
      .selectFrom("platform.signer_outbox")
      .select(["tx_id", "status", "reason_code"])
      .where("chain_id", "=", this.chainId)
      .where("action_id", "=", t.actionKey)
      .executeTakeFirstOrThrow();
    return {
      txId: first.tx_id,
      status: first.status,
      reasonCode: first.reason_code,
      duplicate: true,
    };
  }

  /** One outbox row's state, for a caller following a transaction it asked for. */
  async transaction(txId: string) {
    return this.#o.db
      .selectFrom("platform.signer_outbox")
      .select(["tx_id", "status", "reason_code", "reason", "tx_hash", "block_number"])
      .where("tx_id", "=", txId)
      .executeTakeFirst();
  }

  // ---- the worker ----

  /** One pass: sign what is accepted, then follow everything in flight. */
  async tick(): Promise<void> {
    for (const row of await this.rowsIn(["signed"]))
      await this.guard(row, () => this.signedOrphan(row));
    for (const row of await this.rowsIn(["accepted"]))
      await this.guard(row, () => this.signAndSend(row));
    for (const row of await this.rowsIn(["submitted"]))
      await this.guard(row, () => this.follow(row));
    for (const row of await this.rowsIn(["unknown"]))
      await this.guard(row, () => this.resolveUnknown(row));
    for (const row of await this.rowsIn(["confirmed"]))
      if (!row.reason_code) await this.guard(row, () => this.reconcile(row));
  }

  private async guard(row: Row, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof FencedOutError) {
        this.fencedOut.add(row.agent_id);
        this.log(`agent ${row.agent_id}: ${err.message}; this signer stops using the key`);
        return;
      }
      this.log(
        `agent ${row.agent_id}: ${row.tx_id} ${row.status}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  rowsIn(statuses: readonly SignerStatus[]) {
    return this.#o.db
      .selectFrom("platform.signer_outbox")
      .selectAll()
      .where("chain_id", "=", this.chainId)
      .where("status", "in", statuses)
      .orderBy("created_at")
      .execute();
  }

  private async move(
    row: Row,
    status: SignerStatus,
    set: Record<string, unknown> = {},
    detail?: string,
    db: Db = this.#o.db,
  ): Promise<void> {
    const entry = {
      status,
      at: this.now().toISOString(),
      ...(detail ? { detail: this.clean(detail) } : {}),
    };
    await db
      .updateTable("platform.signer_outbox")
      .set({
        ...set,
        status,
        updated_at: sql`now()`,
        history: sql`history || ${JSON.stringify([entry])}::jsonb`,
      })
      .where("tx_id", "=", row.tx_id)
      .execute();
  }

  private fail(row: Row, code: string, reason: string, set: Record<string, unknown> = {}, db?: Db) {
    this.log(`agent ${row.agent_id}: ${row.tx_id} failed: ${code}`);
    return this.move(
      row,
      "failed",
      { ...set, reason_code: code, reason: this.clean(reason) },
      code,
      db,
    );
  }

  /** Is another transaction of this key still between signing and an outcome? */
  private async busy(row: Row): Promise<boolean> {
    const other = await this.#o.db
      .selectFrom("platform.signer_outbox")
      .select("tx_id")
      .where("chain_id", "=", this.chainId)
      .where("key_address", "=", row.key_address)
      .where("status", "in", IN_FLIGHT)
      .where("tx_id", "!=", row.tx_id)
      .executeTakeFirst();
    return other !== undefined;
  }

  private async signAndSend(row: Row): Promise<void> {
    if (this.fencedOut.has(row.agent_id)) return;
    if (await this.busy(row)) return;
    const request = row.request as { chainId: number; to: Hex | null; data: Hex; value: string };
    const key = await this.#o.keys.key(row.agent_id);
    if (key.address.toLowerCase() !== row.key_address)
      return this.fail(row, "NO_SESSION_KEY", "the provider's key is not the recorded session key");

    const kind = row.kind as TransactionKind;
    const gasLimit = kind === "executor_swap" ? SWAP_GAS_LIMIT : TRANSFER_GAS_LIMIT;
    // Fees: twice the base fee plus the tip, within the caps (A-38).
    const { baseFee, priorityFee } = await this.#o.chain.fees();
    const tip = priorityFee < MAX_PRIORITY_FEE_CAP ? priorityFee : MAX_PRIORITY_FEE_CAP;
    let maxFee = baseFee * 2n + tip;
    if (maxFee > MAX_FEE_PER_GAS_CAP) {
      if (baseFee + tip > MAX_FEE_PER_GAS_CAP)
        return this.fail(
          row,
          "FEE_CAP_EXCEEDED",
          `the network's base fee ${baseFee} is above the cap`,
        );
      maxFee = MAX_FEE_PER_GAS_CAP;
    }
    const sign: SignRequest = {
      chainId: request.chainId,
      to: request.to,
      data: request.data,
      value: BigInt(request.value),
      gas: gasLimit,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip,
    };
    if (kind === "executor_swap") {
      const verdict = checkSignRequest(sign, {
        environment: this.#o.environment,
        executor: this.#o.executor,
        agentId: row.agent_id,
      });
      if (!verdict.ok)
        return this.fail(row, verdict.code, `refused before signing: ${verdict.message}`);
      // The Executor's own verdict first: a refusal is recorded with its reason and nothing is signed.
      const sim = await this.#o.chain.simulate(key.address, this.#o.executor, sign.data);
      if (!sim.ok) return this.fail(row, sim.code, `the Executor would refuse it: ${sim.message}`);
    } else {
      // The recipient is checked again now: a refund pays only whoever owns the agent at signing.
      const usdc = this.#o.usdc;
      const verdict = usdc
        ? checkTransferRequest(sign, {
            environment: this.#o.environment,
            usdc,
            kind,
            recipient: await this.recipientFor(kind, row.agent_id),
          })
        : ({ ok: false, code: "TARGET_NOT_ALLOWED", message: "no USDC address" } as const);
      if (!verdict.ok)
        return this.fail(row, verdict.code, `refused before signing: ${verdict.message}`);
      const sim = await this.#o.chain.simulate(key.address, usdc as Hex, sign.data);
      if (!sim.ok)
        return this.fail(row, "TRANSFER_REVERTED", `the transfer would revert: ${sim.message}`);
    }

    if (this.#o.topUpGas) {
      const need = gasLimit * maxFee;
      if ((await this.#o.chain.nativeBalance(key.address)) < need)
        await this.#o.topUpGas(key.address, need * 10n);
    }

    const fence = await this.claim(row.agent_id);
    const pending = await this.#o.chain.nonce(key.address, "pending");
    const signed = await withKeyLock(this.#o.db, this.chainId, row.agent_id, () =>
      this.#o.db.transaction().execute(async (trx) => {
        const k = await trx
          .selectFrom("platform.signer_keys")
          .select(["next_nonce", "writer_fence"])
          .where("chain_id", "=", this.chainId)
          .where("agent_id", "=", row.agent_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (k.writer_fence !== fence) throw new FencedOutError(row.agent_id);
        let nonce = k.next_nonce;
        let note: string | undefined;
        if (pending > nonce) {
          // The key sent a transaction this outbox did not (a refund signed before P2-U5, or by hand).
          note = `nonce ${nonce} advanced to ${pending}: the key sent another transaction`;
          nonce = pending;
        } else if (pending < nonce) {
          if (this.#o.environment !== "local") return null; // a lagging provider: wait for it
          note = `nonce ${nonce} realigned to ${pending}: the local fork was reset`;
          nonce = pending;
        }
        const tx: TransactionSerializableEIP1559 = {
          type: "eip1559",
          chainId: sign.chainId,
          nonce,
          to: sign.to as Hex,
          data: sign.data,
          value: 0n,
          gas: sign.gas,
          maxFeePerGas: sign.maxFeePerGas,
          maxPriorityFeePerGas: sign.maxPriorityFeePerGas,
        };
        const sig = await key.signDigest(keccak256(serializeTransaction(tx)));
        const raw = serializeTransaction(tx, sig);
        const hash = keccak256(raw);
        const moved = await trx
          .updateTable("platform.signer_keys")
          .set({ next_nonce: nonce + 1, updated_at: sql`now()` })
          .where("chain_id", "=", this.chainId)
          .where("agent_id", "=", row.agent_id)
          .where("writer_fence", "=", fence)
          .executeTakeFirst();
        if (moved.numUpdatedRows !== 1n) throw new FencedOutError(row.agent_id);
        await this.move(
          row,
          "signed",
          {
            nonce,
            raw_tx: raw,
            tx_hash: hash,
            gas_limit: sign.gas.toString(),
            max_fee_per_gas: sign.maxFeePerGas.toString(),
            max_priority_fee_per_gas: sign.maxPriorityFeePerGas.toString(),
          },
          note ? `nonce ${nonce}; ${note}` : `nonce ${nonce}`,
          trx,
        );
        return { raw, hash, nonce };
      }),
    );
    if (!signed) {
      this.log(`agent ${row.agent_id}: waiting for the provider's nonce to reach the recorded one`);
      return;
    }
    await this.broadcast({ ...row, nonce: signed.nonce, tx_hash: signed.hash }, signed.raw);
  }

  private async broadcast(row: Row, raw: Hex): Promise<void> {
    const sent = await this.#o.chain.sendRaw(raw);
    if (sent.kind === "accepted") {
      await this.move(row, "submitted", { submitted_at: this.now() }, row.tx_hash ?? undefined);
      return;
    }
    if (sent.kind === "unknown") {
      await this.move(
        row,
        "unknown",
        { submitted_at: this.now(), unknown_since: this.now() },
        sent.detail,
      );
      this.log(
        `agent ${row.agent_id}: ${row.tx_id} unknown after broadcast; resolving by hash and nonce`,
      );
      return;
    }
    if (sent.nonceConsumed)
      return this.fail(row, "NONCE_CONSUMED", `the node refused it: ${sent.detail}`);
    // Never reached the chain: the nonce is given back, so the next transaction leaves no gap.
    await this.#o.db.transaction().execute(async (trx) => {
      await this.releaseNonce(row, trx);
      await this.fail(
        row,
        "BROADCAST_REJECTED",
        `the node refused it: ${sent.detail}`,
        { nonce: null },
        trx,
      );
    });
  }

  /** Gives back the row's nonce when it is the last one the key allocated. */
  private async releaseNonce(row: Row, trx: Db): Promise<void> {
    if (row.nonce === null) return;
    await trx
      .updateTable("platform.signer_keys")
      .set({ next_nonce: row.nonce, updated_at: sql`now()` })
      .where("chain_id", "=", this.chainId)
      .where("agent_id", "=", row.agent_id)
      .where("next_nonce", "=", row.nonce + 1)
      .execute();
  }

  /** A row left signed by a process that stopped before broadcasting: unknown, never sent again. */
  private async signedOrphan(row: Row): Promise<void> {
    const history = row.history as { at: string }[];
    const signedAt = Date.parse(history[history.length - 1]?.at ?? "");
    const age = this.now().getTime() - (Number.isNaN(signedAt) ? 0 : signedAt);
    if (age < 5_000) return;
    await this.move(
      row,
      "unknown",
      { unknown_since: this.now() },
      "the signer stopped between signing and broadcast",
    );
  }

  private async follow(row: Row): Promise<void> {
    const receipt = await this.#o.chain.receipt(row.tx_hash as Hex).catch(() => null);
    if (receipt) return this.applyReceipt(row, receipt);
    const since = row.submitted_at ? new Date(row.submitted_at).getTime() : 0;
    if (this.now().getTime() - since > (this.#o.receiptTimeoutMs ?? 60_000))
      await this.move(row, "unknown", { unknown_since: this.now() }, "no receipt within the wait");
  }

  /**
   * Resolves an unknown transaction without sending anything: by its hash
   * (a receipt, or a node that still holds it) and by its nonce (another
   * transaction used it, or no one did and it was dropped).
   */
  async resolveUnknown(row: Row): Promise<void> {
    const hash = row.tx_hash as Hex;
    // The nonce first, then the receipt: a transaction mined between the two reads
    // then shows up as a receipt, never as "another transaction used the nonce" (L-114).
    const latest = await this.#o.chain.nonce(row.key_address as Hex, "latest");
    const receipt = await this.#o.chain.receipt(hash);
    if (receipt) return this.applyReceipt(row, receipt);
    const since = row.unknown_since ? new Date(row.unknown_since).getTime() : 0;
    const waited = this.now().getTime() - since;
    if (row.nonce !== null && latest > row.nonce) {
      // Mined nonces past ours but no receipt for our hash. A provider can lag on
      // receipts, so this must hold for a while before it is believed.
      if (waited < (this.#o.consumedGraceMs ?? 30_000)) return;
      return this.fail(
        row,
        "NONCE_CONSUMED",
        `nonce ${row.nonce} was used by another transaction; this one never landed`,
      );
    }
    if (await this.#o.chain.known(hash)) {
      await this.move(row, "submitted", { submitted_at: this.now() }, "a node still holds it");
      return;
    }
    if (waited < (this.#o.dropGraceMs ?? 120_000)) return;
    await this.#o.db.transaction().execute(async (trx) => {
      await this.releaseNonce(row, trx);
      await this.fail(
        row,
        "DROPPED",
        `no node holds it and nonce ${row.nonce} is unused; released, not resent`,
        { nonce: null },
        trx,
      );
    });
  }

  private async applyReceipt(row: Row, receipt: Receipt): Promise<void> {
    const set = {
      block_number: Number(receipt.blockNumber),
      block_hash: receipt.blockHash,
      gas_used: receipt.gasUsed.toString(),
    };
    if (receipt.status === "success") {
      await this.move(row, "confirmed", set, `block ${receipt.blockNumber}`);
      return;
    }
    const request = row.request as { to: Hex; data: Hex };
    const why = await this.#o.chain
      .revertReason(row.key_address as Hex, request.to, request.data, receipt.blockNumber)
      .catch(() => ({
        ok: false as const,
        code: "EXECUTOR_REVERTED",
        message: "reverted on chain",
      }));
    const code =
      row.kind === "executor_swap"
        ? why.ok
          ? "EXECUTOR_REVERTED"
          : why.code
        : "TRANSFER_REVERTED";
    await this.fail(row, code, `reverted on chain: ${why.ok ? "no reason" : why.message}`, set);
  }

  private async reconcile(row: Row): Promise<void> {
    if (!row.intent || row.block_number === null) return;
    if (row.kind !== "executor_swap") return this.reconcileTransfer(row);
    const intent = intentArgs(row.intent);
    const receipt = await this.#o.chain.receipt(row.tx_hash as Hex);
    if (!receipt) return;
    const r = await reconcileSwap(this.#o.chain, receipt, this.#o.executor, intent);
    if (!r.ok) {
      this.log(`agent ${row.agent_id}: ${row.tx_id} reconciliation mismatch: ${r.reason}`);
      await this.move(
        row,
        "confirmed",
        {
          reason_code: "RECONCILE_MISMATCH",
          reason: r.reason,
          balances: r.balances ? JSON.stringify(r.balances) : null,
        },
        `flagged: ${r.reason}`,
      );
      return;
    }
    const assetIn = this.#o.assets[intent.tokenIn.toLowerCase()];
    const assetOut = this.#o.assets[intent.tokenOut.toLowerCase()];
    if (!assetIn || !assetOut) {
      await this.move(row, "confirmed", {
        reason_code: "RECONCILE_MISMATCH",
        reason: "a token is not a known asset",
      });
      return;
    }
    const entryId = randomUUID();
    const entry = tradeEntry({
      environment: ENVIRONMENTS[this.#o.environment].label,
      entryId,
      actionId: intent.actionId,
      occurredAt: await this.#o.chain.blockTime(receipt.blockNumber),
      assetIn,
      assetOut,
      amountIn: r.event.amountIn,
      amountOut: r.event.amountOut,
    });
    assertJournalEntry(entry);
    await this.#o.db.transaction().execute(async (trx) => {
      const written = await insertJournal(trx, {
        entryId,
        chainId: this.chainId,
        agentId: row.agent_id,
        kind: entry.kind,
        idempotencyKey: `trade:${this.chainId}:${intent.actionId.toLowerCase()}`,
        occurredAt: new Date(entry.occurredAt * 1000),
        source: {
          kind: "executor_swap",
          txId: row.tx_id,
          txHash: row.tx_hash,
          blockNumber: Number(receipt.blockNumber),
          account: intent.account,
          oraclePriceE18: r.event.oraclePriceE18.toString(),
          navBefore: r.event.navBefore.toString(),
          navAfter: r.event.navAfter.toString(),
          gasUsed: receipt.gasUsed.toString(),
        },
        lines: entry.lines.map((l) => ({
          account: l.account,
          asset: l.asset,
          amount: l.amountRaw,
          agentId: l.agentId ?? null,
        })),
      });
      await this.move(
        row,
        "reconciled",
        {
          amount_out: r.event.amountOut.toString(),
          balances: JSON.stringify(r.balances),
          ledger_entry_id: written ? entryId : null,
        },
        written ? `ledger entry ${entryId}` : "the ledger entry already existed",
        trx,
      );
    });
  }

  /** A transfer is reconciled when its receipt carries USDC's Transfer from the key, to the recipient, for the amount. */
  private async reconcileTransfer(row: Row): Promise<void> {
    const want = row.intent as { to: Hex; amount: string };
    const receipt = await this.#o.chain.receipt(row.tx_hash as Hex);
    if (!receipt) return;
    const usdc = this.#o.usdc as Hex;
    const seen = receipt.logs.some((l) => {
      if (!isAddressEqual(l.address, usdc)) return false;
      try {
        const { args } = decodeEventLog({
          abi: TRANSFER_EVENT,
          eventName: "Transfer",
          topics: l.topics as [Hex],
          data: l.data,
        });
        return (
          args !== undefined &&
          isAddressEqual(args.from, row.key_address as Hex) &&
          isAddressEqual(args.to, want.to) &&
          args.value === BigInt(want.amount)
        );
      } catch {
        return false;
      }
    });
    if (!seen) {
      await this.move(
        row,
        "confirmed",
        { reason_code: "RECONCILE_MISMATCH", reason: "no matching USDC Transfer in the receipt" },
        "flagged: no matching USDC Transfer",
      );
      return;
    }
    await this.move(
      row,
      "reconciled",
      { amount_out: want.amount },
      `paid ${want.to.toLowerCase()}`,
    );
  }

  // ---- reads for the console ----

  async outbox(agentId?: number, limit = 20): Promise<OutboxView[]> {
    let q = this.#o.db
      .selectFrom("platform.signer_outbox")
      .selectAll()
      .where("chain_id", "=", this.chainId);
    if (agentId !== undefined) q = q.where("agent_id", "=", agentId);
    const rows = await q.orderBy("created_at", "desc").limit(limit).execute();
    return rows.map((r) => ({
      txId: r.tx_id,
      agentId: r.agent_id,
      kind: r.kind,
      status: r.status,
      reasonCode: r.reason_code,
      reason: r.reason,
      actionId: r.action_id,
      keyAddress: getAddress(r.key_address),
      nonce: r.nonce,
      txHash: r.tx_hash,
      blockNumber: r.block_number,
      gasUsed: r.gas_used,
      intent: r.intent,
      amountOut: r.amount_out,
      balances: r.balances,
      ledgerEntryId: r.ledger_entry_id,
      history: r.history as OutboxView["history"],
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  async ledgerEntry(entryId: string) {
    const entry = await this.#o.db
      .selectFrom("platform.ledger_entries")
      .selectAll()
      .where("entry_id", "=", entryId)
      .executeTakeFirst();
    if (!entry) return null;
    const lines = await this.#o.db
      .selectFrom("platform.ledger_lines")
      .select(["line_no", "account", "asset", "amount"])
      .where("entry_id", "=", entryId)
      .orderBy("line_no")
      .execute();
    return {
      entryId,
      kind: entry.kind,
      occurredAt: new Date(entry.occurred_at).toISOString(),
      source: entry.source,
      lines: lines.map((l) => ({ account: l.account, asset: l.asset, amount: l.amount })),
    };
  }
}

/**
 * The agent's advisory lock, the same one the orchestrator's refunds take
 * (Store.withAgentLock), so a refund and a swap never pick a nonce for the
 * same address at once. A try-lock loop on one connection (L-72).
 */
export async function withKeyLock<T>(
  db: Db,
  chainId: number,
  agentId: number,
  fn: () => Promise<T>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await db.connection().execute(async (conn) => {
      const { rows } = await sql<{ ok: boolean }>`
        select pg_try_advisory_lock(${chainId}::int4, ${agentId}::int4) as ok`.execute(conn);
      if (!rows[0]?.ok) return { held: false as const };
      try {
        return { held: true as const, value: await fn() };
      } finally {
        await sql`select pg_advisory_unlock(${chainId}::int4, ${agentId}::int4)`.execute(conn);
      }
    });
    if (outcome.held) return outcome.value;
    if (Date.now() > deadline) throw new Error(`agent ${agentId}'s key stayed locked`);
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
  }
}
