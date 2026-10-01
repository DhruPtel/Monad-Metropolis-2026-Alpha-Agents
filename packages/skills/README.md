# @alpha-agents/skills

The skill.json v1 manifest schema (FINAL_PLAN 4.5.2) and `validateManifest`, which rejects any `required_tools` entry outside the canonical tool registry, any intent outside the intent subset, retired research IDs, and the platform-computed fields. `buildFits` applies BuildRegistry's slot and tier rules. `LAUNCH_SKILL_MANIFESTS` holds the nine launch skills of 4.5.4 as fixtures; the swap skill is `venue-swap` until Q-01 picks the venue. The registry itself is defined in packages/domain and re-exported here.
