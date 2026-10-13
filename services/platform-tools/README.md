# @alpha-agents/platform-tools

The platform tools MCP server, kept thin. It lets the agent end a research stage, store its notes and briefs, and read its research context and the owner's goals and limits. What the model writes here is codes or bounded fields, never free text shown to an owner verbatim.

## What is here

- `src/server.ts`: `registerPlatformTools`, `startPlatformTools` and `MemoryPlatformStore`. Tools: `complete_stage` (recorded once per stage per lease), `write_thesis`, `write_research_brief`, `get_research_context` and `get_goals_and_limits`.
- `src/schema.ts`: the discovery loop's `STAGES` (`SCAN`, `DIVE`, `CHALLENGE`, `TEST`, `ZOOM_OUT`) and the strict inputs and outputs of `complete_stage` and `write_thesis`.
- `src/briefs.ts`: the typed research briefs (`BRIEF_KINDS`) each stage must write, with bounded fields the platform checks against tool results.

## How it is used

- Hosted by `services/orchestrator` (`src/tools/servers.ts`, with its store in `src/tools/platform-store.ts`) through `@alpha-agents/tool-server`. Also started by the Hermes spike scripts (`pnpm spike:hermes:local`, `pnpm spike:hermes`) and `pnpm test:anthropic:dry-run`.
- Tests: `pnpm vitest run --project node services/platform-tools`.
