# @alpha-agents/data-tools

The data tools MCP server: web search, market data, research sources and token tools for the agent. Every call is metered before it runs, and everything a third party wrote reaches the agent as labeled, untrusted data.

## What is here

- `src/server.ts`: `startDataTools`, the price table, and the `web_search` and `read_url` tools.
- `src/tavily.ts`: `TavilyProvider`, the web provider behind `web_search` and `read_url`.
- `src/url-guard.ts`: the `read_url` guard. A URL is fetched only if it is plain http or https and its host resolves to public addresses.
- `src/web-content.ts`: strips, caps and wraps web content in untrusted-content markers.
- `src/market-tools.ts`: `market_snapshot`, `coinmarketcap_prices`, `defillama_tvl`, `defillama_yields` and `volatility`, read through `@alpha-agents/market`.
- `src/research-tools.ts`: `x_search` over curated topics and `dune_query` over the platform's saved queries.
- `src/token-tools.ts`: `list_tokens`, `new_pools`, `lookup_token`, `find_pools` and `screen_token`, over the platform's token registry.

## How it is used

- Hosted by `services/orchestrator` (`src/tools/servers.ts`) through `@alpha-agents/tool-server`, and started directly by `pnpm test:anthropic:dry-run`.
- Tests: `pnpm vitest run --project node services/data-tools`.
