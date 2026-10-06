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
  WriteThesisInput,
  WriteThesisOutput,
} from "./schema.ts";

/**
 * The platform tools server (FINAL_PLAN 4.4.4), thin (D-213): `complete_stage`
 * ends a stage with codes only and is recorded once per stage per lease, and
 * `write_thesis` stores the stage's research notes (the D-160 stub). Both act
 * only for the agent and lease the injected token names. They are free: no
 * upstream is paid, so nothing is charged.
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
}

export interface PlatformToolsOptions {
  readonly resolve: IdentityResolver;
  readonly store: PlatformStore;
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
  options: Pick<PlatformToolsOptions, "store" | "buildOutput">,
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
}

/** Every input schema the server registers, for the identity field lint. */
export const PLATFORM_TOOL_INPUTS = {
  complete_stage: CompleteStageInput,
  write_thesis: WriteThesisInput,
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
