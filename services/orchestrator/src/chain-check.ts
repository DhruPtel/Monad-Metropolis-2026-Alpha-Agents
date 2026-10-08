import { type TaskContext, openAgentSandbox } from "./noop.ts";
import { errorText } from "./secrets.ts";
import type { AgentRef } from "./store.ts";

/**
 * The chain check (P2-U5): one Hermes run in a sandbox under a lease in which
 * the agent reads its account, the prices and its limits through the chain
 * tools server, checks whether a small trade could go through now, proposes
 * it, and reads the intent back. The dev console starts it; nothing is sent
 * to the chain, because a proposal only waits for approval (arming is P2-U6).
 * The result is what the platform recorded in the lease (the chain tool calls
 * and the intents), never the model's final text.
 */
export const CHAIN_CHECK_PROMPT = [
  "CHAIN CHECK. Look at your own trading account and the market, then propose one small swap.",
  "1. Call mcp__chain__get_portfolio.",
  "2. Call mcp__chain__get_prices.",
  "3. Call mcp__chain__get_limits.",
  "4. Choose the trade: if you hold at least 1 USDC and maxTradeValueUsdc from get_limits is at",
  'least 2, buy WMON with exactly 1 USDC (amount "1"); otherwise buy WMON with half of',
  "maxTradeValueUsdc rounded down to two decimals, or, if you hold no USDC, sell a tenth of your",
  "WMON. Never use the account's total value or a price as the amount. Call",
  "mcp__chain__tradable_now for that trade.",
  "5. Call mcp__chain__propose_swap for that same trade with a one-sentence reason, even if",
  "tradable_now said it is blocked: the platform records why.",
  "6. Call mcp__chain__get_intent_status with the intentId propose_swap returned.",
  "Do nothing else: no other tools, no terminal, files or code. Reply with one short line when done.",
].join(" ");

export const CHAIN_CHECK_LEASE_MS = 10 * 60_000;
export const CHAIN_CHECK_DEADLINE_MS = 5 * 60_000;

/** The chain tools the check must have called successfully, in any order. */
export const CHAIN_CHECK_READS = [
  "get_portfolio",
  "get_prices",
  "get_limits",
  "tradable_now",
] as const;

export type ChainCheckStop = "COMPLETED" | "INCOMPLETE" | "DEADLINE" | "FAILED";

export interface ChainCheckResult extends Record<string, unknown> {
  readonly kind: "chain_check";
  readonly agentId: number;
  readonly leaseId: string;
  readonly runStatus: string;
  readonly stopReason: ChainCheckStop;
  readonly toolCalls: readonly {
    readonly tool: string;
    readonly status: string;
    readonly errorCode: string | null;
  }[];
  readonly intents: readonly {
    readonly intentId: string;
    readonly status: string;
    readonly reasonCodes: readonly string[];
  }[];
  readonly modelCalls: number;
  readonly timingsMs: { readonly run: number; readonly total: number };
}

export async function runChainCheckTask(ctx: TaskContext, taskId: string): Promise<void> {
  const task = await ctx.store.task(taskId);
  if (!task || !(await ctx.store.startTask(taskId))) return;
  const ref: AgentRef = { chainId: task.chainId, agentId: task.agentId };
  const started = Date.now();
  let leaseId: string | null = null;
  try {
    const opened = await openAgentSandbox(
      ctx,
      taskId,
      ref,
      "chain_check",
      CHAIN_CHECK_LEASE_MS,
      (id) => {
        leaseId = id;
      },
    );
    leaseId = opened.leaseId;
    const agent = `${ref.chainId}-${ref.agentId}`;
    const t0 = Date.now();
    const run = await opened.runs.start(
      `${agent}:chain_check:${taskId}`,
      CHAIN_CHECK_PROMPT,
      `${agent}-chain-check-${taskId}`,
    );
    let runStatus: string;
    let deadline = false;
    try {
      runStatus = (await opened.runs.waitFinished(run.runId, CHAIN_CHECK_DEADLINE_MS)).status;
    } catch {
      deadline = true;
      runStatus = "stopped";
      await opened.runs.stop(run.runId).catch(() => undefined);
    }
    const runMs = Date.now() - t0;
    await ctx.leases.release(leaseId, "task finished");

    const db = ctx.store.db;
    const calls = await db
      .selectFrom("platform.tool_calls")
      .select(["tool", "status", "error_code", "server"])
      .where("lease_id", "=", leaseId)
      .orderBy("started_at")
      .execute();
    const intents = await db
      .selectFrom("platform.intents")
      .select(["intent_id", "status", "reason_codes"])
      .where("lease_id", "=", leaseId)
      .orderBy("created_at")
      .execute();
    const succeeded = new Set(
      calls.filter((c) => c.server === "chain" && c.status === "succeeded").map((c) => c.tool),
    );
    const complete = CHAIN_CHECK_READS.every((t) => succeeded.has(t)) && intents.length > 0;
    const stopReason: ChainCheckStop = complete
      ? "COMPLETED"
      : deadline
        ? "DEADLINE"
        : "INCOMPLETE";
    const result: ChainCheckResult = {
      kind: "chain_check",
      agentId: ref.agentId,
      leaseId,
      runStatus,
      stopReason,
      toolCalls: calls.map((c) => ({ tool: c.tool, status: c.status, errorCode: c.error_code })),
      intents: intents.map((i) => ({
        intentId: i.intent_id,
        status: i.status,
        reasonCodes: i.reason_codes,
      })),
      modelCalls: ctx.gate.callsFor(leaseId).length,
      timingsMs: { run: runMs, total: Date.now() - started },
    };
    if (complete) await ctx.store.finishTask(taskId, { result });
    else
      await ctx.store.finishTask(taskId, {
        error: deadline
          ? `the chain check passed its ${CHAIN_CHECK_DEADLINE_MS / 60_000} minute deadline and was stopped`
          : `the chain check ended (${runStatus}) without every read and a proposal`,
        result,
      });
    ctx.log(
      `task ${taskId}: chain check ${stopReason.toLowerCase()}, ${calls.length} tool calls, ${intents.length} intents`,
    );
  } catch (err) {
    const message = errorText(err, ctx.redactor);
    if (leaseId) await ctx.leases.release(leaseId, "task failed");
    await ctx.store.finishTask(taskId, { error: message });
    ctx.log(`task ${taskId}: failed: ${message}`);
  }
}
