import {
  AddressSchema,
  IMPLICIT_TOOL_IDS,
  INTENT_TOOL_IDS,
  RETIRED_TOOL_IDS,
  TierSchema,
  type Tier,
  isIntentToolId,
  isToolId,
  meetsTier,
  slotsFor,
} from "@alpha-agents/domain";
import { z } from "zod";

/**
 * The skill.json spec, v1 (FINAL_PLAN 4.5.2). The schema is strict: the
 * platform-computed fields (`content_hash`, `manifest_hash`, `signature`,
 * `audit_attestation`, `published_at`) and anything unknown are rejected if a
 * publisher supplies them.
 */
const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a lowercase slug")
  .max(64);
const semver = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/, "must be semver");
const phrases = z.array(z.string().min(1).max(200)).max(20);

export const SKILL_TYPES = ["protocol", "strategy", "research"] as const;
export const LAUNCH_CHAIN = "eip155:143";

export const SkillManifestSchema = z
  .object({
    schema_version: z.literal(1),
    id: slug,
    name: z.string().min(1).max(48),
    version: semver,
    type: z.enum(SKILL_TYPES),
    publisher: z
      .object({ id: z.string().min(1), address: AddressSchema, key_id: z.string().min(1) })
      .strict(),
    description: z
      .object({
        /** What the model sees; the first 57 characters must stand alone. */
        model: z.string().min(1).max(160),
        marketplace: z.string().min(1).max(600),
      })
      .strict(),
    triggers: phrases.optional(),
    not_for: phrases.optional(),
    required_tools: z.array(z.string()),
    intents: z.array(z.string()),
    data_sources: z.array(slug),
    required_tier: TierSchema.default("base"),
    slot_cost: z.number().int().min(1).max(3),
    synergy_tags: z.array(slug).max(10).optional(),
    compatible_templates: z
      .array(
        z
          .object({
            template: z
              .string()
              .regex(/^[a-z][a-z0-9_]*@[1-9]\d*$/, "must be a template ID like dca@1"),
            params: z
              .string()
              .regex(/^data\/[A-Za-z0-9_.-]+\.(json|ya?ml)$/, "must be a file in data/"),
          })
          .strict(),
      )
      .optional(),
    chains: z.array(z.literal(LAUNCH_CHAIN)).min(1),
    assets: z
      .array(
        z.string().regex(/^eip155:143\/erc20:0x[0-9a-fA-F]{40}$/, "must be CAIP-19 on chain 143"),
      )
      .optional(),
    privacy: z.enum(["public", "private"]),
    dependencies: z.array(slug).optional(),
    disclosures: z.array(z.string().min(1)).optional(),
    license: z.string().optional(),
    min_platform: semver.optional(),
  })
  .strict();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export interface ManifestIssue {
  readonly path: string;
  readonly message: string;
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: SkillManifest }
  | { readonly ok: false; readonly issues: readonly ManifestIssue[] };

/**
 * Validates a manifest: the schema, then the rules that need the registry.
 * `required_tools` may name only registry tools, `intents` only the intent
 * subset; retired research IDs are rejected by name.
 */
export function validateManifest(input: unknown): ManifestResult {
  const parsed = SkillManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  const m = parsed.data;
  const issues: ManifestIssue[] = [];

  m.required_tools.forEach((id, i) => {
    if ((RETIRED_TOOL_IDS as readonly string[]).includes(id)) {
      issues.push({ path: `required_tools.${i}`, message: `${id} is a retired research ID` });
    } else if (!isToolId(id)) {
      issues.push({ path: `required_tools.${i}`, message: `${id} is not in the tool registry` });
    }
  });
  m.intents.forEach((id, i) => {
    if (!isIntentToolId(id)) {
      issues.push({
        path: `intents.${i}`,
        message: `${id} is not a registry intent (${INTENT_TOOL_IDS.join(", ")})`,
      });
    }
  });
  if (new Set(m.required_tools).size !== m.required_tools.length) {
    issues.push({ path: "required_tools", message: "lists a tool more than once" });
  }
  if (m.privacy === "private" && m.type !== "strategy") {
    issues.push({ path: "privacy", message: "private requires type strategy" });
  }
  if (m.type === "strategy" && (m.compatible_templates?.length ?? 0) === 0) {
    issues.push({
      path: "compatible_templates",
      message: "a strategy skill must name its templates",
    });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, manifest: m };
}

/** Every tool a loaded skill may call: its declared tools plus the implicit ones. */
export function allowedTools(m: SkillManifest): readonly string[] {
  return [...new Set([...IMPLICIT_TOOL_IDS, ...m.required_tools])];
}

/** BuildRegistry's slot rule: the sum of slot costs fits the tier, and every skill's tier is met. */
export function buildFits(
  tier: Tier,
  skills: readonly SkillManifest[],
): { fits: boolean; used: number; slots: number; tierNotMet: readonly string[] } {
  const used = skills.reduce((sum, s) => sum + s.slot_cost, 0);
  const slots = slotsFor(tier);
  const tierNotMet = skills.filter((s) => !meetsTier(tier, s.required_tier)).map((s) => s.id);
  return { fits: used <= slots && tierNotMet.length === 0, used, slots, tierNotMet };
}
