# packages

Shared TypeScript packages used across apps and services. Each is TypeScript run directly by Node's type stripping, has its own `typecheck` script, and is checked by the root `pnpm typecheck`.

- `config` (P0-U3): environment IDs, the variable registry, the validated config loader with the mainnet signing guard, and the generator for `.env.example`.
- `domain` (P0-U5): amounts, IDs, tiers, accounts, assets, the canonical mode model, the tool registry, typed intents, reason codes, record and event schemas, and the address book.
- `policy` (P0-U5): the launch hard limits and the pure offchain pre-checks.
- `skills` (P0-U5): the skill.json manifest schema and validator.
- `workflows` (P0-U5): the workflow spec schema and validator.
- `accounting` (P0-U5): journal, valuation and credits types.
