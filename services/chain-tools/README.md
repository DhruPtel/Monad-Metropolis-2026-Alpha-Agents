# @alpha-agents/chain-tools

The chain tools MCP server: the agent's reads of its own account and the market, and its swap proposals as typed intents that wait for approval. Every limit comes from the Executor's own views and from `@alpha-agents/policy`, never from the model; identity comes only from the injected token.

## What is here

- `src/server.ts`: `registerChainTools` and `startChainTools`. Tools: `get_portfolio`, `get_prices`, `get_quote`, `get_limits`, `tradable_now`, `propose_swap`, `get_intent_status`, plus the lookup tools `get_pool_depth`, `read_contract`, `balance` and `get_code` (`registerLookupTools`).
- `src/server-v3.ts`: `registerChainToolsV3`, the same trade tools for the fund agent's v3 set (any registered token, routes of up to three pools).
- `src/reader.ts`, `src/reader-v3.ts`: `ViemChainReader` and `ViemChainReaderV3`, contract reads with addresses from the environment's address book.
- `src/logic.ts`, `src/logic-v3.ts`: pure functions that compute each answer from what the reader returned.
- `src/schema.ts`, `src/schema-v3.ts`: strict zod inputs and outputs. Inputs never carry an address, an agent, calldata or a recipient.
- `src/routes.ts`: route selection in the order Executor v3 checks them.
- `src/transport.ts`: `rpcTransport`, the primary RPC provider with an optional fallback.

## How it is used

- Hosted by `services/orchestrator` (`src/tools/servers.ts`) through `@alpha-agents/tool-server`, and started directly by `pnpm test:anthropic:dry-run`.
- Tests: `pnpm vitest run --project node services/chain-tools`.
