import { AccountRefSchema, UsdcE6Schema, isIntentToolId, isToolId } from "@alpha-agents/domain";
import { z } from "zod";

/**
 * The workflow spec (FINAL_PLAN 4.6.1): an immutable version, a trigger, the
 * account it acts on, preconditions, required skills and tools, reservation
 * rules, bounded steps, timeouts, guardrails, an approval policy and
 * compensation. One schema and validator for the runner, the audit service and
 * the creator portal. A hostile or unbounded spec is rejected: every list and
 * time has a ceiling, steps call registry tools only, and unknown fields fail.
 */
export const WORKFLOW_LIMITS = Object.freeze({
  maxSteps: 20,
  maxStepTimeoutSeconds: 600,
  maxRunTimeoutSeconds: 3_600,
  minConditionIntervalSeconds: 60,
  maxIntentsPerRun: 20,
});

const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a lowercase slug")
  .max(64);
const semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "must be semver");

/** Five-field cron; the minute field must be a fixed list, never `*` or a step, so runs are bounded. */
const cron = z
  .string()
  .regex(
    /^\d{1,2}(,\d{1,2})* (\S+) (\S+) (\S+) (\S+)$/,
    "must be five cron fields with fixed minutes",
  );

/**
 * Events a workflow may wake on: chain and ledger events from packages/domain,
 * plus StrategyUpdateAccepted, the platform event when a parameter proposal
 * passes policy (FINAL_PLAN 4.6.2, Parameter change review).
 */
export const WORKFLOW_EVENTS = [
  "OwnerEpochBumped",
  "BuildActivated",
  "IntentExecuted",
  "IntentRejected",
  "CreditsReceived",
  "CreditsExhausted",
  "StrategyUpdateAccepted",
] as const;

const TriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("schedule"), cron }).strict(),
  z.object({ type: z.literal("event"), event: z.enum(WORKFLOW_EVENTS) }).strict(),
  z
    .object({
      type: z.literal("condition"),
      /** A read-only registry tool evaluated on an interval, for example a drift check. */
      check: z.string(),
      everySeconds: z.number().int().min(WORKFLOW_LIMITS.minConditionIntervalSeconds),
    })
    .strict(),
]);

const StepSchema = z
  .object({
    id: slug,
    /** `tool` reads, `intent` proposes through an intent tool, `llm` asks the agent through /v1/runs. */
    kind: z.enum(["tool", "intent", "llm"]),
    tool: z.string().optional(),
    timeoutSeconds: z.number().int().min(1).max(WORKFLOW_LIMITS.maxStepTimeoutSeconds),
  })
  .strict();

export const WorkflowSpecSchema = z
  .object({
    schema_version: z.literal(1),
    id: slug,
    version: semver,
    name: z.string().min(1).max(64),
    trigger: TriggerSchema,
    account: AccountRefSchema,
    preconditions: z.array(slug).max(10),
    required_skills: z.array(slug).max(9),
    required_tools: z.array(z.string()).max(30),
    reservation: z.object({ maxUsdcE6: UsdcE6Schema }).strict().optional(),
    steps: z.array(StepSchema).min(1).max(WORKFLOW_LIMITS.maxSteps),
    timeoutSeconds: z.number().int().min(1).max(WORKFLOW_LIMITS.maxRunTimeoutSeconds),
    guardrails: z
      .object({
        maxIntentsPerRun: z.number().int().min(0).max(WORKFLOW_LIMITS.maxIntentsPerRun),
        maxValuePerRunUsdcE6: UsdcE6Schema.optional(),
      })
      .strict(),
    approval: z
      .object({
        mode: z.enum(["auto", "notify", "require_approval"]),
        /** Above this value an `auto` or `notify` step still needs the owner's approval. */
        thresholdUsdcE6: UsdcE6Schema.optional(),
      })
      .strict(),
    compensation: z.enum(["none", "cancel_pending_intents", "notify_owner"]),
  })
  .strict();
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

export interface SpecIssue {
  readonly path: string;
  readonly message: string;
}

export type SpecResult =
  | { readonly ok: true; readonly spec: WorkflowSpec }
  | { readonly ok: false; readonly issues: readonly SpecIssue[] };

/** Validates a workflow spec: the schema, then the cross-field and registry rules. */
export function validateWorkflowSpec(input: unknown): SpecResult {
  const parsed = WorkflowSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  const spec = parsed.data;
  const issues: SpecIssue[] = [];
  const declared = new Set(spec.required_tools);

  spec.required_tools.forEach((id, i) => {
    if (!isToolId(id))
      issues.push({ path: `required_tools.${i}`, message: `${id} is not in the tool registry` });
  });
  if (spec.trigger.type === "condition" && !isToolId(spec.trigger.check)) {
    issues.push({
      path: "trigger.check",
      message: `${spec.trigger.check} is not in the tool registry`,
    });
  }

  const stepIds = new Set<string>();
  let intentSteps = 0;
  spec.steps.forEach((step, i) => {
    const path = `steps.${i}`;
    if (stepIds.has(step.id)) issues.push({ path, message: `step id ${step.id} is used twice` });
    stepIds.add(step.id);
    if (step.kind === "llm") {
      if (step.tool !== undefined) issues.push({ path, message: "an llm step names no tool" });
      return;
    }
    if (step.tool === undefined) {
      issues.push({ path, message: `a ${step.kind} step must name a tool` });
      return;
    }
    if (step.kind === "intent") {
      intentSteps += 1;
      if (!isIntentToolId(step.tool))
        issues.push({ path, message: `${step.tool} is not a registry intent` });
    } else if (!isToolId(step.tool)) {
      issues.push({ path, message: `${step.tool} is not in the tool registry` });
    }
    if (step.kind === "tool" && !declared.has(step.tool)) {
      issues.push({ path, message: `${step.tool} is not in required_tools` });
    }
  });

  if (intentSteps > spec.guardrails.maxIntentsPerRun) {
    issues.push({
      path: "guardrails.maxIntentsPerRun",
      message: `is below the ${intentSteps} intent steps`,
    });
  }
  const stepTime = spec.steps.reduce((sum, s) => sum + s.timeoutSeconds, 0);
  if (stepTime > spec.timeoutSeconds) {
    issues.push({
      path: "timeoutSeconds",
      message: `step timeouts add up to ${stepTime}s, above the run timeout`,
    });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec };
}
