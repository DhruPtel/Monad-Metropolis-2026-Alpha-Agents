# @alpha-agents/devenv

Local environment logic shared by the root scripts (`pnpm run doctor`, `pnpm dev:*`, `pnpm test:fork`) and the dev console, so each check exists once.

- `rpc.ts`, `redact.ts`, `proc.ts`: the JSON-RPC client (errors never carry the URL), secret redaction and process helpers, moved from `scripts/lib`.
- `health.ts`: Postgres, Redis and anvil health. Reads only the `network` field of `anvil_nodeInfo`, because that response also carries the fork URL.
- `guard.ts`: `assertLocalFork`. Every state-changing action refuses to run unless the RPC host is exactly 127.0.0.1, the node reports `anvil/...` and the chain is 143; a remote URL is refused before any request.
- `controls.ts`: snapshot, revert, mine, advance time, reset to the pinned block (sending only the block number, so the RPC secret is never handled), set a MON balance, mint test USDC through the real FiatToken contract (the impersonated master minter configures a fork-only test minter), and read balances.
- Tests: guard tests against a remote URL and fake local nodes, and integration tests against the running fork that skip cleanly without it.
