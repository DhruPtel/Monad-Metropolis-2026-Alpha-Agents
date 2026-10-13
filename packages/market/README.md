# @alpha-agents/market

Market data for research and the platform. Every number is a `Figure` with its source and `asOf` time, read through one shared cache with per-provider rate limits, timeouts and plausibility guards.

## What is here

- `service.ts`: `MarketData`, one instance per process, shared by the data tools, the chain tools and the platform's own readers.
- `research.ts`: `ResearchSources`, the sources beyond market data (X search, saved Dune queries, mainnet contract lookups) with persisted daily budgets.
- `cache.ts`, `upstream.ts`, `usage.ts`: the `MarketCache`, upstream request hygiene (timeouts, retries, token buckets) and daily usage counts for paid upstreams.
- `figures.ts`, `guards.ts`, `text.ts`: the `Figure` shape, range guards that refuse implausible values, and sanitizing of upstream names and symbols.
- `coinmarketcap.ts`, `defillama.ts`, `geckoterminal.ts`, `goplus.ts`, `dune.ts`, `x.ts`: one reader per upstream provider.
- `chain.ts`, `mainnet.ts`, `readonly.ts`, `lookup.ts`: chain identifiers, mainnet reads (oracle price, pool depth) over a read-only transport, and contract lookups.
- `discovery.ts`, `pool-verify.ts`, `token-lists.ts`, `token-pools.ts`: token discovery, with every pool confirmed onchain before it is trusted.
- `volatility.ts`: realized volatility from a price history.
- `dune-sync.ts` and `dune/`: the saved Dune query SQL and `queries.json` with their IDs.
- `testing.ts` (exported as `@alpha-agents/market/testing`) and `fixtures/`: fixture fetches and fake chain readers for tests.

## How it is used

- Imported by `services/orchestrator`, `services/data-tools` and `services/chain-tools`.
- `pnpm dune:sync` saves the queries in `dune/` on Dune and records their IDs.
- Tests: `pnpm vitest run --project node packages/market`.
