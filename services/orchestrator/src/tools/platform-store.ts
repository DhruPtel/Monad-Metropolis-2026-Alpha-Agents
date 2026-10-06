import { randomUUID } from "node:crypto";
import type {
  CompleteStageInput,
  CompleteStageOutput,
  PlatformStore,
  WriteThesisInput,
  WriteThesisOutput,
} from "@alpha-agents/platform-tools";
import type { AgentIdentity } from "@alpha-agents/tool-server";
import type { Store } from "../store.ts";

/**
 * The platform tools' records in Postgres (D-213). Each call also goes into
 * the action log (`platform.tool_calls`, free, so no charge), which the
 * narrator and the dev console read. Thesis notes are logged by stage and
 * source count only: the title and text stay in `platform.thesis_notes`.
 */
export class PgPlatformStore implements PlatformStore {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async recordStage(
    identity: AgentIdentity,
    input: CompleteStageInput,
    output: CompleteStageOutput,
  ): Promise<boolean> {
    return this.store.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("platform.stage_records")
        .values({
          stage_id: output.stageId,
          chain_id: identity.chainId,
          agent_id: identity.agentId,
          lease_id: identity.leaseId,
          stage: input.stage,
          outcome: input.outcome,
          candidates: JSON.stringify(input.candidates),
        })
        .onConflict((oc) => oc.columns(["lease_id", "stage"]).doNothing())
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
        })
        .execute();
    });
  }
}
