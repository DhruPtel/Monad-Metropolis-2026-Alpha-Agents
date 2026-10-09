import { randomUUID } from "node:crypto";
import { type JournalEntry, usageEntry, usageReversalEntry } from "@alpha-agents/accounting";
import type { CallSummary, DataTool, Meter } from "@alpha-agents/data-tools";
import { type AgentIdentity, ToolError } from "@alpha-agents/tool-server";
import type { Ledger } from "../credits/ledger.ts";
import type { CreditService } from "../credits/service.ts";
import type { Log } from "../secrets.ts";
import type { Store } from "../store.ts";

/**
 * Metering for the data tools (D-215). Under the agent's advisory lock the
 * meter checks the lease's paid-call count and the agent's spendable credits,
 * then posts the usage entry and the call's row in one transaction, so two
 * concurrent calls can never spend the same credits. A call the upstream did
 * not answer is reversed with a `usage_reversed` entry. A free call (a free
 * tool, or an answer the shared cache already holds, P3-U2) gets its row with
 * no ledger entry and does not count against the lease's paid calls. A tool
 * with a per-run cap (X and Dune, P3-U9) is also refused past its own count
 * of charged calls in the lease.
 */
export const MAX_PAID_CALLS_PER_LEASE = 20;

/**
 * Data tools a stage may not call, whatever its prompt or skills say (D-330):
 * a Scan never searches X; X search belongs to the Dive. Keyed by stage.
 */
export const STAGE_DENIED_TOOLS: Readonly<Record<string, readonly DataTool[]>> = {
  SCAN: ["x_search"],
};

/** The refusal for a tool its stage may not call, or null. Pure, so the rule is tested alone. */
export function stageToolRefusal(stage: string | null, tool: DataTool): string | null {
  if (!stage || !STAGE_DENIED_TOOLS[stage]?.includes(tool)) return null;
  return stage === "SCAN" && tool === "x_search"
    ? "A Scan does not search X; X search is used only in Dives. Use web_search and read_url here, and flag the theme for a Dive."
    : `The ${stage} stage does not use ${tool}.`;
}

export interface ToolMeterOptions {
  readonly store: Store;
  readonly ledger: Ledger;
  readonly credits: CreditService;
  readonly environment: JournalEntry["environment"];
  readonly log: Log;
}

const json = (v: unknown) => JSON.stringify(v ?? null);

export class ToolMeter implements Meter {
  private readonly o: ToolMeterOptions;

  constructor(options: ToolMeterOptions) {
    this.o = options;
  }

  private async insertRefused(
    identity: AgentIdentity,
    tool: DataTool,
    input: Record<string, unknown>,
    errorCode: string,
    summary: CallSummary | null,
  ): Promise<void> {
    await this.o.store.db
      .insertInto("platform.tool_calls")
      .values({
        call_id: `call-${randomUUID()}`,
        chain_id: identity.chainId,
        agent_id: identity.agentId,
        lease_id: identity.leaseId,
        server: "data",
        tool,
        input: json(input),
        status: "refused",
        error_code: errorCode,
        summary: summary ? json(summary) : null,
        finished_at: new Date(),
      })
      .execute();
  }

  /** The research stage a lease is running: a Scan task's lease is a SCAN. */
  private async stageOf(leaseId: string): Promise<string | null> {
    const lease = await this.o.store.lease(leaseId);
    return lease?.purpose === "scan" ? "SCAN" : null;
  }

  async begin(identity: AgentIdentity, call: Parameters<Meter["begin"]>[1]): Promise<string> {
    const ref = { chainId: identity.chainId, agentId: identity.agentId };
    return this.o.store.withAgentLock(ref, async () => {
      const refusal = stageToolRefusal(await this.stageOf(identity.leaseId), call.tool);
      if (refusal) {
        await this.insertRefused(identity, call.tool, call.input, "NOT_IN_STAGE", null);
        throw new ToolError("INVALID_INPUT", refusal, false);
      }
      const paid = await this.o.store.db
        .selectFrom("platform.tool_calls")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("lease_id", "=", identity.leaseId)
        .where("server", "=", "data")
        .where("status", "!=", "refused")
        .where("charge_usdc_e6", ">", "0")
        .executeTakeFirstOrThrow();
      if (call.priceUsdcE6 > 0n && Number(paid.n) >= MAX_PAID_CALLS_PER_LEASE) {
        await this.insertRefused(identity, call.tool, call.input, "LEASE_CALL_LIMIT", null);
        throw new ToolError(
          "RATE_LIMITED",
          `This run has used all ${MAX_PAID_CALLS_PER_LEASE} of its paid tool calls.`,
          false,
        );
      }
      if (call.priceUsdcE6 > 0n && call.maxPerLease !== undefined) {
        const same = await this.o.store.db
          .selectFrom("platform.tool_calls")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("lease_id", "=", identity.leaseId)
          .where("server", "=", "data")
          .where("tool", "=", call.tool)
          .where("status", "!=", "refused")
          .where("charge_usdc_e6", ">", "0")
          .executeTakeFirstOrThrow();
        if (Number(same.n) >= call.maxPerLease) {
          await this.insertRefused(identity, call.tool, call.input, "TOOL_RUN_CAP", null);
          throw new ToolError(
            "RATE_LIMITED",
            `This run has used its ${call.maxPerLease} paid ${call.tool} calls; a cached answer is still free.`,
            false,
          );
        }
      }
      const credits = await this.o.credits.creditsOf(identity.agentId);
      if (credits.spendable < call.priceUsdcE6) {
        await this.insertRefused(identity, call.tool, call.input, "CREDITS_EXHAUSTED", null);
        throw new ToolError(
          "RATE_LIMITED",
          "Credits exhausted: this agent has no credits left for paid tools. Its owner adds USDC to its funding address.",
          false,
        );
      }
      const callId = `call-${randomUUID()}`;
      const row = {
        call_id: callId,
        chain_id: identity.chainId,
        agent_id: identity.agentId,
        lease_id: identity.leaseId,
        server: "data" as const,
        tool: call.tool,
        input: json(call.input),
        status: "running" as const,
        provider: call.provider,
        cache_hit: call.cacheHit ?? false,
      };
      // Free: no ledger entry, nothing to reverse (MK-S6: a ledger row only for a paid call).
      if (call.priceUsdcE6 === 0n) {
        await this.o.store.db.insertInto("platform.tool_calls").values(row).execute();
        return callId;
      }
      const entryId = randomUUID();
      await this.o.ledger.post(
        usageEntry(
          {
            environment: this.o.environment,
            entryId,
            occurredAt: Math.floor(Date.now() / 1000),
            agentId: identity.agentId,
          },
          call.priceUsdcE6,
        ),
        {
          chainId: identity.chainId,
          agentId: identity.agentId,
          idempotencyKey: `tool:${callId}`,
          source: {
            kind: "tool_call",
            callId,
            tool: call.tool,
            provider: call.provider,
            leaseId: identity.leaseId,
          },
        },
        async (trx) => {
          await trx
            .insertInto("platform.tool_calls")
            .values({ ...row, charge_usdc_e6: call.priceUsdcE6.toString(), entry_id: entryId })
            .execute();
        },
      );
      return callId;
    });
  }

  async finish(callId: string, outcome: Parameters<Meter["finish"]>[1]): Promise<void> {
    const row = await this.o.store.db
      .selectFrom("platform.tool_calls")
      .select(["chain_id", "agent_id", "charge_usdc_e6", "status"])
      .where("call_id", "=", callId)
      .executeTakeFirst();
    if (!row || row.status !== "running") return;
    const summary = outcome.summary ? json(outcome.summary) : null;
    if (outcome.status === "succeeded") {
      await this.o.store.db
        .updateTable("platform.tool_calls")
        .set({ status: "succeeded", summary, finished_at: new Date() })
        .where("call_id", "=", callId)
        .execute();
      return;
    }
    const charge = BigInt(row.charge_usdc_e6);
    if (charge === 0n) {
      await this.o.store.db
        .updateTable("platform.tool_calls")
        .set({ status: "failed", error_code: outcome.errorCode, summary, finished_at: new Date() })
        .where("call_id", "=", callId)
        .execute();
      return;
    }
    const reversalId = randomUUID();
    await this.o.ledger.post(
      usageReversalEntry(
        {
          environment: this.o.environment,
          entryId: reversalId,
          occurredAt: Math.floor(Date.now() / 1000),
          agentId: row.agent_id,
        },
        charge,
      ),
      {
        chainId: row.chain_id,
        agentId: row.agent_id,
        idempotencyKey: `tool-reversal:${callId}`,
        source: { kind: "tool_call_failed", callId, errorCode: outcome.errorCode },
      },
      async (trx) => {
        await trx
          .updateTable("platform.tool_calls")
          .set({
            status: "failed",
            error_code: outcome.errorCode,
            summary,
            reversal_entry_id: reversalId,
            finished_at: new Date(),
          })
          .where("call_id", "=", callId)
          .execute();
      },
    );
    this.o.log(
      `agent ${row.agent_id}: tool call ${callId} failed (${outcome.errorCode}); charge reversed`,
    );
  }

  async refuse(identity: AgentIdentity, call: Parameters<Meter["refuse"]>[1]): Promise<void> {
    await this.insertRefused(identity, call.tool, call.input, call.errorCode, call.summary);
  }
}
