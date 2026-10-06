import { TierSchema } from "@alpha-agents/domain";
import { z } from "zod";

/**
 * The JSON schema of an agent's rendered Hermes configuration (D-204). Every
 * setting that keeps the agent contained is a literal here, so no layer and no
 * per-agent override can loosen it: an override that tries fails validation.
 * Values that may vary (turn cap, run budget, the model alias) have bounds.
 *
 * Settings follow FINAL_PLAN 4.3.2. Two it names have no key at the pinned
 * Hermes commit and are left out: `hooks.outbound` and a telemetry switch.
 */
export const SKILLS_ROOT = "/run/agent-skills";
export const EQUIPPED_DIR = `${SKILLS_ROOT}/equipped`;
export const PLAYBOOKS_DIR = `${SKILLS_ROOT}/playbooks`;
export const WORKSPACE_DIR = "/workspace";

/** Removed from the schema entirely; terminal, code execution and file stay (in /workspace). */
export const DISABLED_TOOLSETS = [
  "browser",
  "web",
  "search",
  "x_search",
  "delegation",
  "cronjob",
  "connections",
  "computer_use",
  "clarify",
  "image_gen",
  "video",
  "video_gen",
  "tts",
  "vision",
  "kanban",
  "session_search",
] as const;

/** The toolsets the API server offers the agent. Our three MCP servers join with P1-U7. */
export const API_SERVER_TOOLSETS = [
  "todo",
  "memory",
  "skills",
  "terminal",
  "code_execution",
  "file",
] as const;

const exactly = <T extends readonly string[]>(values: T) =>
  z
    .array(z.string())
    .refine((v) => v.length === values.length && values.every((x, i) => v[i] === x), {
      message: `must be exactly [${values.join(", ")}]`,
    });

const alias = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);

export const HermesSettingsSchema = z
  .object({
    model: z.object({ provider: z.literal("custom:gw"), default: alias }).strict(),
    providers: z
      .object({
        gw: z
          .object({
            key_env: z.literal("AGENT_LLM_KEY"),
            api_mode: z.literal("chat_completions"),
            discover_models: z.literal(false),
            models: z.record(alias, z.object({ context_length: z.number().int().min(8_000) })),
          })
          .strict(),
      })
      .strict(),
    auxiliary: z
      .object({
        compression: z.object({ provider: z.literal("custom:gw"), model: alias }).strict(),
        vision: z.object({ provider: z.literal("custom:gw"), model: alias }).strict(),
        title_generation: z.object({ enabled: z.literal(false) }).strict(),
        background_review: z.object({ enabled: z.literal(false) }).strict(),
      })
      .strict(),
    agent: z
      .object({
        max_turns: z.number().int().min(1).max(60),
        run_budget_seconds: z.number().int().min(10).max(1_800),
        disabled_toolsets: exactly(DISABLED_TOOLSETS),
      })
      .strict(),
    platform_toolsets: z.object({ api_server: exactly(API_SERVER_TOOLSETS) }).strict(),
    terminal: z.object({ cwd: z.literal(WORKSPACE_DIR) }).strict(),
    tool_loop_guardrails: z.object({ hard_stop_enabled: z.literal(true) }).strict(),
    tools: z
      .object({
        tool_search: z.object({ enabled: z.literal(false) }).strict(),
        connectors: z.object({ enabled: z.literal(false) }).strict(),
      })
      .strict(),
    skills: z
      .object({
        external_dirs: exactly([EQUIPPED_DIR, PLAYBOOKS_DIR] as const),
        creation_nudge_interval: z.literal(0),
        write_approval: z.literal(true),
        ledger: z.literal(false),
      })
      .strict(),
    memory: z
      .object({ nudge_interval: z.literal(0), user_profile_enabled: z.literal(false) })
      .strict(),
    curator: z.object({ enabled: z.literal(false) }).strict(),
    approvals: z
      .object({
        mode: z.literal("manual"),
        unattended_mode: z.literal("deny"),
        cron_mode: z.literal("deny"),
        single_query_mode: z.literal("deny"),
      })
      .strict(),
    security: z
      .object({
        allow_lazy_installs: z.literal(false),
        tirith_enabled: z.literal(false),
        redact_secrets: z.literal(true),
      })
      .strict(),
    updates: z.object({ check: z.literal(false) }).strict(),
    model_catalog: z.object({ enabled: z.literal(false) }).strict(),
    web: z.object({ keyless_fallback: z.literal(false) }).strict(),
    cron: z.object({ allow_agent_scheduling: z.literal(false) }).strict(),
    hooks: z
      .object({
        pre_tool_call: z
          .array(
            z
              .object({
                matcher: z.string(),
                command: z.string(),
                timeout: z.number().int(),
                fail_closed: z.literal(true),
              })
              .strict(),
          )
          .refine((hooks) => hooks.some((h) => h.matcher === "^skill_manage$"), {
            message: "must keep the hook that blocks skill_manage",
          }),
      })
      .strict(),
    hooks_auto_accept: z.literal(true),
    mcp_servers: z.object({}).strict(),
  })
  .strict();

export const PlaybookSchema = z
  .object({
    /** Version of the tier's playbook set, recorded for BuildRegistry later. */
    version: z.string().regex(/^tier-(base|medium|pro)@\d+$/),
    /** Playbook skill folders mounted read-only under PLAYBOOKS_DIR. */
    skills: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
    /** Starter workflows the tier names (A-12); the workflow runner arrives with Phase 4. */
    starterWorkflows: z.array(z.enum(["rebalancer", "recurring-buys"])),
    /** The tier's block in SOUL.md. */
    soulBlock: z.string().min(1),
  })
  .strict();

export const AgentConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    agent: z
      .object({
        chainId: z.number().int().positive(),
        agentId: z.number().int().positive(),
        species: z.number().int().min(1).max(25),
        tier: TierSchema,
        generation: z.number().int().min(1),
      })
      .strict(),
    tier: z
      .object({ name: TierSchema, slots: z.number().int(), playbook: PlaybookSchema })
      .strict()
      .refine((t) => t.slots === { base: 3, medium: 5, pro: 8 }[t.name], {
        message: "slots must match the tier (3, 5, 8)",
      }),
    soul: z.string().min(1),
    hermes: HermesSettingsSchema,
  })
  .strict()
  .refine((c) => c.agent.tier === c.tier.name, {
    message: "the tier overlay must match the agent",
  });

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type HermesSettings = z.infer<typeof HermesSettingsSchema>;
export type Playbook = z.infer<typeof PlaybookSchema>;
