# apps/control-api

The control API (P1-U4, D-198, D-199): agents and supply from the indexer's projections with their watermark, Privy sessions, owner sessions bound to the agent's current owner and ownership epoch, mint eligibility, and the mint claim signer with the database allowlist. Hono on Node; run it with `pnpm dev:api`. The routes are listed in the root README under "Indexer and control API".

## Since 2026-10-13

- `GET /v1/agents/:id/money-events` (public, read only): the trading account's and the vault's deposits and withdrawals from their own event logs (scanned in 1,000-block chunks and cached in `src/money-events.ts`), the credit top-ups the indexer recorded, and when each account was created.
- `POST /v1/agents/:id/research-run` (owner only): Research now, forwarded to the orchestrator.
- Tests: `pnpm vitest run apps/control-api/src/money-events.test.ts apps/control-api/src/app.test.ts`.
