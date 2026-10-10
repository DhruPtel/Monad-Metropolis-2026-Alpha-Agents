import { randomUUID } from "node:crypto";
import { type Db, dbAddress } from "@alpha-agents/db";
import {
  ARMING_END_MESSAGES,
  ASSET_DECIMALS,
  type ArmingEndReason,
  type ArmingState,
  type AssetId,
  type CustodyPath,
  type IntentState,
  REJECTION_MESSAGES,
  RUNNER_HOLD_FACTS,
  type RejectionCode,
  type RunnerHoldCode,
  SLOT_HOLDING_INTENT_STATES,
  TRADE_FLOW_MESSAGES,
  type TradeFlowCode,
} from "@alpha-agents/domain";
import { type Hex, getAddress } from "viem";
import { type ArmingRecord, armingState } from "./arming.ts";

/**
 * The trade flow's records (P2-U6): one row per arming in `platform.arming`
 * (at most one open per agent), and the intents' moves through approval,
 * submission, confirmation and reconciliation in `platform.intents`. Every
 * move is conditional on the state it leaves, so two workers or a worker and
 * an owner never both move the same intent.
 */

/** A blocker as stored with an intent: chain-tools' Blocker, by shape. */
export interface StoredBlocker {
  readonly code: string;
  readonly message: string;
  readonly clears: string;
  readonly clearsAt: string | null;
  readonly hint: string;
}

export interface IntentView {
  readonly intentId: string;
  readonly chainId: number;
  readonly agentId: number;
  readonly account: Hex | null;
  /** The custody set the intent trades on (F-U5, D-367). */
  readonly custody: CustodyPath;
  /** The assets by symbol: USDC or WMON on v2; any registered token on v3, with its address and decimals beside it. */
  readonly sell: string;
  readonly buy: string;
  readonly sellToken: Hex | null;
  readonly buyToken: Hex | null;
  readonly sellDecimals: number;
  readonly buyDecimals: number;
  /** The route the proposal chose: registered pool IDs in order (v3). */
  readonly route: readonly Hex[] | null;
  readonly amountIn: bigint;
  readonly reason: string;
  readonly status: IntentState;
  readonly reasonCodes: readonly string[];
  readonly blockers: readonly StoredBlocker[];
  readonly expectedOut: bigint | null;
  readonly ownerEpoch: bigint | null;
  readonly configEpoch: bigint | null;
  /** The strategy epoch it was proposed under (D-281); null before the agent's first goal. */
  readonly strategyEpoch: bigint | null;
  /** P3-U3: who proposed it, the agent or the template runner. */
  readonly source: "agent" | "template";
  readonly approvedBy: "owner" | "auto" | null;
  readonly approvedAt: Date | null;
  readonly submittedAt: Date | null;
  readonly settledAt: Date | null;
  readonly minAmountOut: bigint | null;
  readonly deadline: bigint | null;
  readonly actionId: string | null;
  readonly txId: string | null;
  readonly txHash: string | null;
  readonly amountOut: bigint | null;
  readonly failure: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly updatedAt: Date;
}

const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v));

type IntentRow = Awaited<ReturnType<TradeStore["intentRows"]>>[number];
type ArmingRow = Awaited<ReturnType<TradeStore["armingRows"]>>[number];

/** A symbol's decimals: USDC's and WMON's from the domain, a v3 token's from the intent's checks, else 18. */
const decimalsOf = (symbol: string, fromChecks: unknown): number =>
  typeof fromChecks === "number" ? fromChecks : (ASSET_DECIMALS[symbol as AssetId] ?? 18);

function intentView(r: IntentRow): IntentView {
  const checks = r.checks as {
    expectedOut?: unknown;
    sellDecimals?: unknown;
    buyDecimals?: unknown;
  };
  const expected = checks.expectedOut;
  return {
    intentId: r.intent_id,
    chainId: r.chain_id,
    agentId: r.agent_id,
    account: r.account ? getAddress(r.account) : null,
    custody: r.custody,
    sell: r.sell,
    buy: r.buy,
    sellToken: r.sell_token ? getAddress(r.sell_token) : null,
    buyToken: r.buy_token ? getAddress(r.buy_token) : null,
    sellDecimals: decimalsOf(r.sell, checks.sellDecimals),
    buyDecimals: decimalsOf(r.buy, checks.buyDecimals),
    route: r.route ? r.route.map((id) => id as Hex) : null,
    amountIn: BigInt(r.amount_in),
    reason: r.reason,
    status: r.status,
    reasonCodes: r.reason_codes,
    blockers: r.blockers as unknown as StoredBlocker[],
    expectedOut: typeof expected === "string" ? BigInt(expected) : null,
    ownerEpoch: big(r.owner_epoch),
    configEpoch: big(r.config_epoch),
    strategyEpoch: big(r.strategy_epoch === null ? null : String(r.strategy_epoch)),
    source: r.source,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at ? new Date(r.approved_at) : null,
    submittedAt: r.submitted_at ? new Date(r.submitted_at) : null,
    settledAt: r.settled_at ? new Date(r.settled_at) : null,
    minAmountOut: big(r.min_amount_out),
    deadline: big(r.deadline),
    actionId: r.action_id,
    txId: r.tx_id,
    txHash: r.tx_hash,
    amountOut: big(r.amount_out),
    failure: r.failure,
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
    updatedAt: new Date(r.updated_at),
  };
}

function armingRecord(r: ArmingRow): ArmingRecord {
  return {
    armingId: r.arming_id,
    chainId: r.chain_id,
    agentId: r.agent_id,
    custody: r.custody,
    executor: r.executor ? getAddress(r.executor) : null,
    owner: getAddress(r.owner),
    ownerEpoch: BigInt(r.owner_epoch),
    configEpoch: BigInt(r.config_epoch),
    sessionKey: getAddress(r.session_key),
    validUntil: BigInt(r.valid_until),
    status: r.status,
    endedReason: r.ended_reason,
    firstIntentId: r.first_intent_id,
    revokedOnchain: r.revoked_onchain,
    remindedAt: r.reminded_at ? new Date(r.reminded_at) : null,
    armedAt: r.armed_at ? new Date(r.armed_at) : null,
    endedAt: r.ended_at ? new Date(r.ended_at) : null,
    createdAt: new Date(r.created_at),
  };
}

export interface WhyNotTraded {
  readonly armingState: ArmingState;
  /** Why the last arming ended, when the agent is not armed now. */
  readonly armingEnded: { readonly reason: ArmingEndReason; readonly message: string } | null;
  /** The agent's own reasons, newest first: not armed, then its recent blocked trades. */
  readonly reasons: readonly (StoredBlocker & {
    readonly intentId: string | null;
    readonly at: string;
  })[];
  /** Trades proposed and waiting for the owner's approval. */
  readonly waitingForApproval: number;
  /**
   * P3-U3: the template runner's latest decision for the agent, null when it
   * never ran for it: a hold with its reason (also first in `reasons`) or the
   * leg it proposed.
   */
  readonly runner: {
    readonly outcome: "hold" | "leg";
    readonly code: string;
    readonly message: string;
    readonly since: string;
    readonly lastAt: string;
    readonly intentId: string | null;
  } | null;
}

/** The message for any reason code the runner can record: its own, the trade flow's or the Executor's. */
export function reasonFacts(code: string): Omit<StoredBlocker, "code"> {
  const own = RUNNER_HOLD_FACTS[code as RunnerHoldCode];
  if (own) return { message: own.message, clears: own.clears, clearsAt: null, hint: own.hint };
  const flow = TRADE_FLOW_MESSAGES[code as TradeFlowCode];
  const executor = REJECTION_MESSAGES[code as RejectionCode];
  return {
    message: flow ?? executor ?? code,
    clears: code === "NOT_ARMED" ? "by_the_owner" : "by_waiting",
    clearsAt: null,
    hint: "",
  };
}

function runnerReason(code: string, at: Date | string) {
  return { code, ...reasonFacts(code), intentId: null, at: new Date(at).toISOString() };
}

function runnerJson(
  outcome: "hold" | "leg",
  code: string,
  firstAt: Date | string,
  lastAt: Date | string,
  intentId: string | null,
) {
  return {
    outcome,
    code,
    message:
      outcome === "leg"
        ? "The runner proposed a trade toward the plan's target."
        : reasonFacts(code).message,
    since: new Date(firstAt).toISOString(),
    lastAt: new Date(lastAt).toISOString(),
    intentId,
  };
}

/** How far back "why did the agent not trade" looks for blocked trades. */
export const WHY_WINDOW_MS = 24 * 3_600_000;

export class TradeStore {
  readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** The agent's strategy epoch now (D-281): 0 before its first goal. */
  async strategyEpoch(chainId: number, agentId: number): Promise<bigint> {
    const row = await this.db
      .selectFrom("platform.agent_states")
      .select("strategy_epoch")
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();
    return row ? BigInt(row.strategy_epoch) : 0n;
  }

  // ---- arming ----

  armingRows(chainId: number, agentId?: number) {
    let q = this.db.selectFrom("platform.arming").selectAll().where("chain_id", "=", chainId);
    if (agentId !== undefined) q = q.where("agent_id", "=", agentId);
    return q.orderBy("created_at", "desc").execute();
  }

  /** The agent's open arming (awaiting its first trade, or armed), or null. */
  async openArming(chainId: number, agentId: number): Promise<ArmingRecord | null> {
    const row = await this.db
      .selectFrom("platform.arming")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("status", "!=", "ended")
      .executeTakeFirst();
    return row ? armingRecord(row) : null;
  }

  /** The agent's newest arming of any status, or null if it was never armed. */
  async lastArming(chainId: number, agentId: number): Promise<ArmingRecord | null> {
    const row = (await this.armingRows(chainId, agentId))[0];
    return row ? armingRecord(row) : null;
  }

  /** Every open arming on the chain, for the worker. */
  async openArmings(chainId: number): Promise<ArmingRecord[]> {
    const rows = await this.db
      .selectFrom("platform.arming")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("status", "!=", "ended")
      .execute();
    return rows.map(armingRecord);
  }

  /**
   * Records a confirmed grant. The same grant again (same owner, epochs and
   * key) renews the open arming in place: a new expiry, a fresh reminder, the
   * same status. Any other open arming is ended as replaced (revoked) first.
   */
  async startArming(a: {
    chainId: number;
    agentId: number;
    owner: Hex;
    ownerEpoch: bigint;
    configEpoch: bigint;
    sessionKey: Hex;
    validUntil: bigint;
    /** F-U5: the custody set and the Executor the grant is on; v2 when absent. */
    custody?: CustodyPath;
    executor?: Hex | null;
  }): Promise<{ record: ArmingRecord; renewed: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const at = this.now();
      const open = await trx
        .selectFrom("platform.arming")
        .selectAll()
        .where("chain_id", "=", a.chainId)
        .where("agent_id", "=", a.agentId)
        .where("status", "!=", "ended")
        .forUpdate()
        .executeTakeFirst();
      if (open) {
        const same =
          dbAddress(open.owner) === dbAddress(a.owner) &&
          BigInt(open.owner_epoch) === a.ownerEpoch &&
          BigInt(open.config_epoch) === a.configEpoch &&
          dbAddress(open.session_key) === dbAddress(a.sessionKey) &&
          open.custody === (a.custody ?? "v2");
        if (same) {
          const row = await trx
            .updateTable("platform.arming")
            .set({ valid_until: a.validUntil.toString(), reminded_at: null, updated_at: at })
            .where("arming_id", "=", open.arming_id)
            .returningAll()
            .executeTakeFirstOrThrow();
          return { record: armingRecord(row), renewed: true };
        }
        await trx
          .updateTable("platform.arming")
          .set({ status: "ended", ended_reason: "revoked", ended_at: at, updated_at: at })
          .where("arming_id", "=", open.arming_id)
          .execute();
      }
      const row = await trx
        .insertInto("platform.arming")
        .values({
          arming_id: `arming-${randomUUID()}`,
          chain_id: a.chainId,
          agent_id: a.agentId,
          owner: dbAddress(a.owner),
          owner_epoch: a.ownerEpoch.toString(),
          config_epoch: a.configEpoch.toString(),
          session_key: dbAddress(a.sessionKey),
          valid_until: a.validUntil.toString(),
          custody: a.custody ?? "v2",
          executor: a.executor ? dbAddress(a.executor) : null,
          status: "awaiting_first_trade",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { record: armingRecord(row), renewed: false };
    });
  }

  /** Ends an open arming. Returns the ended record, or null if it had already ended. */
  async endArming(
    armingId: string,
    reason: ArmingEndReason,
    revokedOnchain = false,
  ): Promise<ArmingRecord | null> {
    const at = this.now();
    const row = await this.db
      .updateTable("platform.arming")
      .set({
        status: "ended",
        ended_reason: reason,
        ended_at: at,
        updated_at: at,
        revoked_onchain: revokedOnchain,
      })
      .where("arming_id", "=", armingId)
      .where("status", "!=", "ended")
      .returningAll()
      .executeTakeFirst();
    return row ? armingRecord(row) : null;
  }

  /** Records that the owner's revoke landed on chain for an ended arming. */
  async markRevokedOnchain(armingId: string): Promise<void> {
    await this.db
      .updateTable("platform.arming")
      .set({ revoked_onchain: true, updated_at: this.now() })
      .where("arming_id", "=", armingId)
      .execute();
  }

  /** Disarmed armings whose grant may still be on chain, for the worker to watch for the revoke. */
  async unrevokedDisarmed(chainId: number): Promise<ArmingRecord[]> {
    const rows = await this.db
      .selectFrom("platform.arming")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("status", "=", "ended")
      .where("ended_reason", "=", "disarmed")
      .where("revoked_onchain", "=", false)
      .where("ended_at", ">=", new Date(this.now().getTime() - 31 * 86_400_000))
      .execute();
    return rows.map(armingRecord);
  }

  /** The owner approved the first trade: the agent is armed. Null if it was not waiting. */
  async markArmed(armingId: string, firstIntentId: string): Promise<ArmingRecord | null> {
    const at = this.now();
    const row = await this.db
      .updateTable("platform.arming")
      .set({ status: "armed", first_intent_id: firstIntentId, armed_at: at, updated_at: at })
      .where("arming_id", "=", armingId)
      .where("status", "=", "awaiting_first_trade")
      .returningAll()
      .executeTakeFirst();
    return row ? armingRecord(row) : null;
  }

  /** Marks the renewal reminder sent; false if another worker already did. */
  async markReminded(armingId: string): Promise<boolean> {
    const r = await this.db
      .updateTable("platform.arming")
      .set({ reminded_at: this.now(), updated_at: this.now() })
      .where("arming_id", "=", armingId)
      .where("reminded_at", "is", null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }

  /** The owner renewed the grant on chain (same key and epochs): a new expiry. */
  async renewTo(armingId: string, validUntil: bigint): Promise<void> {
    await this.db
      .updateTable("platform.arming")
      .set({ valid_until: validUntil.toString(), reminded_at: null, updated_at: this.now() })
      .where("arming_id", "=", armingId)
      .where("status", "!=", "ended")
      .execute();
  }

  // ---- intents ----

  intentRows(chainId: number, agentId?: number) {
    let q = this.db.selectFrom("platform.intents").selectAll().where("chain_id", "=", chainId);
    if (agentId !== undefined) q = q.where("agent_id", "=", agentId);
    return q.orderBy("created_at", "desc").execute();
  }

  /** Marks waiting intents past their expiry as expired, releasing their slots. */
  async expireDue(chainId: number, agentId?: number): Promise<number> {
    let q = this.db
      .updateTable("platform.intents")
      .set({ status: "expired", updated_at: this.now() })
      .where("chain_id", "=", chainId)
      .where("status", "=", "awaiting_approval")
      .where("expires_at", "<=", this.now());
    if (agentId !== undefined) q = q.where("agent_id", "=", agentId);
    return Number((await q.executeTakeFirst()).numUpdatedRows);
  }

  async intent(chainId: number, agentId: number, intentId: string): Promise<IntentView | null> {
    await this.expireDue(chainId, agentId);
    const row = await this.db
      .selectFrom("platform.intents")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("intent_id", "=", intentId)
      .executeTakeFirst();
    return row ? intentView(row) : null;
  }

  /** An agent's intents, newest first. */
  async intents(chainId: number, agentId: number, limit = 20): Promise<IntentView[]> {
    await this.expireDue(chainId, agentId);
    const rows = await this.db
      .selectFrom("platform.intents")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map(intentView);
  }

  /**
   * Trade slots the agent's other intents hold (waiting, approved or
   * submitted). For an intent being submitted, pass it: then only the sent
   * ones and those proposed before it count, so the oldest goes first.
   */
  async reservedSlots(
    chainId: number,
    agentId: number,
    submitting?: { intentId: string; createdAt: Date },
  ): Promise<number> {
    await this.expireDue(chainId, agentId);
    let q = this.db
      .selectFrom("platform.intents")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("status", "in", [...SLOT_HOLDING_INTENT_STATES]);
    if (submitting)
      q = q
        .where("intent_id", "!=", submitting.intentId)
        .where((eb) =>
          eb.or([eb("status", "=", "submitted"), eb("created_at", "<", submitting.createdAt)]),
        );
    return Number((await q.executeTakeFirstOrThrow()).n);
  }

  /** Every intent on the chain in these states, oldest first, for the worker. */
  async intentsIn(chainId: number, statuses: readonly IntentState[]): Promise<IntentView[]> {
    await this.expireDue(chainId);
    const rows = await this.db
      .selectFrom("platform.intents")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("status", "in", [...statuses])
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(intentView);
  }

  /**
   * Approves a waiting intent, by the owner or automatically when armed.
   * Null when it is not waiting (already moved, rejected or expired).
   */
  async approve(
    chainId: number,
    agentId: number,
    intentId: string,
    by: "owner" | "auto",
  ): Promise<IntentView | null> {
    await this.expireDue(chainId, agentId);
    const at = this.now();
    const row = await this.db
      .updateTable("platform.intents")
      .set({ status: "approved", approved_by: by, approved_at: at, updated_at: at })
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("intent_id", "=", intentId)
      .where("status", "=", "awaiting_approval")
      .returningAll()
      .executeTakeFirst();
    return row ? intentView(row) : null;
  }

  /** The owner rejects a waiting intent: cancelled, its trade slot freed. Null if it was not waiting. */
  async rejectByOwner(
    chainId: number,
    agentId: number,
    intentId: string,
  ): Promise<IntentView | null> {
    await this.expireDue(chainId, agentId);
    const row = await this.db
      .updateTable("platform.intents")
      .set({ status: "cancelled", failure: "Rejected by the owner.", updated_at: this.now() })
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("intent_id", "=", intentId)
      .where("status", "=", "awaiting_approval")
      .returningAll()
      .executeTakeFirst();
    return row ? intentView(row) : null;
  }

  /** An approved intent was accepted into the signer's outbox. */
  async markSubmitted(
    intentId: string,
    s: {
      txId: string;
      actionId: string;
      minAmountOut: bigint;
      deadline: bigint;
      /** The route the swap was sent along (v3), when it differs from the proposal's. */
      route?: readonly Hex[];
    },
  ): Promise<boolean> {
    const at = this.now();
    const r = await this.db
      .updateTable("platform.intents")
      .set({
        status: "submitted",
        tx_id: s.txId,
        action_id: s.actionId,
        min_amount_out: s.minAmountOut.toString(),
        deadline: s.deadline.toString(),
        ...(s.route ? { route: JSON.stringify([...s.route]) } : {}),
        submitted_at: at,
        updated_at: at,
      })
      .where("intent_id", "=", intentId)
      .where("status", "=", "approved")
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }

  /** The swap was mined and succeeded. */
  async markConfirmed(intentId: string, txHash: string): Promise<boolean> {
    const r = await this.db
      .updateTable("platform.intents")
      .set({ status: "confirmed", tx_hash: txHash, updated_at: this.now() })
      .where("intent_id", "=", intentId)
      .where("status", "=", "submitted")
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }

  /** The swap's event matched the balances and its ledger entry exists: settled. */
  async markReconciled(intentId: string, amountOut: bigint, txHash: string): Promise<boolean> {
    const at = this.now();
    const r = await this.db
      .updateTable("platform.intents")
      .set({
        status: "reconciled",
        amount_out: amountOut.toString(),
        tx_hash: txHash,
        settled_at: at,
        updated_at: at,
      })
      .where("intent_id", "=", intentId)
      .where("status", "in", ["submitted", "confirmed"])
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }

  /**
   * Stops an intent with every reason: rejected when the checks refused it
   * before anything was sent, failed when it was sent and did not go through.
   */
  async markStopped(
    intentId: string,
    from: readonly IntentState[],
    to: "rejected" | "failed",
    failure: string,
    blockers: readonly StoredBlocker[],
  ): Promise<boolean> {
    const r = await this.db
      .updateTable("platform.intents")
      .set({
        status: to,
        failure: failure.slice(0, 500),
        blockers: JSON.stringify(blockers),
        reason_codes: JSON.stringify(blockers.map((b) => b.code)),
        updated_at: this.now(),
      })
      .where("intent_id", "=", intentId)
      .where("status", "in", [...from])
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }

  // ---- why the agent did not trade ----

  /** The agent's arming state and its recent blocked trades, each with its reasons. */
  async whyNotTraded(chainId: number, agentId: number): Promise<WhyNotTraded> {
    await this.expireDue(chainId, agentId);
    const last = await this.lastArming(chainId, agentId);
    const state = armingState(last);
    const since = new Date(this.now().getTime() - WHY_WINDOW_MS);
    const rows = await this.db
      .selectFrom("platform.intents")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("updated_at", ">=", since)
      .orderBy("updated_at", "desc")
      .limit(50)
      .execute();
    const reasons: (StoredBlocker & { intentId: string | null; at: string })[] = [];
    if (state === "unarmed")
      reasons.push({
        code: "NOT_ARMED",
        message: TRADE_FLOW_MESSAGES.NOT_ARMED,
        clears: "by_the_owner",
        clearsAt: null,
        hint: "The owner arms the agent, or approves its trades one by one.",
        intentId: null,
        at: (last?.endedAt ?? this.now()).toISOString(),
      });
    // P3-U3: the runner's latest decision; a hold is the first reason the agent did not trade.
    const decision = await this.db
      .selectFrom("platform.runner_decisions")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("decision_id", "desc")
      .limit(1)
      .executeTakeFirst();
    const runner = decision
      ? runnerJson(
          decision.outcome,
          decision.code,
          decision.first_at,
          decision.last_at,
          decision.intent_id,
        )
      : null;
    if (decision && decision.outcome === "hold")
      reasons.unshift(runnerReason(decision.code, decision.last_at));
    for (const r of rows
      .filter((x) => x.status === "rejected" || x.status === "failed")
      .slice(0, 5))
      for (const b of r.blockers as unknown as StoredBlocker[])
        reasons.push({ ...b, intentId: r.intent_id, at: new Date(r.updated_at).toISOString() });
    return {
      armingState: state,
      armingEnded:
        state === "unarmed" && last?.endedReason
          ? { reason: last.endedReason, message: ARMING_END_MESSAGES[last.endedReason] }
          : null,
      reasons,
      waitingForApproval: rows.filter((x) => x.status === "awaiting_approval").length,
      runner,
    };
  }
}
