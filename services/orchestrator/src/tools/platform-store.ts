import { randomUUID } from "node:crypto";
import type {
  CompleteStageInput,
  CompleteStageOutput,
  PlatformStore,
  ResearchBrief,
  WriteThesisInput,
  WriteThesisOutput,
} from "@alpha-agents/platform-tools";
import { type AgentIdentity, ToolError } from "@alpha-agents/tool-server";
import type { CycleResearch } from "../cycle/research.ts";
import type { CycleStore } from "../cycle/store.ts";
import type { Store } from "../store.ts";

/**
 * The platform tools' records in Postgres (D-213). Each call also goes into
 * the action log (`platform.tool_calls`, free, so no charge), which the
 * narrator and the dev console read. Thesis notes are logged by stage and
 * source count only: the title and text stay in `platform.thesis_notes`.
 *
 * P3-U4: inside a research cycle every record carries the lease's current
 * stage run, complete_stage is checked by the cycle (its stage, its brief, a
 * Zoom out's decision), briefs are validated before they are stored, and the
 * results of get_goals_and_limits and get_research_context are stored with
 * the stage so a brief may quote them.
 */
export class PgPlatformStore implements PlatformStore {
  private readonly store: Store;
  private readonly cycles: { store: CycleStore; research: CycleResearch } | null;

  constructor(store: Store, cycles: { store: CycleStore; research: CycleResearch } | null = null) {
    this.store = store;
    this.cycles = cycles;
  }

  private async stageRunOf(identity: AgentIdentity) {
    return (await this.cycles?.store.currentStage(identity.leaseId)) ?? null;
  }

  async writeBrief(identity: AgentIdentity, brief: ResearchBrief): Promise<string> {
    if (!this.cycles)
      throw new ToolError(
        "UPSTREAM_UNAVAILABLE",
        "Research cycles are not configured here.",
        false,
      );
    const run = await this.stageRunOf(identity);
    try {
      return await this.cycles.research.writeBrief(identity, brief);
    } finally {
      await this.logCall(identity, run?.stageRunId ?? null, "write_research_brief", {
        kind: brief.kind,
      });
    }
  }

  async researchContext(identity: AgentIdentity): Promise<unknown> {
    if (!this.cycles)
      throw new ToolError(
        "UPSTREAM_UNAVAILABLE",
        "Research cycles are not configured here.",
        false,
      );
    const context = await this.cycles.research.researchContext(identity);
    await this.recordRead(identity, "get_research_context", context);
    return context;
  }

  /** A platform read inside a cycle stage: logged, with its result stored for the validator. */
  async recordRead(identity: AgentIdentity, tool: string, result: unknown): Promise<void> {
    const run = await this.stageRunOf(identity);
    if (!run || !this.cycles) return;
    const callId = await this.logCall(identity, run.stageRunId, tool, {});
    await this.cycles.store.storeResult(callId, run, tool, result);
  }

  private async logCall(
    identity: AgentIdentity,
    stageRunId: string | null,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const callId = `call-${randomUUID()}`;
    await this.store.db
      .insertInto("platform.tool_calls")
      .values({
        call_id: callId,
        chain_id: identity.chainId,
        agent_id: identity.agentId,
        lease_id: identity.leaseId,
        server: "platform",
        tool,
        input: JSON.stringify(input),
        status: "succeeded",
        finished_at: new Date(),
        stage_run_id: stageRunId,
      })
      .execute();
    return callId;
  }

  async recordStage(
    identity: AgentIdentity,
    input: CompleteStageInput,
    output: CompleteStageOutput,
  ): Promise<boolean> {
    // Inside a cycle the stage is checked first: a refusal names what to fix.
    const run =
      this.cycles && (await this.stageRunOf(identity))
        ? await this.cycles.research.completeStage(identity, input)
        : null;
    return this.store.db.transaction().execute(async (trx) => {
      const values = {
        stage_id: output.stageId,
        chain_id: identity.chainId,
        agent_id: identity.agentId,
        lease_id: identity.leaseId,
        stage: input.stage,
        outcome: input.outcome,
        candidates: JSON.stringify(input.candidates),
        stage_run_id: run?.stageRunId ?? null,
        decision: input.decision ? JSON.stringify(input.decision) : null,
      };
      const inserted = run
        ? await trx
            .insertInto("platform.stage_records")
            .values(values)
            .onConflict((oc) =>
              oc.column("stage_run_id").where("stage_run_id", "is not", null).doNothing(),
            )
            .returning("stage_id")
            .executeTakeFirst()
        : await trx
            .insertInto("platform.stage_records")
            .values(values)
            .onConflict((oc) =>
              oc.columns(["lease_id", "stage"]).where("stage_run_id", "is", null).doNothing(),
            )
            .returning("stage_id")
            .executeTakeFirst();
      await trx
        .insertInto("platform.tool_calls")
        .values({
          call_id: `call-${randomUUID()}`,
          chain_id: identity.chainId,
          agent_id: identity.agentId,
          lease_id: identity.leaseId,
          server: "platform",
          tool: "complete_stage",
          input: JSON.stringify(input),
          status: inserted ? "succeeded" : "refused",
          error_code: inserted ? null : "DUPLICATE_REQUEST",
          summary: JSON.stringify({ results: input.candidates.length }),
          finished_at: new Date(),
          stage_run_id: run?.stageRunId ?? null,
        })
        .execute();
      return inserted !== undefined;
    });
  }

  async writeThesis(
    identity: AgentIdentity,
    input: WriteThesisInput,
    output: WriteThesisOutput,
  ): Promise<void> {
    const stageRunId = (await this.stageRunOf(identity))?.stageRunId ?? null;
    await this.store.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("platform.thesis_notes")
        .values({
          note_id: output.noteId,
          chain_id: identity.chainId,
          agent_id: identity.agentId,
          lease_id: identity.leaseId,
          stage: input.stage,
          title: input.title,
          notes: input.notes,
          sources: JSON.stringify(input.sources),
          stage_run_id: stageRunId,
        })
        .execute();
      await trx
        .insertInto("platform.tool_calls")
        .values({
          call_id: `call-${randomUUID()}`,
          chain_id: identity.chainId,
          agent_id: identity.agentId,
          lease_id: identity.leaseId,
          server: "platform",
          tool: "write_thesis",
          input: JSON.stringify({ stage: input.stage, sourceCount: input.sources.length }),
          status: "succeeded",
          summary: JSON.stringify({ results: input.sources.length }),
          finished_at: new Date(),
          stage_run_id: stageRunId,
        })
        .execute();
    });
  }
}
