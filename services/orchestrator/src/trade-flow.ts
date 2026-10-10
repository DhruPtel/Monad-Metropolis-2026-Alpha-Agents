import {
  type Blocker,
  type ChainReader,
  type ChainReaderV3,
  assessTrade,
  assessTradeV3,
  blocker,
  floorForV3,
  routeTokensOf,
  tradeNow,
} from "@alpha-agents/chain-tools";
import {
  ARMING_END_MESSAGES,
  ASSET_DECIMALS,
  type ArmingEndReason,
  type AssetId,
  type CustodyPath,
  INTENT_SCHEMA_VERSION,
  INTENT_SCHEMA_VERSION_V3,
  ROUTE_ADAPTER_ID,
  executorV3SwapGasLimit,
} from "@alpha-agents/domain";
import {
  type AcceptResult,
  MAX_FEE_PER_GAS_CAP,
  MAX_PRIORITY_FEE_CAP,
  SWAP_GAS_LIMIT,
  type SwapIntentArgs,
  type SwapIntentV3Args,
} from "@alpha-agents/signer";
import {
  type ArmingRecord,
  type IntentView,
  type StoredBlocker,
  type TradeStore,
  armingEnd,
  grantDate,
  renewalDue,
} from "@alpha-agents/trading";
import { type Hex, formatUnits, isAddressEqual, keccak256, toBytes } from "viem";
import type { ArmingFacts, BlockedFacts, TradeFacts } from "./narrator.ts";

/**
 * The trade flow (P2-U6): proposals become trades. Each pass, for one chain:
 *
 * 1. Arming upkeep: every open arming is checked against a fresh chain read
 *    and ends on expiry, a sale, a configuration change or a revoked grant;
 *    a renewed grant moves its expiry; the renewal reminder is written once.
 * 2. Approval: an armed agent's waiting intents are approved automatically.
 * 3. Submission: an intent proposed under an earlier goal (a stale strategy
 *    epoch, D-281) is refused and the arming stays open; every other approved
 *    intent re-runs every pre-check on fresh reads
 *    (its trade slot excluded from the reserved ones), plus the funding
 *    address's MON for gas; anything changed refuses it with every reason.
 *    The minimum output comes from a fresh quote within the slippage limit,
 *    never under the oracle floor, and the deadline is set now. Then the swap
 *    goes into the signer's outbox under an action ID derived from the intent.
 * 4. Settlement: an intent follows its outbox row. It is confirmed when the
 *    swap is mined, and settled (reconciled) only once the signer reconciled
 *    it and, off the local fork, its block is finalized.
 *
 * Narrator entries are written for arming, each executed trade and each
 * blocked trade; they are best effort and never hold the flow up.
 */

export interface TradeFlowSigner {
  submitSwap(agentId: number, intent: SwapIntentArgs): Promise<AcceptResult>;
  /** F-U5: an Executor v3 swap, with the route's gas limit and the tokens the route crosses. */
  submitSwapV3(
    agentId: number,
    intent: SwapIntentV3Args,
    gas: bigint,
    routeTokens: readonly Hex[],
  ): Promise<AcceptResult>;
  /**
   * The agent's session key (its funding address, D-243), created in the
   * signer if it has none yet: the signer records keys lazily (L-120, L-126).
   */
  createKey(agentId: number): Promise<Hex>;
}

export interface TradeFlowGas {
  balance(address: Hex): Promise<bigint>;
  /** The most one swap's gas can cost now, as the signer would price it; `gas` for a v3 route's limit. */
  swapCost(gas?: bigint): Promise<bigint>;
  /** Local fork only: funds the key instead of blocking the trade. */
  topUp?: (address: Hex, wei: bigint) => Promise<void>;
}

export interface TradeFlowNarrator {
  narrateEvent(
    chainId: number,
    agentId: number,
    key: string,
    facts: ArmingFacts | TradeFacts | BlockedFacts,
  ): Promise<unknown>;
}

export interface TradeFlowOptions {
  readonly chainId: number;
  readonly store: TradeStore;
  readonly reader: ChainReader;
  /** F-U5: the fund agent's v3 set; v3 intents and armings read and send through it (D-367). */
  readonly readerV3?: ChainReaderV3 | null;
  readonly signer: TradeFlowSigner;
  readonly gas: TradeFlowGas;
  /**
   * The newest finalized block, or null where the chain's own receipts are
   * final enough (the local fork). Off the fork, a trade settles only at or
   * below it.
   */
  readonly finalizedBlock: () => Promise<bigint | null>;
  readonly narrator?: TradeFlowNarrator | null;
  /** Called once per settled trade (for its value snapshot); errors are logged, never thrown. */
  readonly onSettled?: (i: IntentView) => Promise<unknown>;
  readonly log: (line: string) => void;
}

const agentName = (agentId: number) => `Agent #${agentId}`;
const amountText = (asset: "USDC" | "WMON", raw: bigint) => formatUnits(raw, ASSET_DECIMALS[asset]);
/** A v2 intent names USDC or WMON on both sides. */
const v2Pair = (i: IntentView): { sell: AssetId; buy: AssetId } => ({
  sell: i.sell as AssetId,
  buy: i.buy as AssetId,
});

/** The Executor's action ID for an intent: one intent is one action, whatever retries. */
export const actionIdOf = (chainId: number, intentId: string): Hex =>
  keccak256(toBytes(`alpha-agents:intent:${chainId}:${intentId}`));

/** The minimum output: the fresh quote less the slippage limit, never under the oracle floor. */
export function minAmountOutFor(quoteOut: bigint, floor: bigint, maxSlippageBps: number): bigint {
  const fromQuote = (quoteOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  const min = fromQuote > floor ? fromQuote : floor;
  return min > 0n ? min : 1n;
}

/** A swap's most gas cost at these fees, priced as the signer prices it (A-38); `gas` for a v3 route's limit. */
export function swapGasCost(baseFee: bigint, priorityFee: bigint, gas = SWAP_GAS_LIMIT): bigint {
  const tip = priorityFee < MAX_PRIORITY_FEE_CAP ? priorityFee : MAX_PRIORITY_FEE_CAP;
  const maxFee = baseFee * 2n + tip;
  return gas * (maxFee > MAX_FEE_PER_GAS_CAP ? MAX_FEE_PER_GAS_CAP : maxFee);
}

export class TradeFlow {
  private readonly o: TradeFlowOptions;
  /** Entries already asked for in this process, so a slow narrator is not asked twice. */
  private readonly narrated = new Set<string>();

  constructor(o: TradeFlowOptions) {
    this.o = o;
  }

  /** One pass over the chain: arming, approvals, submissions, settlements. */
  async tick(): Promise<void> {
    await this.upkeepArmings();
    await this.autoApprove();
    for (const i of await this.o.store.intentsIn(this.o.chainId, ["approved"]))
      await this.guard(i, () => this.submit(i));
    for (const i of await this.o.store.intentsIn(this.o.chainId, ["submitted", "confirmed"]))
      await this.guard(i, () => this.follow(i));
  }

  private async guard(i: IntentView, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.o.log(
        `agent ${i.agentId}: ${i.intentId}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
    }
  }

  // ---- arming ----

  /** Ends, renews or reminds every open arming from a fresh chain read. Returns the ended ones. */
  /** The chain view for a grant's own custody set: Executor v3's for a v3 arming, v2's otherwise. */
  private agentView(custody: CustodyPath, agentId: number) {
    const v3 = this.o.readerV3;
    return custody === "v3" && v3 ? v3.agent(agentId) : this.o.reader.agent(agentId);
  }

  async upkeepArmings(): Promise<ArmingRecord[]> {
    const ended: ArmingRecord[] = [];
    for (const r of await this.o.store.openArmings(this.o.chainId)) {
      const chain = await this.agentView(r.custody, r.agentId);
      if (!chain) continue;
      const reason = armingEnd(r, chain);
      if (reason) {
        const done = await this.endArming(r, reason);
        if (done) ended.push(done);
        continue;
      }
      this.narrate(r.agentId, `${r.armingId}:registered`, {
        agent: agentName(r.agentId),
        activity: "arming",
        event: "grant_registered",
        grantValidUntil: grantDate(r.validUntil),
        endReason: null,
      });
      if (r.status === "armed")
        this.narrate(r.agentId, `${r.armingId}:armed`, {
          agent: agentName(r.agentId),
          activity: "arming",
          event: "armed",
          grantValidUntil: grantDate(r.validUntil),
          endReason: null,
        });
      if (chain.grant && chain.grant.validUntil !== r.validUntil) {
        await this.o.store.renewTo(r.armingId, chain.grant.validUntil);
        continue;
      }
      if (renewalDue(r, chain.timestamp) && (await this.o.store.markReminded(r.armingId)))
        this.narrate(r.agentId, `${r.armingId}:renewal`, {
          agent: agentName(r.agentId),
          activity: "arming",
          event: "renewal_due",
          grantValidUntil: grantDate(r.validUntil),
          endReason: null,
        });
    }
    // A disarm ends arming at once; the owner's revoke then removes the grant on chain.
    for (const r of await this.o.store.unrevokedDisarmed(this.o.chainId)) {
      const chain = await this.agentView(r.custody, r.agentId);
      if (chain && (!chain.grant || !isAddressEqual(chain.grant.key, r.sessionKey)))
        await this.o.store.markRevokedOnchain(r.armingId);
    }
    return ended;
  }

  /** Ends an arming with its reason and narrates it; null if it had already ended. */
  async endArming(
    r: ArmingRecord,
    reason: ArmingEndReason,
    revokedOnchain = false,
  ): Promise<ArmingRecord | null> {
    const done = await this.o.store.endArming(r.armingId, reason, revokedOnchain);
    if (!done) return null;
    this.o.log(`agent ${r.agentId}: arming ended (${reason})`);
    this.narrate(r.agentId, `${r.armingId}:ended`, {
      agent: agentName(r.agentId),
      activity: "arming",
      event: "ended",
      grantValidUntil: grantDate(r.validUntil),
      endReason: ARMING_END_MESSAGES[reason],
    });
    return done;
  }

  /** Approves the waiting intents of every armed agent, for this arming's owner and epochs only. */
  async autoApprove(): Promise<number> {
    let n = 0;
    const armed = (await this.o.store.openArmings(this.o.chainId)).filter(
      (r) => r.status === "armed",
    );
    if (armed.length === 0) return 0;
    for (const i of await this.o.store.intentsIn(this.o.chainId, ["awaiting_approval"])) {
      const r = armed.find((a) => a.agentId === i.agentId);
      if (!r || i.ownerEpoch !== r.ownerEpoch || i.configEpoch !== r.configEpoch) continue;
      if (await this.o.store.approve(this.o.chainId, i.agentId, i.intentId, "auto")) n += 1;
    }
    return n;
  }

  // ---- submission ----

  /** Re-runs every check on fresh reads and sends the swap, or refuses it with every reason. */
  async submit(i: IntentView): Promise<void> {
    const chainId = this.o.chainId;
    const arming = await this.o.store.openArming(chainId, i.agentId);
    if (!arming) return this.refuse(i, "not armed at submission", [blocker("NOT_ARMED", null)]);
    // A grant on the other custody set does not cover this intent (D-367).
    if (arming.custody !== i.custody)
      return this.refuse(i, `armed on ${arming.custody}, the intent trades on ${i.custody}`, [
        blocker("NOT_ARMED", null),
      ]);
    if (i.custody === "v3") return this.submitV3(i);
    // Proposed under an earlier goal: never sent, and the arming stays open (D-281).
    const strategyEpoch = await this.o.store.strategyEpoch(chainId, i.agentId);
    if ((i.strategyEpoch ?? 0n) !== strategyEpoch)
      return this.refuse(
        i,
        `proposed at strategy epoch ${i.strategyEpoch ?? 0n}, now ${strategyEpoch}`,
        [blocker("STRATEGY_EPOCH_STALE", null)],
      );
    const key = await this.o.signer.createKey(i.agentId);
    const reserved = await this.o.store.reservedSlots(chainId, i.agentId, i);
    const { sell, buy } = v2Pair(i);
    const assessed = await assessTrade(this.o.reader, i.agentId, sell, i.amountIn, key, reserved);
    if (!assessed)
      return this.refuse(i, "the agent has no trading account", [blocker("INTENT_INVALID", null)]);
    const { m, a, quote } = assessed;
    const blockers: Blocker[] = [...assessed.blockers];
    // The intent was proposed for this owner and configuration; a sale or a change since voids it.
    if (
      (i.ownerEpoch !== null && i.ownerEpoch !== a.ownerEpoch) ||
      (i.configEpoch !== null && i.configEpoch !== a.configEpoch)
    )
      if (!blockers.some((b) => b.code === "EPOCH_MISMATCH"))
        blockers.push(blocker("EPOCH_MISMATCH", null));
    const gas = await this.gasBlocker(key);
    if (gas) blockers.push(gas);
    // Every gap names its own reason: no venue on chain, or no quote from it.
    if (!m.venue && !blockers.some((b) => b.code === "VENUE_NOT_ALLOWED"))
      blockers.push(blocker("VENUE_NOT_ALLOWED", null));
    if (!quote && !blockers.some((b) => b.code === "SIMULATION_FAILED"))
      blockers.push(blocker("SIMULATION_FAILED", null));
    if (blockers.length > 0 || !quote || !m.venue)
      return this.refuse(i, "a check changed between proposal and submission", blockers);
    const floor = tradeNow(sell, i.amountIn, m).minAmountOut;
    const minAmountOut = minAmountOutFor(quote.amountOut, floor, m.policy.maxSlippageBps);
    const deadline = m.timestamp + BigInt(m.policy.deadlineSeconds);
    const actionId = actionIdOf(chainId, i.intentId);
    const swap: SwapIntentArgs = {
      schemaVersion: INTENT_SCHEMA_VERSION,
      chainId: BigInt(chainId),
      agentId: BigInt(i.agentId),
      account: a.account as Hex,
      actionId,
      ownerEpoch: a.ownerEpoch,
      configEpoch: a.configEpoch,
      policyHash: m.policyHash,
      adapterId: m.venue.adapterId,
      tokenIn: this.o.reader.tokenOf(sell),
      tokenOut: this.o.reader.tokenOf(buy),
      amountIn: i.amountIn,
      minAmountOut,
      deadline,
    };
    const accepted = await this.o.signer.submitSwap(i.agentId, swap);
    if (accepted.status === "failed")
      return this.refuse(i, `the signer refused it: ${accepted.reasonCode ?? "unknown"}`, [
        blocker("SEND_FAILED", null),
      ]);
    await this.o.store.markSubmitted(i.intentId, {
      txId: accepted.txId,
      actionId,
      minAmountOut,
      deadline,
    });
    this.o.log(
      `agent ${i.agentId}: ${i.intentId} submitted (${amountText(sell, i.amountIn)} ${i.sell}, approved by ${i.approvedBy ?? "?"})`,
    );
  }

  /**
   * F-U5: an Executor v3 intent. Every pre-check again on fresh reads along
   * the best route now, the gas limit from the route's hops and the held
   * list after the trade (F-U4's rule), the minimum output from the quote
   * within the pair's slippage limit, never under the floor, and the swap
   * into the signer's outbox with the tokens its route crosses.
   */
  private async submitV3(i: IntentView): Promise<void> {
    const chainId = this.o.chainId;
    const reader = this.o.readerV3;
    if (!reader || !i.sellToken || !i.buyToken)
      return this.refuse(i, "the fund agent's set is not deployed here", [
        blocker("VENUE_NOT_ALLOWED", null),
      ]);
    const strategyEpoch = await this.o.store.strategyEpoch(chainId, i.agentId);
    if ((i.strategyEpoch ?? 0n) !== strategyEpoch)
      return this.refuse(
        i,
        `proposed at strategy epoch ${i.strategyEpoch ?? 0n}, now ${strategyEpoch}`,
        [blocker("STRATEGY_EPOCH_STALE", null)],
      );
    const key = await this.o.signer.createKey(i.agentId);
    const reserved = await this.o.store.reservedSlots(chainId, i.agentId, i);
    const assessed = await assessTradeV3(
      reader,
      i.agentId,
      i.sellToken,
      i.buyToken,
      i.amountIn,
      key,
      reserved,
    );
    if (!assessed)
      return this.refuse(i, "the agent has no fund account", [blocker("INTENT_INVALID", null)]);
    const { m, a, sell, buy, quote } = assessed;
    const blockers: Blocker[] = [...assessed.blockers];
    if (
      (i.ownerEpoch !== null && i.ownerEpoch !== a.ownerEpoch) ||
      (i.configEpoch !== null && i.configEpoch !== a.configEpoch)
    )
      if (!blockers.some((b) => b.code === "EPOCH_MISMATCH"))
        blockers.push(blocker("EPOCH_MISMATCH", null));
    // The gas limit: this route's hops, and the held list once the token bought has joined it.
    const hops = quote?.route.length ?? 1;
    const heldAfter =
      a.holdings.filter((h) => h.balance > 0n).length +
      (a.holdings.some((h) => isAddressEqual(h.token, buy.token) && h.balance > 0n) ? 0 : 1);
    const gasLimit = executorV3SwapGasLimit(hops, Math.min(Math.max(heldAfter, 1), 16));
    const gas = await this.gasBlocker(key, gasLimit);
    if (gas) blockers.push(gas);
    if (
      !quote &&
      !blockers.some((b) => b.code === "SIMULATION_FAILED" || b.code === "ROUTE_INVALID")
    )
      blockers.push(blocker("SIMULATION_FAILED", null));
    if (blockers.length > 0 || !quote)
      return this.refuse(i, "a check changed between proposal and submission", blockers);
    const classA = sell.priceClass === "A" || buy.priceClass === "A";
    const slippageBps = classA ? m.policy.maxSlippageClassABps : m.policy.maxSlippageBps;
    const floor = floorForV3(m, sell, buy, i.amountIn);
    const minAmountOut = minAmountOutFor(quote.amountOut, floor, slippageBps);
    const deadline = m.timestamp + BigInt(m.policy.deadlineSeconds);
    const actionId = actionIdOf(chainId, i.intentId);
    const route = quote.route.map((p) => p.poolId);
    const swap: SwapIntentV3Args = {
      schemaVersion: INTENT_SCHEMA_VERSION_V3,
      chainId: BigInt(chainId),
      agentId: BigInt(i.agentId),
      account: a.account,
      actionId,
      ownerEpoch: a.ownerEpoch,
      configEpoch: a.configEpoch,
      policyHash: m.policyHash,
      adapterId: ROUTE_ADAPTER_ID,
      tokenIn: sell.token,
      tokenOut: buy.token,
      amountIn: i.amountIn,
      minAmountOut,
      deadline,
      route,
      attestationIn: "0x",
      attestationOut: "0x",
    };
    const accepted = await this.o.signer.submitSwapV3(
      i.agentId,
      swap,
      gasLimit,
      routeTokensOf(quote, sell.token),
    );
    if (accepted.status === "failed")
      return this.refuse(i, `the signer refused it: ${accepted.reasonCode ?? "unknown"}`, [
        blocker("SEND_FAILED", null),
      ]);
    await this.o.store.markSubmitted(i.intentId, {
      txId: accepted.txId,
      actionId,
      minAmountOut,
      deadline,
      route,
    });
    this.o.log(
      `agent ${i.agentId}: ${i.intentId} submitted (${formatUnits(i.amountIn, i.sellDecimals)} ${i.sell} for ${i.buy} over ${hops} hop${hops === 1 ? "" : "s"}, gas ${gasLimit}, approved by ${i.approvedBy ?? "?"})`,
    );
  }

  /** GAS_UNFUNDED when the funding address cannot pay for the swap; the local fork tops it up. */
  private async gasBlocker(key: Hex, gas?: bigint): Promise<Blocker | null> {
    const [balance, cost] = await Promise.all([this.o.gas.balance(key), this.o.gas.swapCost(gas)]);
    if (balance >= cost) return null;
    if (this.o.gas.topUp) {
      await this.o.gas.topUp(key, cost * 10n);
      return null;
    }
    return blocker("GAS_UNFUNDED", null);
  }

  private async refuse(i: IntentView, why: string, blockers: readonly Blocker[]): Promise<void> {
    if (!(await this.o.store.markStopped(i.intentId, ["approved"], "rejected", why, blockers)))
      return;
    this.o.log(
      `agent ${i.agentId}: ${i.intentId} blocked at submission: ${blockers.map((b) => b.code).join(", ")}`,
    );
    this.narrateBlocked(i, blockers);
  }

  // ---- settlement ----

  /** Moves a sent intent with its outbox row: confirmed, then settled after reconciliation. */
  async follow(i: IntentView): Promise<void> {
    if (!i.txId) return;
    const tx = await this.o.store.db
      .selectFrom("platform.signer_outbox")
      .select(["status", "tx_hash", "block_number", "amount_out", "reason_code", "reason"])
      .where("tx_id", "=", i.txId)
      .executeTakeFirst();
    if (!tx) return;
    if (tx.status === "failed") {
      const b = blocker("SEND_FAILED", null);
      const stopped: StoredBlocker = {
        ...b,
        hint: `${b.hint} (${tx.reason_code ?? "failed"})`,
      };
      const why = `${tx.reason_code ?? "failed"}: ${tx.reason ?? ""}`;
      if (
        await this.o.store.markStopped(i.intentId, ["submitted", "confirmed"], "failed", why, [
          stopped,
        ])
      ) {
        this.o.log(`agent ${i.agentId}: ${i.intentId} failed (${tx.reason_code ?? "?"})`);
        this.narrateBlocked(i, [stopped]);
      }
      return;
    }
    if (
      (tx.status === "confirmed" || tx.status === "reconciled") &&
      i.status === "submitted" &&
      tx.tx_hash
    )
      await this.o.store.markConfirmed(i.intentId, tx.tx_hash);
    if (tx.status !== "reconciled" || tx.amount_out === null || !tx.tx_hash) return;
    const finalized = await this.o.finalizedBlock();
    if (finalized !== null && (tx.block_number === null || BigInt(tx.block_number) > finalized))
      return;
    const amountOut = BigInt(tx.amount_out);
    if (!(await this.o.store.markReconciled(i.intentId, amountOut, tx.tx_hash))) return;
    if (this.o.onSettled)
      await this.o
        .onSettled(i)
        .catch((err: unknown) =>
          this.o.log(
            `agent ${i.agentId}: no snapshot after ${i.intentId}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
          ),
        );
    const soldText = formatUnits(i.amountIn, i.sellDecimals);
    const boughtText = formatUnits(amountOut, i.buyDecimals);
    this.o.log(
      `agent ${i.agentId}: ${i.intentId} settled: ${soldText} ${i.sell} for ${boughtText} ${i.buy}`,
    );
    this.narrate(i.agentId, `${i.intentId}:trade`, {
      agent: agentName(i.agentId),
      activity: "trade",
      sold: { asset: i.sell, amount: soldText },
      bought: { asset: i.buy, amount: boughtText },
      approvedBy: i.approvedBy === "owner" ? "the owner" : "automatically (armed)",
    });
  }

  // ---- narration ----

  private narrateBlocked(i: IntentView, blockers: readonly StoredBlocker[]) {
    this.narrate(i.agentId, `${i.intentId}:blocked`, {
      agent: agentName(i.agentId),
      activity: "blocked_trade",
      sell: { asset: i.sell, amount: formatUnits(i.amountIn, i.sellDecimals) },
      buy: i.buy,
      reasons: blockers.map((b) => ({ code: b.code, message: b.message, clears: b.clears })),
    });
  }

  narrate(agentId: number, key: string, facts: ArmingFacts | TradeFacts | BlockedFacts): void {
    const n = this.o.narrator;
    if (!n || this.narrated.has(key)) return;
    this.narrated.add(key);
    void n.narrateEvent(this.o.chainId, agentId, key, facts).catch(() => undefined);
  }
}
