import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AgentIdentity,
  type IdentityResolver,
  ToolError,
  type ToolServer,
  errorFrom,
  okResult,
  startToolServer,
} from "@alpha-agents/tool-server";
import {
  CompleteStageInput,
  CompleteStageOutput,
  GetGoalsAndLimitsInput,
  GetGoalsAndLimitsOutput,
  WriteThesisInput,
  WriteThesisOutput,
} from "./schema.ts";
import {
  GetResearchContextInput,
  GetResearchContextOutput,
  type ResearchBrief,
  WriteResearchBriefInput,
  WriteResearchBriefOutput,
} from "./briefs.ts";

/**
 * The platform tools server (FINAL_PLAN 4.4.4), thin (D-213): `complete_stage`
 * ends a stage with codes only and is recorded once per stage per lease,
 * `write_thesis` stores the stage's research notes (the D-160 stub), and
 * `get_goals_and_limits` (P3-U1) returns the owner's goal and every limit.
 * All act only for the agent and lease the injected token names. They are
 * free: no upstream is paid, so nothing is charged.
 */
export interface PlatformStore {
  /** Records the stage; false when this lease already completed it. */
  recordStage(
    identity: AgentIdentity,
    input: CompleteStageInput,
    output: CompleteStageOutput,
  ): Promise<boolean>;
  writeThesis(
    identity: AgentIdentity,
    input: WriteThesisInput,
    output: WriteThesisOutput,
  ): Promise<void>;
  /**
   * P3-U4: validates and stores a brief for the lease's current stage, and
   * returns its ID; throws ToolError INVALID_INPUT with every reason it was
   * refused. Absent where the platform runs no research cycles.
   */
  writeBrief?(identity: AgentIdentity, brief: ResearchBrief): Promise<string>;
  /** P3-U4: the bounded research context for the lease's current stage. */
  researchContext?(identity: AgentIdentity): Promise<unknown>;
}

/** The agent's goal and limits, assembled by the platform (packages/trading's goalsAndLimitsJson). */
export interface GoalsReader {
  read(identity: AgentIdentity): Promise<unknown>;
}

export interface PlatformToolsOptions {
  readonly resolve: IdentityResolver;
  readonly store: PlatformStore;
  /** Absent where the platform has no goal store: the tool answers UPSTREAM_UNAVAILABLE. */
  readonly goals?: GoalsReader;
  readonly port?: number;
  /** Builds complete_stage's output. Tests replace it to prove invalid output is rejected. */
  readonly buildOutput?: (input: CompleteStageInput) => unknown;
}

function defaultOutput(input: CompleteStageInput): CompleteStageOutput {
  return {
    stageId: `stage-${randomUUID()}`,
    stage: input.stage,
    outcome: input.outcome,
    accepted: true,
    candidateCount: input.candidates.length,
  };
}

export function registerPlatformTools(
  mcp: McpServer,
  identity: AgentIdentity,
  options: Pick<PlatformToolsOptions, "store" | "buildOutput" | "goals">,
): void {
  const build = options.buildOutput ?? defaultOutput;
  mcp.registerTool(
    "complete_stage",
    {
      description:
        "End the current research stage. Call exactly once, as the last action of the stage, with codes only.",
      // The strict objects, not their raw shapes: the SDK wraps a raw shape in a non-strict
      // object, which silently strips unknown fields instead of rejecting them.
      inputSchema: CompleteStageInput,
      outputSchema: CompleteStageOutput,
      annotations: { idempotentHint: false },
    },
    async (input) => {
      try {
        const output = build(input) as CompleteStageOutput;
        // Checked before it is stored, so a malformed output is never recorded.
        const valid = CompleteStageOutput.safeParse(output);
        if (!valid.success) throw new Error("complete_stage built an invalid output");
        if (!(await options.store.recordStage(identity, input, valid.data)))
          throw new ToolError(
            "DUPLICATE_REQUEST",
            `The ${input.stage} stage is already complete for this run.`,
            false,
          );
        return okResult({ ...valid.data });
      } catch (err) {
        return errorFrom(err);
      }
    },
  );
  mcp.registerTool(
    "write_thesis",
    {
      description:
        "Save research notes for this stage: a short title, your notes and the source URLs. Notes stay private to the platform; owners never see them.",
      inputSchema: WriteThesisInput,
      outputSchema: WriteThesisOutput,
    },
    async (input) => {
      try {
        const output: WriteThesisOutput = {
          noteId: `note-${randomUUID()}`,
          stage: input.stage,
          accepted: true,
          sourceCount: input.sources.length,
        };
        await options.store.writeThesis(identity, input, output);
        return okResult({ ...output });
      } catch (err) {
        return errorFrom(err);
      }
    },
  );
  mcp.registerTool(
    "write_research_brief",
    {
      description:
        "Write this stage's typed research brief, the only research your owner reads. Every number must be one a tool returned in this cycle, every URL one this cycle retrieved, and every source a URL or the name of a tool you called. A refused brief comes back with every reason; fix them and write it again.",
      inputSchema: WriteResearchBriefInput,
      outputSchema: WriteResearchBriefOutput,
      annotations: { idempotentHint: false },
    },
    async (input) => {
      try {
        if (!options.store.writeBrief)
          throw new ToolError(
            "UPSTREAM_UNAVAILABLE",
            "Research briefs are written only inside a research cycle.",
            false,
          );
        const briefId = await options.store.writeBrief(identity, input.brief);
        const output = WriteResearchBriefOutput.parse({
          briefId,
          kind: input.brief.kind,
          accepted: true,
        });
        return okResult({ ...output });
      } catch (err) {
        return errorFrom(err);
      }
    },
  );
  mcp.registerTool(
    "get_research_context",
    {
      description:
        "Your research context for this stage, as typed records: the cycle and stage, the active plan, the latest overview, open themes, the briefs this cycle has accepted that this stage builds on, what the plan may change within (Zoom out), and the briefs this stage must write. Call it first.",
      inputSchema: GetResearchContextInput,
      outputSchema: GetResearchContextOutput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      try {
        if (!options.store.researchContext)
          throw new ToolError(
            "UPSTREAM_UNAVAILABLE",
            "Research context exists only inside a research cycle.",
            false,
          );
        const output = GetResearchContextOutput.safeParse(
          await options.store.researchContext(identity),
        );
        if (!output.success) throw new Error("get_research_context built an invalid output");
        return okResult({ ...output.data });
      } catch (err) {
        return errorFrom(err);
      }
    },
  );
  mcp.registerTool(
    "get_goals_and_limits",
    {
      description:
        "Your owner's goal and every limit you trade under: the strategy template and its parameters, the risk preset, the allowed assets, the hard limits, the owner's stricter limits, the Executor's live limits, the tightest of them all, and the account's mode. Call it first in every stage. The values are authoritative.",
      inputSchema: GetGoalsAndLimitsInput,
      outputSchema: GetGoalsAndLimitsOutput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      try {
        if (!options.goals)
          throw new ToolError(
            "UPSTREAM_UNAVAILABLE",
            "Goals are not available on this platform yet.",
            false,
          );
        // Identity comes only from the token: the reader is asked for this agent and no other.
        const output = GetGoalsAndLimitsOutput.safeParse(await options.goals.read(identity));
        if (!output.success) throw new Error("get_goals_and_limits built an invalid output");
        return okResult({ ...output.data });
      } catch (err) {
        return errorFrom(err);
      }
    },
  );
}

/** Every input schema the server registers, for the identity field lint. */
export const PLATFORM_TOOL_INPUTS = {
  complete_stage: CompleteStageInput,
  write_thesis: WriteThesisInput,
  get_goals_and_limits: GetGoalsAndLimitsInput,
  write_research_brief: WriteResearchBriefInput,
  get_research_context: GetResearchContextInput,
} as const;

export async function startPlatformTools(options: PlatformToolsOptions): Promise<ToolServer> {
  return startToolServer({
    name: "platform",
    resolve: options.resolve,
    register: (mcp, identity) => registerPlatformTools(mcp, identity, options),
    ...(options.port === undefined ? {} : { port: options.port }),
  });
}

export interface StageRecord {
  readonly receivedAt: string;
  readonly identity: AgentIdentity;
  readonly input: CompleteStageInput;
  readonly output: CompleteStageOutput;
}

/** The platform store in memory, for tests and the P1-U1 spike. */
export class MemoryPlatformStore implements PlatformStore {
  readonly stages: StageRecord[] = [];
  readonly notes: {
    identity: AgentIdentity;
    input: WriteThesisInput;
    output: WriteThesisOutput;
  }[] = [];

  async recordStage(
    identity: AgentIdentity,
    input: CompleteStageInput,
    output: CompleteStageOutput,
  ): Promise<boolean> {
    if (
      this.stages.some(
        (s) => s.identity.leaseId === identity.leaseId && s.input.stage === input.stage,
      )
    )
      return false;
    this.stages.push({ receivedAt: new Date().toISOString(), identity, input, output });
    return true;
  }

  async writeThesis(
    identity: AgentIdentity,
    input: WriteThesisInput,
    output: WriteThesisOutput,
  ): Promise<void> {
    this.notes.push({ identity, input, output });
  }
}
