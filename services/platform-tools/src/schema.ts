import {
  ACCOUNT_MODES,
  AGENT_STATES,
  PLAN_CHANGE_MODES,
  MODEL_TIERS,
  RESEARCH_INTENSITIES,
  AGGRESSIVENESS_LEVELS,
} from "@alpha-agents/domain";
import { z } from "zod";
import { ZoomOutDecision } from "./briefs.ts";

// The discovery loop's stages (FINAL_PLAN 4.3.7). Every stage ends in one complete_stage call.
export const STAGES = ["SCAN", "DIVE", "CHALLENGE", "TEST", "ZOOM_OUT"] as const;

// Codes, never free text: nothing the model writes here is shown to an owner verbatim.
const code = z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/, "an upper-case code of 3 to 40 characters");

export const completeStageInput = {
  stage: z.enum(STAGES),
  outcome: z.enum(["DONE", "NO_CANDIDATES"]),
  candidates: z
    .array(
      z.strictObject({
        /** The token's symbol or address, or MARKET for a chain-wide theme (F-U8: any registered token). */
        asset: z.string().trim().min(1).max(42),
        thesisCode: code,
        confidenceBps: z.int().min(0).max(10_000),
      }),
    )
    .max(5),
  /**
   * P3-U4: a Zoom out's decision, required for ZOOM_OUT and refused for any
   * other stage: no change with its reason code, or a proposed plan, which the
   * deterministic Test checks before the stage may end.
   */
  decision: ZoomOutDecision.optional(),
};

export const CompleteStageInput = z.strictObject(completeStageInput);
export type CompleteStageInput = z.infer<typeof CompleteStageInput>;

export const completeStageOutput = {
  stageId: z.string().regex(/^stage-[0-9a-f-]{36}$/),
  stage: z.enum(STAGES),
  outcome: z.enum(["DONE", "NO_CANDIDATES"]),
  accepted: z.literal(true),
  candidateCount: z.int().min(0).max(5),
};

export const CompleteStageOutput = z.strictObject(completeStageOutput);
export type CompleteStageOutput = z.infer<typeof CompleteStageOutput>;

/**
 * The `write_thesis` stub (D-160): the agent's research notes for a stage. The
 * notes are private research, never served to owners; only their count reaches
 * the narrator.
 */
export const WriteThesisInput = z.strictObject({
  stage: z.enum(STAGES),
  title: z.string().trim().min(3).max(120),
  notes: z.string().trim().min(1).max(4_000),
  sources: z
    .array(z.url({ protocol: /^https?$/ }).max(2_048))
    .max(10)
    .default([]),
});
export type WriteThesisInput = z.infer<typeof WriteThesisInput>;

export const WriteThesisOutput = z.strictObject({
  noteId: z.string().regex(/^note-[0-9a-f-]{36}$/),
  stage: z.enum(STAGES),
  accepted: z.literal(true),
  sourceCount: z.int().min(0).max(10),
});
export type WriteThesisOutput = z.infer<typeof WriteThesisOutput>;

/**
 * `get_goals_and_limits` (P3-U1, FINAL_PLAN 4.4.4): the owner's goal, the
 * plan's template and parameters, and every limit the agent trades under,
 * typed. It takes no input: the agent is the one the token names.
 */
export const GetGoalsAndLimitsInput = z.strictObject({});
export type GetGoalsAndLimitsInput = z.infer<typeof GetGoalsAndLimitsInput>;

const bps = z.int().min(0).max(10_000);
const usdc = z.string().regex(/^\d+(\.\d{1,6})?$/, "a USDC amount");
const limitSet = z.strictObject({
  maxTradeBps: bps,
  maxPositionBps: bps,
  minUsdcShareBps: bps,
  maxSlippageBps: bps,
  maxTradesPer24h: z.int().min(0).max(255),
});

export const GetGoalsAndLimitsOutput = z.strictObject({
  state: z.enum(AGENT_STATES),
  configured: z.boolean(),
  strategyEpoch: z.string().regex(/^\d+$/),
  policyHash: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .nullable(),
  goal: z
    .strictObject({
      aggressiveness: z.enum(AGGRESSIVENESS_LEVELS),
      modelTier: z.strictObject({ choice: z.enum(MODEL_TIERS), alias: z.string() }),
      screenedOptIn: z.boolean(),
      excludedTokens: z.array(z.string().regex(/^0x[0-9a-f]{40}$/)).max(32),
      research: z.strictObject({
        intensity: z.enum(RESEARCH_INTENSITIES),
        scanEveryHours: z.int().min(1),
        divesPerDay: z.int().min(0),
        dailyBudgetUsdc: usdc,
      }),
      creditReserveUsdc: usdc,
      planChanges: z.enum(PLAN_CHANGE_MODES),
    })
    .nullable(),
  /** F-U7 (D-345): the brief the agent interprets, a fixed text per aggressiveness with the owner's choices. */
  brief: z.string().nullable(),
  /** The envelope the deterministic Test enforces on a target portfolio (A-60). */
  envelope: z
    .strictObject({
      classAAllowed: z.boolean(),
      maxPositionBps: bps,
      maxClassAPositionBps: bps,
      maxClassATotalBps: bps,
      minStableBps: bps,
      maxPositions: z.int().min(1).max(16),
      reviewTriggerBps: bps,
    })
    .nullable(),
  plan: z
    .strictObject({
      template: z.literal("rebalance_bands@1"),
      params: z.strictObject({
        targetWmonBps: bps,
        bandHalfWidthBps: bps,
        minTradeUsdc: usdc,
        volatilityBrakeBps: z.int().min(0),
        costHurdleBps: bps,
        maxLegBps: bps,
      }),
      targetRange: z.strictObject({ minBps: bps, maxBps: bps }),
      researchTriggerBps: bps,
    })
    .nullable(),
  limits: z.strictObject({
    hard: limitSet,
    owner: limitSet.nullable(),
    live: limitSet.nullable(),
    effective: limitSet,
  }),
  account: z.strictObject({
    mode: z.enum(ACCOUNT_MODES).nullable(),
    executorPaused: z.boolean().nullable(),
  }),
  asOf: z.strictObject({ block: z.string(), timestamp: z.string() }).nullable(),
  authority: z.string(),
});
export type GetGoalsAndLimitsOutput = z.infer<typeof GetGoalsAndLimitsOutput>;
