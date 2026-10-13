# @alpha-agents/tool-server

Shared conventions for the MCP tool servers. Identity comes from the connection's bearer token (the lease's gate token), never from a tool parameter, and every server returns the same error shape and structured results.

## What is here

- `src/conventions.ts`: identity resolution, `ToolError` and `TOOL_ERROR_CODES` (the shared error shape), structured result helpers and `sha256Hex`.
- `src/host.ts`: `startToolServer`, which hosts one MCP server over Streamable HTTP on loopback. It is stateless: each request builds its own server for the identity its token resolves to.
- `src/testing.ts` (exported as `@alpha-agents/tool-server/testing`): `staticResolver`, `connectClient` and `structured` for tool server tests.

## How it is used

- Imported by the three tool servers (`services/chain-tools`, `services/data-tools`, `services/platform-tools`) and by `services/orchestrator`, which starts them.
- Tests: `pnpm vitest run --project node packages/tool-server`.
