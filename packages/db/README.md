# @alpha-agents/db

The Postgres schema, migrations and typed Kysely client shared by the indexer, the control API, the orchestrator and the signer. There are two schemas: `indexer` holds chain projections written only by the indexer, and `platform` holds state the platform owns (allowlist, claims, runtimes, leases, tasks, ledger and more).

## What is here

- `src/index.ts`: `createDb`, `migrateToLatest`, `resetDatabase`, the ordered `MIGRATIONS` map, `dbAddress` (lowercases an address) and the `Db` type.
- `src/schema.ts`: the `Database` type, one interface per table, as Kysely sees it.
- `src/migrations/`: numbered migrations, `0001_initial.ts` through `0036_research_reports.ts`.
- `src/journal.ts`: `insertJournal`, which stores a ledger journal entry already checked by `@alpha-agents/accounting`.
- `src/contributions.ts`: `readContributionWeights`, one contributor's funding and refund basis for an agent.
- `src/testing.ts` (exported as `@alpha-agents/db/testing`): `createTestDatabase`, a throwaway migrated database per test file, and `databaseAvailable`.

## How it is used

- Imported by `apps/control-api`, `services/indexer`, `services/orchestrator`, `packages/signer`, `packages/skills` and `packages/trading`, and by several root scripts.
- `pnpm db:migrate` applies pending migrations; `pnpm db:reset` (local only) drops both schemas and migrates from scratch.
- Tests: `pnpm vitest run --project node packages/db` (they need the local Postgres from `pnpm dev:up`).
