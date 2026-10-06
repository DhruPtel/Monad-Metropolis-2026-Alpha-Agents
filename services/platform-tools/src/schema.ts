import { z } from "zod";

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
        asset: z.enum(["USDC", "WMON"]),
        thesisCode: code,
        confidenceBps: z.int().min(0).max(10_000),
      }),
    )
    .max(5),
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
