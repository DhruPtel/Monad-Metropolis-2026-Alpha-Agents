import { randomUUID } from "node:crypto";
import {
  type AgentCredits,
  CREDIT_CAP_USDC_E6,
  type JournalEntry,
  chargeFor,
  depositEntry,
  keyBudgetUsd,
  reversalEntry,
  spendable,
  splitDeposit,
  usageEntry,
  usdToPicos,
} from "@alpha-agents/accounting";
import { sql } from "@alpha-agents/db";
import type { CycleStore } from "../cycle/store.ts";
import { chargeWithinCeiling } from "../cycle/stages.ts";
import type { GatewayAdmin } from "../gateway-admin.ts";
import { type Log, type Redactor, errorText } from "../secrets.ts";
import type { AgentRef, Runtime, Store } from "../store.ts";
import type { Ledger } from "./ledger.ts";

/**
 * Credits for every agent (D-208, D-209):
 * - deposits: USDC the indexer saw arriving at a funding address is credited,
 *   up to the beta cap, the rest held (A-28); a deposit a reorg removed is reversed;
 * - metering: each LiteLLM request with a cost becomes a usage receipt and a
 *   usage entry at provider cost plus the markup (A-27);
 * - budget sync: each key's LiteLLM budget is its metered provider cost plus
 *   what the agent's spendable credits buy, so the gateway refuses the call
 *   after credits run out.
 * Everything per agent runs under the agent's advisory lock; the `...Locked`
 * methods are for callers that already hold it (the lock is not re-entrant).
 */
export interface CreditServiceOptions {
  readonly store: Store;
  readonly ledger: Ledger;
  readonly gateway: GatewayAdmin;
  readonly chainId: number;
  readonly environment: JournalEntry["environment"];
  /** The agent's decrypted virtual key, for its spend logs and budget. */
  readonly keyOf: (runtime: Runtime) => string | null;
  readonly redactor: Redactor;
  readonly log: Log;
  readonly cap?: bigint;
  /**
   * P3-U4: the research cycles' records. A call made under a cycle's stage is
   * charged at most what is left of the stage's ceiling, and the platform
   * absorbs the rest (D-298).
   */
  readonly cycles?: CycleStore;
}

/** How long a costed request may wait for the gate's record of its stage before it is metered without one. */
export const STAGE_ATTRIBUTION_GRACE_MS = 120_000;

export interface CreditView extends AgentCredits {
  readonly spendable: bigint;
  /** D-129: no spendable credits, so LLM work stops and the agent is RESTRICTED. */
  readonly restricted: boolean;
}

interface PendingDeposit {
  chain_id: number;
  agent_id: number;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_hash: string;
  from_address: string;
  value: string;
}

const depositKey = (d: {
  chain_id: number;
  tx_hash: string;
  log_index: number;
  block_hash: string;
}) => `deposit:${d.chain_id}:${d.tx_hash}:${d.log_index}:${d.block_hash}`;

export class CreditService {
  private readonly o: CreditServiceOptions;

  constructor(options: CreditServiceOptions) {
    this.o = options;
  }

  private ref(agentId: number): AgentRef {
    return { chainId: this.o.chainId, agentId };
  }

  async creditsOf(agentId: number): Promise<CreditView> {
    const c = await this.o.ledger.balances(this.o.chainId, agentId);
    const s = spendable(c);
    return { ...c, spendable: s, restricted: s === 0n };
  }

  // ---- deposits ----

  /** Credits every indexed deposit into a funding address not yet in the ledger. */
  async creditDeposits(): Promise<number[]> {
    const pending = (await this.o.store.db
      .selectFrom("indexer.usdc_transfers as t")
      .select([
        "t.chain_id",
        "t.agent_id",
        "t.tx_hash",
        "t.log_index",
        "t.block_number",
        "t.block_hash",
        "t.from_address",
        "t.value",
      ])
      .where("t.chain_id", "=", this.o.chainId)
      .where("t.direction", "=", "in")
      .where("t.account", "=", "funding")
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("platform.ledger_entries as e")
              .select("e.entry_id")
              .whereRef(
                "e.idempotency_key",
                "=",
                sql<string>`'deposit:' || t.chain_id || ':' || t.tx_hash || ':' || t.log_index || ':' || t.block_hash`,
              ),
          ),
        ),
      )
      .orderBy("t.block_number")
      .orderBy("t.log_index")
      .execute()) as PendingDeposit[];
    const touched = new Set<number>();
    for (const d of pending) {
      await this.o.store.withAgentLock(this.ref(d.agent_id), () => this.creditOne(d));
      touched.add(d.agent_id);
    }
    return [...touched];
  }

  private async creditOne(d: PendingDeposit): Promise<void> {
    const amount = BigInt(d.value);
    if (amount <= 0n) return;
    const before = await this.o.ledger.balances(this.o.chainId, d.agent_id);
    const { credited, held } = splitDeposit(
      amount,
      before.credits,
      this.o.cap ?? CREDIT_CAP_USDC_E6,
    );
    const posted = await this.o.ledger.post(
      depositEntry(
        {
          environment: this.o.environment,
          entryId: randomUUID(),
          occurredAt: Math.floor(Date.now() / 1000),
          agentId: d.agent_id,
        },
        credited,
        held,
      ),
      {
        chainId: this.o.chainId,
        agentId: d.agent_id,
        idempotencyKey: depositKey(d),
        source: {
          kind: "usdc_transfer",
          txHash: d.tx_hash,
          logIndex: d.log_index,
          blockNumber: d.block_number,
          blockHash: d.block_hash,
          from: d.from_address,
          valueUsdcE6: d.value,
          heldUsdcE6: held.toString(),
        },
      },
    );
    if (!posted) return;
    this.o.log(
      `agent ${d.agent_id}: deposit of ${d.value} USDC units credited ${credited}` +
        (held > 0n ? `, ${held} held above the cap and flagged` : ""),
    );
  }

  /** Reverses credited deposits whose transfer is no longer in the index (a reorg). */
  async reverseOrphanDeposits(): Promise<number[]> {
    const orphans = await this.o.store.db
      .selectFrom("platform.ledger_entries as e")
      .select(["e.entry_id", "e.agent_id", "e.kind", "e.source"])
      .where("e.chain_id", "=", this.o.chainId)
      .where("e.kind", "in", ["credits_received", "deposit_held"])
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("indexer.usdc_transfers as t")
              .select("t.tx_hash")
              .whereRef("t.chain_id", "=", "e.chain_id")
              .where("t.direction", "=", "in")
              .where("t.account", "=", "funding")
              .where(
                sql<boolean>`e.idempotency_key = 'deposit:' || t.chain_id || ':' || t.tx_hash || ':' || t.log_index || ':' || t.block_hash`,
              ),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("platform.ledger_entries as r")
              .select("r.entry_id")
              .whereRef("r.idempotency_key", "=", sql<string>`'reversal:' || e.entry_id`),
          ),
        ),
      )
      .execute();
    const touched = new Set<number>();
    for (const o of orphans) {
      const lines = await this.o.store.db
        .selectFrom("platform.ledger_lines")
        .selectAll()
        .where("entry_id", "=", o.entry_id)
        .orderBy("line_no")
        .execute();
      const original = {
        environment: this.o.environment,
        entryId: o.entry_id,
        occurredAt: 0,
        kind: o.kind as JournalEntry["kind"],
        lines: lines.map((l) => ({
          account: l.account as JournalEntry["lines"][number]["account"],
          asset: l.asset as "USDC",
          amountRaw: BigInt(l.amount),
          ...(l.agent_id === null ? {} : { agentId: l.agent_id }),
        })),
      } as JournalEntry;
      await this.o.store.withAgentLock(this.ref(o.agent_id), () =>
        this.o.ledger.post(
          reversalEntry(
            {
              environment: this.o.environment,
              entryId: randomUUID(),
              occurredAt: Math.floor(Date.now() / 1000),
            },
            original,
          ),
          {
            chainId: this.o.chainId,
            agentId: o.agent_id,
            idempotencyKey: `reversal:${o.entry_id}`,
            source: { kind: "reorg", reverses: o.entry_id },
          },
        ),
      );
      this.o.log(`agent ${o.agent_id}: a reorg removed a credited deposit; reversed it`);
      touched.add(o.agent_id);
    }
    return [...touched];
  }

  // ---- metering ----

  async meter(agentId: number): Promise<number> {
    return this.o.store.withAgentLock(this.ref(agentId), () => this.meterLocked(agentId));
  }

  /** Meters every costed request of the agent's current key not yet charged. */
  async meterLocked(agentId: number): Promise<number> {
    const runtime = await this.o.store.runtime(this.ref(agentId));
    if (!runtime || runtime.status === "deprovisioned") return 0;
    const key = runtime.keyCiphertext ? this.o.keyOf({ ...runtime, status: "ready" }) : null;
    if (!key) return 0;
    const rows = (await this.o.gateway.spendLogs(key)).filter((r) => r.spendUsd > 0);
    if (rows.length === 0) return 0;
    const seen = new Set(
      (
        await this.o.store.db
          .selectFrom("platform.usage_receipts")
          .select("request_id")
          .where("key_alias", "=", runtime.keyAlias)
          .execute()
      ).map((r) => r.request_id),
    );
    let added = 0;
    for (const row of rows) {
      if (seen.has(row.requestId)) continue;
      const picos = usdToPicos(row.spendUsd);
      const full = chargeFor(picos);
      if (full === 0n) continue;
      // P3-U4: a call under a cycle stage is held to what is left of its ceiling.
      const stage = await this.stageOf(agentId, row);
      if (stage === "wait") continue;
      const split = stage
        ? chargeWithinCeiling(full, stage.chargedSoFar, stage.ceiling)
        : { charged: full, absorbed: 0n };
      const charge = split.charged;
      const receipt = {
        key_alias: runtime.keyAlias,
        request_id: row.requestId,
        chain_id: this.o.chainId,
        agent_id: agentId,
        model: row.model,
        provider_picos: picos.toString(),
        charge_usdc_e6: charge.toString(),
        called_at: row.startTime,
        stage_run_id: stage ? stage.stageRunId : null,
        absorbed_usdc_e6: split.absorbed.toString(),
      };
      if (charge === 0n) {
        // Wholly above the ceiling: nothing charged, the receipt records what was absorbed.
        await this.o.store.db
          .insertInto("platform.usage_receipts")
          .values({ ...receipt, entry_id: null })
          .onConflict((oc) => oc.columns(["key_alias", "request_id"]).doNothing())
          .execute();
        added += 1;
        continue;
      }
      const entryId = randomUUID();
      const posted = await this.o.ledger.post(
        usageEntry(
          {
            environment: this.o.environment,
            entryId,
            occurredAt: Math.floor((row.startTime ? Date.parse(row.startTime) : Date.now()) / 1000),
            agentId,
          },
          charge,
        ),
        {
          chainId: this.o.chainId,
          agentId,
          idempotencyKey: `usage:${runtime.keyAlias}:${row.requestId}`,
          source: {
            kind: "litellm_request",
            keyAlias: runtime.keyAlias,
            requestId: row.requestId,
            model: row.model,
          },
        },
        async (trx) => {
          await trx
            .insertInto("platform.usage_receipts")
            .values({ ...receipt, entry_id: entryId })
            .execute();
        },
      );
      if (posted) added += 1;
    }
    if (added > 0) this.o.log(`agent ${agentId}: metered ${added} model call(s)`);
    return added;
  }

  /**
   * The cycle stage a costed request ran under, with the stage's ceiling and
   * what it has charged so far; null outside a stage. "wait" while the gate's
   * record of a recent request may still be on its way and a stage is open.
   */
  private async stageOf(
    agentId: number,
    row: { requestId: string; startTime: string | null },
  ): Promise<{ stageRunId: string; ceiling: bigint; chargedSoFar: bigint } | null | "wait"> {
    const cycles = this.o.cycles;
    if (!cycles) return null;
    const call = await this.o.store.db
      .selectFrom("platform.model_calls")
      .select("stage_run_id")
      .where("request_id", "=", row.requestId)
      .executeTakeFirst();
    if (!call) {
      const at = row.startTime ? Date.parse(row.startTime) : Date.now();
      const open = await this.o.store.db
        .selectFrom("platform.stage_runs")
        .select("stage_run_id")
        .where("chain_id", "=", this.o.chainId)
        .where("agent_id", "=", agentId)
        .where("status", "=", "running")
        .executeTakeFirst();
      return open && Date.now() - at < STAGE_ATTRIBUTION_GRACE_MS ? "wait" : null;
    }
    if (!call.stage_run_id) return null;
    const run = await cycles.stageRun(call.stage_run_id);
    if (!run) return null;
    const tools = await cycles.toolCharges(run.stageRunId);
    const model = await cycles.meteredModel(run.stageRunId);
    return {
      stageRunId: run.stageRunId,
      ceiling: run.ceilingUsdcE6,
      chargedSoFar: tools.chargeUsdcE6 + model.charged,
    };
  }

  // ---- budget sync ----

  /** The budget the agent's current key should have, in USD with six decimals. */
  async budgetForLocked(agentId: number, keyAlias: string): Promise<number> {
    const metered = await this.o.store.db
      .selectFrom("platform.usage_receipts")
      .select(sql<string | null>`sum(provider_picos)`.as("picos"))
      .where("key_alias", "=", keyAlias)
      .executeTakeFirst();
    const credits = await this.o.ledger.balances(this.o.chainId, agentId);
    const usd = keyBudgetUsd(BigInt(metered?.picos ?? "0"), credits.credits);
    return Math.floor(usd * 1e6) / 1e6;
  }

  async syncBudget(agentId: number): Promise<number | null> {
    return this.o.store.withAgentLock(this.ref(agentId), () => this.syncBudgetLocked(agentId));
  }

  /** Sets the key's LiteLLM budget from the ledger when it changed; returns the budget. */
  async syncBudgetLocked(agentId: number): Promise<number | null> {
    const runtime = await this.o.store.runtime(this.ref(agentId));
    if (!runtime || runtime.status !== "ready") return null;
    const key = this.o.keyOf(runtime);
    if (!key) return null;
    const budget = await this.budgetForLocked(agentId, runtime.keyAlias);
    if (Number(runtime.budgetUsd) === budget) return budget;
    await this.o.gateway.setBudget(key, budget);
    await this.o.store.db
      .updateTable("platform.agent_runtimes")
      .set({ budget_usd: budget.toFixed(6), updated_at: sql`now()` })
      .where("chain_id", "=", this.o.chainId)
      .where("agent_id", "=", agentId)
      .execute();
    this.o.log(`agent ${agentId}: gateway budget set to ${budget.toFixed(6)} USD`);
    return budget;
  }

  /**
   * One pass: credit deposits, reverse orphans, then meter and sync every
   * provisioned agent. Failures are per agent, logged, and retried next pass.
   */
  async tick(): Promise<void> {
    await this.creditDeposits();
    await this.reverseOrphanDeposits();
    const ready = (await this.o.store.runtimes(this.o.chainId)).filter((r) => r.status === "ready");
    for (const r of ready) {
      try {
        await this.o.store.withAgentLock(r, async () => {
          await this.meterLocked(r.agentId);
          await this.syncBudgetLocked(r.agentId);
        });
      } catch (err) {
        this.o.log(`agent ${r.agentId}: metering failed: ${errorText(err, this.o.redactor)}`);
      }
    }
  }
}
