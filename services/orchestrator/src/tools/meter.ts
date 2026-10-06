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
 * not answer is reversed with a `usage_reversed` entry.
 */
export const MAX_PAID_CALLS_PER_LEASE = 20;

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

  async begin(identity: AgentIdentity, call: Parameters<Meter["begin"]>[1]): Promise<string> {
    const ref = { chainId: identity.chainId, agentId: identity.agentId };
    return this.o.store.withAgentLock(ref, async () => {
      const paid = await this.o.store.db
        .selectFrom("platform.tool_calls")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("lease_id", "=", identity.leaseId)
        .where("server", "=", "data")
        .where("status", "!=", "refused")
        .executeTakeFirstOrThrow();
      if (Number(paid.n) >= MAX_PAID_CALLS_PER_LEASE) {
        await this.insertRefused(identity, call.tool, call.input, "LEASE_CALL_LIMIT", null);
        throw new ToolError(
          "RATE_LIMITED",
          `This run has used all ${MAX_PAID_CALLS_PER_LEASE} of its paid tool calls.`,
          false,
        );
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
            .values({
              call_id: callId,
              chain_id: identity.chainId,
              agent_id: identity.agentId,
              lease_id: identity.leaseId,
              server: "data",
              tool: call.tool,
              input: json(call.input),
              status: "running",
              charge_usdc_e6: call.priceUsdcE6.toString(),
              entry_id: entryId,
              provider: call.provider,
              cache_hit: false,
            })
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
